/**
 * sync.mjs — 整库快照同步（本地 sqlite ↔ Cloudflare D1）
 *
 * 手机端要能读到桌面端的学习数据，但页面不部署到云端，只把「数据」存上去。
 * 采用整库快照 + 哈希，不做逐行合并（和项目现有的「以某一台为准」思路一致）：
 *  - 导出：把要同步的表整份读出来，行排序后连同列定义打成一份快照；
 *  - 哈希：对 { version, tables } 做规范化序列化后取 sha256，不含 exportedAt / deviceLabel，
    所以「谁导出的、什么时候导出的」都不影响哈希，只有数据本身变了哈希才变；
 *  - 回写：先 VACUUM INTO 备份当前库，再在一个事务里按「子表先删、父表先插」整份替换。
 *
 * 同步范围：学习列表 / 学习事件 / 词义画像 / 小文档（标签 / 目标 / 打印批次）。
 * 不含 dict_cache——查词缓存随时能重新生成，同步它会让「本地有更新」天天报；
 * 也不含 schema_migrations（迁移标记是每台机器自己的进度）和 legacy_totals（已废弃的空表）。
 *
 * 同步状态（上次同步到哪个哈希）存在 cache/sync-state.json，不进共享库——
 * 不然 A 推送会把 B 的「上次同步到哪」一起覆盖掉，B 就分不清自己是不是有新数据了。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { openStudyDb } from './db.mjs'

/** 快照格式版本；将来结构大改时递增，回写时能识别不兼容的旧快照 */
export const SNAPSHOT_VERSION = 1

/** 参与同步的表：学习相关的一切，不含词典缓存 / 迁移标记 / 遗留空表 */
export const SYNC_TABLES = [
  'lists',
  'list_words',
  'learning_events',
  'learning_event_meanings',
  'meaning_profiles',
  'kv',
]

/** 回写时先删子表再删父表，否则外键约束拦着删不掉 */
const DELETE_ORDER = [
  'learning_event_meanings',
  'list_words',
  'learning_events',
  'meaning_profiles',
  'lists',
  'kv',
]

/** 插入反过来：父表先有行，子表的外键才挂得上 */
const INSERT_ORDER = [
  'lists',
  'meaning_profiles',
  'learning_events',
  'list_words',
  'learning_event_meanings',
  'kv',
]

const STATE_FILE = 'sync-state.json'
/** 云端请求超时：快照可能不小，给充足一点 */
const SYNC_TIMEOUT_MS = 30000

// ── 工具 ───────────────────────────────────────────────────────────────────

/** SQL 字符串字面量（VACUUM INTO 的目标路径用它），单引号转义防注入 */
function sqlLiteral(value) {
  return "'" + String(value).replace(/'/g, "''") + "'"
}

/** SQL 标识符（表名 / 列名），双引号转义。这些名字都是代码里写死的，转义只是兜底 */
function quoteIdent(name) {
  return '"' + String(name).replace(/"/g, '""') + '"'
}

function tableExists(db, name) {
  const row = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)
  return Boolean(row)
}

/**
 * 确定性序列化：对象按键名排序、数组保留顺序、无多余空白。
 * 哈希必须稳定——同一份数据任何时候导出都得是同一个哈希，否则「是否一致」就没法判断。
 */
export function canonicalStringify(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalStringify).join(',') + ']'
  if (value !== null && typeof value === 'object') {
    return '{' + Object.keys(value).sort()
      .map(key => JSON.stringify(key) + ':' + canonicalStringify(value[key])).join(',') + '}'
  }
  return JSON.stringify(value)
}

/** 行排序的比较：按列从左到右逐个比，null 排最前，数字排在字符串前 */
function compareValues(a, b) {
  if (a === b) return 0
  if (a === null || a === undefined) return -1
  if (b === null || b === undefined) return 1
  const ta = typeof a, tb = typeof b
  if (ta === 'number' && tb === 'number') return a - b
  if (ta === 'number') return -1
  if (tb === 'number') return 1
  const sa = String(a), sb = String(b)
  return sa < sb ? -1 : sa > sb ? 1 : 0
}

function compareRows(a, b) {
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i++) {
    const cmp = compareValues(a[i], b[i])
    if (cmp !== 0) return cmp
  }
  return a.length - b.length
}

// ── 快照导出 / 哈希 ─────────────────────────────────────────────────────────

/**
 * 把本地库导出成一份快照：{ version, exportedAt, deviceLabel, tables }。
 * 每个表带列定义（名字 + 类型，方便目标机缺表时按样建出来）和已排序的行。
 * 行的顺序对哈希很关键，这里排好，后面任何地方都不再依赖插入顺序。
 */
export function exportSnapshot(dataDir, deviceLabel) {
  const db = openStudyDb(dataDir)
  const tables = {}
  for (const name of SYNC_TABLES) {
    if (!tableExists(db, name)) continue
    const info = db.prepare('PRAGMA table_info(' + quoteIdent(name) + ')').all()
    const columns = info.map(col => ({ name: col.name, type: col.type || 'TEXT' }))
    const colNames = columns.map(col => col.name)
    const select = db.prepare(
      'SELECT ' + colNames.map(quoteIdent).join(', ') + ' FROM ' + quoteIdent(name)
    )
    const rows = select.all()
      .map(row => colNames.map(col => row[col] ?? null))
      .sort(compareRows)
    tables[name] = { columns, rows }
  }
  return {
    version: SNAPSHOT_VERSION,
    exportedAt: Date.now(),
    deviceLabel: deviceLabel || '',
    tables,
  }
}

/** 快照哈希：只认 version 和表数据，不认导出时间 / 设备名 */
export function snapshotHash(snapshot) {
  const core = { version: snapshot?.version ?? SNAPSHOT_VERSION, tables: snapshot?.tables ?? {} }
  return createHash('sha256').update(canonicalStringify(core), 'utf8').digest('hex')
}

/** 快照的人类可读摘要：哈希 + 各表行数，给「本地 / 云端是否一致」和界面提示用 */
export function summarizeSnapshot(snapshot) {
  const tables = (snapshot && typeof snapshot === 'object' ? snapshot.tables : null) || {}
  const count = name => (Array.isArray(tables[name]?.rows) ? tables[name].rows.length : 0)
  const listCount = count('lists')
  const wordCount = count('list_words')
  const eventCount = count('learning_events')
  return {
    hash: snapshotHash(snapshot),
    exportedAt: Number(snapshot?.exportedAt) || 0,
    deviceLabel: typeof snapshot?.deviceLabel === 'string' ? snapshot.deviceLabel : '',
    listCount,
    wordCount,
    eventCount,
    /** 用户内容总量（列表词条 + 学习事件），用于「空快照」判定 */
    totalRows: wordCount + eventCount,
    /** 没有任何用户内容：空库或只有 default 列表 */
    empty: wordCount === 0 && eventCount === 0 && listCount <= 1,
  }
}

/**
 * 本地摘要 + 是否有未同步的改动。
 * dirty = 自上次同步以来本地数据变过：从没同步过就看库里有没有内容，同步过就和上次那个哈希比。
 */
export function localSummary(dataDir, deviceLabel, lastSyncedHash) {
  const summary = summarizeSnapshot(exportSnapshot(dataDir, deviceLabel))
  const synced = typeof lastSyncedHash === 'string' && lastSyncedHash.length > 0
  return {
    ...summary,
    dirty: synced ? summary.hash !== lastSyncedHash : summary.totalRows > 0,
  }
}

// ── 快照回写 ─────────────────────────────────────────────────────────────────

/** 拉取覆盖本地前先 VACUUM INTO 一份完整备份，整库被换掉了也能捞回来 */
function backupBeforeSync(dataDir, db) {
  const backupDir = path.join(dataDir, 'backups')
  fs.mkdirSync(backupDir, { recursive: true })
  db.exec('PRAGMA wal_checkpoint(FULL)')
  const target = path.join(backupDir, 'study-history.before-pull-' + Date.now() + '-' + randomUUID() + '.sqlite')
  db.exec('VACUUM INTO ' + sqlLiteral(target))
  return target
}

/**
 * 把云端快照整份写回本地库（全量替换，不是合并）。
 * 只替换快照里出现的表；快照没带的表（比如对方版本旧、少一张表）本地原样保留。
 * 列按名字对齐：快照里有、本地没有的列跳过（旧机器不认识新列）。
 */
export function applySnapshot(dataDir, snapshot) {
  if (!snapshot || snapshot.tables === null || typeof snapshot.tables !== 'object') {
    throw new Error('快照数据无效')
  }
  if (snapshot.version !== SNAPSHOT_VERSION) {
    throw new Error('快照版本不兼容（期望 ' + SNAPSHOT_VERSION + '，收到 ' + snapshot.version + '）')
  }
  const db = openStudyDb(dataDir)
  backupBeforeSync(dataDir, db)
  const tables = snapshot.tables
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const name of DELETE_ORDER) {
      if (!tables[name] || !tableExists(db, name)) continue
      db.exec('DELETE FROM ' + quoteIdent(name))
    }
    for (const name of INSERT_ORDER) {
      const table = tables[name]
      if (!table || !Array.isArray(table.rows)) continue
      ensureTable(db, name, table.columns)
      insertRows(db, name, table)
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

/** 目标机缺这张表时，照着快照给的列定义建一张（类型保留，约束不追求一致，能装下数据即可） */
function ensureTable(db, name, columns) {
  if (tableExists(db, name)) return
  if (!Array.isArray(columns) || columns.length === 0) return
  const defs = columns
    .map(col => quoteIdent(col.name) + ' ' + (typeof col.type === 'string' && col.type ? col.type : 'TEXT'))
    .join(', ')
  db.exec('CREATE TABLE ' + quoteIdent(name) + ' (' + defs + ')')
}

function insertRows(db, name, table) {
  const localColumns = db.prepare('PRAGMA table_info(' + quoteIdent(name) + ')').all().map(col => col.name)
  const localSet = new Set(localColumns)
  // 快照里有、本地也有的列才插；本地不认识的列（对方版本更新）跳过
  const useColumns = table.columns
    .map(col => col.name)
    .filter(col => localSet.has(col))
  if (useColumns.length === 0) return
  const colIndex = new Map(table.columns.map((col, index) => [col.name, index]))
  const stmt = db.prepare(
    'INSERT INTO ' + quoteIdent(name)
    + ' (' + useColumns.map(quoteIdent).join(', ') + ')'
    + ' VALUES (' + useColumns.map(() => '?').join(', ') + ')'
  )
  for (const row of table.rows) {
    stmt.run(...useColumns.map(col => row[colIndex.get(col)] ?? null))
  }
}

// ── 同步状态（cache/sync-state.json）──────────────────────────────────────────

export function syncStateFile(dataDir) {
  return path.join(dataDir, STATE_FILE)
}

export function readSyncState(dataDir) {
  const fallback = { lastSyncedHash: '', lastSyncAt: 0, lastDirection: '', deviceLabel: '' }
  try {
    const parsed = JSON.parse(fs.readFileSync(syncStateFile(dataDir), 'utf8'))
    if (!parsed || typeof parsed !== 'object') return fallback
    return {
      lastSyncedHash: typeof parsed.lastSyncedHash === 'string' ? parsed.lastSyncedHash : '',
      lastSyncAt: Number.isFinite(Number(parsed.lastSyncAt)) ? Number(parsed.lastSyncAt) : 0,
      lastDirection: parsed.lastDirection === 'push' || parsed.lastDirection === 'pull'
        ? parsed.lastDirection : '',
      deviceLabel: typeof parsed.deviceLabel === 'string' ? parsed.deviceLabel : '',
    }
  } catch (error) {
    // 没同步过（文件不存在）或内容损坏，都当成「还没同步过」
    if (error.code !== 'ENOENT') console.warn('[sync] 同步状态读取失败，当作未同步过:', error.message)
    return fallback
  }
}

export function writeSyncState(dataDir, patch) {
  const next = { ...readSyncState(dataDir), ...patch }
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(syncStateFile(dataDir), JSON.stringify(next, null, 2) + '\n')
  return next
}

// ── 云端传输（本地服务直连 Worker）────────────────────────────────────────────

/**
 * 请求 Cloudflare Worker。同步是本地服务发起的，不是浏览器发起的——
 * 浏览器直连云端会暴露令牌，而且手机在别的网络下未必能访问到本机服务。
 * keys = { url, token }；op 是 '/sync/status' 这类路径。
 */
export async function workerRequest(keys, op, options = {}) {
  if (!keys || !keys.url) throw new Error('还没配置同步地址')
  const base = String(keys.url).trim().replace(/\/+$/, '')
  const url = base + op
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SYNC_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(keys.token ? { Authorization: 'Bearer ' + keys.token } : {}),
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    })
    const text = await res.text()
    if (!res.ok) {
      let message = '云端返回错误（HTTP ' + res.status + '）'
      try { const parsed = JSON.parse(text); if (parsed?.error) message = String(parsed.error) } catch { /* 非 JSON 错误体 */ }
      const error = new Error(message)
      error.status = res.status
      throw error
    }
    try {
      return JSON.parse(text)
    } catch {
      throw new Error('云端返回的不是有效 JSON')
    }
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('连接云端超时')
    if (error?.status) throw error
    if (error?.message?.startsWith('连接云端超时')) throw error
    throw new Error('连不上云端同步服务：' + error.message)
  } finally {
    clearTimeout(timer)
  }
}

/** 校验云端 /sync/status 的返回形状，不认识的格式当没数据，免得界面显示一堆 undefined */
export function parseRemoteStatus(body) {
  if (!body || typeof body !== 'object') return null
  const hash = typeof body.hash === 'string' ? body.hash : ''
  return {
    hash,
    exportedAt: Number(body.exportedAt) || 0,
    deviceLabel: typeof body.deviceLabel === 'string' ? body.deviceLabel : '',
    listCount: Number(body.listCount) || 0,
    wordCount: Number(body.wordCount) || 0,
    eventCount: Number(body.eventCount) || 0,
    totalRows: Number(body.totalRows) || 0,
    empty: hash.length === 0 || body.empty === true,
  }
}
