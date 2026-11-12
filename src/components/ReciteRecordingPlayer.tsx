import { useEffect, useRef, useState } from 'react'
import { useReciteRecordingPlayback } from '../hooks/useReciteRecordingPlayback'
import type { RecordingGroup } from '../utils/reciteRecordings'
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
 * 组里可能有多段（关页面 / 切后台各停过一次）：能拼就按顺序连着播，进度条按整条算；
 * 顺序不可信时也按组内顺序播，但组外面会用分段按钮提示「没有合并」。
 * 抽屉关闭即卸载：自动停掉播放并释放 Blob URL。
 */
export function ReciteRecordingPlayer({ group, onError }: {
  group?: RecordingGroup
  /** 拉取 / 播放失败的原因交给外层（抽屉顶部提示），组件内也会就地显示 */
  onError?: (message: string) => void
}) {
  const playback = useReciteRecordingPlayback(group ?? null)
  const [rate, setRate] = useState(1)
  const trackRef = useRef<HTMLDivElement | null>(null)
  const draggingRef = useRef(false)

  // 失败原因往上传一次（抽屉顶部显示），不在渲染里调，避免重复渲染
  useEffect(() => {
    if (!playback.failed) return
    onError?.('录音加载失败：' + playback.failed)
    // onError 只是往外的提示通道，变化不需要重播
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playback.failed])

  if (!group || group.segments.length === 0) {
    return (
      <div className="recite-player recite-player--empty" role="status">
        <span aria-hidden="true">🔇</span>
        <span>暂无音频</span>
      </div>
    )
  }

  const duration = Math.max(0, playback.duration)
  const current = Math.min(duration, Math.max(0, playback.current))
  const progress = duration > 0 ? Math.min(1, current / duration) : 0
  const playable = !playback.loading && !playback.failed
  const segmentCount = group.segments.length

  function cycleRate() {
    const nextIndex = (PLAYBACK_RATES.indexOf(rate) + 1) % PLAYBACK_RATES.length
    const next = PLAYBACK_RATES[nextIndex] ?? 1
    setRate(next)
    playback.setRate(next)
  }

  function seekFromClientX(clientX: number) {
    const track = trackRef.current
    if (!track || duration <= 0) return
    const rect = track.getBoundingClientRect()
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    playback.seek(ratio * duration)
  }

  function onTrackPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (!playable) return
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
    if (!playable) return
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault()
      const step = event.key === 'ArrowRight' ? SKIP_SECONDS : -SKIP_SECONDS
      playback.seek(current + step)
    }
  }

  const meta = playback.loading
    ? '音频加载中…'
    : playback.failed
      ? playback.failed
      : fmtTime(current) + ' / ' + fmtTime(duration) + (segmentCount > 1 ? ' · 第 ' + (playback.segmentIndex + 1) + '/' + segmentCount + ' 段' : '')

  return (
    <div className="recite-player">
      <button
        type="button"
        className="recite-player__toggle"
        onClick={() => playback.toggle()}
        disabled={!playable}
        aria-label={playback.playing ? '暂停播放' : '播放录音'}
        title={playback.playing ? '暂停' : '播放'}
      >
        {playback.playing ? (
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
          <span className="recite-player__times">{meta}</span>
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
