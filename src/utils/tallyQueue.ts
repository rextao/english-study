import type { StudyMarkScope } from '../types/vocab'

import { apiFetch } from './apiBase'
import { invalidateApiCache } from './apiCache'

/**
 * 熟悉度计次（会拼 / 会读 / 知意）的统一前端队列。
 *
 * 学习页和成果页加减的是同一份永久事件账本，只是落库入口不同：
 * 带 listId 的走 POST /api/lists/:id/tally-batch（撤销限制在本周期内），
 * 不带 listId 的走 PATCH /api/study/achievements/:word（成果页人工修正，撤销最近一条）。
 *
 * 队列是模块级单例：两个页面共用同一条队列和同一个 flush 循环，
 * 不会出现各刷各的、同一批点击被拆成多次请求的情况。
 */

/** 计数维度：与 TallyCounter、服务端 tally 维度一致 */
export type TallyKind = 'spelling' | 'reading' | 'meaning'

type TallyAction = 'tally' | 'undo'

/** 一次计次请求：delta 1 = 加一次，-1 = 减一次 */
export interface TallyRequest {
  word: string
  kind: TallyKind
  delta: 1 | -1
  /** 学习页有列表；成果页的人工修正没有列表 */
  listId?: string
  /** 只有带 listId 的撤销才按周期（按天 / 按周）限制范围 */
  scope?: StudyMarkScope
  /** 失败提示里显示的文本（句子用原句） */
  displayText?: string
}

export interface PendingTallyOperation {
  requestId: string
  word: string
  action: TallyAction
  successKind: TallyKind
  count: number
  listId?: string
  scope?: StudyMarkScope
  displayText?: string
}

export interface TallyResult {
  word: string
  displayText?: string
  listId?: string
  ok: boolean
  error?: string
}

const QUEUE_KEY = 'es-tally-queue'
/** 连点合并后的落库延迟 */
const FLUSH_DELAY = 350
/** 云端不可达时的重试间隔 */
const RETRY_DELAY = 2000
/** 同一批里还有别的列表 / 别的词时，接着处理下一轮的间隔 */
const NEXT_ROUND_DELAY = 500
/** 同一条操作连续被服务端拒绝几次后丢弃，避免死循环重试 */
const MAX_ATTEMPTS = 3

let operations: PendingTallyOperation[] | null = null
let flushTimer: ReturnType<typeof setTimeout> | null = null
let running = false
let failedAttempts = 0
const listeners = new Set<(results: TallyResult[]) => void>()

function readQueue(): PendingTallyOperation[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]')
    return Array.isArray(value)
      ? value.filter(item => item && typeof item.requestId === 'string' && typeof item.word === 'string')
      : []
  } catch { return [] }
}

function persist(): void {
  try { localStorage.setItem(QUEUE_KEY, JSON.stringify(operations ?? [])) } catch { /* 隐私模式下仍保留内存队列 */ }
}

function queue(): PendingTallyOperation[] {
  if (!operations) operations = readQueue()
  return operations
}

function removeOperations(predicate: (operation: PendingTallyOperation) => boolean): void {
  operations = queue().filter(operation => !predicate(operation))
  persist()
}

/** 队列快照：学习页拉回服务端计划后，要把还没落库的计次重新叠上去 */
export function pendingTallyOperations(): PendingTallyOperation[] {
  return queue().slice()
}

/** 订阅每一轮落库的结果；返回取消订阅函数 */
export function subscribeTallyResults(listener: (results: TallyResult[]) => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

function scheduleFlush(delay: number): void {
  if (flushTimer) clearTimeout(flushTimer)
  flushTimer = setTimeout(() => {
    flushTimer = null
    void flushTallyQueue()
  }, delay)
}

function notify(results: TallyResult[]): void {
  if (results.length === 0) return
  for (const listener of listeners) listener(results)
}

interface Reply<T> {
  ok: boolean
  data: T | null
  offline: boolean
}

async function sendJson<T>(url: string, method: 'POST' | 'PATCH', body: unknown): Promise<Reply<T>> {
  try {
    const res = await apiFetch(url, {
      method,
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

/** 一次 ±1 计次入队：与上一条完全相同的操作合并，连点只发一次请求 */
export function enqueueTally(request: TallyRequest): void {
  const items = queue()
  const action: TallyAction = request.delta > 0 ? 'tally' : 'undo'
  const last = items[items.length - 1]
  if (last && last.word === request.word && last.action === action
    && last.successKind === request.kind && last.listId === request.listId
    && last.scope === request.scope) {
    last.count += 1
    if (request.displayText) last.displayText = request.displayText
  } else {
    items.push({
      requestId: crypto.randomUUID(),
      word: request.word,
      action,
      successKind: request.kind,
      count: 1,
      listId: request.listId,
      scope: request.scope,
      displayText: request.displayText,
    })
  }
  persist()
  scheduleFlush(FLUSH_DELAY)
}

/** 服务端连续拒绝时累计次数，超过上限就丢弃这一批并回报错误 */
function dropAfterFailure(
  predicate: (operation: PendingTallyOperation) => boolean,
  error: string | undefined,
  fallback: string,
): TallyResult[] {
  failedAttempts += 1
  if (failedAttempts < MAX_ATTEMPTS) return []
  failedAttempts = 0
  const failed = queue().filter(predicate)
  removeOperations(predicate)
  return failed.map(operation => ({
    word: operation.word,
    displayText: operation.displayText,
    listId: operation.listId,
    ok: false,
    error: error?.trim() || fallback,
  }))
}

interface FlushOutcome {
  results: TallyResult[]
  offline: boolean
}

/** 列表计次：同一列表的操作合成一批，最多 100 条，服务端按 requestId 幂等 */
async function flushListBatch(listId: string): Promise<FlushOutcome> {
  const batch = queue().filter(operation => operation.listId === listId).slice(0, 100)
  if (batch.length === 0) return { results: [], offline: false }
  const reply = await sendJson<{ ok: boolean; processed?: string[]; error?: string }>(
    '/api/lists/' + encodeURIComponent(listId) + '/tally-batch',
    'POST',
    {
      operations: batch.map(operation => ({
        requestId: operation.requestId,
        word: operation.word,
        action: operation.action,
        successKind: operation.successKind,
        scope: operation.scope,
        count: operation.count,
      })),
    },
  )
  if (reply.offline) return { results: [], offline: true }
  if (!reply.ok || !reply.data?.ok) {
    const failed = new Set(batch.map(operation => operation.requestId))
    return {
      results: dropAfterFailure(item => item.listId === listId && failed.has(item.requestId),
        reply.data?.error, '计次保存失败'),
      offline: false,
    }
  }
  failedAttempts = 0
  const processed = new Set(reply.data.processed ?? batch.map(operation => operation.requestId))
  removeOperations(item => item.listId === listId && processed.has(item.requestId))
  return {
    results: batch.map(operation => ({
      word: operation.word,
      displayText: operation.displayText,
      listId,
      ok: true,
    })),
    offline: false,
  }
}

/** 成果页人工修正没有列表，接口一次只改 1 次：合并的 count 拆成多次请求，逐次递减 */
async function flushAchievementOperation(operation: PendingTallyOperation): Promise<FlushOutcome> {
  const requestId = operation.count > 1 ? operation.requestId + ':' + operation.count : operation.requestId
  const reply = await sendJson<{ ok: boolean; count?: number; error?: string }>(
    '/api/study/achievements/' + encodeURIComponent(operation.word),
    'PATCH',
    {
      kind: operation.successKind,
      delta: operation.action === 'tally' ? 1 : -1,
      requestId,
    },
  )
  if (reply.offline) return { results: [], offline: true }
  if (!reply.ok || !reply.data?.ok) {
    return {
      results: dropAfterFailure(item => item === operation, reply.data?.error, '学习成果次数修改失败'),
      offline: false,
    }
  }
  failedAttempts = 0
  operation.count -= 1
  if (operation.count <= 0) removeOperations(item => item === operation)
  else persist()
  return {
    results: [{ word: operation.word, displayText: operation.displayText, ok: true }],
    offline: false,
  }
}

async function flushTallyQueue(): Promise<void> {
  if (running) return
  const items = queue()
  if (items.length === 0) return
  running = true
  let outcome: FlushOutcome = { results: [], offline: false }
  try {
    const head = items[0]
    outcome = head.listId
      ? await flushListBatch(head.listId)
      : await flushAchievementOperation(head)
  } finally {
    running = false
  }
  if (outcome.results.some(result => result.ok)) {
    invalidateApiCache(['study-plan', 'achievements', 'history'])
  }
  notify(outcome.results)
  if (queue().length > 0) scheduleFlush(outcome.offline ? RETRY_DELAY : NEXT_ROUND_DELAY)
}

/** 页面首次使用队列时调用：把上次没传上去的操作重新排进 flush */
export function resumeTallyQueue(): void {
  if (queue().length > 0) scheduleFlush(0)
}
