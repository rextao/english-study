import fs from 'node:fs'
import path from 'node:path'
import { openStudyDb, openStudyDbSnapshot } from './db.mjs'
import { normalizeText } from './text.mjs'

/** 一次性迁移标记：跑过一次就不再跑，老 json 随之删除 */
const MIGRATION_KEY = 'study-lists-to-sqlite-v1'

const CREATE_MIGRATIONS = 'CREATE TABLE IF NOT EXISTS schema_migrations (key TEXT PRIMARY KEY, applied_at INTEGER NOT NULL) STRICT'

const CREATE_LISTS = [
  'CREATE TABLE IF NOT EXISTS lists (',
  'id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL,',
  'position INTEGER NOT NULL, batch_names_json TEXT NOT NULL',
  ') STRICT',
].join(' ')

const CREATE_LIST_WORDS = [
  'CREATE TABLE IF NOT EXISTS list_words (',
  'list_id TEXT NOT NULL REFERENCES lists(id) ON DELETE CASCADE, word TEXT NOT NULL,',
  'position INTEGER NOT NULL, type TEXT NOT NULL, display_text TEXT,',
  'source_ids_json TEXT NOT NULL, added_at INTEGER NOT NULL, phonetic TEXT, translation TEXT,',
  'sense_ids_json TEXT NOT NULL, translation_ids_json TEXT NOT NULL,',
  'custom_translations_json TEXT NOT NULL, started_at INTEGER, stage INTEGER,',
  'reviewed_json TEXT NOT NULL, last_done_at INTEGER, review_scope TEXT,',
  'mark_count INTEGER NOT NULL DEFAULT 0, review_count INTEGER NOT NULL DEFAULT 0,',
  'spelling_count INTEGER NOT NULL DEFAULT 0, reading_count INTEGER NOT NULL DEFAULT 0,',
  'remembered_count INTEGER NOT NULL DEFAULT 0, forgotten_count INTEGER NOT NULL DEFAULT 0,',
  'processed_review_keys_json TEXT NOT NULL,',
  'PRIMARY KEY (list_id, word)',
  ') STRICT',
].join(' ')

const CREATE_INDEX_WORDS = 'CREATE INDEX IF NOT EXISTS idx_list_words_added ON list_words(added_at)'

const INSERT_LIST_SQL = 'INSERT INTO lists (id, name, created_at, position, batch_names_json) VALUES (?, ?, ?, ?, ?)'

const INSERT_WORD_COLUMNS = [
  'list_id', 'word', 'position', 'type', 'display_text', 'source_ids_json', 'added_at',
  'phonetic', 'translation', 'sense_ids_json', 'translation_ids_json',
  'custom_translations_json', 'started_at', 'stage', 'reviewed_json',
  'last_done_at', 'review_scope', 'mark_count', 'review_count', 'spelling_count',
  'reading_count', 'remembered_count', 'forgotten_count', 'processed_review_keys_json',
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
 * 只回填有值的字段，缺省字段直接不出现，和以前 json 文件里的形状完全一致——
 * 上层 loadLists() 和前端都靠「字段在不在」区分自动 / 手动，不能塞空值进去。
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
  return item
}

/** 老结构里的 StudyWordItem -> 一行参数（顺序 = INSERT_WORD_COLUMNS） */
function itemToRow(listId, item, position) {
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
  ]
}

export function createStudyListsStore(options) {
  const dataDir = options.dataDir
  const listsFile = options.listsFile
  const defaultListId = options.defaultListId || 'default'
  const defaultListName = options.defaultListName || '默认列表'
  const backupDir = path.join(dataDir, 'backups')
  const db = openStudyDb(dataDir)

  db.exec(CREATE_MIGRATIONS)
  db.exec(CREATE_LISTS)
  db.exec(CREATE_LIST_WORDS)
  db.exec(CREATE_INDEX_WORDS)

  const selectLists = db.prepare('SELECT * FROM lists ORDER BY position, id')
  const selectWords = db.prepare('SELECT * FROM list_words WHERE list_id = ? ORDER BY position, word')
  const insertList = db.prepare(INSERT_LIST_SQL)
  const insertWord = db.prepare(INSERT_WORD_SQL)
  const migrationSeen = db.prepare('SELECT 1 FROM schema_migrations WHERE key = ?')
  const markMigration = db.prepare('INSERT INTO schema_migrations (key, applied_at) VALUES (?, ?)')

  function seedDefault() {
    insertList.run(defaultListId, defaultListName, Date.now(), 0, json({}))
  }

  function writeAll(lists) {
    db.prepare('DELETE FROM list_words').run()
    db.prepare('DELETE FROM lists').run()
    lists.forEach((list, index) => {
      insertList.run(
        String(list?.id ?? ''), String(list?.name ?? ''),
        Number.isFinite(Number(list?.createdAt)) ? Number(list.createdAt) : Date.now(),
        index, json(normalizeBatchNames(list?.batchNames)),
      )
      const words = Array.isArray(list?.words) ? list.words : []
      words.forEach((word, wi) => insertWord.run(...itemToRow(String(list.id), word, wi)))
    })
  }

  /**
   * 返回和老 json 文件完全同构的结构：{ lists: [{ id, name, createdAt, batchNames, words }] }。
   * 上层 dict-server 拿到后继续做字段补齐，调用方无感知数据已经换了存储。
   */
  function load() {
    let listRows = selectLists.all()
    if (listRows.length === 0) {
      db.exec('BEGIN IMMEDIATE')
      try { seedDefault(); db.exec('COMMIT') }
      catch (error) { db.exec('ROLLBACK'); throw error }
      listRows = selectLists.all()
    }
    return {
      lists: listRows.map(row => ({
        id: row.id,
        name: row.name,
        createdAt: Number(row.created_at),
        batchNames: normalizeBatchNames(parseJson(row.batch_names_json, {})),
        words: selectWords.all(row.id).map(rowToItem),
      })),
    }
  }

  /** 整库重写：一次事务里 DELETE 全部再按数组顺序插入，保证落库结果和入参完全一致。 */
  function save(data) {
    const lists = Array.isArray(data?.lists) ? data.lists : []
    db.exec('BEGIN IMMEDIATE')
    try { writeAll(lists); db.exec('COMMIT') }
    catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  /**
   * 事件被 purge 后，列表里冗余的累计计数 / 复习时间也要一起回退，否则统计会和事件表对不上。
   * 排期锚点（startedAt / stage / lastDoneAt）和幂等键保持不变，维持当前进度。
   */
  function resetStats({ words, all }) {
    db.exec('BEGIN IMMEDIATE')
    try {
      let changes = 0
      if (all === true) {
        changes = Number(db.prepare(RESET_STATS_SQL).run(json([])).changes)
      } else {
        const keys = [...new Set((Array.isArray(words) ? words : [])
          .map(value => normalizeText(value)).filter(Boolean))]
        if (keys.length > 0) {
          const placeholders = keys.map(() => '?').join(', ')
          const sql = RESET_STATS_SQL + ' WHERE word IN (' + placeholders + ')'
          changes = Number(db.prepare(sql).run(json([]), ...keys).changes)
        }
      }
      db.exec('COMMIT')
      return { reset: changes }
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  /**
   * 把老的 study-lists.json 导进 sqlite 然后删掉它。
   * 事务提交成功之后才备份 + 删 json：提交前老数据还在，随时能回滚；
   * 提交后进程挂了也没关系——迁移标记已经入库，下次启动直接读 sqlite。
   */
  function migrateListsToSqlite() {
    if (migrationSeen.get(MIGRATION_KEY)) return
    let data = null
    try { data = JSON.parse(fs.readFileSync(listsFile, 'utf8')) }
    catch { data = null }
    const lists = data && Array.isArray(data.lists) ? data.lists : []
    db.exec('BEGIN IMMEDIATE')
    try {
      if (lists.length > 0) writeAll(lists)
      else seedDefault()
      markMigration.run(MIGRATION_KEY, Date.now())
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    // 老 json 备份到 cache/backups/ 后删除：数据已经在库里，文件留着只会造成「两个真相」
    if (lists.length > 0 && listsFile && fs.existsSync(listsFile)) {
      try {
        fs.mkdirSync(backupDir, { recursive: true })
        const backup = path.join(backupDir, 'study-lists.before-sqlite-' + Date.now() + '.json')
        fs.copyFileSync(listsFile, backup, fs.constants.COPYFILE_EXCL)
        fs.unlinkSync(listsFile)
      } catch {
        // 备份 / 删除失败不影响数据：迁移标记已提交，残留 json 会被忽略
      }
    }
  }

  migrateListsToSqlite()

  return { load, save, resetStats, close: () => {} }
}

/**
 * 测试断言用：另开一条短连接读出整库，不碰服务进程常驻的那条连接。
 * 库还没建表时返回 { lists: [] }，而不是抛「no such table」。
 */
export function readStudyLists(dataDir) {
  const db = openStudyDbSnapshot(dataDir)
  try {
    const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'lists'").get()
    if (!hasTable) return { lists: [] }
    const listRows = db.prepare('SELECT * FROM lists ORDER BY position, id').all()
    const wordStmt = db.prepare('SELECT * FROM list_words WHERE list_id = ? ORDER BY position, word')
    return {
      lists: listRows.map(row => ({
        id: row.id,
        name: row.name,
        createdAt: Number(row.created_at),
        batchNames: normalizeBatchNames(parseJson(row.batch_names_json, {})),
        words: wordStmt.all(row.id).map(rowToItem),
      })),
    }
  } finally {
    db.close()
  }
}
