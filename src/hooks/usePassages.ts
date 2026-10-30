import { useCallback, useEffect, useState } from 'react'
import type { Passage, PassageWord } from '../types/vocab'
import { apiFetch } from '../utils/apiBase'
import { invalidateApiCache, queryApi } from '../utils/apiCache'

interface PassageListResponse { passages?: Passage[] }
interface PassageResponse { passage?: Passage }
type PassageMarkAction = 'reading' | 'meaning'

async function readJson<T>(response: Response, fallback: string): Promise<T> {
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const error = body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string'
      ? (body as { error: string }).error
      : fallback
    throw new Error(error)
  }
  return body as T
}

export function usePassages() {
  const [passages, setPassages] = useState<Passage[]>([])
  const [loading, setLoading] = useState(true)
  const [mutating, setMutating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const body = await queryApi<PassageListResponse>('/api/passages', {}, {
        staleTime: 15_000,
        tags: ['passages'],
      })
      setPassages(Array.isArray(body.passages) ? body.passages : [])
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '短文读取失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const save = useCallback(async (input: {
    id?: string
    title: string
    content: string
    sourceWords: PassageWord[]
    groups: Passage['groups']
  }) => {
    setMutating(true)
    setError(null)
    try {
      const response = await apiFetch(input.id ? '/api/passages/' + encodeURIComponent(input.id) : '/api/passages', {
        method: input.id ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      })
      const body = await readJson<PassageResponse>(response, '短文保存失败')
      if (!body.passage) throw new Error('短文保存结果不正确')
      invalidateApiCache('passages')
      setPassages(current => [body.passage!, ...current.filter(item => item.id !== body.passage!.id)])
      return { ok: true as const, passage: body.passage }
    } catch (saveError) {
      const message = saveError instanceof Error ? saveError.message : '短文保存失败'
      setError(message)
      return { ok: false as const, error: message }
    } finally {
      setMutating(false)
    }
  }, [])

  const mark = useCallback(async (id: string, action: PassageMarkAction) => {
    setMutating(true)
    setError(null)
    try {
      const response = await apiFetch('/api/passages/' + encodeURIComponent(id) + '/mark', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      })
      const body = await readJson<{ passage?: Passage; marked?: number }>(response, '短文标记失败')
      if (!body.passage) throw new Error('短文标记结果不正确')
      invalidateApiCache(['passages', 'achievements', 'history'])
      setPassages(current => current.map(item => item.id === id ? body.passage! : item))
      return { ok: true as const, marked: body.marked ?? 0, passage: body.passage }
    } catch (markError) {
      const message = markError instanceof Error ? markError.message : '短文标记失败'
      setError(message)
      return { ok: false as const, error: message }
    } finally {
      setMutating(false)
    }
  }, [])

  return { passages, loading, mutating, error, refresh, save, mark }
}
