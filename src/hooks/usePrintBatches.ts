import { useState, useEffect, useCallback } from 'react'
import type { PrintBatch, StudyMarkScope, StudyReviewAction } from '../types/vocab'

const SERVER = 'http://127.0.0.1:3456'
const BASE = SERVER + '/api/print-batches'

/** 记一次卡片导出。一批词可能跨列表（复习计划里的词就是），所以按列表分组传 */
export interface PrintRecordInput {
  title: string
  /** start = 挑新词 / review = 复习计划 / custom = 自由挑选打印 */
  kind: 'start' | 'review' | 'custom'
  /** 打印时的粒度，整批打卡默认沿用它 */
  scope?: StudyMarkScope
  /** 缺省用服务端当前时间；挑新词时传开始学习时间，和卡片上印的对齐 */
  printedAt?: number
  groups: { listId: string; words: string[] }[]
}

export interface PrintReviewOptions {
  scope?: StudyMarkScope
  /** 这一周的最后一毫秒；不传服务端按 scope 自己算 */
  through?: number
  /** 批次内每个词独立的复习任务幂等键。 */
  requestIds?: Record<string, string>
}

type Result = { ok: true } | { ok: false; error: string }

/** 三个写操作的公共壳子：fetch 抛错就当本地服务没起 */
async function send(url: string, method: string, body?: unknown): Promise<Result> {
  try {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    let data: { ok?: boolean; error?: string } | null = null
    try { data = await res.json() as { ok?: boolean; error?: string } } catch { /* 非 JSON 响应 */ }
    if (!res.ok || data?.ok !== true) return { ok: false, error: data?.error ?? '操作失败' }
    return { ok: true }
  } catch {
    return { ok: false, error: '本地服务未启动' }
  }
}

export type PrintBatchesApi = ReturnType<typeof usePrintBatches>

/**
 * 打印批次：每导出一次卡片就留一条档，过一段时间（比如一周后）
 * 拿着那批卡片回来，可以照批次整批打卡。
 */
export function usePrintBatches() {
  const [batches, setBatches] = useState<PrintBatch[]>([])
  const [loading, setLoading] = useState(true)
  const [offline, setOffline] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const res  = await fetch(BASE)
      const data = await res.json() as { batches?: PrintBatch[] }
      if (Array.isArray(data?.batches)) setBatches(data.batches)
      setOffline(false)
    } catch {
      setOffline(true)
    }
    setLoading(false)
  }, [])

  useEffect(() => { refresh() }, [refresh])

  /** 留档。空的分组先滤掉，免得服务端记出一条 0 词的记录 */
  const record = useCallback(async (input: PrintRecordInput): Promise<Result> => {
    const groups = input.groups.filter(group => group.listId && group.words.length > 0)
    if (groups.length === 0) return { ok: false, error: '没有要记录的词' }
    const res = await send(BASE, 'POST', {
      title: input.title,
      kind: input.kind,
      scope: input.scope,
      printedAt: input.printedAt,
      groups,
    })
    if (res.ok) await refresh()
    return res
  }, [refresh])

  /** 整批打卡：scope 不传服务端就沿用打印时的粒度 */
  const reviewBatch = useCallback(async (
    id: string,
    action: StudyReviewAction,
    options?: PrintReviewOptions,
  ): Promise<Result> => {
    const res = await send(BASE + '/' + encodeURIComponent(id) + '/review', 'POST', {
      action,
      scope: options?.scope,
      through: options?.through,
      requestIds: options?.requestIds,
    })
    if (res.ok) await refresh()
    return res
  }, [refresh])

  /** 只删这条记录，词的学习进度不动 */
  const removeBatch = useCallback(async (id: string): Promise<Result> => {
    const res = await send(BASE + '/' + encodeURIComponent(id), 'DELETE')
    if (res.ok) await refresh()
    return res
  }, [refresh])

  return { batches, loading, offline, refresh, record, reviewBatch, removeBatch }
}
