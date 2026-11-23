import { useCallback, useEffect, useState } from 'react'

import { queryApi } from '../utils/apiCache'

/**
 * 游戏记录：GET /api/games/results 返回最近 N 天按「日期 + 单词」聚合的结果，
 * 每个词带配对正确次数、配错次数，以及是在哪些游戏里出现的。
 * 数据由游戏外壳（src/games/record.ts）在玩的过程中批量上报。
 */
export interface GameResultWord {
  /** 配置时区下的日期 YYYY-MM-DD */
  day: string
  /** 小写统计键 */
  word: string
  /** 上报时的原始写法，展示用 */
  display: string
  translation: string
  correct: number
  wrong: number
  lastAt: number
  /** 出过这个词的游戏 id */
  games: string[]
}

interface GameResultsResponse {
  results: GameResultWord[]
}

export function useGameResults(days = 30) {
  const [rows, setRows] = useState<GameResultWord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [version, setVersion] = useState(0)
  const reload = useCallback(() => setVersion(current => current + 1), [])

  useEffect(() => {
    let alive = true
    setLoading(true)
    setError(null)
    queryApi<GameResultsResponse>('/api/games/results?days=' + days, {}, {
      staleTime: 30_000, tags: ['game-results'],
    })
      .then(body => {
        if (!alive) return
        if (!Array.isArray(body.results)) throw new Error('游戏记录数据格式不正确')
        setRows(body.results)
        setLoading(false)
      })
      .catch(loadError => {
        if (!alive) return
        setRows([])
        setError(loadError instanceof Error ? loadError.message : '游戏记录读取失败')
        setLoading(false)
      })
    return () => { alive = false }
  }, [days, version])

  return { rows, loading, error, reload }
}
