import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'

import { speak, stopSpeech } from '../utils/speech'

/**
 * sound.tsx — 游戏的单词发音开关（所有游戏共用）。
 *
 * - 默认打开，偏好存在 localStorage（es-games-sound），刷新 / 换游戏都保留；
 * - 开关按钮由游戏外壳渲染在右上角（GameSoundToggle），游戏组件不用自己画；
 * - 游戏里点英文单词时调 speakWord(text)，关掉开关就静音，不会拦住任何操作；
 * - 发音走 utils/speech 的 speak()（/api/tts，Google 合成，同一个词会话内只取一次）。
 */

const STORAGE_KEY = 'es-games-sound'

export interface GameSoundApi {
  /** 喇叭是否打开 */
  enabled: boolean
  setEnabled: (on: boolean) => void
  toggle: () => void
  /** 播一个英文单词；喇叭关着时什么都不做，失败也不打断游戏 */
  speakWord: (word: string) => void
}

/** 没有 Provider 时（比如单独预览某个游戏）也不能崩，直接静音 */
const FALLBACK: GameSoundApi = {
  enabled: false,
  setEnabled: () => {},
  toggle: () => {},
  speakWord: () => {},
}

const GameSoundContext = createContext<GameSoundApi>(FALLBACK)

function readStored(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) !== 'off'
  } catch {
    return true
  }
}

export function GameSoundProvider({ children }: { children: ReactNode }) {
  const [enabled, setEnabledState] = useState(readStored)

  const setEnabled = useCallback((on: boolean) => {
    setEnabledState(on)
    try { window.localStorage.setItem(STORAGE_KEY, on ? 'on' : 'off') } catch { /* 隐私模式写不进去，仅本次生效 */ }
    if (!on) stopSpeech()
  }, [])

  const toggle = useCallback(() => setEnabled(!enabled), [enabled, setEnabled])

  const speakWord = useCallback((word: string) => {
    if (!enabled) return
    const text = word.trim()
    if (!text) return
    // 点得快时上一次合成可能还没回来；speak 自己会掐掉上一条
    void speak(text).catch(() => { /* 发音失败不影响游戏，页面不做提示 */ })
  }, [enabled])

  // 离开游戏页时把还没播完的声音停掉
  useEffect(() => () => stopSpeech(), [])

  const value = useMemo<GameSoundApi>(
    () => ({ enabled, setEnabled, toggle, speakWord }),
    [enabled, setEnabled, toggle, speakWord],
  )

  return <GameSoundContext.Provider value={value}>{children}</GameSoundContext.Provider>
}

export function useGameSound(): GameSoundApi {
  return useContext(GameSoundContext)
}

/** 外壳右上角的喇叭开关：开 = 有波纹，关 = 打叉 */
export function GameSoundToggle() {
  const { enabled, toggle } = useGameSound()
  const label = enabled ? '关闭单词发音' : '打开单词发音'

  return (
    <button
      type="button"
      className={'games__sound' + (enabled ? '' : ' is-off')}
      aria-pressed={enabled}
      aria-label={label}
      title={label}
      onClick={toggle}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M4 9.5h3.2L12 5.6v12.8L7.2 14.5H4z" fill="currentColor" stroke="none" />
        {enabled ? (
          <>
            <path d="M15.4 8.6a4.6 4.6 0 0 1 0 6.8" />
            <path d="M17.9 6.1a8.2 8.2 0 0 1 0 11.8" />
          </>
        ) : (
          <path d="M15.4 9.4l4.6 5.2M20 9.4l-4.6 5.2" />
        )}
      </svg>
    </button>
  )
}
