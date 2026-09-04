import { useState, useCallback } from 'react'

const SERVER = 'http://127.0.0.1:3456'

export type StudyStatus = 'unknown' | 'checking' | 'in-study' | 'not-in-study' | 'adding' | 'error'

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
      const res = await fetch(SERVER + '/api/word-lists?word=' + encodeURIComponent(w))
      if (!res.ok) throw new Error()
      const data = await res.json() as { listIds: string[] }
      setWordListMap(prev => ({ ...prev, [w]: data.listIds }))
      setStatusMap(prev => ({ ...prev, [w]: data.listIds.length > 0 ? 'in-study' : 'not-in-study' }))
    } catch {
      setStatusMap(prev => ({ ...prev, [w]: 'error' }))
    }
  }, [])

  const markAdded = useCallback((word: string, listId: string) => {
    const w = word.toLowerCase()
    setWordListMap(prev => {
      const current = prev[w] ?? []
      if (current.includes(listId)) return prev
      return { ...prev, [w]: [...current, listId] }
    })
    setStatusMap(prev => ({ ...prev, [w]: 'in-study' }))
  }, [])

  return { getStatus, getListIds, checkWord, markAdded }
}
