import { useCallback, useEffect, useRef, useState } from 'react'
import { subscribeLocalChanges } from '../syncBus'

const SERVER = 'http://127.0.0.1:3456'
const CONFIG_URL = SERVER + '/api/sync/config'
const STATUS_URL = SERVER + '/api/sync/status'
const PUSH_URL = SERVER + '/api/sync/push'
const PULL_URL = SERVER + '/api/sync/pull'

/** 本地数据变动后多久重新查差异：写操作常常连续发生（比如连续打卡），防抖一下 */
const RECHECK_DEBOUNCE_MS = 800

type JsonBody = Record<string, unknown>

/** 一份快照的人类可读摘要（本地 / 云端通用） */
export interface SyncSummary {
  hash: string
  exportedAt: number
  deviceLabel: string
  listCount: number
  wordCount: number
  eventCount: number
  /** 用户内容总量（列表词条 + 学习事件），用于「空快照」判定 */
  totalRows: number
  empty: boolean
}

/** 本地摘要额外带一个「是否有未同步的改动」 */
export interface LocalSummary extends SyncSummary {
  dirty: boolean
}

export interface SyncStatus {
  configured: boolean
  local: LocalSummary
  remote: SyncSummary | null
  /** 云端连不上时的错误信息（不报错，界面提示「无法连接云端」） */
  remoteError: string
  lastSyncedHash: string
  lastSyncAt: number
  lastDirection: '' | 'push' | 'pull'
  deviceLabel: string
}

export interface SyncConfig {
  url: string
  hasToken: boolean
  /** 令牌只留后 4 位，给输入框占位用 */
  tokenHint: string
  deviceLabel: string
  configured: boolean
}

/**
 * 同步状态机：界面只认这一个状态，自己不算哈希。
 * - loading      首次查询中
 * - offline      本地服务没起 / 是没有同步接口的旧版本，同步条不显示
 * - unconfigured 还没填云端地址，只在设置页提示
 * - error        已配置但连不上云端
 * - synced       本地和云端一致，什么都不提示
 * - local-ahead  本地有新改动（云端还是上次同步的样）→ 提示「上传到云端」
 * - remote-ahead 云端有新改动（本地没动）→ 提示「同步到本地」
 * - conflict     两边都变了 → 弹窗让用户选方向
 */
export type SyncState =
  | 'loading'
  | 'offline'
  | 'unconfigured'
  | 'error'
  | 'synced'
  | 'local-ahead'
  | 'remote-ahead'
  | 'conflict'

export type PushPullState = 'push' | 'pull' | null

export interface PullResult {
  ok: boolean
  /** 云端是空快照而本地有数据：需要用户再确认一次才会清空本地 */
  needsForce?: boolean
  error?: string
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function toSummary(body: unknown): SyncSummary | null {
  if (body === null || typeof body !== 'object') return null
  const obj = body as JsonBody
  if (typeof obj.hash !== 'string') return null
  return {
    hash: obj.hash,
    exportedAt: num(obj.exportedAt),
    deviceLabel: str(obj.deviceLabel),
    listCount: num(obj.listCount),
    wordCount: num(obj.wordCount),
    eventCount: num(obj.eventCount),
    totalRows: num(obj.totalRows),
    empty: obj.empty === true || obj.hash.length === 0,
  }
}

/** 服务端返回的状态不一定可信（老版本服务没有这些字段），字段不齐就当查不到 */
function toStatus(body: unknown): SyncStatus | null {
  if (body === null || typeof body !== 'object') return null
  const obj = body as JsonBody
  if (typeof obj.configured !== 'boolean') return null
  const local = toSummary(obj.local)
  if (!local) return null
  const localBody = obj.local as JsonBody | null
  return {
    configured: obj.configured,
    local: { ...local, dirty: localBody?.dirty === true },
    remote: toSummary(obj.remote),
    remoteError: str(obj.remoteError),
    lastSyncedHash: str(obj.lastSyncedHash),
    lastSyncAt: num(obj.lastSyncAt),
    lastDirection: obj.lastDirection === 'push' || obj.lastDirection === 'pull' ? obj.lastDirection : '',
    deviceLabel: str(obj.deviceLabel),
  }
}

function toConfig(body: unknown): SyncConfig | null {
  if (body === null || typeof body !== 'object') return null
  const obj = body as JsonBody
  if (typeof obj.configured !== 'boolean') return null
  return {
    url: str(obj.url),
    hasToken: obj.hasToken === true,
    tokenHint: str(obj.tokenHint),
    deviceLabel: str(obj.deviceLabel),
    configured: obj.configured,
  }
}

interface ApiResult {
  ok: boolean
  status: number
  body: JsonBody | null
  /** fetch 直接失败 = 本地服务没起 */
  offline: boolean
}

async function fetchJson(url: string): Promise<JsonBody | null> {
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    const body: unknown = await res.json()
    return body !== null && typeof body === 'object' ? (body as JsonBody) : null
  } catch {
    return null
  }
}

async function sendJson(url: string, method: string, body?: unknown): Promise<ApiResult> {
  try {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    let parsed: JsonBody | null = null
    try { parsed = await res.json() as JsonBody } catch { /* 非 JSON 响应 */ }
    return { ok: res.ok, status: res.status, body: parsed, offline: false }
  } catch {
    return { ok: false, status: 0, body: null, offline: true }
  }
}

function errorMessage(result: ApiResult, fallback: string): string {
  if (result.offline) return '本地服务未启动'
  const error = result.body?.error
  return typeof error === 'string' && error ? error : fallback
}

/**
 * 把服务端状态归一成界面用的同步状态。
 * 判定依据：本地是否比上次同步后改过（dirty）+ 云端哈希是否还是上次同步那个。
 */
export function classifySync(status: SyncStatus | null, checking: boolean): SyncState {
  if (!status) return checking ? 'loading' : 'offline'
  if (!status.configured) return 'unconfigured'
  if (!status.remote) return 'error'
  const { local, remote, lastSyncedHash } = status
  if (local.hash === remote.hash) return 'synced'
  const localChanged = local.dirty && remote.hash === lastSyncedHash
  const remoteChanged = !local.dirty && remote.hash !== lastSyncedHash
  if (localChanged) return 'local-ahead'
  if (remoteChanged) return 'remote-ahead'
  // 两边都变了（或从没同步过且两边都有数据）：交给用户选方向
  return 'conflict'
}

export type SyncApi = ReturnType<typeof useSync>

/**
 * 数据同步（本地 sqlite ↔ Cloudflare D1）。
 * 挂在 App 上全局唯一一份，设置页和顶部提示条共用，避免切 tab 后状态不同步。
 * 所有写操作（push / pull / saveConfig）都要用户点了按钮才执行，绝不自动同步。
 */
export function useSync() {
  const [status, setStatus]     = useState<SyncStatus | null>(null)
  const [config, setConfig]     = useState<SyncConfig | null>(null)
  const [checking, setChecking] = useState(true)
  const [busy, setBusy]         = useState<PushPullState>(null)
  /** push / pull / saveConfig 的错误信息，给按钮旁边显示 */
  const [actionError, setActionError] = useState('')
  /** 本地数据变动后用它触发一次重新查询（查差异是幂等的，重复触发无所谓） */
  const [checkToken, setCheckToken] = useState(0)

  const configuredRef = useRef(false)
  useEffect(() => { configuredRef.current = Boolean(config?.configured) }, [config])

  /** 拉一次配置 + 差异状态；push / pull / 改配置之后都调它刷新界面 */
  const check = useCallback(async () => {
    setChecking(true)
    const [cfg, st] = await Promise.all([fetchJson(CONFIG_URL), fetchJson(STATUS_URL)])
    setConfig(toConfig(cfg))
    setStatus(toStatus(st))
    setChecking(false)
  }, [])

  useEffect(() => { void check() }, [check])

  // 本地任意数据变动 → 防抖后重新查差异；没配置同步地址就不查（省得到云端空跑）
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const unsubscribe = subscribeLocalChanges(() => {
      if (!configuredRef.current) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => { void check() }, RECHECK_DEBOUNCE_MS)
    })
    return () => {
      unsubscribe()
      if (timer) clearTimeout(timer)
    }
  }, [check])

  useEffect(() => { void check() }, [check, checkToken])

  /** 保存同步配置：字符串 = 覆盖，null = 清除覆盖项回落环境变量 */
  const saveConfig = useCallback(async (patch: Partial<Record<'url' | 'token' | 'deviceLabel', string | null>>): Promise<boolean> => {
    setActionError('')
    const result = await sendJson(CONFIG_URL, 'PUT', patch)
    if (!result.ok) {
      setActionError(errorMessage(result, '保存失败'))
      return false
    }
    setConfig(toConfig(result.body))
    // 配置从无到有 / 从有到无都会改变「该不该提示」，立刻重查一次差异
    void check()
    return true
  }, [check])

  /** 把本地整库快照推到云端（覆盖云端） */
  const push = useCallback(async (): Promise<boolean> => {
    setBusy('push')
    setActionError('')
    const result = await sendJson(PUSH_URL, 'POST')
    if (!result.ok) {
      setActionError(errorMessage(result, '推送失败'))
      setBusy(null)
      return false
    }
    setBusy(null)
    await check()
    return true
  }, [check])

  /** 把云端快照拉下来整份覆盖本地；云端是空快照时返回 needsForce 要求二次确认 */
  const pull = useCallback(async (force = false): Promise<PullResult> => {
    setBusy('pull')
    setActionError('')
    const result = await sendJson(PULL_URL, 'POST', { force })
    if (result.status === 409 && result.body?.needsForce === true) {
      setBusy(null)
      return { ok: false, needsForce: true, error: errorMessage(result, '云端是空数据，拉取会清空本地') }
    }
    if (!result.ok) {
      setActionError(errorMessage(result, '拉取失败'))
      setBusy(null)
      return { ok: false }
    }
    setBusy(null)
    await check()
    return { ok: true }
  }, [check])

  const state = classifySync(status, checking)

  return {
    state,
    status,
    config,
    checking,
    busy,
    actionError,
    /** 手动重查差异（设置页的「重新检查」按钮） */
    recheck: () => setCheckToken(token => token + 1),
    saveConfig,
    push,
    pull,
  }
}
