import type { SyncApi } from '../hooks/useSync'
import { Button } from '../ui'
import './SyncNotice.css'

interface SyncNoticeProps {
  sync: SyncApi
  /** 切到设置页「数据同步」tab；showDiff=true 时顺带展开具体差异 */
  onNavigateToSync: (showDiff: boolean) => void
}

/**
 * 顶部的数据同步提示条 + 冲突弹窗。
 * 只有「需要用户动手」的几种状态才显示：本地有新改动 / 两边冲突 / 连不上云端。
 * 「云端有新改动」刻意不在这里占一整行提示条，改成标题栏（Nav）里的小提示，点一下去设置页拉取。
 * 数据一致、没配置同步、本地服务没起，都不打扰用户。
 * 同步永远在用户点按钮后才执行，这里不做任何自动同步。
 * 两边冲突时不在这里弹窗，而是引导用户去设置页「数据同步」里选方向、看差异，复用那一套面板。
 */
export function SyncNotice({ sync, onNavigateToSync }: SyncNoticeProps) {
  const { state, status, busy, push, recheck } = sync

  async function handlePush() {
    await push()
    // 上传不会改本地数据，不用刷新页面；只有拉取覆盖本地才需要
  }

  const busyAny = busy !== null

 let text = ''
 let actions = null

  if (state === 'error') {
    text = '无法连接云端同步服务：' + (status?.remoteError || '请检查云端地址和令牌')
    actions = (
      <Button size="small" loading={busyAny} onClick={() => { recheck() }}>重试</Button>
    )
  } else if (state === 'local-ahead') {
    const words = status?.local.wordCount ?? 0
    text = '本地有 ' + words + ' 个词条的学习数据还没同步到云端。'
    actions = (
      <>
        <Button type="primary" size="small" loading={busy === 'push'} disabled={busyAny} onClick={() => { void handlePush() }}>
          上传到云端
        </Button>
        <Button size="small" disabled={busyAny} onClick={() => onNavigateToSync(true)}>详情</Button>
      </>
    )
  } else if (state === 'conflict') {
    text = '本地和云端都有未同步的改动，需要你选一个方向同步。'
    actions = (
      <>
        <Button type="primary" size="small" disabled={busyAny} onClick={() => onNavigateToSync(false)}>
          选择同步方向
        </Button>
        <Button size="small" disabled={busyAny} onClick={() => onNavigateToSync(true)}>详情</Button>
      </>
    )
  }

  // synced / unconfigured / loading / offline 都不显示
  if (!text) return null

  return (
    <div className="app__notice">
      <div className="callout callout--warn sync-notice">
        <span className="sync-notice__text">{text}</span>
        <span className="sync-notice__actions">{actions}</span>
      </div>
    </div>
  )
}
