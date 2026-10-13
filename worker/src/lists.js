/**
 * lists.js — 学习列表领域服务（从 dict-server.mjs 移植）
 *
 * store（study-lists.js）只管表 ↔ 行；这里负责「列表数据」这一层的语义：
 * 字段补齐、释义选择快照、标签 / 目标 / 打印批次三份小文档、批次富化等。
 * 所有函数都是 async——底下是 D1。
 */

import { normalizeText, capitalizeSentence } from './text.js'
import { createStudyListsStore } from './study-lists.js'
import { KV_KEYS } from './kv.js'
import { nextDueAt, studyState, pushMark } from './review.js'
import { expandedTranslations, formatSelectedTranslations } from './dict.js'

/** 默认列表：始终存在，不允许删除 */
export const DEFAULT_LIST_ID = 'default'

// ── 容量上限（与本地版一致） ────────────────────────────────────────────────

/** 学习列表里一个词最多勾选多少条释义 */
export const MAX_PICKED_SENSES = 12
/** 学习列表里一个词最多勾选多少条中文词义 */
export const MAX_PICKED_TRANSLATIONS = 12
/** 一个词最多几条自定义词义；超出部分丢弃，避免快照串过长 */
export const MAX_CUSTOM_TRANSLATIONS = 6
/** 单条自定义词义最长多少字，与中文摘要截断保持同一量级 */
export const MAX_CUSTOM_TRANSLATION_LEN = 60
/** 标签长度上限，避免把整段描述塞进标签里 */
export const MAX_LABEL_LENGTH = 40
/** 词库 id 再长就是脏数据了 */
export const MAX_LIBRARY_ID_LENGTH = 80

// ── 词条字段归一化 ──────────────────────────────────────────────────────────

/**
 * 判定词条类型：
 * - 命中任意词库（sourceIds 非空）→ 词库条目，即使是 "a few" 这类固定短语也算 word
 * - 否则含空白 → 句子
 */
export function detectType(input, sourceIds) {
  if (Array.isArray(sourceIds) && sourceIds.length > 0) return 'word'
  return /\s/.test(normalizeText(input)) ? 'sentence' : 'word'
}

/** 要背的释义 id：去空、去重、限量。返回空数组表示「没挑」，调用方不写这个字段。 */
export function normalizeSenseIds(input) {
  if (!Array.isArray(input)) return []
  const out = []
  for (const raw of input) {
    const id = String(raw ?? '').trim()
    if (!id || out.includes(id)) continue
    out.push(id)
    if (out.length >= MAX_PICKED_SENSES) break
  }
  return out
}

/**
 * 用户手填的自定义词义：去空、去重（不区分大小写）、限长度限量。
 * 返回空数组表示没有自定义词义，调用方不写这个字段。
 */
export function normalizeCustomTranslations(input) {
  if (!Array.isArray(input)) return []
  const out = []
  const seen = new Set()
  for (const raw of input) {
    const text = String(raw ?? '').trim()
    if (!text || text.length > MAX_CUSTOM_TRANSLATION_LEN) continue
    const key = text.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(text)
    if (out.length >= MAX_CUSTOM_TRANSLATIONS) break
  }
  return out
}

/** 中文词义 id：去空、去重、限量；空数组表示使用默认中文摘要。 */
export function normalizeTranslationIds(input) {
  if (!Array.isArray(input)) return []
  const out = []
  for (const raw of input) {
    const id = String(raw ?? '').trim()
    if (!id || out.includes(id)) continue
    out.push(id)
    if (out.length >= MAX_PICKED_TRANSLATIONS) break
  }
  return out
}

// ── 学习列表读写 ────────────────────────────────────────────────────────────

function makeDefaultList() {
  return { id: DEFAULT_LIST_ID, name: '默认列表', createdAt: Date.now(), words: [] }
}

/** { lists: [ { id, name, createdAt, batchNames, words: [StudyWordItem] } ] } */
export async function loadLists(app) {
  // 数据在 D1 的 lists / list_words 表里；store 返回和老 json 同构的结构
  const data = await app.listsStore.load()
  // default 列表必须存在
  if (!data.lists.some(l => l.id === DEFAULT_LIST_ID)) {
    data.lists.unshift(makeDefaultList())
  }
  // 老数据补齐字段
  for (const list of data.lists) {
    if (!Array.isArray(list.words)) list.words = []
    // 批次显示名：形如 { '2026-09-15': '秋词汇' }，没有自定义名的日期留在日期本身
    if (!list.batchNames || typeof list.batchNames !== 'object' || Array.isArray(list.batchNames)) {
      list.batchNames = {}
    }
    for (const item of list.words) {
      if (!Array.isArray(item.sourceIds)) item.sourceIds = []
      if (!item.type) item.type = detectType(item.word, item.sourceIds)
      if (item.type === 'sentence') item.displayText = capitalizeSentence(item.displayText || item.word)
      else delete item.displayText
      // 中文翻译是加入列表时保存的快照；兼容旧词条和空值
      if ('translation' in item) {
        const translation = String(item.translation ?? '').trim()
        if (translation) item.translation = translation
        else delete item.translation
      }
      // 只背某几条释义；空数组不落盘，字段缺省 = 自动（中文 + 第一条英文释义）
      if ('senseIds' in item) {
        const ids = normalizeSenseIds(item.senseIds)
        if (ids.length) item.senseIds = ids
        else delete item.senseIds
      }
      if ('translationIds' in item) {
        const ids = normalizeTranslationIds(item.translationIds)
        if (ids.length) item.translationIds = ids
        else delete item.translationIds
      }
      // 自定义词义：旧数据没有这个字段；存在就顺手归一化
      if ('customTranslations' in item) {
        const customs = normalizeCustomTranslations(item.customTranslations)
        if (customs.length) item.customTranslations = customs
        else delete item.customTranslations
      }
      // 批次归属：缺省按 addedAt 自然日分批；自定义批次键 b:... 原样保留
      if ('batchKey' in item) {
        const key = String(item.batchKey ?? '').trim()
        if (key) item.batchKey = key
        else delete item.batchKey
      }
      // 复习进度字段只在开始学习后才写，未开始的词保持精简
      if (item.startedAt) {
        if (typeof item.stage !== 'number' || !(item.stage >= 0)) item.stage = 0
        if (!Array.isArray(item.reviewedAt)) item.reviewedAt = []
      }
    }
  }
  return data
}

export async function saveLists(app, data) {
  // 一个 batch（事务）整库重写；marks 镜像已废弃，事件表是唯一来源
  await app.listsStore.save(data)
}

/** 把词典里已经拿到的中文翻译同步到学习列表词条；不改变列表页面的展示规则。 */
export async function syncListTranslation(word, entry, app) {
  const target = normalizeText(word)
  if (!target) return false
  const data = await loadLists(app)
  let changed = false
  for (const list of data.lists) {
    for (const item of list.words) {
      if (item.word !== target) continue
      if (String(item.translation ?? '').trim()) continue
      const value = selectedTranslation(entry, item.translationIds)
      if (!value) continue
      item.translation = value
      changed = true
    }
  }
  if (changed) await saveLists(app, data)
  return changed
}

// ── 中文快照选择 ────────────────────────────────────────────────────────────

/**
 * 选中中文词义 + 自定义词义 →「选中词义；自定义」；没选中词义但填了自定义 → 只剩自定义。
 * 与前端 formatTranslationWithCustom 保持同一合并语义。
 */
export function selectedTranslation(entry, ids, customs) {
  const choices = expandedTranslations(entry?.translations)
  const wanted = normalizeTranslationIds(ids)
  const picked = []
  if (wanted.length > 0) {
    for (const id of wanted) {
      const exact = choices.find(item => item.id === id)
      if (exact) { picked.push(exact); continue }
      // 兼容旧数据：旧版把同一词性下的逗号释义保存成一个基础 ID。
      for (const item of choices) {
        if (item.id.startsWith(String(id) + '::')) picked.push(item)
      }
    }
  }
  // 自定义词义没有词性，按输入顺序接在选中词义后面
  const extra = normalizeCustomTranslations(customs).map(text => ({ text }))
  if (picked.length > 0 || extra.length > 0) {
    const merged = formatSelectedTranslations(picked.concat(extra))
    if (merged) return merged
  }
  return String(entry?.translation ?? '').trim()
}

// ── 词库标签 ────────────────────────────────────────────────────────────────

/**
 * 词库标签：{ labels: { [词库id]: 显示标签 }, printLabels: { [词库id]: 打印标签 } }
 * 词库本体由前端在构建期打包 vocab/*.json，服务端只存「标签覆写」，没有覆写就用词库 id。
 */
export async function loadLabels(app) {
  const data = await app.kv.get(KV_KEYS.labels, null)
  const labels = {}
  const printLabels = {}
  if (data && typeof data.labels === 'object' && data.labels !== null) {
    for (const [id, label] of Object.entries(data.labels)) {
      if (typeof label === 'string' && label.trim()) labels[id] = label.trim()
    }
  }
  if (data && typeof data.printLabels === 'object' && data.printLabels !== null) {
    for (const [id, label] of Object.entries(data.printLabels)) {
      if (typeof label === 'string' && label.trim()) printLabels[id] = label.trim()
    }
  }
  return { labels, printLabels }
}

export async function saveLabels(app, data) { await app.kv.set(KV_KEYS.labels, data) }

// ── 学习目标 ────────────────────────────────────────────────────────────────

/**
 * 学习目标：{ libraryId } 指向某个词库 id，空串表示还没设过目标。
 * 词库本体在前端（构建期打包 vocab 目录下的 json），服务端只记「目标是哪个词库」。
 */
export async function loadGoal(app) {
  const data = await app.kv.get(KV_KEYS.goal, null)
  const libraryId = data && typeof data.libraryId === 'string' ? data.libraryId.trim() : ''
  return { libraryId }
}

export async function saveGoal(app, data) { await app.kv.set(KV_KEYS.goal, data) }

// ── 打印批次（导出卡片的留档） ─────────────────────────────────────────────

/** 最多留多少条打印记录，超了丢最老的 */
export const MAX_PRINT_BATCHES = 60
/** GET 默认返回多少条 */
export const DEFAULT_PRINT_LIMIT = 20
/** 批次标题长度上限 */
export const MAX_PRINT_TITLE = 80
/** 批次来源：start 挑新词 / review 复习计划 / custom 自由挑选打印 */
export const PRINT_KINDS = new Set(['start', 'review', 'custom'])

/**
 * { batches: [ { id, printedAt, kind, scope?, title, wordCount, items: [{ listId, listName, word }] } ] }
 * 批次只存「打印了哪些词」，每个词的进度读接口时从学习列表现算，
 * 免得同一个词在两处各存一份状态、互相矛盾。
 */
export async function loadPrints(app) {
  const data = await app.kv.get(KV_KEYS.prints, null)
  if (!data || !Array.isArray(data.batches)) return { batches: [] }
  for (const batch of data.batches) {
    if (!Array.isArray(batch.items)) batch.items = []
  }
  return data
}

export async function savePrints(app, data) { await app.kv.set(KV_KEYS.prints, data) }

/** 批次 id 用打印时间；同一毫秒内又打了一批就加后缀 */
export function uniquePrintId(batches, printedAt) {
  const base = 'print_' + printedAt
  let id = base
  for (let i = 1; batches.some(b => b.id === id); i++) id = base + '_' + i
  return id
}

/**
 * 打印批次按 listId + 规范化后的 word 判定内容是否相同。排序后再序列化，
 * 因此跨列表的同一组词即使传入顺序不同，也只保留最近创建的一条记录。
 */
export function printBatchItemsKey(items) {
  if (!Array.isArray(items)) return ''
  return items
    .map(item => [String(item?.listId ?? '').trim(), normalizeText(item?.word)])
    .filter(([listId, word]) => listId && word)
    .map(pair => JSON.stringify(pair))
    .sort()
    .join('\n')
}

/** 批次 + 每个词的当前进度：dueCount / markableCount / missingCount 都是现算的，不落盘 */
export function enrichBatch(batch, lists, now, env) {
  const items = []
  let dueCount = 0, markableCount = 0, missingCount = 0
  for (const ref of batch.items) {
    const list = lists.find(l => l.id === ref.listId)
    const item = list ? list.words.find(w => w.word === ref.word) : undefined
    if (!item) {
      // 打印之后这个词被从列表里删了，记录还留着但不参与打卡
      missingCount++
      items.push({
        listId: ref.listId,
        listName: (list && list.name) || ref.listName || ref.listId,
        word: ref.word,
        missing: true,
      })
      continue
    }
    const state = studyState(item, now, env)
    if (state === 'due') dueCount++
    if (item.startedAt) markableCount++
    items.push({
      listId: list.id,
      listName: list.name,
      word: item.word,
      state,
      stage: item.stage || 0,
      nextDueAt: nextDueAt(item, env),
    })
  }
  return Object.assign({}, batch, { items, dueCount, markableCount, missingCount })
}

// ── 学习事件 ────────────────────────────────────────────────────────────────

/** 打标日志统一走事件表；列表名随事件快照，改名不影响历史 */
export function recordStudyEvent(app, list, event) {
  return app.history.record({
    item: event.item, listId: list.id, listName: list.name, action: event.action,
    at: event.at, scope: event.scope, stage: event.stage, requestId: event.requestId,
    eventKey: event.eventKey, metadata: event.metadata,
  })
}

// ── 组装 ────────────────────────────────────────────────────────────────────

/** 每个请求建一份 app 上下文：store 们共享同一条 db 适配层 */
export function createAppServices(db) {
  return {
    listsStore: createStudyListsStore(db),
  }
}
