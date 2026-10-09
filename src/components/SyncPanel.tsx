import { useState } from 'react'
import type { ReactNode } from 'react'
import type { SyncApi, SyncSummary } from '../hooks/useSync'
import { Button, Input, Popconfirm, Tag } from '../ui'
import './SyncPanel.css'

interface SyncPanelProps {
  sync: SyncApi
}

type ConfigField = 'url' | 'token' | 'deviceLabel'

function formatTime(ts: number): string {
  if (!ts) return '还没同步过'
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
    + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
}

/** 一份快照摘要排成小卡片：多少列表 / 多少词 / 多少学习事件 / 谁导出的 */
function SummaryCard({ title, summary, extra }: {
  title: string
  summary: SyncSummary | null
  extra?: ReactNode
}) {
  return (
    <div className="sync-card">
      <div className="sync-card__head">
        <span className="sync-card__title">{title}</span>
        {extra}
      </div>
      {summary ? (
        <div className="sync-card__stats">
          <span>{summary.listCount} 个列表</span>
          <span>{summary.wordCount} 个词条</span>
          <span>{summary.eventCount} 条学习记录</span>
        </div>
      ) : (
        <div className="sync-card__stats">读不到数据</div>
      )}
      <div className="sync-card__meta">
        {summary ? (
          <>
            <span>哈希 {summary.hash.slice(0, 10) || '—'}</span>
            {summary.deviceLabel && <span>来自「{summary.deviceLabel}」</span>}
            <span>{formatTime(summary.exportedAt)}</span>
          </>
        ) : (
          <span>{formatTime(0)}</span>
        )}
      </div>
    </div>
  )
}

export function SyncPanel({ sync }: SyncPanelProps) {
  const { config, status, busy, actionError, checking, saveConfig, push, pull, recheck } = sync
  const [urlDraft, setUrlDraft] = useState('')
  const [tokenDraft, setTokenDraft] = useState('')
  const [deviceDraft, setDeviceDraft] = useState('')
  const [pullHint, setPullHint] = useState('')

  const configured = Boolean(config?.configured)
  const remote = status?.remote ?? null

  async function handleSave() {
    const patch: Partial<Record<ConfigField, string>> = {}
    if (urlDraft.trim()) patch.url = urlDraft.trim()
    if (tokenDraft.trim()) patch.token = tokenDraft.trim()
    if (deviceDraft.trim()) patch.deviceLabel = deviceDraft.trim()
    if (Object.keys(patch).length === 0) return
    if (await saveConfig(patch)) {
      setUrlDraft('')
      setTokenDraft('')
      setDeviceDraft('')
    }
  }

  async function handlePull() {
    const result = await pull(false)
    setPullHint(result.needsForce
      ? '云端快照是空的，拉取会清空本地数据。请点击下面的按钮确认。'
      : '')
  }

  async function handlePullForce() {
    await pull(true)
    setPullHint('')
  }

  return (
    <section className="settings-section">
      <div className="settings-section__head">
        <p className="hint">
          把学习数据存到云端（Cloudflare D1），手机端以后就能读到桌面端的学习记录。页面不部署到云端，数据只存在云端数据库里。
        </p>
      </div>

      <div className="sync-form">
        <div className="sync-form__row">
          <label className="field-label sync-form__label" htmlFor="sync-url">云端地址</label>
          <Input
            id="sync-url"
            size="small"
            value={urlDraft}
            placeholder={config && config.url ? '已配置 ' + config.url + '，输入新的覆盖' : '部署 Worker 后拿到的 https://... 地址'}
            onChange={e => setUrlDraft(e.target.value)}
            onPressEnter={handleSave}
            spellCheck={false}
          />
        </div>
        <div className="sync-form__row">
          <label className="field-label sync-form__label" htmlFor="sync-token">同步令牌</label>
          <Input
            id="sync-token"
            size="small"
            value={tokenDraft}
            placeholder={
              config && config.hasToken
                ? '已配置 ' + config.tokenHint + '，输入新的覆盖'
                : 'wrangler secret put SYNC_TOKEN 设置的令牌'
            }
            onChange={e => setTokenDraft(e.target.value)}
            onPressEnter={handleSave}
            spellCheck={false}
          />
        </div>
        <div className="sync-form__row">
          <label className="field-label sync-form__label" htmlFor="sync-device">设备名</label>
          <Input
            id="sync-device"
            size="small"
            value={deviceDraft}
            placeholder={config && config.deviceLabel ? '已配置「' + config.deviceLabel + '」' : '给这台机器起个名字，推送后能分辨是谁传的'}
            onChange={e => setDeviceDraft(e.target.value)}
            onPressEnter={handleSave}
            spellCheck={false}
          />
        </div>
        <div className="sync-form__actions">
          <Button
            type="primary"
            size="small"
            disabled={!urlDraft.trim() && !tokenDraft.trim() && !deviceDraft.trim()}
            onClick={() => { void handleSave() }}
          >
            保存
          </Button>
          {configured && (
            <Button size="small" onClick={() => { void saveConfig({ url: null }) }}>
              清除云端地址
            </Button>
          )}
        </div>
        <p className="hint sync-form__hint">
          令牌存在本机 cache/sync-keys.json（不进 git），也可以写在 .env.local 的
          SYNC_WORKER_URL / SYNC_WORKER_TOKEN / SYNC_DEVICE_LABEL 里，页面配置优先。
          同步由本地服务发起，浏览器不直连云端，令牌不会暴露给页面。
        </p>
        {actionError && <div className="callout callout--error sync-form__error">{actionError}</div>}
      </div>

      {configured ? (
        <>
          <div className="sync-cards">
            <SummaryCard
              title="本机"
              summary={status?.local ?? null}
              extra={status?.local?.dirty ? <Tag color="gold">有未同步的改动</Tag> : <Tag color="green">已同步</Tag>}
            />
            <SummaryCard
              title="云端"
              summary={remote}
              extra={remote ? <Tag color="blue">云端数据</Tag> : <Tag color="default">连不上</Tag>}
            />
          </div>
          {status?.remoteError && (
            <div className="callout callout--warn sync-remote-error">
              无法连接云端同步服务：{status.remoteError}。请检查云端地址和令牌，或稍后重试。
            </div>
          )}

          <div className="sync-actions">
            <Button
              type="primary"
              size="small"
              loading={busy === 'push'}
              disabled={busy !== null}
              onClick={() => { void push() }}
            >
              上传到云端
            </Button>
            <Popconfirm
              title="用云端数据整份覆盖本地？"
              description="本地现在的学习数据会被云端版本替换（覆盖前会自动备份）。"
              okText="确认拉取"
              danger
              disabled={busy !== null}
              onConfirm={() => { void handlePull() }}
            >
              <Button size="small" loading={busy === 'pull'} disabled={busy !== null}>从云端拉取</Button>
            </Popconfirm>
            <Button size="small" loading={checking} onClick={() => { recheck() }}>
              重新检查
            </Button>
          </div>
          {pullHint && (
            <Popconfirm
              title="云端是空数据，确定清空本地？"
              description="云端快照里没有任何学习内容，拉取后本地数据会被清空（已自动备份）。"
              okText="确认清空并拉取"
              danger
              placement="bottomRight"
              disabled={busy !== null}
              onConfirm={() => { void handlePullForce() }}
            >
              <Button size="small" danger disabled={busy !== null}>云端是空的，仍要拉取</Button>
            </Popconfirm>
          )}

          <p className="hint sync-how">
            <strong>同步原理：</strong>传的是整库快照（学习列表 / 学习记录 / 词义画像 / 标签 / 目标 / 打印批次），
            不做逐行合并，最后同步的一份数据为准；两边都改了需要你自己选以哪边为准。
            查词缓存不参与同步（随时能重新生成）。从云端拉取覆盖本地前会自动备份当前数据库。
            上次同步：{status ? formatTime(status.lastSyncAt) : formatTime(0)}
            {status?.lastDirection ? '（' + (status.lastDirection === 'push' ? '上传' : '拉取') + '）' : ''}。
          </p>
        </>
      ) : (
        <div className="callout callout--warn sync-not-configured">
          还没配置云端同步地址。填上面的「云端地址」和「同步令牌」并保存后，就能在多台设备之间同步学习数据了。
        </div>
      )}
    </section>
  )
}
