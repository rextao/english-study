import { useState, useCallback, useEffect, useRef } from 'react'
import type { DictionaryEntry } from '../types/vocab'

import { apiFetch } from '../utils/apiBase'

export type DictionaryStatus = 'idle' | 'loading' | 'done' | 'error' | 'no-server'

/** 查过的词在内存里留 5 分钟，同一个词反复查不再打接口（刷新页面才清空这份缓存） */
const ENTRY_CACHE_TTL = 5 * 60 * 1000
const entryCache = new Map<string, { entry: DictionaryEntry; ts: number }>()

export function useDictionary() {
  const [entry, setEntry]   = useState<DictionaryEntry | null>(null)
  const [status, setStatus] = useState<DictionaryStatus>('idle')
  const requestRef = useRef(0)
  const controllerRef = useRef<AbortController | null>(null)

  const cancelLookup = useCallback((hasQuery = false) => {
    requestRef.current += 1
    controllerRef.current?.abort()
    controllerRef.current = null
    setEntry(null)
    setStatus(hasQuery ? 'loading' : 'idle')
  }, [])

  const lookup = useCallback(async (word: string) => {
    const w = word.trim().replace(/\s+/g, ' ')
    if (!w) { cancelLookup(); return }

    const requestId = requestRef.current + 1
    requestRef.current = requestId
    controllerRef.current?.abort()

    // 同一个词短时间内的结果直接复用，不再请求云端
    const cacheKey = w.toLowerCase()
    const cached = entryCache.get(cacheKey)
    if (cached && Date.now() - cached.ts < ENTRY_CACHE_TTL) {
      setEntry(cached.entry)
      setStatus('done')
      return
    }

    const controller = new AbortController()
    controllerRef.current = controller
    setStatus('loading')
    try {
      const res = await apiFetch('/api/dict?word=' + encodeURIComponent(w), {
        signal: controller.signal,
      })
      if (requestId !== requestRef.current) return
      if (!res.ok) { setEntry(null); setStatus('error'); return }
      const data = await res.json() as DictionaryEntry & { fromCache?: boolean }
      if (requestId !== requestRef.current) return
      // 服务端的 word 始终是稳定的小写主键；句子另存本次查询使用的展示文本。
      const resolved = /\s/.test(w) ? { ...data, displayText: w } : data
      entryCache.set(cacheKey, { entry: resolved, ts: Date.now() })
      setEntry(resolved)
      setStatus('done')
    } catch (error) {
      if (controller.signal.aborted || requestId !== requestRef.current) return
      // Server not running
      setEntry(null)
      setStatus('no-server')
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null
    }
  }, [cancelLookup])

  useEffect(() => () => {
    requestRef.current += 1
    controllerRef.current?.abort()
  }, [])

  return { entry, status, lookup, cancelLookup }
}
