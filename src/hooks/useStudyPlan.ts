import { useState, useEffect, useCallback } from 'react'
import type { StudyMarkScope, StudyPlan, StudyReviewAction } from '../types/vocab'

const SERVER = 'http://127.0.0.1:3456'

/** done 进入下一轮 / again 没记住 / stop 退出学习 / tally 熟悉度计数 */
export type ReviewAction = StudyReviewAction
export type PureMarkAction = 'spelling'

/** 熟悉度计数维度：tally 打卡时必传其一，只累计次数、不动排期 */
export type TallyKind = 'spelling' | 'reading' | 'meaning'

export interface ReviewOptions {
  scope?: StudyMarkScope
  /** tally 打卡的计数维度：会拼 / 会读 / 知意，各自只累计自己的次数。 */
  successKind?: TallyKind
  /** 客户端为一次复习任务生成的幂等键。 */
  requestId?: string
  /** 批量复习时为每个词传入独立的幂等键。 */
  requestIds?: Record<string, string>
}

function startOfDay(ts: number): number {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** 本地服务没起时的占位，节奏与服务端 REVIEW_INTERVALS 保持一致 */
const EMPTY_PLAN: StudyPlan = {
  intervals: [1, 2, 4, 7, 15, 30, 60],
  today: startOfDay(Date.now()),
  items: [],
}

interface Reply<T> {
  ok: boolean
  data: T | null
  /** fetch 直接失败，说明本地服务没起 */
  offline: boolean
}

async function postJson<T>(url: string, body: unknown): Promise<Reply<T>> {
  try {
    const res = await fetch(SERVER + url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    let data: T | null = null
    try { data = await res.json() as T } catch { /* 非 JSON 响应 */ }
    return { ok: res.ok, data, offline: false }
  } catch {
    return { ok: false, data: null, offline: true }
  }
}

const listPath = (listId: string) => '/api/lists/' + encodeURIComponent(listId)

export type StudyPlanApi = ReturnType<typeof useStudyPlan>

/** 艾宾浩斯复习计划：哪些词在学、今天该复习哪些、打卡与开始学习 */
export function useStudyPlan() {
  const [plan, setPlan]       = useState<StudyPlan>(EMPTY_PLAN)
  const [loading, setLoading] = useState(true)
  const [offline, setOffline] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const res  = await fetch(SERVER + '/api/study/plan')
      const data = await res.json() as StudyPlan
      if (data && Array.isArray(data.items)) setPlan(data)
      setOffline(false)
    } catch {
      setOffline(true)
    }
    setLoading(false)
  }, [])

  useEffect(() => { refresh() }, [refresh])

  /** 把一批词标记为开始学习，startedAt 缺省用服务端当前时间 */
  const startWords = useCallback(async (
    listId: string,
    words: string[],
    startedAt?: number,
    scope?: StudyMarkScope,
  ) => {
    const reply = await postJson<{ ok: boolean; started: number; skipped: number; error?: string }>(
      listPath(listId) + '/start', { words, startedAt, scope }
    )
    if (reply.offline) return { ok: false as const, error: '本地服务未启动' }
    if (!reply.data?.ok) return { ok: false as const, error: reply.data?.error ?? '标记失败' }
    await refresh()
    return { ok: true as const, started: reply.data.started, skipped: reply.data.skipped }
  }, [refresh])

  /** 复习打卡 */
  const reviewWords = useCallback(async (
    listId: string,
    words: string[],
    action: ReviewAction,
    options?: ReviewOptions,
  ) => {
    const reply = await postJson<{ ok: boolean; error?: string }>(
      listPath(listId) + '/review', {
        words,
        action,
        scope: options?.scope,
        successKind: options?.successKind,
        requestIds: options?.requestIds ?? (options?.requestId ? { [words[0]]: options.requestId } : undefined),
      }
    )
    if (reply.offline) return { ok: false as const, error: '本地服务未启动' }
    if (!reply.data?.ok) return { ok: false as const, error: reply.data?.error ?? '打卡失败' }
    await refresh()
    return { ok: true as const }
  }, [refresh])

  /** 撤销本周期内最近一次会拼 / 会读 / 知意：计数 -1（下限 0），永久事件同步软删 */
  const undoTally = useCallback(async (
    listId: string,
    words: string[],
    successKind: TallyKind,
    scope?: StudyMarkScope,
  ) => {
    const reply = await postJson<{ ok: boolean; undone?: number; error?: string }>(
      listPath(listId) + '/tally-undo', { words, successKind, scope }
    )
    if (reply.offline) return { ok: false as const, error: '本地服务未启动' }
    if (!reply.data?.ok) return { ok: false as const, error: reply.data?.error ?? '撤销失败' }
    await refresh()
    return { ok: true as const, undone: reply.data.undone ?? 0 }
  }, [refresh])

  /** 兼容性的纯标记原语：不改变复习轮次；当前“会拼”复习不走这里。 */
  const markWords = useCallback(async (
    listId: string,
    words: string[],
    action: PureMarkAction,
    scope?: StudyMarkScope,
  ) => {
    const reply = await postJson<{ ok: boolean; error?: string }>(
      listPath(listId) + '/mark', { words, action, scope }
    )
    if (reply.offline) return { ok: false as const, error: '本地服务未启动' }
    if (!reply.data?.ok) return { ok: false as const, error: reply.data?.error ?? '标记失败' }
    await refresh()
    return { ok: true as const }
  }, [refresh])

  const dueCount = plan.items.filter(item => item.state === 'due').length

  return { plan, loading, offline, dueCount, refresh, startWords, reviewWords, undoTally, markWords }
}
