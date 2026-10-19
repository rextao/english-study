import { useState, useEffect, useCallback, useRef } from 'react'
import type { StudyMarkScope, StudyPlan, StudyReviewAction, StudyWordItem, TallyPeriodCounts } from '../types/vocab'

import { apiFetch } from '../utils/apiBase'
import { invalidateApiCache, queryApi } from '../utils/apiCache'

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

function mergePlanItems(plan: StudyPlan, listId: string, updates: StudyWordItem[]): StudyPlan {
  if (updates.length === 0) return plan
  const byKey = new Map(updates.map(item => [listId + '/' + item.word, item]))
  return {
    ...plan,
    items: plan.items.map(item => {
      const update = byKey.get(item.listId + '/' + item.word)
      return update ? { ...item, ...update, tallyCounts: item.tallyCounts } : item
    }),
  }
}

/** 计数按钮采用“先更新界面、后由服务端确认”的方式，失败时用反向增量回滚。 */
function adjustLocalTally(
  plan: StudyPlan,
  listId: string,
  words: string[],
  scope: StudyMarkScope | undefined,
  kind: TallyKind,
  delta: number,
): StudyPlan {
  const wordSet = new Set(words)
  const period = scope === 'week' ? 'week' : 'day'
  return {
    ...plan,
    items: plan.items.map(item => {
      if (item.listId !== listId || !wordSet.has(item.word)) return item
      const current: TallyPeriodCounts = item.tallyCounts ?? {
        day: { spelling: 0, reading: 0, meaning: 0 },
        week: { spelling: 0, reading: 0, meaning: 0 },
      }
      return {
        ...item,
        tallyCounts: {
          ...current,
          [period]: {
            ...current[period],
            [kind]: Math.max(0, current[period][kind] + delta),
          },
        },
      }
    }),
  }
}

/** 云端不可达时的占位，节奏与服务端 REVIEW_INTERVALS 保持一致 */
const EMPTY_PLAN: StudyPlan = {
  intervals: [1, 2, 4, 7, 15, 30, 60],
  today: startOfDay(Date.now()),
  items: [],
}

interface Reply<T> {
  ok: boolean
  data: T | null
  /** fetch 直接失败，说明云端不可达 */
  offline: boolean
}

interface PlanQuery {
  dayStart?: number
  weekStart?: number
}

async function postJson<T>(url: string, body: unknown): Promise<Reply<T>> {
  try {
    const res = await apiFetch(url, {
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
  const queryRef = useRef<PlanQuery>({})
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 挂载时那次拉取不算数据变动；之后每次 refresh 都是打卡 / 开始学习等写操作触发的

  const refresh = useCallback(async (query?: PlanQuery) => {
    if (query) queryRef.current = query
    const params = new URLSearchParams()
    const currentQuery = queryRef.current
    if (Number.isFinite(currentQuery.dayStart)) params.set('dayStart', String(currentQuery.dayStart))
    if (Number.isFinite(currentQuery.weekStart)) params.set('weekStart', String(currentQuery.weekStart))
    try {
      const suffix = params.toString()
      const data = await queryApi<StudyPlan>('/api/study/plan' + (suffix ? '?' + suffix : ''), {}, {
        staleTime: 15_000, tags: ['study-plan'],
      })
      if (data && Array.isArray(data.items)) setPlan(data)
      setOffline(false)
    } catch {
      setOffline(true)
    }
    setLoading(false)
  }, [])

  /** 连续点击只在最后一次操作后对账一次，避免每次 tally 都额外 GET 计划。 */
  const scheduleRefresh = useCallback(() => {
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current)
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null
      void refresh()
    }, 800)
  }, [refresh])

  useEffect(() => () => {
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current)
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
    if (reply.offline) return { ok: false as const, error: '云端服务不可用' }
    if (!reply.data?.ok) return { ok: false as const, error: reply.data?.error ?? '标记失败' }
    // startedAt / stage 变了，学习页要看到新排期，作废词条缓存
    invalidateApiCache(['list-words:' + listId, 'study-plan', 'achievements', 'history'])
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
    const tallyKind = action === 'tally' ? options?.successKind : undefined
    if (tallyKind) {
      // 点击后立即反馈；真正落库仍以随后成功返回的 POST 为准。
      setPlan(current => adjustLocalTally(current, listId, words, options?.scope, tallyKind, 1))
    }
    const reply = await postJson<{ ok: boolean; updated?: number; updatedWords?: string[]; items?: StudyWordItem[]; error?: string }>(
      listPath(listId) + '/review', {
        words,
        action,
        scope: options?.scope,
        successKind: options?.successKind,
        requestIds: options?.requestIds ?? (options?.requestId ? { [words[0]]: options.requestId } : undefined),
      }
    )
    if (reply.offline) {
      if (tallyKind) setPlan(current => adjustLocalTally(current, listId, words, options?.scope, tallyKind, -1))
      return { ok: false as const, error: '云端服务不可用' }
    }
    if (!reply.data?.ok) {
      if (tallyKind) setPlan(current => adjustLocalTally(current, listId, words, options?.scope, tallyKind, -1))
      return { ok: false as const, error: reply.data?.error ?? '打卡失败' }
    }
    // 计划项优先采用本次响应；服务端 item 不含周期 tally 聚合，合并时保留本地计数。
    if (Array.isArray(reply.data.items)) {
      setPlan(current => mergePlanItems(current, listId, reply.data!.items!))
    }
    invalidateApiCache(['list-words:' + listId, 'study-plan', 'achievements', 'history'])
    if (action === 'tally') {
      // POST 已经等待服务端落库；界面先显示本地计数，稍后只做一次服务端对账。
      scheduleRefresh()
      return { ok: true as const }
    }
    // done / again 改变排期：先立即提交响应中的词条，再后台对账，不阻塞按钮解锁。
    void refresh()
    return { ok: true as const }
  }, [refresh, scheduleRefresh])

  /** 撤销本周期内最近一次会拼 / 会读 / 知意：计数 -1（下限 0），永久事件同步软删 */
  const undoTally = useCallback(async (
    listId: string,
    words: string[],
    successKind: TallyKind,
    scope?: StudyMarkScope,
  ) => {
    setPlan(current => adjustLocalTally(current, listId, words, scope, successKind, -1))
    const reply = await postJson<{ ok: boolean; undone?: number; undoneWords?: string[]; items?: StudyWordItem[]; error?: string }>(
      listPath(listId) + '/tally-undo', { words, successKind, scope }
    )
    if (reply.offline) {
      setPlan(current => adjustLocalTally(current, listId, words, scope, successKind, 1))
      return { ok: false as const, error: '云端服务不可用' }
    }
    if (!reply.data?.ok) {
      setPlan(current => adjustLocalTally(current, listId, words, scope, successKind, 1))
      return { ok: false as const, error: reply.data?.error ?? '撤销失败' }
    }
    const undone = reply.data.undone ?? 0
    // 撤销同样重新按当前选中的窗口聚合，避免 day / week 两套镜像互相污染。
    invalidateApiCache(['list-words:' + listId, 'study-plan', 'achievements', 'history'])
    if (undone === 0) {
      setPlan(current => adjustLocalTally(current, listId, words, scope, successKind, 1))
    }
    scheduleRefresh()
    return { ok: true as const, undone }
  }, [refresh, scheduleRefresh])

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
    if (reply.offline) return { ok: false as const, error: '云端服务不可用' }
    if (!reply.data?.ok) return { ok: false as const, error: reply.data?.error ?? '标记失败' }
    invalidateApiCache(['list-words:' + listId, 'study-plan', 'achievements', 'history'])
    await refresh()
    return { ok: true as const }
  }, [refresh])

  const dueCount = plan.items.filter(item => item.state === 'due').length

  return { plan, loading, offline, dueCount, refresh, startWords, reviewWords, undoTally, markWords }
}
