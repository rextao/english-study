import fs from 'node:fs'
import path from 'node:path'
import { openStudyDb, openStudyDbSnapshot } from './db.mjs'

/**
 * 学习列表之外的小文档全部收进同一个 study-history.sqlite，和学习列表 / 学习历史共用一个库：
 *  - kv 表：一整份 JSON 文档存一行（词库标签 / 学习目标 / 打印批次），key 和老 json 文件名一一对应
 *  - dict_cache 表：一个词一行；词典缓存词表大、又是热路径，整库重写太亏，按词写
 *
 * 老 json 只在启动时迁移一次：读出来 -> 备份到 cache/backups/ -> 入库 -> 删掉文件。
 * 迁移标记进 schema_migrations，二次启动直接读 sqlite，不会再跑。
 * 之后 sqlite 是唯一落盘来源，不再有「两份真相」来回同步——这正是合并存储的目的。
 *
 * 词典缓存例外一点：服务进程内存里那份是运行时正本，落库只是为了让缓存跟着 git 走，
 * 换设备不用重新查。别的连接（测试 / 将来的工具）改了库，PRAGMA data_version 会变，
 * 下次 getCache 就整表重读；本连接自己的写不算，所以写完不会触发无谓的重载。
 */

const CREATE_MIGRATIONS = 'CREATE TABLE IF NOT EXISTS schema_migrations (key TEXT PRIMARY KEY, applied_at INTEGER NOT NULL) STRICT'

const CREATE_KV = 'CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at INTEGER NOT NULL) STRICT'

const CREATE_DICT_CACHE = 'CREATE TABLE IF NOT EXISTS dict_cache (word TEXT PRIMARY KEY, entry_json TEXT NOT NULL) STRICT'

const UPSERT_KV = 'INSERT INTO kv (key, value_json, updated_at) VALUES (?, ?, ?)'
  + ' ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at'

const UPSERT_CACHE = 'INSERT INTO dict_cache (word, entry_json) VALUES (?, ?)'
  + ' ON CONFLICT(word) DO UPDATE SET entry_json = excluded.entry_json'

// kv 表里的一份份文档
export const KV_KEYS = {
  labels: 'vocab-labels',
  goal: 'study-goal',
  prints: 'print-batches',
}

function parseJson(value, fallback) {
  try { return JSON.parse(value) }
  catch { return fallback }
}

export function createKvStore(options) {
  const dataDir = options.dataDir
  const legacy = options.legacyFiles || {}
  const backupDir = path.join(dataDir, 'backups')
  const db = openStudyDb(dataDir)

  db.exec(CREATE_MIGRATIONS)
  db.exec(CREATE_KV)
  db.exec(CREATE_DICT_CACHE)

  const selectKv = db.prepare('SELECT value_json FROM kv WHERE key = ?')
  const upsertKv = db.prepare(UPSERT_KV)
  const selectAllCache = db.prepare('SELECT word, entry_json FROM dict_cache')
  const upsertCache = db.prepare(UPSERT_CACHE)
  const migrationSeen = db.prepare('SELECT 1 FROM schema_migrations WHERE key = ?')
  const markMigration = db.prepare('INSERT INTO schema_migrations (key, applied_at) VALUES (?, ?)')
  const dataVersion = db.prepare('PRAGMA data_version')

  function get(key, fallback) {
    const row = selectKv.get(key)
    return row ? parseJson(row.value_json, fallback) : fallback
  }

  function set(key, value) {
    upsertKv.run(key, JSON.stringify(value), Date.now())
  }

  function loadCacheMap() {
    const map = {}
    for (const row of selectAllCache.iterate()) {
      const entry = parseJson(row.entry_json, null)
      if (entry && typeof entry === 'object') map[row.word] = entry
    }
    return map
  }

  function putCacheEntry(entry) {
    upsertCache.run(entry.word, JSON.stringify(entry))
  }

  function putCacheEntries(entries) {
    if (!Array.isArray(entries) || entries.length === 0) return
    db.exec('BEGIN IMMEDIATE')
    try {
      for (const entry of entries) upsertCache.run(entry.word, JSON.stringify(entry))
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  function cacheVersion() {
    return Number(dataVersion.get().data_version)
  }

  /** 老 json 备份到 cache/backups/ 后删除：数据已经在库里，文件留着只会造成「两个真相」 */
  function backupAndDelete(file) {
    if (!file || !fs.existsSync(file)) return
    try {
      fs.mkdirSync(backupDir, { recursive: true })
      const backup = path.join(backupDir, path.basename(file) + '.before-sqlite-' + Date.now() + '.json')
      fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL)
      fs.unlinkSync(file)
    } catch {
      // 备份 / 删除失败不影响数据：迁移标记已提交，残留 json 会被忽略
    }
  }

  /**
   * 一次迁移：读老 json -> 事务里写库 + 记标记 -> 提交后才备份 + 删文件。
   * 提交前老数据原样在，随时能回滚；提交后进程挂了也没关系，标记已入库，下次启动直接读 sqlite。
   */
  function runMigration(migrationKey, file, apply) {
    if (migrationSeen.get(migrationKey)) return
    let data = null
    try { data = parseJson(fs.readFileSync(file, 'utf8'), null) } catch { data = null }
    const hasData = data !== null && data !== undefined
    db.exec('BEGIN IMMEDIATE')
    try {
      if (hasData) apply(data)
      markMigration.run(migrationKey, Date.now())
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    if (hasData) backupAndDelete(file)
  }

  runMigration('kv-labels-to-sqlite-v1', legacy.labels, data => {
    if (data && typeof data === 'object') set(KV_KEYS.labels, data)
  })
  runMigration('kv-goal-to-sqlite-v1', legacy.goal, data => {
    if (data && typeof data === 'object') set(KV_KEYS.goal, data)
  })
  runMigration('kv-prints-to-sqlite-v1', legacy.prints, data => {
    if (data && typeof data === 'object') set(KV_KEYS.prints, data)
  })
  runMigration('kv-dict-cache-to-sqlite-v1', legacy.dictCache, data => {
    for (const [word, entry] of Object.entries(data)) {
      if (word && entry && typeof entry === 'object') upsertCache.run(word, JSON.stringify(entry))
    }
  })

  return { get, set, loadCacheMap, putCacheEntry, putCacheEntries, cacheVersion, close: () => {} }
}

/**
 * 测试断言用：另开一条短连接读 kv / 词典缓存，不碰服务进程常驻的那条。
 * 库还没建表时返回 fallback，而不是抛「no such table」。
 */
export function readKv(dataDir, key, fallback) {
  const db = openStudyDbSnapshot(dataDir)
  try {
    const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'kv'").get()
    if (!hasTable) return fallback
    const row = db.prepare('SELECT value_json FROM kv WHERE key = ?').get(key)
    return row ? parseJson(row.value_json, fallback) : fallback
  } finally {
    db.close()
  }
}

export function readDictCache(dataDir) {
  const db = openStudyDbSnapshot(dataDir)
  try {
    const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'dict_cache'").get()
    if (!hasTable) return {}
    const map = {}
    for (const row of db.prepare('SELECT word, entry_json FROM dict_cache').iterate()) {
      const entry = parseJson(row.entry_json, null)
      if (entry && typeof entry === 'object') map[row.word] = entry
    }
    return map
  } finally {
    db.close()
  }
}

/**
 * 测试用它整份替换词典缓存，等价于从前的 writeFileSync(dict-cache.json)：
 * 走另一条连接提交，data_version 一变，服务进程下次 getCache 就整表重读。
 */
export function writeDictCache(dataDir, map) {
  const db = openStudyDbSnapshot(dataDir)
  try {
    db.exec(CREATE_DICT_CACHE)
    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare('DELETE FROM dict_cache').run()
      const stmt = db.prepare(UPSERT_CACHE)
      for (const [word, entry] of Object.entries(map || {})) {
        if (word && entry && typeof entry === 'object') stmt.run(word, JSON.stringify(entry))
      }
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  } finally {
    db.close()
  }
}
