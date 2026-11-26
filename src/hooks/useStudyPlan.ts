import { useState, useEffect, useCallback, useRef } from 'react'
import type { StudyMarkScope, StudyPlan, StudyReviewAction, StudyWordItem, TallyPeriodCounts } from '../types/vocab'

import { apiFetch } from '../utils/apiBase'
import { invalidateApiCache, queryApi } from '../utils/apiCache'
import { enqueueTally, pendingTallyOperations, resumeTallyQueue, subscribeTallyResults } from '../utils/tallyQueue'
import type { PendingTallyOperation, TallyKind } from '../utils/tallyQueue'

/** done 进入下一轮 / again 没记住 / stop 退出学习 / tally 熟悉度计数 */
export type ReviewAction = StudyReviewAction
export type PureMarkAction = 'spelling'

/** 熟悉度计数维度：tally 打卡时必传其一，只累计次数、不动排期 */
export type { TallyKind } from '../utils/tallyQueue'

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

/** 拉回服务端计划后，把队列里还没落库的计次重新叠上去 */
function applyPendingTallies(plan: StudyPlan, operations: PendingTallyOperation[]): StudyPlan {
  return operations.reduce((current, operation) => operation.listId
    ? adjustLocalTally(
      current,
      operation.listId,
      [operation.word],
      operation.scope,
      operation.successKind,
      (operation.action === 'tally' ? 1 : -1) * operation.count,
    )
    : current, plan)
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
        setPlan(applyPendingTallies(data, pendingTallyOperations()))
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

  /** 恢复暂时移出计划的词，只清除隐藏标记，不重置记忆曲线。 */
  const resumeWords = useCallback(async (listId: string, words: string[]) => {
    const reply = await postJson<{ ok: boolean; resumed?: number; error?: string }>(
      listPath(listId) + '/resume', { words },
    )
    if (reply.offline) return { ok: false as const, error: '云端服务不可用' }
    if (!reply.data?.ok) return { ok: false as const, error: reply.data?.error ?? '恢复失败' }
    invalidateApiCache(['list-words:' + listId, 'study-plan', 'achievements', 'history'])
    await refresh()
    return { ok: true as const, resumed: reply.data.resumed ?? 0 }
  }, [refresh])

  /** 暂时移出计划，不改变学习统计和记忆曲线。 */
  const suspendWords = useCallback(async (listId: string, words: string[]) => {
    const reply = await postJson<{ ok: boolean; suspended?: number; error?: string }>(
      listPath(listId) + '/suspend', { words },
    )
    if (reply.offline) return { ok: false as const, error: '云端服务不可用' }
    if (!reply.data?.ok) return { ok: false as const, error: reply.data?.error ?? '暂时移出失败' }
    invalidateApiCache(['list-words:' + listId, 'study-plan', 'achievements', 'history'])
    await refresh()
    return { ok: true as const, suspended: reply.data.suspended ?? 0 }
  }, [refresh])

  // 计次队列是模块级单例（与学习成果页共用）：这一批落在列表上之后才对账计划
  useEffect(() => subscribeTallyResults(results => {
    if (results.some(result => result.ok && result.listId)) scheduleRefresh()
  }), [scheduleRefresh])

  // 上次没传上去的计次继续补传；卸载时只清本 hook 自己的对账定时器
  useEffect(() => {
    resumeTallyQueue()
    return () => {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current)
    }
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
  ): Promise<ReviewOpResult> => {
    const tallyKind = action === 'tally' ? options?.successKind : undefined
    if (tallyKind) {
      // 点击后立即反馈（本地 +1），落库交给共享的计次队列后台合并 / 重试，调用方不用等网络。
      setPlan(current => adjustLocalTally(current, listId, words, options?.scope, tallyKind, 1))
      enqueueTally({ listId, word: words[0], kind: tallyKind, delta: 1, scope: options?.scope })
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
  }, [refresh])

  /** 撤销本周期内最近一次会拼 / 会读 / 知意：计数 -1（下限 0），永久事件同步软删。
   *  与 tally 一样乐观生效、队列落库；撤销没有可撤记录时由对账刷新纠正显示。 */
  const undoTally = useCallback(async (
    listId: string,
    words: string[],
    successKind: TallyKind,
    scope?: StudyMarkScope,
  ): Promise<UndoOpResult> => {
    setPlan(current => adjustLocalTally(current, listId, words, scope, successKind, -1))
    enqueueTally({ listId, word: words[0], kind: successKind, delta: -1, scope })
    return Promise.resolve({ ok: true as const, undone: 1 })
  }, [])

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

  return { plan, loading, offline, dueCount, refresh, startWords, resumeWords, suspendWords, reviewWords, undoTally, markWords }
}
