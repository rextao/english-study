/**
 * SpeakerButton.tsx — 音标旁的小喇叭按钮。
 *
 * 学习列表每条词条的音标后面挂一个：点一下走 utils/speech 的 speak()
 * 播放 Google TTS 发音（同一个词会话内只合成一次），加载中图标转圈，
 * 失败把原因翻成中文回调给页面提示条。
 * 多选模式下喇叭长在勾选框的 label 里，onClick 要拦掉默认行为和冒泡，
 * 免得点喇叭顺手把这一行勾上。
 */

import { useState } from 'react'
import type { MouseEvent } from 'react'
import { speak, speechErrorMessage } from '../utils/speech'
import './SpeakerButton.css'

interface SpeakerButtonProps {
  /** 要朗读的文本：单词原形，或句子用展示文本 */
  text: string
  /** 无障碍标签里显示的名字，默认用 text */
  label?: string
  /** 播放失败时回调，参数是已翻成中文的一句话 */
  onError?: (message: string) => void
}

export function SpeakerButton({ text, label, onError }: SpeakerButtonProps) {
  const [busy, setBusy] = useState(false)
  const name = label || text

  async function handleClick(event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault()
    event.stopPropagation()
    if (busy) return
    setBusy(true)
    try {
      await speak(text)
    } catch (error) {
      onError?.(speechErrorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      type="button"
      className={'word-row__speak' + (busy ? ' word-row__speak--busy' : '')}
      onClick={handleClick}
      disabled={busy}
      aria-label={'播放「' + name + '」的发音'}
      title={'播放「' + name + '」的发音'}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M4 9.5h3.2L12 5.6v12.8L7.2 14.5H4z" />
        <path d="M15.4 8.6a4.6 4.6 0 0 1 0 6.8" />
        <path d="M17.9 6.1a8.2 8.2 0 0 1 0 11.8" />
      </svg>
    </button>
  )
}
