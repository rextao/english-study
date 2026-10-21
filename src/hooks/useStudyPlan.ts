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

function applyPendingTallies(plan: StudyPlan, queue: PendingTallyOperation[]): StudyPlan {
  return queue.reduce((current, operation) => adjustLocalTally(
    current,
    operation.listId,
    [operation.word],
    operation.scope,
    operation.successKind,
    (operation.action === 'tally' ? 1 : -1) * operation.count,
  ), plan)
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

interface PendingTallyOperation {
  requestId: string
  listId: string
  word: string
  action: 'tally' | 'undo'
  successKind: TallyKind
  scope?: StudyMarkScope
  count: number
}

const TALLY_QUEUE_KEY = 'es-tally-queue'

function readTallyQueue(): PendingTallyOperation[] {
  try {
    const value = JSON.parse(localStorage.getItem(TALLY_QUEUE_KEY) || '[]')
    return Array.isArray(value) ? value.filter(item => item && typeof item.requestId === 'string') : []
  } catch { return [] }
}

function writeTallyQueue(queue: PendingTallyOperation[]): void {
  try { localStorage.setItem(TALLY_QUEUE_KEY, JSON.stringify(queue)) } catch { /* 隐私模式下仍保留内存队列 */ }
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

/** 打卡 / 撤销的统一返回：成功带结果明细，失败带原因 */
type ReviewOpResult = { ok: true } | { ok: false; error: string }
type UndoOpResult = { ok: true; undone: number } | { ok: false; error: string }

export type StudyPlanApi = ReturnType<typeof useStudyPlan>

/** 艾宾浩斯复习计划：哪些词在学、今天该复习哪些、打卡与开始学习 */
export function useStudyPlan() {
  const [plan, setPlan]       = useState<StudyPlan>(EMPTY_PLAN)
  const [loading, setLoading] = useState(true)
  const [offline, setOffline] = useState(false)
  const queryRef = useRef<PlanQuery>({})
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const tallyQueueRef = useRef<PendingTallyOperation[]>([])
  const tallyFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const tallyFlushRunningRef = useRef(false)

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
      if (data && Array.isArray(data.items)) {
        setPlan(applyPendingTallies(data, tallyQueueRef.current))
      }
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
  const flushTallyQueue = useCallback(async () => {
    if (tallyFlushRunningRef.current || tallyQueueRef.current.length === 0) return
    tallyFlushRunningRef.current = true
    const firstListId = tallyQueueRef.current[0].listId
    const batch = tallyQueueRef.current.filter(item => item.listId === firstListId).slice(0, 100)
    const reply = await postJson<{ ok: boolean; processed?: string[]; error?: string }>(
      listPath(batch[0].listId) + '/tally-batch', { operations: batch },
    )
    if (reply.ok && reply.data?.ok) {
      const processed = new Set(reply.data.processed ?? batch.map(item => item.requestId))
      tallyQueueRef.current = tallyQueueRef.current.filter(item => !processed.has(item.requestId))
      writeTallyQueue(tallyQueueRef.current)
      invalidateApiCache(['study-plan', 'achievements', 'history'])
      scheduleRefresh()
    }
    tallyFlushRunningRef.current = false
    if (tallyQueueRef.current.length > 0) {
      tallyFlushTimerRef.current = setTimeout(() => {
        tallyFlushTimerRef.current = null
        void flushTallyQueue()
      }, reply.offline ? 2000 : 500)
    }
  }, [scheduleRefresh])

  const enqueueTallyOperation = useCallback((operation: Omit<PendingTallyOperation, 'requestId' | 'count'>) => {
    const last = tallyQueueRef.current[tallyQueueRef.current.length - 1]
    if (last && last.listId === operation.listId && last.word === operation.word
      && last.action === operation.action && last.successKind === operation.successKind && last.scope === operation.scope) {
      last.count += 1
    } else {
      tallyQueueRef.current.push({ ...operation, requestId: crypto.randomUUID(), count: 1 })
    }
    writeTallyQueue(tallyQueueRef.current)
    if (tallyFlushTimerRef.current) clearTimeout(tallyFlushTimerRef.current)
    tallyFlushTimerRef.current = setTimeout(() => {
      tallyFlushTimerRef.current = null
      void flushTallyQueue()
    }, 350)
  }, [flushTallyQueue])

  useEffect(() => {
    tallyQueueRef.current = readTallyQueue()
    if (tallyQueueRef.current.length > 0) void flushTallyQueue()
    return () => {
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current)
    if (tallyFlushTimerRef.current) clearTimeout(tallyFlushTimerRef.current)
    }
  }, [flushTallyQueue])

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
  ): Promise<ReviewOpResult> => {
    const tallyKind = action === 'tally' ? options?.successKind : undefined
    if (tallyKind) {
      // 点击后立即反馈（本地 +1），落库请求排进串行链后台执行，调用方不用等网络；
      // 失败时回滚本地计数并把错误带回给调用方提示。
      setPlan(current => adjustLocalTally(current, listId, words, options?.scope, tallyKind, 1))
      enqueueTallyOperation({ listId, word: words[0], action: 'tally', successKind: tallyKind, scope: options?.scope })
      return Promise.resolve({ ok: true as const })
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
      return { ok: false as const, error: '云端服务不可用' }
    }
    if (!reply.data?.ok) {
      return { ok: false as const, error: reply.data?.error ?? '打卡失败' }
    }
    // done / again 改变排期：先立即提交响应中的词条，再后台对账，不阻塞按钮解锁。
    if (Array.isArray(reply.data.items)) {
      setPlan(current => mergePlanItems(current, listId, reply.data!.items!))
    }
    invalidateApiCache(['list-words:' + listId, 'study-plan', 'achievements', 'history'])
    void refresh()
    return { ok: true as const }
  }, [enqueueTallyOperation, refresh])

  /** 撤销本周期内最近一次会拼 / 会读 / 知意：计数 -1（下限 0），永久事件同步软删。
   *  与 tally 一样乐观生效、排队落库；撤销没有可撤记录时由对账刷新纠正显示。 */
  const undoTally = useCallback(async (
    listId: string,
    words: string[],
    successKind: TallyKind,
    scope?: StudyMarkScope,
  ): Promise<UndoOpResult> => {
    setPlan(current => adjustLocalTally(current, listId, words, scope, successKind, -1))
    enqueueTallyOperation({ listId, word: words[0], action: 'undo', successKind, scope })
    return Promise.resolve({ ok: true as const, undone: 1 })
  }, [enqueueTallyOperation])

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
