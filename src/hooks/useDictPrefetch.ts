import { useCallback, useEffect, useRef, useState } from 'react'

const SERVER = 'http://127.0.0.1:3456'

/** 服务端补词队列的进度 */
export interface PrefetchState {
  total: number
  done: number
  failed: number
  pending: number
  running: number
  finished: boolean
}

const IDLE: PrefetchState = { total: 0, done: 0, failed: 0, pending: 0, running: 0, finished: true }

/** repair 的结果，失败时带上能直接显示给用户的原因 */
export type RepairResult =
  | { ok: true; scanned: number; queued: number }
  | { ok: false; error: string }

const MSG_OFFLINE = '本地服务没有响应，请确认已启动（npm run dev:all）'
const MSG_STALE = '本地服务是旧版本，还没有补齐接口，请重启本地服务（npm run dev:all）后再试'

type JsonBody = Record<string, unknown>

function numOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * 进度字段齐全才认这份数据。
 * 旧版本服务没有这些接口时会回 404 { error: 'not found' }，照抄进 state 的话
 * 界面会显示 undefined/undefined，而且 finished 是 undefined，「补齐中」会一直转下去。
 */
function toState(body: JsonBody): PrefetchState | null {
  const total = numOf(body.total)
  const done  = numOf(body.done)
  if (total === null || done === null || typeof body.finished !== 'boolean') return null
  return {
    total,
    done,
    failed:   numOf(body.failed)  ?? 0,
    pending:  numOf(body.pending) ?? 0,
    running:  numOf(body.running) ?? 0,
    finished: body.finished,
  }
}

/** 连不上返回 offline；状态码或响应体不对返回 stale */
async function callServer(path: string, init?: RequestInit): Promise<JsonBody | 'offline' | 'stale'> {
  let res: Response
  try {
    res = await fetch(SERVER + path, init)
  } catch {
    return 'offline'
  }
  if (!res.ok) return 'stale'
  try {
    const body: unknown = await res.json()
    return body !== null && typeof body === 'object' ? body as JsonBody : 'stale'
  } catch {
    return 'stale'
  }
}

/** 盯着服务端补音标 / 释义的后台队列：进度靠轮询，跑完自动停下来 */
export function useDictPrefetch(onFinish?: () => void) {
  const [state, setState] = useState<PrefetchState>(IDLE)
  const [watching, setWatching] = useState(false)
  const [error, setError] = useState('')
  const finishRef = useRef(onFinish)

  useEffect(() => { finishRef.current = onFinish }, [onFinish])

  useEffect(() => {
    if (!watching) return
    let alive = true
    // 出问题就把进度归零，别让「补齐中」永远转下去
    const stop = (message: string) => {
      setWatching(false)
      setState(IDLE)
      setError(message)
    }
    const timer = setInterval(async () => {
      const body = await callServer('/api/dict/prefetch')
      if (!alive) return
      if (body === 'offline') { stop(MSG_OFFLINE); return }
      if (body === 'stale')   { stop(MSG_STALE);   return }
      const next = toState(body)
      if (!next) { stop(MSG_STALE); return }
      setState(next)
      if (next.finished) {
        setWatching(false)
        finishRef.current?.()
      }
    }, 1200)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [watching])

  /** 别人（比如导入接口）已经排好队了，这里只接着看进度 */
  const watch = useCallback(() => { setError(''); setWatching(true) }, [])

  /** 扫一遍缺音标 / 缺释义的词并重新抓；不传 words = 扫所有学习列表 */
  const repair = useCallback(async (words?: string[]): Promise<RepairResult> => {
    setError('')
    const body = await callServer('/api/dict/repair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(words ? { words } : {}),
    })
    if (body === 'offline' || body === 'stale') {
      const message = body === 'offline' ? MSG_OFFLINE : MSG_STALE
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
    // 一个词都没排队说明本来就是齐的，不用再轮询
    if (queued > 0 || !next.finished) setWatching(true)
    return { ok: true, scanned: numOf(body.scanned) ?? 0, queued }
  }, [])

  return { state, error, busy: watching, repair, watch }
}
