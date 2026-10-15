import type { VocabLibrary } from '../types/vocab'

/** 词库展示顺序：稳定 ID 排序，不受用户自定义标签影响。 */
const VOCAB_ORDER = [
  'cambridge-pre-a1-starters-2025',
  'cambridge-a1-movers-2025',
  'cambridge-a2-flyers-2025',
  'a2-key-2020',
] as const

const ORDER_INDEX = new Map<string, number>(VOCAB_ORDER.map((id, index) => [id, index]))
type VocabSourceMap = Map<string, string[]>
const sourceMapCache = new WeakMap<readonly VocabLibrary[], VocabSourceMap>()

export function compareVocabIds(a: string, b: string): number {
  const ai = ORDER_INDEX.get(a)
  const bi = ORDER_INDEX.get(b)
  if (ai != null && bi != null) return ai - bi
  if (ai != null) return -1
  if (bi != null) return 1
  return a.localeCompare(b)
}

export function primaryVocabId(ids: string[] | undefined): string | undefined {
  if (!ids || ids.length === 0) return undefined
  return [...new Set(ids)].sort(compareVocabIds)[0]
}

/** 兼容历史词条：旧数据只保存当时的 sourceIds，展示时重新按当前词库反查一次。 */
export function primaryVocabIdForWord(word: string, storedIds: string[] | undefined, libraries: VocabLibrary[]): string | undefined {
  const key = word.trim().toLowerCase()
  let sourceMap = sourceMapCache.get(libraries)
  if (!sourceMap) {
    sourceMap = new Map()
    for (const library of libraries) {
      for (const item of library.words) {
        const itemKey = item.word.trim().toLowerCase()
        const ids = sourceMap.get(itemKey) ?? []
        if (!ids.includes(library.id)) ids.push(library.id)
        sourceMap.set(itemKey, ids)
      }
    }
    sourceMapCache.set(libraries, sourceMap)
  }
  const currentIds = sourceMap.get(key) ?? []
  return primaryVocabId(currentIds.length > 0 ? currentIds : storedIds)
}

export const DEFAULT_VOCAB_LABELS: Record<string, string> = {
  'cambridge-pre-a1-starters-2025': 'Starters',
  'cambridge-a1-movers-2025': 'Movers',
  'cambridge-a2-flyers-2025': 'Flyers',
  'a2-key-2020': 'KET',
}
