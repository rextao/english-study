import { useState, useCallback } from 'react'
import type { DictionaryEntry } from '../types/vocab'

const SERVER = 'http://127.0.0.1:3456'

export type DictionaryStatus = 'idle' | 'loading' | 'done' | 'error' | 'no-server'

export function useDictionary() {
  const [entry, setEntry]   = useState<DictionaryEntry | null>(null)
  const [status, setStatus] = useState<DictionaryStatus>('idle')

  const lookup = useCallback(async (word: string) => {
    const w = word.trim()
    if (!w) { setEntry(null); setStatus('idle'); return }

    setStatus('loading')
    try {
      const res = await fetch(SERVER + '/api/dict?word=' + encodeURIComponent(w))
      if (!res.ok) { setStatus('error'); return }
      const data = await res.json() as DictionaryEntry & { fromCache?: boolean }
      setEntry(data)
      setStatus('done')
    } catch {
      // Server not running
      setStatus('no-server')
    }
  }, [])

  return { entry, status, lookup }
}
