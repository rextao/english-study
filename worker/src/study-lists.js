/**
 * study-lists.js — 学习列表 store（D1 版）
 *
 * 从 server/study-lists.mjs 移植：表结构、行 ↔ StudyWordItem 的映射逻辑原样保留，
 * 同步的 better-sqlite3 风格调用换成 db 适配层的异步接口；业务路径按列表 / 词条定向读写。
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

// 复习打卡只动这 12 列（INSERT_WORD_COLUMNS 的第 12–23 列）：
// 开始时间 / 轮次 / 打卡记录 / 最近打卡 / 排期粒度 / 各累计计数 / 幂等键。
// 行级更新路径只写这些列，position、音标、释义快照等一概不动。
const UPDATE_PROGRESS_COLUMNS = INSERT_WORD_COLUMNS.slice(12, 24)
const UPDATE_WORD_PROGRESS_SQL = 'UPDATE list_words SET '
  + UPDATE_PROGRESS_COLUMNS.map(column => column + ' = ?').join(', ')
  + ' WHERE list_id = ? AND word = ?'

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

/**
 * 打卡前后对比用的进度列快照（顺序 = UPDATE_WORD_PROGRESS_SQL 的 SET 段）。
 * 逐词比对前后的快照，只有进度列真正变化的词才需要写回——幂等跳过的词不产生 UPDATE。
 */
export function progressRow(listId, item) {
  return itemToRow(listId, item, 0).slice(12, 24)
}

export function createStudyListsStore(db) {
  /** 列表页摘要：只读列表头和计数，不解析整库词条 JSON。 */
  async function listSummaries() {
    return await db.all("SELECT l.id, l.name, l.created_at AS createdAt, COUNT(w.word) AS wordCount FROM lists l LEFT JOIN list_words w ON w.list_id = l.id GROUP BY l.id ORDER BY l.position, l.id")
  }

  /** 单列表词条读路径：只取该列表，不触碰其他列表。 */
  async function listWords(listId) {
    const rows = await db.all("SELECT * FROM list_words WHERE list_id = ? ORDER BY position, word", String(listId))
    return rows.map(rowToItem)
  }

  async function batchNames(listId) {
    const row = await db.first("SELECT batch_names_json FROM lists WHERE id = ?", String(listId))
    return normalizeBatchNames(parseJson(row?.batch_names_json, {}))
  }

  async function listIdsForWord(word) {
    return await db.all("SELECT list_id FROM list_words WHERE word = ? ORDER BY list_id", normalizeText(word))
  }

  /** 修复任务只扫描缺字段的唯一词，不装载 StudyWordItem。 */
  async function wordsNeedingRepair() {
    return await db.all("SELECT DISTINCT word FROM list_words WHERE phonetic IS NULL OR phonetic = '' OR translation IS NULL OR translation = '' ORDER BY word")
  }

  /** 计划页只读在学词，并带出列表名。 */
  async function activePlanRows() {
    const rows = await db.all("SELECT w.*, l.name AS list_name FROM list_words w JOIN lists l ON l.id = w.list_id WHERE w.started_at IS NOT NULL ORDER BY w.list_id, w.position")
    return rows.map(row => ({ listId: row.list_id, listName: row.list_name, item: rowToItem(row) }))
  }

  /** 后台补齐只回写缺失中文快照，不覆盖用户已有选择。 */
  async function itemsMissingTranslation(word) {
    const key = normalizeText(word)
    if (!key) return []
    const rows = await db.all("SELECT list_id, word, translation_ids_json FROM list_words WHERE word = ? AND (translation IS NULL OR translation = '')", key)
    return rows.map(row => ({
      listId: row.list_id,
      word: row.word,
      translationIds: parseJson(row.translation_ids_json, []),
    }))
  }

  async function syncTranslations(items) {
    const rows = (Array.isArray(items) ? items : []).filter(item => item?.translation)
    if (!rows.length) return 0
    const results = await db.batch(rows.map(item => [
      "UPDATE list_words SET translation = ? WHERE list_id = ? AND word = ? AND (translation IS NULL OR translation = '')",
      String(item.translation), String(item.listId), normalizeText(item.word),
    ]))
    return results.reduce((sum, changes) => sum + changes, 0)
  }

  /**
   * 行级读：只取某个列表里命中词的词条，打卡路径按 position 排序。
   */
  async function selectWords(listId, wordKeys) {
    const keys = [...new Set((Array.isArray(wordKeys) ? wordKeys : [])
      .map(key => normalizeText(key)).filter(Boolean))]
    if (keys.length === 0) return []
    const rows = []
    for (let i = 0; i < keys.length; i += 80) {
      const chunk = keys.slice(i, i + 80)
      const placeholders = chunk.map(() => '?').join(', ')
      rows.push(...await db.all(
        'SELECT * FROM list_words WHERE list_id = ? AND word IN (' + placeholders + ') ORDER BY position',
        String(listId), ...chunk))
    }
    rows.sort((a, b) => Number(a.position) - Number(b.position))
    return rows.map(rowToItem)
  }

  /** 列表名；lists 表里没有这一行就返回 null（列表不存在） */
  async function listName(listId) {
    const row = await db.first('SELECT name FROM lists WHERE id = ?', String(listId))
    return row ? row.name : null
  }

  async function listMeta(listId) {
    const row = await db.first('SELECT id, name, created_at, batch_names_json FROM lists WHERE id = ?', String(listId))
    if (!row) return null
    return {
      id: row.id, name: row.name, createdAt: Number(row.created_at),
      batchNames: normalizeBatchNames(parseJson(row.batch_names_json, {})), words: [],
    }
  }

  async function nameExists(name, exceptId = '') {
    return Boolean(await db.first('SELECT 1 AS found FROM lists WHERE name = ? AND id <> ? LIMIT 1', String(name), String(exceptId)))
  }

  async function insertList({ id, name, createdAt }) {
    const row = await db.first('SELECT COALESCE(MAX(position), -1) + 1 AS position FROM lists')
    await db.run(INSERT_LIST_SQL, String(id), String(name), Number(createdAt), Number(row?.position || 0), '{}')
  }

  async function renameList(listId, name) {
    return await db.run('UPDATE lists SET name = ? WHERE id = ?', String(name), String(listId))
  }

  async function deleteList(listId) {
    return await db.run('DELETE FROM lists WHERE id = ?', String(listId))
  }

  async function insertWords(listId, items, batchNames) {
    const list = await db.first('SELECT COALESCE(MAX(position), -1) + 1 AS position FROM list_words WHERE list_id = ?', String(listId))
    let position = Number(list?.position || 0)
    const statements = (Array.isArray(items) ? items : []).map(item => [INSERT_WORD_SQL, ...itemToRow(String(listId), item, position++)])
    if (batchNames !== undefined) statements.unshift([
      'UPDATE lists SET batch_names_json = ? WHERE id = ?', json(normalizeBatchNames(batchNames)), String(listId),
    ])
    if (statements.length) await db.batch(statements)
  }

  async function updateWordContent(listId, item) {
    const row = itemToRow(listId, item, 0)
    return await db.run(
      'UPDATE list_words SET display_text = ?, phonetic = ?, translation = ?, sense_ids_json = ?, translation_ids_json = ?, custom_translations_json = ? WHERE list_id = ? AND word = ?',
      row[4], row[7], row[8], row[9], row[10], row[11], String(listId), normalizeText(item.word),
    )
  }

  async function removeWords(listId, words) {
    const keys = [...new Set((Array.isArray(words) ? words : []).map(normalizeText).filter(Boolean))]
    let removed = 0
    for (let i = 0; i < keys.length; i += 80) {
      const chunk = keys.slice(i, i + 80)
      removed += await db.run('DELETE FROM list_words WHERE list_id = ? AND word IN (' + chunk.map(() => '?').join(', ') + ')', String(listId), ...chunk)
    }
    return removed
  }

  async function updateBatchNames(listId, batchNames) {
    return await db.run('UPDATE lists SET batch_names_json = ? WHERE id = ?', json(normalizeBatchNames(batchNames)), String(listId))
  }

  /**
   * 行级写：只 UPDATE 传入词的 12 个进度列，不动 position / 音标 / 释义快照，
   * 也不重写别的列表——把一次打卡的写盘量从「整库 DELETE + INSERT」压到「若干条 UPDATE」。
   */
  async function saveWordProgress(listId, items) {
    const words = (Array.isArray(items) ? items : []).filter(Boolean)
    if (words.length === 0) return
    const statements = words.map(item => [
      UPDATE_WORD_PROGRESS_SQL,
      ...progressRow(listId, item),
      String(listId), normalizeText(item.word),
    ])
    await db.batch(statements)
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

  return {
    resetStats, selectWords, listName, listMeta, nameExists, insertList, renameList, deleteList,
    insertWords, updateWordContent, removeWords, updateBatchNames, saveWordProgress,
    listSummaries, listWords, batchNames, listIdsForWord, wordsNeedingRepair,
    activePlanRows, itemsMissingTranslation, syncTranslations,
  }
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
