import { useEffect, useMemo } from 'react'
import { useReciteRecordingPlayback } from '../hooks/useReciteRecordingPlayback'
import { buildRecordingGroup, fmtRecordingDuration } from '../utils/reciteRecordings'
import type { RecordingGroup } from '../utils/reciteRecordings'
import type { ReciteRecordingSummary } from '../hooks/useRecite'
import './ReciteRecordingButton.css'

/**
 * 一次学习的课堂录音播放按钮：挂在 recite/tasks 每行「次数」下面。
 *
 * 这一次学习可能因为关页面 / 切后台录成好几段，这里把同一会话的片段当成一条：
 * 顺序可信（序号与录制时间一致）就一个按钮连着播完；不可信就不合并，分段各给一个按钮，
 * 绝不把时间顺序拼错。播放仍然走 GET /api/recite/recordings/:id/audio（要 Bearer）。
 * 同一时间只播一条：点另一个按钮会把当前这条停掉。
 */

function AudioButton({ group, onError, title }: {
  group: RecordingGroup
  /** 播放失败的原因交给页面顶部显示，按钮本身只留图标 */
  onError: (message: string) => void
  /** 悬停提示：单条时说时长，多段时说明是第几段 */
  title: string
}) {
  const playback = useReciteRecordingPlayback(group)

  useEffect(() => {
    if (!playback.failed) return
    onError('录音播放失败：' + playback.failed)
    // onError 只是往外抛提示，不需要触发重播
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playback.failed])

  const label = playback.playing ? '停止播放这次课堂录音' : '播放这次课堂录音'
  return (
    <button
      type="button"
      className={'recite-audio-btn' + (playback.playing ? ' is-playing' : '')}
      aria-label={label}
      title={label + '（' + title + '）'}
      disabled={playback.loading}
      onClick={event => {
        // 整行可点（进入改词），点喇叭只播放，不要连带行事件
        event.stopPropagation()
        playback.toggle()
      }}
    >
      <span aria-hidden="true">{playback.playing ? '⏹' : '🔊'}</span>
    </button>
  )
}

function SingleSegmentButton({ recording, onError }: {
  recording: ReciteRecordingSummary
  onError: (message: string) => void
}) {
  const group = useMemo(() => buildRecordingGroup([recording]), [recording])
  return <AudioButton group={group} onError={onError} title={fmtRecordingDuration(recording.durationMs)} />
}

export function ReciteRecordingButton({ group, onError }: {
  group: RecordingGroup
  /** 播放失败的原因交给页面顶部显示，按钮本身只留图标 */
  onError: (message: string) => void
}) {
  const { segments, merged, durationMs } = group
  if (segments.length === 0) return null
  if (merged || segments.length === 1) {
    return <AudioButton group={group} onError={onError} title={fmtRecordingDuration(durationMs)} />
  }
  // 顺序无法可靠判定：不合并，一段一个按钮，各自播自己的
  return (
    <span className="recite-audio-group" title="这几段录音的顺序无法确定，没有合并">
      {segments.map(segment => (
        <SingleSegmentButton
          key={segment.id}
          recording={segment}
          onError={onError}
        />
      ))}
    </span>
  )
}
