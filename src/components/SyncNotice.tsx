import { useState } from 'react'
import type { SyncApi } from '../hooks/useSync'
import { Button, Modal } from '../ui'
import './SyncNotice.css'

interface SyncNoticeProps {
  sync: SyncApi
  /** 拉取覆盖本地成功后，让 App 刷新学习列表 / 复习计划 / 词库标签 */
  onApplied: () => void
  /** 切到设置页「数据同步」tab；showDiff=true 时顺带展开具体差异 */
  onNavigateToSync: (showDiff: boolean) => void
}

type ModalKind = null | 'empty'

/**
 * 顶部的数据同步提示条 + 冲突弹窗。
 * 只有「需要用户动手」的几种状态才显示：本地有新改动 / 云端有新改动 / 两边冲突 / 连不上云端。
 * 数据一致、没配置同步、本地服务没起，都不打扰用户。
 * 同步永远在用户点按钮后才执行，这里不做任何自动同步。
 * 两边冲突时不在这里弹窗，而是引导用户去设置页「数据同步」里选方向、看差异，复用那一套面板。
 */
export function SyncNotice({ sync, onApplied, onNavigateToSync }: SyncNoticeProps) {
  const { state, status, busy, push, pull, recheck } = sync
  const [modal, setModal] = useState<ModalKind>(null)

  async function handlePush() {
    if (await push()) {
      // 上传不会改本地数据，不用刷新页面；只有拉取覆盖本地才需要
      setModal(null)
    }
  }

  async function handlePull(force = false) {
    const result = await pull(force)
    if (result.needsForce) {
      setModal('empty')
      return
    }
    setModal(null)
    if (result.ok) onApplied()
  }

  const remote = status?.remote ?? null
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
  } else if (state === 'remote-ahead') {
    const words = remote?.wordCount ?? 0
    text = '云端有更新的学习数据（' + words + ' 个词条'
      + (remote?.deviceLabel ? '，来自「' + remote.deviceLabel + '」' : '') + '）。'
    actions = (
      <>
        <Button type="primary" size="small" loading={busy === 'pull'} disabled={busyAny} onClick={() => { void handlePull(false) }}>
          同步到本地
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
    <>
      <div className="app__notice">
        <div className="callout callout--warn sync-notice">
          <span className="sync-notice__text">{text}</span>
          <span className="sync-notice__actions">{actions}</span>
        </div>
      </div>

      <Modal
        open={modal === 'empty'}
        title="云端是空数据"
        description="云端快照里没有任何学习内容，拉取后本地数据会被清空（拉取前会自动备份）。"
        onClose={() => setModal(null)}
        footer={
          <>
            <Button
              type="primary"
              danger
              size="small"
              loading={busy === 'pull'}
              disabled={busyAny}
              onClick={() => { void handlePull(true) }}
            >
              确认清空并拉取
            </Button>
            <Button size="small" disabled={busyAny} onClick={() => setModal(null)}>取消</Button>
          </>
        }
      >
        <p className="hint">本机现有 {status?.local.wordCount ?? 0} 个词条，云端是空的。如果只是想清空本地重新开始，可以继续；否则请先在另一台设备上传数据。</p>
      </Modal>
    </>
  )
}
