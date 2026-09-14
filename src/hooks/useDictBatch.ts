import { useCallback, useEffect, useMemo, useState } from 'react'
import type { DictionaryEntry } from '../types/vocab'

const SERVER = 'http://127.0.0.1:3456'

/** 和服务端一致的归一化：去首尾空格、压缩空白、转小写 */
function keyOf(word: string) {
  return word.trim().replace(/\s+/g, ' ').toLowerCase()
}

interface BatchReply {
  /** key 是归一化后的词 */
  entries?: Record<string, DictionaryEntry>
  /** 完全没有缓存的词 */
  missing?: string[]
  /** 有缓存但音标 / 释义缺了一块的词 */
  incomplete?: string[]
}

/** 一次把一批词的缓存条目读回来，列表页拿它显示音标 */
export function useDictBatch(words: string[]) {
  const [entries, setEntries] = useState<Map<string, DictionaryEntry>>(new Map())
  const [missing, setMissing] = useState<string[]>([])
  const [incomplete, setIncomplete] = useState<string[]>([])
  const [loading, setLoading] = useState(false)

  // 只有词的集合真的变了才重新请求，不然每次 render 都会打一次接口
  const signature = useMemo(
    () => Array.from(new Set(words.map(keyOf).filter(Boolean))).sort().join('\n'),
    [words],
  )

  const load = useCallback(async () => {
    const list = signature ? signature.split('\n') : []
    if (list.length === 0) {
      setEntries(new Map())
      setMissing([])
      setIncomplete([])
      return
    }
    setLoading(true)
    try {
      const res = await fetch(SERVER + '/api/dict/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ words: list }),
      })
      const data = await res.json() as BatchReply
      const next = new Map<string, DictionaryEntry>()
      for (const [key, entry] of Object.entries(data.entries ?? {})) next.set(key, entry)
      setEntries(next)
      setMissing(data.missing ?? [])
      setIncomplete(data.incomplete ?? [])
    } catch {
      // 本地服务没起来，页面照旧显示，只是没有音标
    }
    setLoading(false)
  }, [signature])

  useEffect(() => { load() }, [load])

  const getEntry = useCallback(
    (word: string) => entries.get(keyOf(word)) ?? null,
    [entries],
  )

  /** 需要补的词 = 没缓存的 + 缓存不全的 */
  const pending = useMemo(() => missing.concat(incomplete), [missing, incomplete])

  return { entries, missing, incomplete, pending, loading, getEntry, reload: load }
}
