import type { StudyWordItem } from '../types/vocab'

/**
 * 学习列表读结果的模块级内存缓存（词条 + 分组名）。
 *
 * useStudyList / useStudyPlan / usePrintBatches 都会改 list_words 表，但它们互相不认识，
 * 「写完立刻作废」只能收口到这份共享模块：任一 hook 写完调一下 invalidate*，所有页面
 * 切 tab 重建时都能拿到新数据，不会停在打卡前的旧状态。
 *
 * 有效期 5 分钟，纯属削减重复请求；过期就老老实实重打接口。
 */
const READ_CACHE_TTL = 5 * 60 * 1000

const wordsCache   = new Map<string, { words: StudyWordItem[]; ts: number }>()
const batchesCache = new Map<string, { names: Record<string, string>; ts: number }>()

/** 命中且未过期才返回数据，否则返回 null 让调用方去打接口 */
export function readWords(listId: string): StudyWordItem[] | null {
  const hit = wordsCache.get(listId)
  return hit && Date.now() - hit.ts < READ_CACHE_TTL ? hit.words : null
}

/** offline 拿到的空表不要写进来，免得网络恢复后还显示空列表 */
export function writeWords(listId: string, words: StudyWordItem[]): void {
  wordsCache.set(listId, { words, ts: Date.now() })
}

export function readBatches(listId: string): Record<string, string> | null {
  const hit = batchesCache.get(listId)
  return hit && Date.now() - hit.ts < READ_CACHE_TTL ? hit.names : null
}

export function writeBatches(listId: string, names: Record<string, string>): void {
  batchesCache.set(listId, { names, ts: Date.now() })
}

/** 加词 / 删词 / 改释义 / 打卡排期变化之后调用 */
export function invalidateWords(listId: string): void {
  wordsCache.delete(listId)
}

/** 重命名分组之后调用 */
export function invalidateBatches(listId: string): void {
  batchesCache.delete(listId)
}

/** 删列表：词条和分组名一起作废 */
export function invalidateList(listId: string): void {
  invalidateWords(listId)
  invalidateBatches(listId)
}
