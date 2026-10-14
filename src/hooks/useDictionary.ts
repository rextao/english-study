import { useState, useCallback, useEffect, useRef } from 'react'
import type { DictionaryEntry } from '../types/vocab'

import { ApiError, peekApiCache, queryApi } from '../utils/apiCache'

export type DictionaryStatus = 'idle' | 'loading' | 'done' | 'error' | 'no-server'

const ENTRY_CACHE_TTL = 5 * 60 * 1000

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
    const peeked = peekApiCache<DictionaryEntry & { fromCache?: boolean }>(
      '/api/dict?word=' + encodeURIComponent(w), {},
    )
    if (peeked) {
      const resolvedPeek = /\s/.test(w) ? { ...peeked, displayText: w } : peeked
      setEntry(resolvedPeek)
      setStatus('done')
      return
    }
    const controller = new AbortController()
    controllerRef.current = controller
    setStatus('loading')
    try {
      const data = await queryApi<DictionaryEntry & { fromCache?: boolean }>('/api/dict?word=' + encodeURIComponent(w), {
        signal: controller.signal,
      }, { staleTime: ENTRY_CACHE_TTL, tags: ['dictionary'] })
      if (requestId !== requestRef.current) return
      // 服务端的 word 始终是稳定的小写主键；句子另存本次查询使用的展示文本。
      const resolved = /\s/.test(w) ? { ...data, displayText: w } : data
      setEntry(resolved)
      setStatus('done')
    } catch (error) {
      if (controller.signal.aborted || requestId !== requestRef.current) return
      setEntry(null)
      // 服务端回了错误状态码 = 这次没抓到释义；请求根本没发出去才是云端不可用。
      setStatus(error instanceof ApiError ? 'error' : 'no-server')
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
