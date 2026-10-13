/**
 * study-lists.js — 学习列表 store（D1 版）
 *
 * 从 server/study-lists.mjs 移植：表结构、行 ↔ StudyWordItem 的映射逻辑原样保留，
 * 同步的 better-sqlite3 风格调用换成 db 适配层的异步接口；
 * 「一次事务整库重写」由 db.batch 承担（batch 即事务）。
 *
 * 没有 json 迁移逻辑：本地库由 scripts/migrate-to-d1.mjs 一次性导进 D1。
 */

import { normalizeText } from './text.js'

const INSERT_LIST_SQL = 'INSERT INTO lists (id, name, created_at, position, batch_names_json) VALUES (?, ?, ?, ?, ?)'

const INSERT_WORD_COLUMNS = [
  'list_id', 'word', 'position', 'type', 'display_text', 'source_ids_json', 'added_at',
  'phonetic', 'translation', 'sense_ids_json', 'translation_ids_json',
  'custom_translations_json', 'started_at', 'stage', 'reviewed_json',
  'last_done_at', 'review_scope', 'mark_count', 'review_count', 'spelling_count',
  'reading_count', 'remembered_count', 'forgotten_count', 'processed_review_keys_json',
  'batch_key',
]
const INSERT_WORD_SQL = 'INSERT INTO list_words (' + INSERT_WORD_COLUMNS.join(', ')
  + ') VALUES (' + INSERT_WORD_COLUMNS.map(() => '?').join(', ') + ')'

const RESET_STATS_SQL = 'UPDATE list_words SET reviewed_json = ?, mark_count = 0, review_count = 0,'
  + ' spelling_count = 0, reading_count = 0, remembered_count = 0, forgotten_count = 0'

const COUNT_FIELDS = [
  ['markCount', 'mark_count'], ['reviewCount', 'review_count'],
  ['spellingCount', 'spelling_count'], ['readingCount', 'reading_count'],
  ['rememberedCount', 'remembered_count'], ['forgottenCount', 'forgotten_count'],
]

function json(value) {
  return JSON.stringify(value ?? null)
}

function parseJson(value, fallback) {
  try { return JSON.parse(value) }
  catch { return fallback }
}

function normalizeBatchNames(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

/**
 * 数据库里的一行 -> 老结构里的 StudyWordItem。
 * 只回填有值的字段，缺省字段直接不出现——上层和前端都靠「字段在不在」区分自动 / 手动。
 */
function rowToItem(row) {
  const item = {
    word: row.word,
    type: row.type,
    sourceIds: parseJson(row.source_ids_json, []),
    addedAt: Number(row.added_at),
  }
  if (row.display_text) item.displayText = row.display_text
  if (row.phonetic) item.phonetic = row.phonetic
  if (row.translation) item.translation = row.translation
  const senseIds = parseJson(row.sense_ids_json, [])
  if (Array.isArray(senseIds) && senseIds.length) item.senseIds = senseIds
  const translationIds = parseJson(row.translation_ids_json, [])
  if (Array.isArray(translationIds) && translationIds.length) item.translationIds = translationIds
  const customs = parseJson(row.custom_translations_json, [])
  if (Array.isArray(customs) && customs.length) item.customTranslations = customs
  // 复习进度字段只在开始学习后才存在；startedAt 是假值（含 NULL）就当没有，
  // 和老 json 的 if (item.startedAt) 语义一致——Number(null) 会变成 0，不能直接转
  if (row.started_at) {
    item.startedAt = Number(row.started_at)
    const stage = Number(row.stage)
    if (Number.isFinite(stage)) item.stage = stage
  }
  const reviewedAt = parseJson(row.reviewed_json, [])
  if (Array.isArray(reviewedAt) && reviewedAt.length) item.reviewedAt = reviewedAt.map(Number)
  if (row.last_done_at) item.lastDoneAt = Number(row.last_done_at)
  if (row.review_scope) item.reviewScope = row.review_scope
  for (const [field, column] of COUNT_FIELDS) {
    const num = Number(row[column])
    if (Number.isFinite(num) && num > 0) item[field] = num
  }
  const keys = parseJson(row.processed_review_keys_json, [])
  if (Array.isArray(keys) && keys.length) item.processedReviewKeys = keys
  if (row.batch_key) item.batchKey = row.batch_key
  return item
}

/** 老结构里的 StudyWordItem -> 一行参数（顺序 = INSERT_WORD_COLUMNS） */
export function itemToRow(listId, item, position) {
  const word = String(item?.word ?? '')
  const sourceIds = Array.isArray(item?.sourceIds) ? item.sourceIds : []
  const hasWhitespace = /\s/.test(word)
  const type = item?.type === 'sentence' ? 'sentence'
    : (item?.type === 'word' || sourceIds.length > 0 || !hasWhitespace ? 'word' : 'sentence')
  const reviewedAt = Array.isArray(item?.reviewedAt)
    ? item.reviewedAt.map(v => Number(v)).filter(v => Number.isFinite(v))
    : []
  const startedAt = Number(item?.startedAt)
  const stage = Number(item?.stage)
  const lastDoneAt = Number(item?.lastDoneAt)
  return [
    listId, word, position, type,
    item?.displayText ? String(item.displayText) : null,
    json(sourceIds),
    Number.isFinite(Number(item?.addedAt)) ? Number(item.addedAt) : Date.now(),
    item?.phonetic ? String(item.phonetic) : null,
    item?.translation ? String(item.translation) : null,
    json(Array.isArray(item?.senseIds) ? item.senseIds : []),
    json(Array.isArray(item?.translationIds) ? item.translationIds : []),
    json(Array.isArray(item?.customTranslations) ? item.customTranslations : []),
    Number.isFinite(startedAt) ? startedAt : null,
    Number.isFinite(stage) ? stage : null,
    json(reviewedAt),
    Number.isFinite(lastDoneAt) ? lastDoneAt : null,
    item?.reviewScope === 'week' ? 'week' : (item?.reviewScope === 'day' ? 'day' : null),
    Math.max(0, Number(item?.markCount) || 0),
    Math.max(0, Number(item?.reviewCount) || 0),
    Math.max(0, Number(item?.spellingCount) || 0),
    Math.max(0, Number(item?.readingCount) || 0),
    Math.max(0, Number(item?.rememberedCount) || 0),
    Math.max(0, Number(item?.forgottenCount) || 0),
    json(Array.isArray(item?.processedReviewKeys) ? item.processedReviewKeys : []),
    item?.batchKey ? String(item.batchKey) : null,
  ]
}

export function createStudyListsStore(db) {
  /** 把全部 lists / list_words 行装回和老 json 同构的结构（两个查询搞定，不分列表循环查） */
  async function load() {
    const listRows = await db.all('SELECT * FROM lists ORDER BY position, id')
    const wordRows = await db.all('SELECT * FROM list_words ORDER BY position, word')
    const wordsByList = new Map()
    for (const row of wordRows) {
      if (!wordsByList.has(row.list_id)) wordsByList.set(row.list_id, [])
      wordsByList.get(row.list_id).push(rowToItem(row))
    }
    return {
      lists: listRows.map(row => ({
        id: row.id,
        name: row.name,
        createdAt: Number(row.created_at),
        batchNames: normalizeBatchNames(parseJson(row.batch_names_json, {})),
        words: wordsByList.get(row.id) || [],
      })),
    }
  }

  function statementsFor(lists) {
    const statements = [['DELETE FROM list_words'], ['DELETE FROM lists']]
    lists.forEach((list, index) => {
      statements.push([
        INSERT_LIST_SQL,
        String(list?.id ?? ''), String(list?.name ?? ''),
        Number.isFinite(Number(list?.createdAt)) ? Number(list.createdAt) : Date.now(),
        index, json(normalizeBatchNames(list?.batchNames)),
      ])
      const words = Array.isArray(list?.words) ? list.words : []
      words.forEach((word, wi) => statements.push([INSERT_WORD_SQL, ...itemToRow(String(list.id), word, wi)]))
    })
    return statements
  }

  /** 整库重写：一个 batch（= 一个事务）里 DELETE 全部再按数组顺序插入 */
  async function save(data) {
    const lists = Array.isArray(data?.lists) ? data.lists : []
    await db.batch(statementsFor(lists))
  }

  /**
   * 事件被 purge 后，列表里冗余的累计计数 / 复习时间也要一起回退，否则统计会和事件表对不上。
   * 排期锚点（startedAt / stage / lastDoneAt）和幂等键保持不变，维持当前进度。
   */
  async function resetStats({ words, all }) {
    if (all === true) {
      const changes = await db.run(RESET_STATS_SQL, json([]))
      return { reset: changes }
    }
    const keys = [...new Set((Array.isArray(words) ? words : [])
      .map(value => normalizeText(value)).filter(Boolean))]
    if (keys.length === 0) return { reset: 0 }
    const placeholders = keys.map(() => '?').join(', ')
    const changes = await db.run(RESET_STATS_SQL + ' WHERE word IN (' + placeholders + ')', json([]), ...keys)
    return { reset: changes }
  }

  return { load, save, resetStats }
}

/**
 * 测试断言用：用独立适配层读出整库（等价本地版 readStudyLists）。
 * 库还没建表时由调用方保证（shim 会先跑 schema）。
 */
export async function readStudyLists(db) {
  const listRows = await db.all('SELECT * FROM lists ORDER BY position, id')
  const wordRows = await db.all('SELECT * FROM list_words ORDER BY position, word')
  const wordsByList = new Map()
  for (const row of wordRows) {
    if (!wordsByList.has(row.list_id)) wordsByList.set(row.list_id, [])
    wordsByList.get(row.list_id).push(rowToItem(row))
  }
  return {
    lists: listRows.map(row => ({
      id: row.id,
      name: row.name,
      createdAt: Number(row.created_at),
      batchNames: normalizeBatchNames(parseJson(row.batch_names_json, {})),
      words: wordsByList.get(row.id) || [],
    })),
  }
}
