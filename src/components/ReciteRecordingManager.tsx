import { useCallback, useEffect, useState } from 'react'
import { Button, Checkbox, Popconfirm } from '../ui'
import { ReciteRecordingButton } from './ReciteRecordingButton'
import { deleteReciteRecordings, fetchReciteRecordings } from '../hooks/useRecite'
import type { ReciteRecordingSummary } from '../hooks/useRecite'
import './ReciteRecordingManager.css'

/**
 * 设置页「课堂录音」分区：统一管理背词页自动上传的录音。
 * 列出最近 15 天（服务端只留这么久的），可逐条试听、多选后统一删除。
 * 删除只动音频，学习记录和背词进度不受影响。
 */

const LIMIT = 60
const RETENTION_DAYS = 15

function fmtTime(ts: number): string {
  const date = new Date(ts)
  const pad = (value: number) => String(value).padStart(2, '0')
  return (date.getMonth() + 1) + '.' + date.getDate() + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
}

function fmtDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return minutes > 0 ? minutes + ' 分 ' + seconds + ' 秒' : seconds + ' 秒'
}

function fmtSize(bytes: number): string {
  if (!bytes) return '—'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

export function ReciteRecordingManager() {
  const [items, setItems] = useState<ReciteRecordingSummary[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const list = await fetchReciteRecordings(LIMIT)
      setItems(list)
      // 列表刷新后把已经不存在的选中项去掉
      setSelected(previous => new Set(list.filter(item => previous.has(item.id)).map(item => item.id)))
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '录音列表读取失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  function toggleOne(id: string, checked: boolean) {
    setSelected(previous => {
      const next = new Set(previous)
      if (checked) next.add(id)
      else next.delete(id)
      return next
    })
  }

  function toggleAll() {
    setSelected(previous => (
      previous.size === items.length ? new Set() : new Set(items.map(item => item.id))
    ))
  }

  async function removeSelected() {
    if (selected.size === 0 || deleting) return
    setDeleting(true)
    setError('')
    try {
      await deleteReciteRecordings(Array.from(selected))
      setSelected(new Set())
      await load()
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : '删除失败，请重试')
    } finally {
      setDeleting(false)
    }
  }

  const allSelected = items.length > 0 && selected.size === items.length

  return (
    <div className="recite-recordings">
      <div className="recite-recordings__head">
        <div>
          <h2 className="settings-section__title">课堂录音</h2>
          <p className="hint">
            背词页开着录音时，每学完一次会自动上传一段，只保留最近 {RETENTION_DAYS} 天。
            这里可以逐条试听，也可以勾选后统一删除——删的只是音频，学习记录和背词进度不受影响。
          </p>
        </div>
      </div>

      {error && <div className="callout callout--error recite-recordings__message" role="alert">{error}</div>}

      {loading ? (
        <p className="empty recite-recordings__loading"><span className="ui-spin" aria-hidden="true" />正在读取课堂录音...</p>
      ) : items.length === 0 ? (
        <div className="callout callout--success recite-recordings__message">
          近 {RETENTION_DAYS} 天还没有课堂录音。孩子在背词页学完一次后，这里就会出现那一段音频。
        </div>
      ) : (
        <>
          <div className="recite-recordings__toolbar">
            <Checkbox checked={allSelected} onChange={() => toggleAll()}>全选</Checkbox>
            <span className="recite-recordings__count">已选 {selected.size} / {items.length} 条</span>
            <Popconfirm
              title={'删除选中的 ' + selected.size + ' 条课堂录音？'}
              description="音频会一起删除，无法恢复；学习记录与背词进度不受影响。"
              okText="删除"
              danger
              disabled={selected.size === 0 || deleting}
              onConfirm={() => { void removeSelected() }}
            >
              <Button size="small" danger disabled={selected.size === 0 || deleting}>
                {deleting ? '删除中...' : '删除所选'}
              </Button>
            </Popconfirm>
            <Button size="small" onClick={() => { void load() }} disabled={loading || deleting}>刷新</Button>
          </div>

          <ul className="recite-recordings__list">
            {items.map(item => (
              <li key={item.id} className="recite-recordings__row">
                <Checkbox
                  className="recite-recordings__check"
                  checked={selected.has(item.id)}
                  onChange={event => toggleOne(item.id, event.target.checked)}
                >
                  <span className="recite-recordings__when">{fmtTime(item.createdAt)}</span>
                  <span className="recite-recordings__meta">
                    {item.sessionIndex != null ? '第 ' + item.sessionIndex + ' 次' : '未关联学习'}
                  </span>
                </Checkbox>
                <span className="recite-recordings__size">
                  {fmtDuration(item.durationMs)} · {fmtSize(item.size)}
                </span>
                <ReciteRecordingButton recording={item} onError={setError} />
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}
