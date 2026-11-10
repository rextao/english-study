/**
 * ReciteDebugPanel — 背词页右下角齿轮里的调试面板。
 *
 * 输入口令 123 才能进来（给家长看的，小朋友乱点进不去）：录音状态 + 本地缓存情况。
 * 录音失败时齿轮会显红色，这里能看到失败原因并重试；缓存区显示本周词数、拉取进度、
 * 本地占用，失败的词可单独重试，也能一次性重新拉取或清空本地缓存。
 */

import { useCallback, useEffect, useState } from 'react'
import { Button, Input, Modal, Popconfirm, Tag } from '../ui'
import type { RecitePreloadState } from '../hooks/useRecitePreload'
import {
  clearReciteCache,
  getAudioCacheStats,
  loadReciteMeta,
} from '../utils/reciteCache'
import type { AudioCacheStats, ReciteCacheMeta } from '../utils/reciteCache'
import './ReciteDebugPanel.css'

const DEBUG_CODE = '123'

export interface ReciteDebugRecording {
  supported: boolean
  recording: boolean
  starting: boolean
  startFailed: boolean
  error: string
  retry: () => void
}

interface ReciteDebugPanelProps {
  open: boolean
  onClose: () => void
  recording: ReciteDebugRecording
  recordEnabled: boolean
  onRecordToggle: (next: boolean) => void
  preload: RecitePreloadState
  onReloadCache: (words?: string[]) => void
  /** 本周日期范围（时间戳，用来显示「本周 11.9—11.15」） */
  weekStart: number | null
  weekEnd: number | null
}

function formatWeekLabel(weekStart: number, weekEnd: number): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  const format = (time: number) => {
    const date = new Date(time)
    return pad(date.getMonth() + 1) + '.' + pad(date.getDate())
  }
  return format(weekStart) + '—' + format(weekEnd)
}

function formatBytes(bytes: number): string {
  if (!bytes) return '0 KB'
  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
  return Math.max(1, Math.round(bytes / 1024)) + ' KB'
}

export function ReciteDebugPanel({
  open,
  onClose,
  recording,
  recordEnabled,
  onRecordToggle,
  preload,
  onReloadCache,
  weekStart,
  weekEnd,
}: ReciteDebugPanelProps) {
  const [code, setCode] = useState('')
  const [codeError, setCodeError] = useState('')
  const [unlocked, setUnlocked] = useState(false)
  const [stats, setStats] = useState<AudioCacheStats>({ count: 0, bytes: 0 })
  const [meta, setMeta] = useState<ReciteCacheMeta | null>(null)
  const [clearing, setClearing] = useState(false)

  // 每次打开都重新问口令，避免小朋友上次看到了面板一直留着
  useEffect(() => {
    if (!open) return
    setCode('')
    setCodeError('')
    setUnlocked(false)
  }, [open])

  const refreshCacheInfo = useCallback(async () => {
    const [nextStats, nextMeta] = await Promise.all([getAudioCacheStats(), loadReciteMeta()])
    setStats(nextStats)
    setMeta(nextMeta)
  }, [])

  // 解锁后读一次；预取有进展（状态 / 已完成数变化）也跟着刷
  useEffect(() => {
    if (open && unlocked) void refreshCacheInfo()
  }, [open, unlocked, refreshCacheInfo, preload.status, preload.done])

  function submitCode() {
    if (code.trim() === DEBUG_CODE) {
      setUnlocked(true)
      setCodeError('')
    } else {
      setCodeError('口令不对，请确认后再试')
    }
  }

  async function handleClear() {
    setClearing(true)
    await clearReciteCache()
    await refreshCacheInfo()
    setClearing(false)
  }

  const recordStatus = !recording.supported
    ? '不可用（需要 HTTPS 和新版浏览器）'
    : !recordEnabled
      ? '已关闭'
      : recording.recording
        ? '录音中'
        : recording.starting
          ? '正在开启…'
          : recording.startFailed
            ? '开录失败'
            : '待开启'

  const progressText = preload.total > 0
    ? preload.done + ' / ' + preload.total
    : meta ? meta.done + ' / ' + meta.total : '—'
  const weekLabel = weekStart != null && weekEnd != null ? formatWeekLabel(weekStart, weekEnd) : ''

  return (
    <Modal
      open={open}
      title="调试面板"
      description={unlocked ? '录音状态与本地缓存情况' : '输入口令查看录音与缓存状态'}
      onClose={onClose}
      footer={<Button block onClick={onClose}>关闭</Button>}
    >
      {!unlocked ? (
        <div className="recite-debug__gate">
          <Input
            value={code}
            onChange={event => { setCode(event.target.value); setCodeError('') }}
            onPressEnter={submitCode}
            placeholder="输入口令"
            inputMode="numeric"
            block
          />
          {codeError && <p className="recite-debug__gate-error">{codeError}</p>}
          <Button block type="primary" onClick={submitCode}>进入</Button>
        </div>
      ) : (
        <>
          <section className="recite-debug__section">
            <h3 className="recite-debug__heading">录音状态</h3>
            <dl className="recite-debug__rows">
              <div>
                <dt>浏览器支持</dt>
                <dd>{recording.supported ? '支持' : '不支持'}</dd>
              </div>
              <div>
                <dt>当前状态</dt>
                <dd>{recordStatus}</dd>
              </div>
              {Boolean(recording.error) && (
                <div className="recite-debug__row--error">
                  <dt>失败原因</dt>
                  <dd>{recording.error}</dd>
                </div>
              )}
            </dl>
            <div className="recite-debug__actions">
              <Button
                size="small"
                type={recordEnabled ? 'primary' : 'default'}
                onClick={() => onRecordToggle(!recordEnabled)}
              >
                {recordEnabled ? '关闭录音' : '开启录音'}
              </Button>
              {(recording.startFailed || Boolean(recording.error)) && (
                <Button size="small" onClick={recording.retry}>重试录音</Button>
              )}
            </div>
          </section>

          <section className="recite-debug__section">
            <h3 className="recite-debug__heading">本地缓存{weekLabel ? '（本周 ' + weekLabel + '）' : ''}</h3>
            <dl className="recite-debug__rows">
              <div>
                <dt>拉取进度</dt>
                <dd>{progressText}{preload.status === 'loading' ? ' · 拉取中' : ''}</dd>
              </div>
              <div>
                <dt>本地音频</dt>
                <dd>{stats.count} 条 · {formatBytes(stats.bytes)}</dd>
              </div>
            </dl>
            {Boolean(preload.reason) && <p className="recite-debug__note">{preload.reason}</p>}
            {preload.failed.length > 0 && (
              <div className="recite-debug__failed">
                <span className="recite-debug__failed-label">没缓存成功的词（{preload.failed.length}）</span>
                <div className="recite-debug__chips">
                  {preload.failed.map(word => <Tag key={word}>{word}</Tag>)}
                </div>
                <Button size="small" onClick={() => onReloadCache(preload.failed)}>重试这些词</Button>
              </div>
            )}
            <div className="recite-debug__actions">
              <Button
                size="small"
                loading={preload.status === 'loading' || clearing}
                onClick={() => onReloadCache()}
              >
                重新拉取本周
              </Button>
              <Popconfirm
                title="清空本地缓存？"
                description="清掉后点喇叭要重新走网络下载，本周没拉完的词也得重拉。"
                okText="清空"
                danger
                onConfirm={handleClear}
              >
                <Button size="small" danger>清空本地缓存</Button>
              </Popconfirm>
            </div>
          </section>
        </>
      )}
    </Modal>
  )
}
