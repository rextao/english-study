import { useCallback, useEffect, useState } from 'react'

import { apiFetch } from '../utils/apiBase'
import { invalidateApiCache, queryApi } from '../utils/apiCache'

const CONFIG_URL = '/api/games/config'

/** 闯关模式的默认关卡数与每关单词数（与 worker/src/games.js 保持一致） */
export const DEFAULT_CHALLENGE_LEVELS = 3
export const DEFAULT_CHALLENGE_WORDS_PER_LEVEL = 20
export const MAX_CHALLENGE_LEVELS = 10
export const MIN_CHALLENGE_WORDS_PER_LEVEL = 3
export const MAX_CHALLENGE_WORDS_PER_LEVEL = 50

/**
 * 单词游戏的家长配置。
 * - endlessListIds / endlessWords：无尽模式与闯关模式的取词范围。
 *   listIds 空数组 = 全部学习列表（默认），words 空数组 = 范围内全部单词。
 * - challengeLevels / challengeWordsPerLevel：闯关模式的关卡数与每关单词数，默认 3 关 × 20 词。
 * 存服务端 D1，换设备也能读到。
 */
export interface GameConfig {
  endlessListIds: string[]
  endlessWords: string[]
  challengeLevels: number
  challengeWordsPerLevel: number
}

/** 读回来的值兜底：整数且不超过上下限，非法就用默认值 */
function clampInt(value: unknown, fallback: number, min: number, max: number) {
  const num = Math.floor(Number(value))
  if (!Number.isFinite(num)) return fallback
  return Math.min(max, Math.max(min, num))
}

export function useGameConfig() {
  const [config, setConfig] = useState<GameConfig>({
    endlessListIds: [],
    endlessWords: [],
    challengeLevels: DEFAULT_CHALLENGE_LEVELS,
    challengeWordsPerLevel: DEFAULT_CHALLENGE_WORDS_PER_LEVEL,
  })
  const [loading, setLoading]   = useState(true)
  const [offline, setOffline]   = useState(false)

  useEffect(() => {
    let alive = true

    async function load() {
      try {
        const data = await queryApi<GameConfig>(CONFIG_URL, {}, {
          staleTime: 5 * 60_000, tags: ['game-config'],
        })
        if (!alive) return
        setConfig({
          endlessListIds: Array.isArray(data?.endlessListIds) ? data.endlessListIds : [],
          endlessWords: Array.isArray(data?.endlessWords) ? data.endlessWords : [],
          challengeLevels: clampInt(data?.challengeLevels, DEFAULT_CHALLENGE_LEVELS, 1, MAX_CHALLENGE_LEVELS),
          challengeWordsPerLevel: clampInt(
            data?.challengeWordsPerLevel,
            DEFAULT_CHALLENGE_WORDS_PER_LEVEL,
            MIN_CHALLENGE_WORDS_PER_LEVEL,
            MAX_CHALLENGE_WORDS_PER_LEVEL,
          ),
        })
      } catch {
        if (!alive) return
        setOffline(true)
      }
      if (alive) setLoading(false)
    }

    load()
    return () => { alive = false }
  }, [])

  /** 先本地生效再写服务端；返回是否写成功 */
  const save = useCallback(async (next: GameConfig) => {
    setConfig(next)
    try {
      const response = await apiFetch(CONFIG_URL, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      })
      if (!response.ok) throw new Error('游戏配置保存失败')
      invalidateApiCache('game-config')
      setOffline(false)
      return true
    } catch {
      setOffline(true)
      return false
    }
  }, [])

  return { config, loading, offline, save }
}
