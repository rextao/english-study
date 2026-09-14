import { useCallback, useMemo } from 'react'
import type { VocabLibrary } from '../types/vocab'

/** Returns the vocab library IDs that contain this exact word */
export function useVocabMatch(libraries: VocabLibrary[]) {
  const wordMap = useMemo(() => {
    const map = new Map<string, string[]>()
    for (const lib of libraries) {
      for (const entry of lib.words) {
        const key = entry.word.toLowerCase()
        if (!map.has(key)) map.set(key, [])
        map.get(key)!.push(lib.id)
      }
    }
    return map
  }, [libraries])

  const getSourceIds = useCallback((word: string): string[] => {
    return wordMap.get(word.trim().toLowerCase()) ?? []
  }, [wordMap])

  return { getSourceIds }
}
