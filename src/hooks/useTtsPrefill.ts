import { useCallback, useEffect, useRef, useState } from 'react'

import { apiFetch } from '../utils/apiBase'
import { invalidateApiCache } from '../utils/apiCache'

/** 服务端发音预合成队列的进度 */
export interface TtsPrefillState {
  total: number
  done: number
  failed: number
  pending: number
  running: number
  finished: boolean
  errors: { word: string; message: string }[]
}

const IDLE: TtsPrefillState = { total: 0, done: 0, failed: 0, pending: 0, running: 0, finished: true, errors: [] }

/** prefill 的结果，失败时带上能直接显示给用户的原因 */
export type PrefillResult =
  | { ok: true; scanned: number; queued: number }
  | { ok: false; error: string }

const MSG_OFFLINE = '云端服务没有响应，请检查网络或稍后再试'
const MSG_STALE = '云端服务版本较旧，还没有发音补充接口，请重新部署 Worker 后再试'
const MSG_STALLED = '补充进度长时间没有变化，后台任务可能被中断了，请再点一次「全部补充音频」继续'
/** 进度多久没变化就认定卡住：服务端一轮执行约 22 秒收手续跑，40 秒足够跨过一轮 */
const STALL_MS = 40_000
/** 进度轮询间隔：服务端一条要 1–2 秒，2 秒一次已经够跟得上，不必打得更密 */
const POLL_MS = 2000

type JsonBody = Record<string, unknown>
type ServerError = { kind: 'error'; message: string }

function isServerError(body: JsonBody | ServerError): body is ServerError {
  return body.kind === 'error' && typeof body.message === 'string'
}

function numOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * 进度字段齐全才认这份数据。
 * 旧版本服务没有这些接口时会回 404 { error: 'not found' }，照抄进 state 的话
 * 界面会显示 undefined/undefined，而且 finished 是 undefined，「补充中」会一直转下去。
 */
function toState(body: JsonBody): TtsPrefillState | null {
  const total = numOf(body.total)
  const done = numOf(body.done)
  if (total === null || done === null || typeof body.finished !== 'boolean') return null
  return {
    total,
    done,
    failed: numOf(body.failed) ?? 0,
    pending: numOf(body.pending) ?? 0,
    running: numOf(body.running) ?? 0,
    finished: body.finished,
    errors: Array.isArray(body.errors)
      ? body.errors.flatMap(item => {
          if (!item || typeof item !== 'object') return []
          const value = item as { word?: unknown; message?: unknown }
          return typeof value.word === 'string' && typeof value.message === 'string'
            ? [{ word: value.word, message: value.message }]
            : []
        })
      : [],
  }
}

/** 连不上返回 offline；状态码或响应体不对返回 stale */
async function callServer(path: string, init?: RequestInit): Promise<JsonBody | ServerError | 'offline' | 'stale'> {
  let res: Response
  try {
    res = await apiFetch(path, init)
  } catch {
    return 'offline'
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null) as { error?: unknown; message?: unknown } | null
    const message = body && typeof body.error === 'string' ? body.error
      : body && typeof body.message === 'string' ? body.message
        : `请求失败（HTTP ${res.status}）`
    return { kind: 'error', message }
  }
  try {
    const body: unknown = await res.json()
    return body !== null && typeof body === 'object' ? body as JsonBody : 'stale'
  } catch {
    return 'stale'
  }
}

/** 盯着服务端发音预合成的后台队列：进度靠轮询，跑完自动停下来 */
export function useTtsPrefill(onFinish?: () => void) {
  const [state, setState] = useState<TtsPrefillState>(IDLE)
  const [watching, setWatching] = useState(false)
  const [error, setError] = useState('')
  const finishRef = useRef(onFinish)

  useEffect(() => { finishRef.current = onFinish }, [onFinish])

  useEffect(() => {
    if (!watching) return
    let alive = true
    // 出问题就把进度归零，别让「补充中」永远转下去
    const stop = (message: string) => {
      setWatching(false)
      setState(IDLE)
      setError(message)
    }
    let lastSignature = ''
    let lastChangeAt = Date.now()
    const tick = async () => {
      // 后台标签页不轮询：补充在服务端跑，用户看不见时没必要每秒打接口
      if (typeof document !== 'undefined' && document.hidden) return
      const body = await callServer('/api/tts/prefill')
      if (!alive) return
      if (body === 'offline') { stop(MSG_OFFLINE); return }
      if (body === 'stale') { stop(MSG_STALE); return }
      if (isServerError(body)) { stop(body.message); return }
      const next = toState(body)
      if (!next) { stop(MSG_STALE); return }
      // 兜底：后台队列真卡了就别让「补充中」一直转下去
      const signature = next.done + '/' + next.failed + '/' + next.pending
      if (signature !== lastSignature) {
        lastSignature = signature
        lastChangeAt = Date.now()
      } else if (!next.finished && Date.now() - lastChangeAt > STALL_MS) {
        stop(MSG_STALLED)
        return
      }
      setState(next)
      if (next.finished) {
        setWatching(false)
        // 后台预合成本质是往 tts_cache 写缓存，不影响学习列表快照；
        // 只需要刷新缺失名单本身。
        invalidateApiCache(['missing-tts'])
        finishRef.current?.()
      }
    }
    const timer = setInterval(() => { void tick() }, POLL_MS)
    // 回到前台立刻补一次，不用等下一个间隔
    const onVisible = () => { if (!document.hidden) void tick() }
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible)
    return () => {
      alive = false
      clearInterval(timer)
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible)
    }
  }, [watching])

  /** 触发一次扫描 + 入队，并跟着进度 */
  const prefill = useCallback(async (): Promise<PrefillResult> => {
    setError('')
    const body = await callServer('/api/tts/prefill', { method: 'POST' })
    if (body === 'offline' || body === 'stale' || isServerError(body)) {
      const message = body === 'offline' ? MSG_OFFLINE
        : body === 'stale' ? MSG_STALE
          : body.message
      setError(message)
      return { ok: false, error: message }
    }
    const next = toState(body)
    if (!next) {
      setError(MSG_STALE)
      return { ok: false, error: MSG_STALE }
    }
    const queued = numOf(body.queued) ?? 0
    setState(next)
    // 一个都没排上说明本来就齐了，不用再轮询
    if (queued > 0 || !next.finished) setWatching(true)
    return { ok: true, scanned: numOf(body.scanned) ?? 0, queued }
  }, [])

  return { state, error, busy: watching, prefill }
}
