import { apiFetch, getStoredToken } from './apiBase'

/** 显式声明的只读请求进入统一会话缓存；所有写请求继续使用 apiFetch。 */
export interface QueryOptions {
  staleTime?: number
  tags?: string[]
  force?: boolean
}

/** 请求连通了、但服务端回了非 2xx：调用方据此区分「接口报错」和「连不上云端」。 */
export class ApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

interface CacheEntry {
  value: unknown
  expiresAt: number
  tags: Set<string>
}

/**
 * 同一个 key 正在执行的请求。signal 只属于发起它的调用方，
 * 因此用它来判断后来的调用方能不能合并——不同 signal 合并会出现「一方 abort、两方一起失败」。
 */
interface PendingRequest {
  promise: Promise<unknown>
  signal: AbortSignal | null
  tags: Set<string>
}

const DEFAULT_STALE_TIME = 30_000
/** 会话缓存的条目上限，超过就丢最久没用过的 */
const MAX_CACHE_ENTRIES = 200
/** 标签计数超过这个量才值得做一次回收扫描 */
const MAX_EPOCH_TAGS = 500
const BASE_ORIGIN = typeof window === 'undefined' ? 'http://localhost' : window.location.origin

const cache = new Map<string, CacheEntry>()
const inFlight = new Map<string, PendingRequest>()
const invalidationEpoch = new Map<string, number>()
let tokenSnapshot = ''
let tokenEpoch = 0

function tokenScope(): number {
  const token = getStoredToken()
  if (token !== tokenSnapshot) {
    tokenSnapshot = token
    tokenEpoch += 1
    cache.clear()
    inFlight.clear()
  }
  return tokenEpoch
}

function parseUrl(url: string): URL {
  return new URL(url, BASE_ORIGIN)
}

function normalizeUrl(url: string): string {
  const parsed = parseUrl(url)
  parsed.searchParams.sort()
  return parsed.pathname + parsed.search
}

/** 服务端用 refresh=1 表示「跳过缓存重抓」，这类请求既不能读缓存也不能写缓存。 */
function bypassesCache(url: string): boolean {
  try { return parseUrl(url).searchParams.get('refresh') === '1' } catch { return false }
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, sortValue(item)]))
  }
  return value
}

function stableBody(body: BodyInit | null | undefined): string {
  if (body == null) return ''
  if (body instanceof URLSearchParams) return [...body.entries()].sort().map(([key, value]) => key + '=' + value).join('&')
  if (typeof body !== 'string') return String(body)
  try { return JSON.stringify(sortValue(JSON.parse(body))) } catch { return body }
}

function requestKey(url: string, init: RequestInit): string {
  return [tokenScope(), normalizeUrl(url), (init.method ?? 'GET').toUpperCase(), stableBody(init.body)].join('\n')
}

function intersects(tags: Set<string>, selected: Set<string>): boolean {
  for (const tag of tags) if (selected.has(tag)) return true
  return false
}

/** 写入并按 LRU 淘汰；命中时也会调用它把条目挪到队尾。 */
function keep(key: string, entry: CacheEntry): void {
  cache.delete(key)
  cache.set(key, entry)
  if (cache.size <= MAX_CACHE_ENTRIES) return
  const now = Date.now()
  for (const [cachedKey, cachedEntry] of cache) {
    if (cache.size <= MAX_CACHE_ENTRIES) break
    if (cachedEntry.expiresAt <= now) cache.delete(cachedKey)
  }
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next()
    if (oldest.done) break
    cache.delete(oldest.value)
  }
}

/**
 * 只为「还在用」的标签保留计数：缓存里没人引用、也没有请求在途的标签可以清掉。
 * 之所以安全，是因为读计数的只有「在途请求返回后的比对」，而这类请求的标签此刻都在 inFlight 里。
 */
function pruneEpochs(): void {
  if (invalidationEpoch.size <= MAX_EPOCH_TAGS) return
  const live = new Set<string>()
  for (const entry of cache.values()) for (const tag of entry.tags) live.add(tag)
  for (const pending of inFlight.values()) for (const tag of pending.tags) live.add(tag)
  for (const tag of invalidationEpoch.keys()) {
    if (!live.has(tag)) invalidationEpoch.delete(tag)
  }
}

/** 同步窥探缓存：命中且未过期直接返回，不发起请求也不进入并发合并。 */
export function peekApiCache<T>(url: string, init: RequestInit = {}): T | undefined {
  if (bypassesCache(url)) return undefined
  const key = requestKey(url, init)
  const hit = cache.get(key)
  if (!hit || hit.expiresAt <= Date.now()) return undefined
  keep(key, hit)
  return hit.value as T
}

/** 对明确声明为只读的 GET/HEAD/POST 请求做会话级缓存及并发合并。 */
export async function queryApi<T>(url: string, init: RequestInit = {}, options: QueryOptions = {}): Promise<T> {
  const method = (init.method ?? 'GET').toUpperCase()
  if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') {
    throw new Error('queryApi 只允许 GET、HEAD 或显式声明的只读 POST')
  }

  const key = requestKey(url, init)
  const epoch = tokenEpoch
  const signal = init.signal ?? null
  const tags = new Set(options.tags ?? [])
  const tagEpochs = new Map([...tags].map(tag => [tag, invalidationEpoch.get(tag) ?? 0]))
  const cacheable = !bypassesCache(url)
  const cached = cacheable ? cache.get(key) : undefined
  if (!options.force && cached && cached.expiresAt > Date.now()) {
    for (const tag of tags) cached.tags.add(tag)
    keep(key, cached)
    return cached.value as T
  }
  const pending = inFlight.get(key)
  if (pending && pending.signal === signal) {
    for (const tag of tags) pending.tags.add(tag)
    return pending.promise as Promise<T>
  }

  const task = (async () => {
    const response = await apiFetch(url, init)
    if (!response.ok) {
      const body: unknown = await response.json().catch(() => null)
      const bodyRecord = body && typeof body === 'object' ? body as { error?: unknown; message?: unknown } : null
      throw new ApiError(response.status, String(bodyRecord?.error ?? bodyRecord?.message ?? ('HTTP ' + response.status)))
    }
    const value = await response.json() as T
    if (!cacheable) return value
    // 请求期间被写操作作废过（或换了登录态）的快照，不能再写回缓存。
    if (epoch !== tokenEpoch || [...tagEpochs].some(([tag, startedAt]) =>
      (invalidationEpoch.get(tag) ?? 0) !== startedAt)) return value
    keep(key, {
      value,
      expiresAt: Date.now() + Math.max(0, options.staleTime ?? DEFAULT_STALE_TIME),
      tags,
    })
    return value
  })()
  const entry: PendingRequest = { promise: task, signal, tags }
  inFlight.set(key, entry)
  try { return await task }
  finally {
    if (inFlight.get(key) === entry) inFlight.delete(key)
  }
}

/** 成功写操作后，按资源标签清理缓存。 */
export function invalidateApiCache(tags: string | string[]): void {
  const selected = new Set(Array.isArray(tags) ? tags : [tags])
  if (selected.size === 0) return
  for (const tag of selected) invalidationEpoch.set(tag, (invalidationEpoch.get(tag) ?? 0) + 1)
  for (const [key, entry] of cache) {
    if (intersects(entry.tags, selected)) cache.delete(key)
  }
  // 正在执行的同资源查询若晚于写操作返回，不应重新写入旧快照。
  for (const [key, pending] of inFlight) {
    if (intersects(pending.tags, selected)) inFlight.delete(key)
  }
  pruneEpochs()
}
