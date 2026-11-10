import { useEffect, useRef, useState } from 'react'
import { fetchReciteRecordingAudio } from '../hooks/useRecite'
import type { ReciteRecordingSummary } from '../hooks/useRecite'
import './ReciteRecordingButton.css'

/**
 * 一次学习的课堂录音播放按钮：挂在 recite/tasks 每行「次数」下面。
 * 这一次有录音才渲染，点一下走 GET /api/recite/recordings/:id/audio（要 Bearer），
 * 整段 base64 解成 Blob URL 播放，播放完 / 离开页面自动释放。
 * 同一时间只播一条：点另一行的喇叭会把当前这条停掉。
 */

interface ActivePlayer {
  audio: HTMLAudioElement
  url: string
  /** 通知原来那个按钮回到「未播放」 */
  clear: () => void
}

let activePlayer: ActivePlayer | null = null

function stopActive() {
  const current = activePlayer
  if (!current) return
  activePlayer = null
  try {
    current.audio.pause()
  } catch {
    /* 已经停了 */
  }
  URL.revokeObjectURL(current.url)
  current.clear()
}

/** 离开页面 / 点别的行时停掉正在播的那条 */
export function stopReciteRecordingPlayback() {
  stopActive()
}

export function base64ToBlobUrl(base64: string, mime: string): string {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return URL.createObjectURL(new Blob([bytes.buffer as ArrayBuffer], { type: mime }))
}

function fmtDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return minutes > 0 ? minutes + ' 分 ' + seconds + ' 秒' : seconds + ' 秒'
}

export function ReciteRecordingButton({ recording, onError }: {
  recording: ReciteRecordingSummary
  /** 播放失败的原因交给页面顶部显示，按钮本身只留图标 */
  onError: (message: string) => void
}) {
  const [playing, setPlaying] = useState(false)
  const [loading, setLoading] = useState(false)
  const ownUrl = useRef('')

  // 卸载时只停自己那一条，别误伤别的行正在播的录音
  useEffect(() => () => {
    if (activePlayer && ownUrl.current && activePlayer.url === ownUrl.current) stopActive()
  }, [])

  async function toggle(event: React.MouseEvent) {
    // 整行可点（进入改词），点喇叭只播放，不要连带行事件
    event.stopPropagation()
    if (playing) {
      stopActive()
      return
    }
    stopActive()
    setLoading(true)
    onError('')
    try {
      const { audio, mime } = await fetchReciteRecordingAudio(recording.id)
      const url = base64ToBlobUrl(audio, mime || recording.mime || 'audio/mp4')
      const player = new Audio(url)
      ownUrl.current = url
      const clear = () => {
        setPlaying(false)
        if (ownUrl.current === url) ownUrl.current = ''
      }
      player.onended = () => {
        if (activePlayer?.audio === player) stopActive()
      }
      activePlayer = { audio: player, url, clear }
      await player.play()
      setPlaying(true)
    } catch (playError) {
      ownUrl.current = ''
      stopActive()
      onError('录音播放失败：' + (playError instanceof Error ? playError.message : '网络异常'))
    } finally {
      setLoading(false)
    }
  }

  const label = playing ? '停止播放这次课堂录音' : '播放这次课堂录音'
  return (
    <button
      type="button"
      className={'recite-audio-btn' + (playing ? ' is-playing' : '')}
      aria-label={label}
      title={label + '（' + fmtDuration(recording.durationMs) + '）'}
      disabled={loading}
      onClick={event => { void toggle(event) }}
    >
      <span aria-hidden="true">{playing ? '⏹' : '🔊'}</span>
    </button>
  )
}
