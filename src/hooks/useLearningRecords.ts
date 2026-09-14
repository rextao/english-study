import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  LearningAchievement,
  LearningAchievementsResponse,
  LearningHistoryResponse,
  LearningRecordGroup,
  StudyMarkAction,
} from '../types/vocab'

const API_BASE = 'http://127.0.0.1:3456'

export type LearningRecordFilterAction = 'all' | Extract<StudyMarkAction, 'spelling' | 'done' | 'again'>

interface HistoryFilters {
  libraryId: string
  word: string
  action: LearningRecordFilterAction
}

interface ApiErrorBody { error?: unknown }

function errorMessage(body: unknown, fallback: string) {
  if (body && typeof body === 'object') {
    const error = (body as ApiErrorBody).error
    if (typeof error === 'string' && error.trim()) return error
  }
  return fallback
}

async function readJson<T>(response: Response, fallback: string): Promise<T> {
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) throw new Error(errorMessage(body, fallback))
  return body as T
}

/** 从永久事件账本读取成果；libraryId 为空字符串表示全部词库。 */
export function useLearningAchievements(libraryId: string) {
  const [items, setItems] = useState<LearningAchievement[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [version, setVersion] = useState(0)
  const reload = useCallback(() => setVersion(current => current + 1), [])

  useEffect(() => {
    const controller = new AbortController()
    async function load() {
      setLoading(true)
      setError(null)
      try {
        const query = new URLSearchParams({ libraryId })
        const response = await fetch(`${API_BASE}/api/study/achievements?${query}`, { signal: controller.signal })
        const body = await readJson<LearningAchievementsResponse>(response, '学习成果读取失败')
        if (!Array.isArray(body.items)) throw new Error('学习成果数据格式不正确')
        setItems(body.items)
      } catch (loadError) {
        if (loadError instanceof DOMException && loadError.name === 'AbortError') return
        setItems([])
        setError(loadError instanceof Error ? loadError.message : '学习成果读取失败')
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    }
    void load()
    return () => controller.abort()
  }, [libraryId, version])

  return { items, loading, error, reload }
}

const PAGE_SIZE = 20

/** 查询及管理永久学习事件，分页单位为单词分组。 */
export function useLearningRecords(filters: HistoryFilters, enabled: boolean) {
  const [items, setItems] = useState<LearningRecordGroup[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [mutating, setMutating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [version, setVersion] = useState(0)
  const requestRef = useRef(0)
  const itemCountRef = useRef(0)
  const reloadLimitRef = useRef(PAGE_SIZE)
  itemCountRef.current = items.length
  const reload = useCallback(() => setVersion(current => current + 1), [])

  const fetchPage = useCallback(async (offset: number, append: boolean, limit = PAGE_SIZE) => {
    const requestId = requestRef.current + 1
    requestRef.current = requestId
    append ? setLoadingMore(true) : setLoading(true)
    setError(null)
    try {
      const query = new URLSearchParams({
        libraryId: filters.libraryId,
        word: filters.word.trim(),
        // 管理页只关心实际复习结果；“全部标记”也不能把开始学习、打印等事件带进来。
        action: filters.action === 'all' ? 'review' : filters.action,
        limit: String(limit),
        offset: String(offset),
      })
      const response = await fetch(`${API_BASE}/api/study/history?${query}`)
      const body = await readJson<LearningHistoryResponse>(response, '学习记录读取失败')
      if (!Array.isArray(body.items) || typeof body.total !== 'number') throw new Error('学习记录数据格式不正确')
      if (requestRef.current !== requestId) return
      setItems(current => append ? [...current, ...body.items] : body.items)
      setTotal(body.total)
    } catch (loadError) {
      if (requestRef.current !== requestId) return
      setError(loadError instanceof Error ? loadError.message : '学习记录读取失败')
      if (!append) { setItems([]); setTotal(0) }
    } finally {
      if (requestRef.current === requestId) { setLoading(false); setLoadingMore(false) }
    }
  }, [filters.action, filters.libraryId, filters.word])

  useEffect(() => {
    if (enabled) {
      const limit = reloadLimitRef.current
      reloadLimitRef.current = PAGE_SIZE
      void fetchPage(0, false, limit)
    }
  }, [enabled, fetchPage, version])

  const loadMore = useCallback(() => {
    if (!loading && !loadingMore && items.length < total) void fetchPage(items.length, true)
  }, [fetchPage, items.length, loading, loadingMore, total])

  const mutate = useCallback(async (url: string, fallback: string) => {
    setMutating(true)
    setError(null)
    try {
      const response = await fetch(`${API_BASE}${url}`, { method: 'DELETE' })
      await readJson<unknown>(response, fallback)
      // 交给 effect 使用最新筛选条件刷新，避免删除期间切换筛选时旧请求覆盖新结果。
      reloadLimitRef.current = Math.max(PAGE_SIZE, itemCountRef.current)
      setVersion(current => current + 1)
      return true
    } catch (mutationError) {
      setError(mutationError instanceof Error ? mutationError.message : fallback)
      return false
    } finally { setMutating(false) }
  }, [])

  const removeEvent = useCallback((eventId: string) => mutate(
    `/api/study/history/events/${encodeURIComponent(eventId)}`, '这条学习记录删除失败',
  ), [mutate])
  const clearWord = useCallback((word: string) => mutate(
    `/api/study/history/words/${encodeURIComponent(word)}`, '这个单词的学习记录清空失败',
  ), [mutate])

  const purge = useCallback(async (body: { words: string[] } | { all: true }, fallback: string) => {
    setMutating(true)
    setError(null)
    try {
      const response = await fetch(`${API_BASE}/api/study/history/purge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      await readJson<unknown>(response, fallback)
      reloadLimitRef.current = Math.max(PAGE_SIZE, itemCountRef.current)
      setVersion(current => current + 1)
      return true
    } catch (mutationError) {
      setError(mutationError instanceof Error ? mutationError.message : fallback)
      return false
    } finally { setMutating(false) }
  }, [])

  const purgeWords = useCallback((words: string[]) => purge(
    { words }, '选中的学习记录物理删除失败',
  ), [purge])
  const purgeAll = useCallback(() => purge(
    { all: true }, '全部学习记录物理删除失败',
  ), [purge])

  return {
    items, total, loading, loadingMore, mutating, error, hasMore: items.length < total,
    reload, loadMore, removeEvent, clearWord, purgeWords, purgeAll,
  }
}
