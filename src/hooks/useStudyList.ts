import { useState, useEffect, useCallback } from 'react'
import type { StudyList, StudyWordItem } from '../types/vocab'

const SERVER = 'http://127.0.0.1:3456'

/** 批量导入的一条记录：单词或句子 + 命中的词库 id */
export interface ImportItem {
  text: string
  sourceIds?: string[]
  /** 批量查询完成后生成的音标快照；确认导入时直接保存，不再重新请求 */
  phonetic?: string
  /** 这一阶段要背的释义 id，不填就是自动 */
  senseIds?: string[]
  /** 这一阶段要背的中文词义 id，不填就是默认全部中文词义 */
  translationIds?: string[]
  /** 批量查询完成后生成的中文快照；确认导入时直接保存，不再重新请求 */
  translation?: string
  /** 用户手填的自定义词义；已并入 translation 快照，这里只用于持久化后还原编辑 */
  customTranslations?: string[]
}

interface Reply<T> {
  status: number
  data: T | null
  /** fetch 直接失败，说明本地服务没起 */
  offline: boolean
}

async function request<T>(url: string, init?: RequestInit): Promise<Reply<T>> {
  try {
    const res = await fetch(SERVER + url, init)
    let data: T | null = null
    try { data = await res.json() as T } catch { /* 非 JSON 响应 */ }
    return { status: res.status, data, offline: false }
  } catch {
    return { status: 0, data: null, offline: true }
  }
}

function jsonInit(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }
}

const listPath = (listId: string) => '/api/lists/' + encodeURIComponent(listId)

export type StudyListApi = ReturnType<typeof useStudyList>

export function useStudyList() {
  const [lists, setLists]     = useState<StudyList[]>([])
  const [loading, setLoading] = useState(true)
  const [offline, setOffline] = useState(false)

  const fetchLists = useCallback(async () => {
    const reply = await request<StudyList[]>('/api/lists')
    setOffline(reply.offline)
    if (Array.isArray(reply.data)) setLists(reply.data)
    setLoading(false)
  }, [])

  useEffect(() => { fetchLists() }, [fetchLists])

  /** 新建列表；名称重复时返回错误信息 */
  const createList = useCallback(async (name: string) => {
    const reply = await request<{ ok: boolean; id: string; error?: string }>(
      '/api/lists', jsonInit('POST', { name })
    )
    if (reply.offline) return { ok: false as const, error: '本地服务未启动' }
    if (!reply.data?.ok) return { ok: false as const, error: reply.data?.error ?? '新建失败' }
    await fetchLists()
    return { ok: true as const, id: reply.data.id }
  }, [fetchLists])

  /** 重命名列表 */
  const renameList = useCallback(async (listId: string, name: string) => {
    const reply = await request<{ ok: boolean; error?: string }>(
      listPath(listId), jsonInit('PATCH', { name })
    )
    if (reply.offline) return { ok: false as const, error: '本地服务未启动' }
    if (!reply.data?.ok) return { ok: false as const, error: reply.data?.error ?? '重命名失败' }
    await fetchLists()
    return { ok: true as const }
  }, [fetchLists])

  /** 删除列表（default 会被服务端拒绝） */
  const deleteList = useCallback(async (listId: string) => {
    const reply = await request<{ ok: boolean; error?: string }>(
      listPath(listId), { method: 'DELETE' }
    )
    if (reply.offline) return { ok: false as const, error: '本地服务未启动' }
    if (!reply.data?.ok) return { ok: false as const, error: reply.data?.error ?? '删除失败' }
    await fetchLists()
    return { ok: true as const }
  }, [fetchLists])

  /** 加入单个词 / 句子 */
  const addItem = useCallback(async (
    listId: string, text: string, sourceIds: string[], senseIds?: string[], translationIds?: string[],
    translation?: string, phonetic?: string, customTranslations?: string[],
  ) => {
    const reply = await request<{ ok: boolean; reason?: string; item?: StudyWordItem }>(
      listPath(listId) + '/words',
      jsonInit('POST', { text, sourceIds, senseIds, translationIds, translation, phonetic, customTranslations }),
    )
    if (reply.offline) return { ok: false as const, reason: '本地服务未启动' }
    if (!reply.data?.ok) return { ok: false as const, reason: reply.data?.reason ?? '添加失败' }
    await fetchLists()
    return { ok: true as const, item: reply.data.item }
  }, [fetchLists])

  /** 批量导入；queued = 服务端后台排队补音标的词数 */
  const importItems = useCallback(async (listId: string, items: ImportItem[]) => {
    const reply = await request<{ ok: boolean; added: number; skipped: number; queued?: number }>(
      listPath(listId) + '/import', jsonInit('POST', { items })
    )
    if (reply.offline || !reply.data?.ok) return null
    await fetchLists()
    return { added: reply.data.added, skipped: reply.data.skipped, queued: reply.data.queued ?? 0 }
  }, [fetchLists])

  /** 读取某个列表下的全部词条 */
  const fetchListWords = useCallback(async (listId: string): Promise<StudyWordItem[]> => {
    const reply = await request<StudyWordItem[]>(listPath(listId) + '/words')
    return Array.isArray(reply.data) ? reply.data : []
  }, [])

  /** 读取列表的批次显示名（按导入自然日分组） */
  const fetchBatches = useCallback(async (listId: string): Promise<Record<string, string>> => {
    const reply = await request<{ batchNames: Record<string, string> }>(listPath(listId) + '/batches')
    return reply.data?.batchNames ?? {}
  }, [])

  /** 重命名某个批次；name 空串=重置为日期；服务不可用/失败返回 null */
  const renameBatch = useCallback(async (listId: string, date: string, name: string): Promise<Record<string, string> | null> => {
    const reply = await request<{ ok: boolean; batchNames?: Record<string, string> }>(
      listPath(listId) + '/batches', jsonInit('PATCH', { date, name })
    )
    if (reply.offline || !reply.data?.ok) return null
    return reply.data.batchNames ?? {}
  }, [])

  /** 从列表移除某个词条 */
  const removeItem = useCallback(async (listId: string, text: string) => {
    const reply = await request<{ ok: boolean }>(
      listPath(listId) + '/words/' + encodeURIComponent(text), { method: 'DELETE' }
    )
    if (!reply.data?.ok) return false
    await fetchLists()
    return true
  }, [fetchLists])

  /**
   * 批量移除词条：一次请求删掉一批，服务端只写一次盘。
   * removed = 真的删掉几条，missing = 传过去但列表里已经没有的几条；服务不可用返回 null。
   */
  const removeItems = useCallback(async (listId: string, words: string[]) => {
    if (words.length === 0) return { removed: 0, missing: 0 }
    const reply = await request<{ ok: boolean; removed: number; missing?: number }>(
      listPath(listId) + '/remove', jsonInit('POST', { words })
    )
    if (reply.offline || !reply.data?.ok) return null
    await fetchLists()
    return { removed: reply.data.removed, missing: reply.data.missing ?? 0 }
  }, [fetchLists])

  /** 改某个词条这一阶段要背的释义；传空数组 = 恢复自动 */
  const updateItemSenses = useCallback(async (
    listId: string, text: string, senseIds: string[],
  ): Promise<StudyWordItem | null> => {
    const reply = await request<{ ok: boolean; item?: StudyWordItem }>(
      listPath(listId) + '/words/' + encodeURIComponent(text),
      jsonInit('PATCH', { senseIds })
    )
    if (!reply.data?.ok) return null
    return reply.data.item ?? null
  }, [])

  /** 修改这一阶段要背的中文词义；空数组恢复默认摘要 */
  const updateItemTranslations = useCallback(async (
    listId: string, text: string, translationIds: string[], translation: string,
    customTranslations?: string[],
  ): Promise<StudyWordItem | null> => {
    const reply = await request<{ ok: boolean; item?: StudyWordItem }>(
      listPath(listId) + '/words/' + encodeURIComponent(text),
      jsonInit('PATCH', { translationIds, translation, customTranslations })
    )
    if (!reply.data?.ok) return null
    return reply.data.item ?? null
  }, [])

  /** 某个词在哪些学习列表里 */
  const getWordListIds = useCallback(async (word: string): Promise<string[]> => {
    const reply = await request<{ listIds: string[] }>(
      '/api/word-lists?word=' + encodeURIComponent(word)
    )
    return reply.data?.listIds ?? []
  }, [])

  const getListName = useCallback(
    (listId: string) => lists.find(l => l.id === listId)?.name ?? listId,
    [lists]
  )

  return {
    lists, loading, offline,
    fetchLists, createList, renameList, deleteList,
    addItem, importItems, fetchListWords, removeItem, removeItems,
    fetchBatches, renameBatch,
    updateItemSenses, getWordListIds, getListName,
    updateItemTranslations,
  }
}
