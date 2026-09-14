import { useState, useCallback, useEffect, useRef } from 'react'
import type { DictionaryEntry } from '../types/vocab'

const SERVER = 'http://127.0.0.1:3456'

export type DictionaryStatus = 'idle' | 'loading' | 'done' | 'error' | 'no-server'

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
    const controller = new AbortController()
    controllerRef.current = controller
    setStatus('loading')
    try {
      const res = await fetch(SERVER + '/api/dict?word=' + encodeURIComponent(w), {
        signal: controller.signal,
      })
      if (requestId !== requestRef.current) return
      if (!res.ok) { setEntry(null); setStatus('error'); return }
      const data = await res.json() as DictionaryEntry & { fromCache?: boolean }
      if (requestId !== requestRef.current) return
      // 服务端的 word 始终是稳定的小写主键；句子另存本次查询使用的展示文本。
      setEntry(/\s/.test(w) ? { ...data, displayText: w } : data)
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
