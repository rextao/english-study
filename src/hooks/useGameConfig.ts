import { useCallback, useEffect, useState } from 'react'

import { apiFetch } from '../utils/apiBase'
import { invalidateApiCache, queryApi } from '../utils/apiCache'

const CONFIG_URL = '/api/games/config'

/**
 * 单词游戏的家长配置：无尽模式的取词范围。
 * - endlessListIds：勾选的学习列表，空数组 = 全部学习列表（默认）
 * - endlessWords：再缩小到具体单词，空数组 = 范围内全部单词
 * 存服务端 D1，换设备也能读到。
 */
export interface GameConfig {
  endlessListIds: string[]
  endlessWords: string[]
}

export function useGameConfig() {
  const [config, setConfig]     = useState<GameConfig>({ endlessListIds: [], endlessWords: [] })
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
