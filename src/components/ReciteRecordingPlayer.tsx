import { useEffect, useRef, useState } from 'react'
import { fetchReciteRecordingAudio } from '../hooks/useRecite'
import type { ReciteRecordingSummary } from '../hooks/useRecite'
import { base64ToBlobUrl } from './ReciteRecordingButton'
import './ReciteRecordingPlayer.css'

/** 倍速档位循环切换：核对录音时经常想快一点听 */
const PLAYBACK_RATES = [1, 1.25, 1.5, 2]
/** 键盘左右键一次进退的秒数 */
const SKIP_SECONDS = 5

function fmtTime(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  return Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0')
}

/**
 * 一次学习的课堂录音播放器：挂在保存抽屉顶部。
 * 没有录音显示「暂无音频」；有录音则可以播放 / 暂停、拖动进度条、切换倍速。
 * 抽屉关闭即卸载：自动停掉播放并释放 Blob URL。
 */
export function ReciteRecordingPlayer({ recording, onError }: {
  recording?: ReciteRecordingSummary
  /** 拉取 / 播放失败的原因交给外层（抽屉顶部提示），组件内也会就地显示 */
  onError?: (message: string) => void
}) {
  const [loading, setLoading] = useState(Boolean(recording))
  const [failed, setFailed] = useState('')
  const [playing, setPlaying] = useState(false)
  const [current, setCurrent] = useState(0)
  const [duration, setDuration] = useState(recording ? recording.durationMs / 1000 : 0)
  const [rate, setRate] = useState(1)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const urlRef = useRef('')
  const trackRef = useRef<HTMLDivElement | null>(null)
  const draggingRef = useRef(false)

  // 录音存在才拉音频；元素、监听和 Blob URL 都在清理里收掉（换录音或抽屉关闭）
  useEffect(() => {
    if (!recording) return
    let cancelled = false
    let player: HTMLAudioElement | null = null
    const onTime = () => { if (player && !draggingRef.current) setCurrent(player.currentTime) }
    const onDuration = () => { if (player && isFinite(player.duration)) setDuration(player.duration) }
    const onPlay = () => setPlaying(true)
    const onPause = () => setPlaying(false)
    const onEnded = () => { setPlaying(false); setCurrent(0) }

    setLoading(true)
    setFailed('')
    setDuration(recording.durationMs / 1000)
    fetchReciteRecordingAudio(recording.id)
      .then(({ audio, mime }) => {
        if (cancelled) return
        const url = base64ToBlobUrl(audio, mime || recording.mime || 'audio/mp4')
        urlRef.current = url
        player = new Audio(url)
        player.playbackRate = rate
        player.addEventListener('timeupdate', onTime)
        player.addEventListener('durationchange', onDuration)
        player.addEventListener('loadedmetadata', onDuration)
        player.addEventListener('play', onPlay)
        player.addEventListener('pause', onPause)
        player.addEventListener('ended', onEnded)
        audioRef.current = player
      })
      .catch(error => {
        if (cancelled) return
        const message = '录音加载失败：' + (error instanceof Error ? error.message : '网络异常')
        setFailed(message)
        onError?.(message)
      })
      .finally(() => { if (!cancelled) setLoading(false) })

    return () => {
      cancelled = true
      if (player) {
        player.pause()
        player.removeEventListener('timeupdate', onTime)
        player.removeEventListener('durationchange', onDuration)
        player.removeEventListener('loadedmetadata', onDuration)
        player.removeEventListener('play', onPlay)
        player.removeEventListener('pause', onPause)
        player.removeEventListener('ended', onEnded)
      }
      if (urlRef.current) {
        URL.revokeObjectURL(urlRef.current)
        urlRef.current = ''
      }
      audioRef.current = null
      setPlaying(false)
      setCurrent(0)
    }
    // 每条录音只加载一次；倍速变化在按钮里直接改 playbackRate，不用重载
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording?.id])

  function toggle() {
    const audio = audioRef.current
    if (!audio) return
    if (audio.paused) {
      void audio.play().catch(error => {
        const message = '录音播放失败：' + (error instanceof Error ? error.message : '浏览器拒绝了播放')
        setFailed(message)
        onError?.(message)
      })
    } else {
      audio.pause()
    }
  }

  function cycleRate() {
    const audio = audioRef.current
    const nextIndex = (PLAYBACK_RATES.indexOf(rate) + 1) % PLAYBACK_RATES.length
    const next = PLAYBACK_RATES[nextIndex] ?? 1
    setRate(next)
    if (audio) audio.playbackRate = next
  }

  function seekFromClientX(clientX: number) {
    const track = trackRef.current
    const audio = audioRef.current
    if (!track || !audio || !isFinite(audio.duration) || audio.duration <= 0) return
    const rect = track.getBoundingClientRect()
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    audio.currentTime = ratio * audio.duration
    // 拖动时立刻反馈，不等 timeupdate 事件
    setCurrent(audio.currentTime)
  }

  function onTrackPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (!audioRef.current) return
    draggingRef.current = true
    event.currentTarget.setPointerCapture(event.pointerId)
    seekFromClientX(event.clientX)
  }

  function onTrackPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (!draggingRef.current) return
    seekFromClientX(event.clientX)
  }

  function onTrackPointerUp() {
    draggingRef.current = false
  }

  function onTrackKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const audio = audioRef.current
    if (!audio || !isFinite(audio.duration)) return
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault()
      const step = event.key === 'ArrowRight' ? SKIP_SECONDS : -SKIP_SECONDS
      audio.currentTime = Math.min(audio.duration, Math.max(0, audio.currentTime + step))
      setCurrent(audio.currentTime)
    }
  }

  if (!recording) {
    return (
      <div className="recite-player recite-player--empty" role="status">
        <span aria-hidden="true">🔇</span>
        <span>暂无音频</span>
      </div>
    )
  }

  const progress = duration > 0 ? Math.min(1, current / duration) : 0
  const playable = !loading && !failed

  return (
    <div className="recite-player">
      <button
        type="button"
        className="recite-player__toggle"
        onClick={toggle}
        disabled={!playable}
        aria-label={playing ? '暂停播放' : '播放录音'}
        title={playing ? '暂停' : '播放'}
      >
        {playing ? (
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <rect x="7" y="5" width="4" height="14" rx="1" />
            <rect x="13" y="5" width="4" height="14" rx="1" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M8 5.5v13L18.5 12z" />
          </svg>
        )}
      </button>
      <div className="recite-player__main">
        <div
          ref={trackRef}
          className={'recite-player__track' + (playable ? '' : ' is-disabled')}
          role="slider"
          tabIndex={playable ? 0 : -1}
          aria-label="播放进度"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={Math.round(current)}
          aria-valuetext={fmtTime(current) + ' / ' + fmtTime(duration)}
          onPointerDown={onTrackPointerDown}
          onPointerMove={onTrackPointerMove}
          onPointerUp={onTrackPointerUp}
          onPointerCancel={onTrackPointerUp}
          onKeyDown={onTrackKeyDown}
        >
          <span className="recite-player__rail" />
          <span className="recite-player__fill" style={{ width: progress * 100 + '%' }} />
          <span className="recite-player__knob" style={{ left: progress * 100 + '%' }} />
        </div>
        <div className="recite-player__meta">
          <span className="recite-player__times">
            {loading ? '音频加载中…' : failed || fmtTime(current) + ' / ' + fmtTime(duration)}
          </span>
          <button
            type="button"
            className="recite-player__rate"
            onClick={cycleRate}
            disabled={!playable}
            aria-label={'播放倍速，当前 ' + rate + ' 倍'}
            title="点击切换倍速"
          >{rate}×</button>
        </div>
      </div>
    </div>
  )
}
