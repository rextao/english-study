import { useCallback, useEffect, useRef } from 'react'

import { apiFetch } from '../utils/apiBase'
import { invalidateApiCache } from '../utils/apiCache'
import type { GameWordOutcome } from './types'

/**
 * 游戏结果的统一记录能力（以后新增的游戏直接调 recordWord 就有错词统计）。
 *
 * 游戏在配对成功 / 配错时把一个单词交上来，这里先攒着，1.5 秒一批 POST
 * /api/games/results，避免每点一下都打一次接口。攒满 / 换游戏 / 离开页面
 * 都会立刻冲一次；提交失败不提示、不打断游戏，只是这一批丢了。
 */

interface PendingResult {
  word: string
  translation?: string
  outcome: GameWordOutcome
}

const FLUSH_DELAY_MS = 1500
/** 还没送出去的结果上限：超过就先冲一批 */
const MAX_PENDING = 120

export interface GameRecorder {
  record: (word: string, outcome: GameWordOutcome, translation?: string) => void
  /** 立刻把攒着的送出去（切换模式 / 离开页面时自动调） */
  flush: () => void
}

export function useGameRecorder(gameId: string, mode: string): GameRecorder {
  const pending = useRef<PendingResult[]>([])
  const timer = useRef<number | null>(null)

  const flush = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current)
      timer.current = null
    }
    const batch = pending.current
    pending.current = []
    if (batch.length === 0 || !gameId) return
    void apiFetch('/api/games/results', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gameId, mode, results: batch }),
    })
      .then(response => {
        // 设置页「游戏记录」读的是共享缓存，写成功后作废一次
        if (response.ok) invalidateApiCache('game-results')
      })
      .catch(() => { /* 记不上不影响游戏 */ })
  }, [gameId, mode])

  const record = useCallback((word: string, outcome: GameWordOutcome, translation?: string) => {
    const text = word.trim()
    if (!text) return
    pending.current.push({ word: text, translation, outcome })
    if (pending.current.length >= MAX_PENDING) {
      flush()
      return
    }
    if (timer.current !== null) return
    timer.current = window.setTimeout(() => {
      timer.current = null
      flush()
    }, FLUSH_DELAY_MS)
  }, [flush])

  // 换游戏 / 换模式 / 卸载：把上一个游戏攒着的结果先送出去
  useEffect(() => flush, [flush])

  // 关页面 / 切到后台：浏览器不保证还能发请求，但至少给一次机会
  useEffect(() => {
    const onHide = () => flush()
    window.addEventListener('pagehide', onHide)
    return () => window.removeEventListener('pagehide', onHide)
  }, [flush])

  return { record, flush }
}
