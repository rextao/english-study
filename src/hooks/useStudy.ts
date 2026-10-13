import { useState, useCallback } from 'react'

import { apiFetch } from '../utils/apiBase'

export type StudyStatus = 'unknown' | 'checking' | 'in-study' | 'not-in-study' | 'adding' | 'error'

/** 「某词在哪些列表里」短时间内的查询结果复用，切 tab 重建页面不重打接口 */
const MEMBERSHIP_CACHE_TTL = 5 * 60 * 1000
const membershipCache = new Map<string, { listIds: string[]; ts: number }>()

export function useStudy() {
  // word -> list ids that contain it
  const [wordListMap, setWordListMap] = useState<Record<string, string[]>>({})
  const [statusMap, setStatusMap]     = useState<Record<string, StudyStatus>>({})

  const getStatus = useCallback((word: string): StudyStatus => {
    return statusMap[word.toLowerCase()] ?? 'unknown'
  }, [statusMap])

  const getListIds = useCallback((word: string): string[] => {
    return wordListMap[word.toLowerCase()] ?? []
  }, [wordListMap])

  const checkWord = useCallback(async (word: string) => {
    const w = word.trim().toLowerCase()
    if (!w) return
    const cached = membershipCache.get(w)
    if (cached && Date.now() - cached.ts < MEMBERSHIP_CACHE_TTL) {
      setWordListMap(prev => ({ ...prev, [w]: cached.listIds }))
      setStatusMap(prev => ({ ...prev, [w]: cached.listIds.length > 0 ? 'in-study' : 'not-in-study' }))
      return
    }
    setStatusMap(prev => ({ ...prev, [w]: 'checking' }))
    try {
      const res = await apiFetch('/api/word-lists?word=' + encodeURIComponent(w))
      if (!res.ok) throw new Error()
      const data = await res.json() as { listIds: string[] }
      membershipCache.set(w, { listIds: data.listIds, ts: Date.now() })
      setWordListMap(prev => ({ ...prev, [w]: data.listIds }))
      setStatusMap(prev => ({ ...prev, [w]: data.listIds.length > 0 ? 'in-study' : 'not-in-study' }))
    } catch {
      setStatusMap(prev => ({ ...prev, [w]: 'error' }))
    }
  }, [])

  const markAdded = useCallback((word: string, listId: string) => {
    const w = word.toLowerCase()
    // 加词后同步更新缓存，下次查同一个词直接命中，不会还显示「未加入」
    const hit = membershipCache.get(w)
    if (hit && !hit.listIds.includes(listId)) hit.listIds = [...hit.listIds, listId]
    setWordListMap(prev => {
      const current = prev[w] ?? []
      if (current.includes(listId)) return prev
      return { ...prev, [w]: [...current, listId] }
    })
    setStatusMap(prev => ({ ...prev, [w]: 'in-study' }))
  }, [])

  return { getStatus, getListIds, checkWord, markAdded }
}

/** 作废某个词的「在哪些列表里」缓存（学习列表页删词后调用） */
export function invalidateMembership(word: string): void {
  membershipCache.delete(word.trim().toLowerCase())
}

/** 把某个列表从所有成员资格记录里摘掉；删列表时调用，成员资格清空的词整个删掉 */
export function invalidateListMembership(listId: string): void {
  for (const [word, entry] of membershipCache) {
    const rest = entry.listIds.filter(id => id !== listId)
    if (rest.length === entry.listIds.length) continue
    if (rest.length === 0) membershipCache.delete(word)
    else entry.listIds = rest
  }
}
