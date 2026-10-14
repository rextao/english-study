import { useState, useCallback } from 'react'

import { invalidateApiCache, queryApi } from '../utils/apiCache'

export type StudyStatus = 'unknown' | 'checking' | 'in-study' | 'not-in-study' | 'adding' | 'error'

const MEMBERSHIP_CACHE_TTL = 5 * 60 * 1000

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
    setStatusMap(prev => ({ ...prev, [w]: 'checking' }))
    try {
      const data = await queryApi<{ listIds: string[] }>(
        '/api/word-lists?word=' + encodeURIComponent(w), {},
        { staleTime: MEMBERSHIP_CACHE_TTL, tags: ['word-lists', 'word-lists:' + w] },
      )
      setWordListMap(prev => ({ ...prev, [w]: data.listIds }))
      setStatusMap(prev => ({ ...prev, [w]: data.listIds.length > 0 ? 'in-study' : 'not-in-study' }))
    } catch {
      setStatusMap(prev => ({ ...prev, [w]: 'error' }))
    }
  }, [])

  const markAdded = useCallback((word: string, listId: string) => {
    const w = word.toLowerCase()
    invalidateApiCache(['word-lists:' + w, 'lists'])
    setWordListMap(prev => {
      const current = prev[w] ?? []
      if (current.includes(listId)) return prev
      return { ...prev, [w]: [...current, listId] }
    })
    setStatusMap(prev => ({ ...prev, [w]: 'in-study' }))
  }, [])

  return { getStatus, getListIds, checkWord, markAdded }
}

/**
 * 作废这些词的「在哪些列表里」缓存（学习列表页增删词后调用）。
 * 支持一次传一批词：只扫一遍缓存，导入几百个词时不会变成几百次全量扫描。
 *
 * 只作废成员关系本身：history / achievements 是按事件自己记的 source_ids 快照过滤的
 * （见 worker/src/study-history.js 的 matchesLibrary），增删词不会改事件账本，
 * 带上它们只会让记录页多做一次无谓刷新；需要一起刷的 study-plan 由各调用方自己作废。
 */
export function invalidateMembership(words: string | string[]): void {
  const list = (Array.isArray(words) ? words : [words])
    .map(value => value.trim().toLowerCase())
    .filter(Boolean)
  if (list.length === 0) return
  invalidateApiCache(list.map(value => 'word-lists:' + value))
}

/**
 * 删列表时调用：被删的列表可能出现在任意已查过的单词成员关系里，
 * 按单词逐个摘除做不到，直接作废整个成员资格集合，下次查词重打接口。
 */
export function invalidateListMembership(): void {
  invalidateApiCache(['word-lists'])
}
