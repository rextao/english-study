import { useEffect, useRef, useState } from 'react'
import { Button } from '../ui'
import { fetchReciteRecordingAudio, fetchReciteRecordings } from '../hooks/useRecite'
import type { ReciteRecordingSummary } from '../hooks/useRecite'
import './ReciteRecordings.css'

/** 与服务端一致：只保留最近 15 天 */
const RETENTION_DAYS = 15
const LIMIT = 30

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

function base64ToBlobUrl(base64: string, mime: string): string {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return URL.createObjectURL(new Blob([bytes.buffer as ArrayBuffer], { type: mime }))
}

/**
 * 课堂录音列表（挂在校背词任务页）：按时间倒序列出最近 15 天的录音，点播放走
 * GET /api/recite/recordings/:id/audio（同样要 Bearer 令牌），解成 Blob URL 播放。
 */
export function ReciteRecordings({ reloadKey }: { reloadKey: number }) {
  const [items, setItems] = useState<ReciteRecordingSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  /** 正在播 / 正在取的那一条 */
  const [playingId, setPlayingId] = useState('')
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const urlRef = useRef('')

  useEffect(() => {
    let alive = true
    setLoading(true)
    fetchReciteRecordings(LIMIT)
      .then(list => {
        if (!alive) return
        setItems(list)
        setError('')
      })
      .catch(loadError => {
        if (!alive) return
        setError(loadError instanceof Error ? loadError.message : '录音读取失败')
      })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [reloadKey])

  // 离开页面时停掉正在播的音频并释放 Blob URL
  useEffect(() => () => {
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current = null
    }
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current)
      urlRef.current = ''
    }
  }, [])

  function stopPlayback() {
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current = null
    }
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current)
      urlRef.current = ''
    }
    setPlayingId('')
  }

  async function toggle(item: ReciteRecordingSummary) {
    if (playingId === item.id) {
      stopPlayback()
      return
    }
    stopPlayback()
    setError('')
    setPlayingId(item.id)
    try {
      const { audio, mime } = await fetchReciteRecordingAudio(item.id)
      const url = base64ToBlobUrl(audio, mime || item.mime || 'audio/mp4')
      urlRef.current = url
      const player = new Audio(url)
      audioRef.current = player
      player.onended = () => {
        if (urlRef.current === url) {
          URL.revokeObjectURL(url)
          urlRef.current = ''
        }
        audioRef.current = null
        setPlayingId('')
      }
      await player.play()
    } catch (playError) {
      stopPlayback()
      setError(playError instanceof Error ? playError.message : '录音播放失败')
    }
  }

  return (
    <section className="card card--pad recite-recordings">
      <div className="recite-recordings__head">
        <h2 className="recite-recordings__title">课堂录音</h2>
        <span className="recite-recordings__hint">
          {loading ? '正在读取…' : '最近 ' + RETENTION_DAYS + ' 天 · 共 ' + items.length + ' 条'}
        </span>
      </div>

      {error && <p className="callout callout--error">{error}</p>}

      {!loading && items.length === 0 && (
        <p className="recite-recordings__empty">
          还没有录音。背词页开着录音时，每学完一次会自动上传一段，只保留最近 15 天。
        </p>
      )}

      <ul className="recite-recordings__list">
        {items.map(item => (
          <li key={item.id} className="recite-recordings__row">
            <span className="recite-recordings__when">{fmtTime(item.createdAt)}</span>
            <span className="recite-recordings__meta">
              {item.sessionIndex != null ? '第 ' + item.sessionIndex + ' 次' : '整段'}
              {' · '}
              {fmtDuration(item.durationMs)}
            </span>
            <Button size="small" onClick={() => { void toggle(item) }}>
              {playingId === item.id ? '停止' : '播放'}
            </Button>
          </li>
        ))}
      </ul>
    </section>
  )
}
