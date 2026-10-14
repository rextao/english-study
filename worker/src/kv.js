/**
 * kv.js — 小文档 store（D1 版）
 *
 * 从 server/kv.mjs 移植：kv 表一整份 JSON 存一行（词库标签 / 学习目标 / 打印批次 /
 * 补齐队列状态），dict_cache 表一个词一行。
 *
 * 与本地版的差异：
 *  - 没有 json 文件迁移逻辑（上云前由 scripts/migrate-to-d1.mjs 一次性导完）；
 *  - 没有 PRAGMA data_version 热重载——D1 就是唯一真相，每次按需读写，
 *    不再维护 isolate 内存正本（isolate 随时会被回收，缓存一致性没有意义）。
 */

const UPSERT_KV = 'INSERT INTO kv (key, value_json, updated_at) VALUES (?, ?, ?)'
  + ' ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at'

const UPSERT_CACHE = 'INSERT INTO dict_cache (word, entry_json, status) VALUES (?, ?, ?)'
  + ' ON CONFLICT(word) DO UPDATE SET entry_json = excluded.entry_json, status = excluded.status'

// kv 表里的一份份文档
export const KV_KEYS = {
  labels: 'vocab-labels',
  goal: 'study-goal',
  prints: 'print-batches',
  prefetch: 'prefetch-state',
}

/** 单次 IN 查询最多带多少个词，防超 D1 的绑定参数上限 */
const IN_CHUNK = 80

function parseJson(value, fallback) {
  try { return JSON.parse(value) }
  catch { return fallback }
}

/**
 * 写进 status 列的值。看不出来时按 partial 记：宁可统计上少算一条完整，
 * 也不要把没抓齐的词记成 ok——那会让它永远不再重试。
 */
function cacheStatusOf(entry) {
  return entry?.status === 'ok' ? 'ok' : 'partial'
}

export function createKvStore(db) {
  async function get(key, fallback) {
    const row = await db.first('SELECT value_json FROM kv WHERE key = ?', key)
    return row ? parseJson(row.value_json, fallback) : fallback
  }

  async function set(key, value) {
    await db.run(UPSERT_KV, key, JSON.stringify(value), Date.now())
  }

  /** 按词取一批缓存词条；查不到的词不出现在结果里 */
  async function getCacheEntries(words) {
    const map = {}
    const list = [...new Set(words.map(word => String(word ?? '').trim()).filter(Boolean))]
    for (let i = 0; i < list.length; i += IN_CHUNK) {
      const chunk = list.slice(i, i + IN_CHUNK)
      const placeholders = chunk.map(() => '?').join(', ')
      const rows = await db.all(
        'SELECT word, entry_json FROM dict_cache WHERE word IN (' + placeholders + ')',
        ...chunk,
      )
      for (const row of rows) {
        const entry = parseJson(row.entry_json, null)
        if (entry && typeof entry === 'object') map[row.word] = entry
      }
    }
    return map
  }

  /** 缓存统计：两条 COUNT 走 idx_dict_cache_status，不再把整张表的 entry_json 读进来解析 */
  async function cacheCounts() {
    const totalRow = await db.first('SELECT COUNT(*) AS count FROM dict_cache')
    const completeRow = await db.first("SELECT COUNT(*) AS count FROM dict_cache WHERE status = 'ok'")
    const total = Number(totalRow?.count || 0)
    const complete = Number(completeRow?.count || 0)
    return { total, complete, incomplete: Math.max(0, total - complete) }
  }

  async function putCacheEntry(entry) {
    await db.run(UPSERT_CACHE, entry.word, JSON.stringify(entry), cacheStatusOf(entry))
  }

  /** 批量写缓存：一个 batch = 一个事务，只写一次盘 */
  async function putCacheEntries(entries) {
    if (!Array.isArray(entries) || entries.length === 0) return
    await db.batch(entries.map(entry => [
      UPSERT_CACHE, entry.word, JSON.stringify(entry), cacheStatusOf(entry),
    ]))
  }

  return { get, set, getCacheEntries, cacheCounts, putCacheEntry, putCacheEntries }
}

// ── 测试断言辅助：直接从适配层读，不经过业务 store ─────────────────────────

export async function readKv(db, key, fallback) {
  const row = await db.first('SELECT value_json FROM kv WHERE key = ?', key)
  return row ? parseJson(row.value_json, fallback) : fallback
}

export async function readDictCache(db) {
  const rows = await db.all('SELECT word, entry_json FROM dict_cache')
  const map = {}
  for (const row of rows) {
    const entry = parseJson(row.entry_json, null)
    if (entry && typeof entry === 'object') map[row.word] = entry
  }
  return map
}

/**
 * 测试用它整份替换词典缓存（对应本地版 writeDictCache）。
 * 调用方给的词条要带上 status：生产写入的都是归一化后的词条，本来就有；
 * 缺省按 partial 记，别让测试写出生成不了的形状。
 */
export async function writeDictCache(db, map) {
  const statements = [['DELETE FROM dict_cache']]
  for (const [word, entry] of Object.entries(map || {})) {
    if (word && entry && typeof entry === 'object') {
      statements.push([UPSERT_CACHE, word, JSON.stringify(entry), cacheStatusOf(entry)])
    }
  }
  await db.batch(statements)
}
