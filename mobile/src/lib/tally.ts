/**
 * tally.ts — 手机端对「会拼 / 会读 / 知意」次数做加减并写回云端
 *
 * 架构约束：云端 Worker 只是「带令牌鉴权的整库快照存储」，不在云端重算哈希
 * （见 worker/src/index.js 顶部注释与 server/sync.mjs）。所以写逻辑放在客户端：
 *   1. 在内存里的整库快照上改 learning_events（+1 追加一条、-1 软删最近一条）；
 *   2. 顺带维护 list_words 的去规范化计数（和桌面端 tally / tally-undo 对齐，下限 0）；
 *   3. 用和 server/sync.mjs 完全一致的 canonicalStringify + sha256 重算哈希；
 *   4. 走已有的 POST /sync/snapshot 整份覆盖推上去。
 *
 * 聚合口径和 snapshot.ts / 桌面端 server/study-history.mjs 一致：
 *   会拼→action 'spelling'，会读→'reading'，知意→'meaning'（计入 rememberedCount）。
 * 这三类只计数、不推进轮次、不动排期，可重复点各算一次；软删一条即减一次。
 */
import { syncBase, type Snapshot, type SnapshotTable, type SyncConfig } from './snapshot'

/** 可加减的三项：值即 learning_events.action */
export type SuccessKind = 'spelling' | 'reading' | 'meaning'

/** success kind → list_words 里对应的计数列名 */
const COUNT_COLUMN: Record<SuccessKind, string> = {
  spelling: 'spelling_count',
  reading: 'reading_count',
  meaning: 'remembered_count',
}

type Cell = string | number | null

function colIndex(columns: { name: string }[], name: string): number {
  return columns.findIndex(col => col.name === name)
}

/** 浅克隆一张表：列定义照用，行数组换新（行本身按需再逐个克隆） */
function cloneTable(table: SnapshotTable): SnapshotTable {
  return { columns: table.columns, rows: table.rows.slice() }
}

// ── 行排序：和 server/sync.mjs 的 compareValues / compareRows 完全一致 ──────────
// 推回去的快照必须和桌面端导出的字节一致，否则两边哈希对不上、会误报「有改动」。
function compareValues(a: Cell, b: Cell): number {
  if (a === b) return 0
  if (a === null || a === undefined) return -1
  if (b === null || b === undefined) return 1
  const ta = typeof a
  const tb = typeof b
  if (ta === 'number' && tb === 'number') return (a as number) - (b as number)
  if (ta === 'number') return -1
  if (tb === 'number') return 1
  const sa = String(a)
  const sb = String(b)
  return sa < sb ? -1 : sa > sb ? 1 : 0
}

function compareRows(a: Cell[], b: Cell[]): number {
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i++) {
    const cmp = compareValues(a[i] ?? null, b[i] ?? null)
    if (cmp !== 0) return cmp
  }
  return a.length - b.length
}

/** 确定性序列化：和 server/sync.mjs 的 canonicalStringify 完全一致 */
function canonicalStringify(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalStringify).join(',') + ']'
  if (value !== null && typeof value === 'object') {
    return '{' + Object.keys(value as Record<string, unknown>).sort()
      .map(key => JSON.stringify(key) + ':' + canonicalStringify((value as Record<string, unknown>)[key]))
      .join(',') + '}'
  }
  return JSON.stringify(value)
}

/** 快照哈希：只认 version + tables，不含 exportedAt / deviceLabel（同 server/sync.mjs） */
async function snapshotHash(snapshot: Snapshot): Promise<string> {
  const core = { version: snapshot?.version ?? 1, tables: snapshot?.tables ?? {} }
  const bytes = new TextEncoder().encode(canonicalStringify(core))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
}

/** 维护 list_words 的去规范化计数：按事件行上的 list_id + word_key 定位那一行，计数下限 0 */
function bumpListWord(
  tables: Record<string, SnapshotTable>,
  originalListWords: SnapshotTable | undefined,
  eventRow: Cell[],
  eventCols: { name: string }[],
  kind: SuccessKind,
  delta: number,
): void {
  if (!originalListWords) return
  const listId = eventRow[colIndex(eventCols, 'list_id')]
  const wordKey = eventRow[colIndex(eventCols, 'word_key')]
  if (listId === null || listId === undefined) return
  const lc = originalListWords.columns
  const cListId = colIndex(lc, 'list_id')
  const cWord = colIndex(lc, 'word')
  const cCount = colIndex(lc, COUNT_COLUMN[kind])
  if (cListId < 0 || cWord < 0 || cCount < 0) return
  const rowIndex = originalListWords.rows.findIndex(
    row => row[cListId] === listId && row[cWord] === wordKey,
  )
  if (rowIndex < 0) return
  // 复用本次已克隆的 list_words（可能已被别的加减改过），否则现克隆一张
  const next = tables['list_words'] && tables['list_words'] !== originalListWords
    ? tables['list_words']
    : cloneTable(originalListWords)
  tables['list_words'] = next
  const row = next.rows[rowIndex].slice()
  row[cCount] = Math.max(0, (Number(row[cCount]) || 0) + delta)
  next.rows[rowIndex] = row
}

export interface TallyResult {
  snapshot: Snapshot
  changed: boolean
}

/**
 * 在快照上对某个词的某一项做加减，返回新的快照（不改入参）。
 * +1：克隆同词的一条已有事件当模板，改成本项动作、换新 id / 时间，并复制词义链接；
 * -1：软删该词该动作最近一条未删事件（下限 0，没有可删就 no-op）。
 */
export function applyTally(
  snapshot: Snapshot,
  wordKey: string,
  kind: SuccessKind,
  delta: number,
): TallyResult {
  const events = snapshot.tables['learning_events']
  if (!events || !Array.isArray(events.rows)) return { snapshot, changed: false }
  const ec = events.columns
  const iId = colIndex(ec, 'id')
  const iAction = colIndex(ec, 'action')
  const iWordKey = colIndex(ec, 'word_key')
  const iDeleted = colIndex(ec, 'deleted_at')
  const iOccurred = colIndex(ec, 'occurred_at')
  const iCreated = colIndex(ec, 'created_at')
  if (iId < 0 || iAction < 0 || iWordKey < 0 || iDeleted < 0 || iOccurred < 0) {
    return { snapshot, changed: false }
  }

  const now = Date.now()
  const nextEvents = cloneTable(events)
  const tables: Record<string, SnapshotTable> = { ...snapshot.tables, learning_events: nextEvents }
  const originalListWords = snapshot.tables['list_words']

  if (delta > 0) {
    // 模板：优先未删事件（list / source 信息最真），退而取任意一条同词事件
    const active = events.rows.find(row => row[iWordKey] === wordKey && row[iDeleted] == null)
    const template = active || events.rows.find(row => row[iWordKey] === wordKey)
    if (!template) return { snapshot, changed: false }
    const srcId = template[iId]
    const newId = crypto.randomUUID()
    const row = template.slice() as Cell[]
    row[iId] = newId
    row[iAction] = kind
    row[iOccurred] = now
    row[iDeleted] = null
    if (iCreated >= 0) row[iCreated] = now
    const iEventKey = colIndex(ec, 'event_key')
    if (iEventKey >= 0) row[iEventKey] = null
    const iRequest = colIndex(ec, 'request_id')
    if (iRequest >= 0) row[iRequest] = null
    const iScope = colIndex(ec, 'scope')
    if (iScope >= 0) row[iScope] = null
    const iStage = colIndex(ec, 'stage')
    if (iStage >= 0) row[iStage] = null
    const iMeta = colIndex(ec, 'metadata_json')
    if (iMeta >= 0) row[iMeta] = JSON.stringify({ source: 'mobile' })
    nextEvents.rows.push(row)

    // 复制模板事件挂的词义链接到新事件，知意的词义小计才跟得上
    const links = snapshot.tables['learning_event_meanings']
    if (links && Array.isArray(links.rows)) {
      const lEvent = colIndex(links.columns, 'event_id')
      const lMeaning = colIndex(links.columns, 'meaning_key')
      if (lEvent >= 0 && lMeaning >= 0) {
        const copied = links.rows.filter(r => r[lEvent] === srcId)
        if (copied.length) {
          const nextLinks = cloneTable(links)
          for (const r of copied) {
            const nr = r.slice() as Cell[]
            nr[lEvent] = newId
            nextLinks.rows.push(nr)
          }
          tables['learning_event_meanings'] = nextLinks
        }
      }
    }

    bumpListWord(tables, originalListWords, template, ec, kind, +1)
  } else {
    // 软删最近一条匹配的未删事件（按 occurred_at，再按 created_at 兜底）
    let target = -1
    let bestOcc = -Infinity
    let bestCreated = -Infinity
    for (let i = 0; i < events.rows.length; i++) {
      const r = events.rows[i]
      if (r[iWordKey] !== wordKey || r[iAction] !== kind || r[iDeleted] != null) continue
      const occ = Number(r[iOccurred]) || 0
      const created = iCreated >= 0 ? (Number(r[iCreated]) || 0) : 0
      if (occ > bestOcc || (occ === bestOcc && created >= bestCreated)) {
        bestOcc = occ
        bestCreated = created
        target = i
      }
    }
    if (target < 0) return { snapshot, changed: false }
    const original = events.rows[target]
    const row = original.slice() as Cell[]
    row[iDeleted] = now
    nextEvents.rows[target] = row
    bumpListWord(tables, originalListWords, original, ec, kind, -1)
  }

  // 维持和桌面端导出一致的行序，推回去哈希才对得上
  nextEvents.rows = nextEvents.rows.slice().sort(compareRows)
  const links = tables['learning_event_meanings']
  if (links && links !== snapshot.tables['learning_event_meanings']) {
    links.rows = links.rows.slice().sort(compareRows)
  }
  const listWords = tables['list_words']
  if (listWords && listWords !== originalListWords) {
    listWords.rows = listWords.rows.slice().sort(compareRows)
  }

  return { snapshot: { ...snapshot, tables }, changed: true }
}

/** 把改过的整库快照覆盖推到云端；失败抛中文错误 */
export async function pushSnapshot(config: SyncConfig, snapshot: Snapshot): Promise<void> {
  const payload: Snapshot = {
    ...snapshot,
    exportedAt: Date.now(),
    deviceLabel: '手机端',
  }
  const hash = await snapshotHash(payload)
  const res = await fetch(syncBase() + '/sync/snapshot', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + config.token.trim(),
    },
    body: JSON.stringify({ snapshot: payload, snapshotHash: hash }),
  })
  const text = await res.text()
  if (!res.ok) {
    let message = '保存到云端失败（HTTP ' + res.status + '）'
    try {
      const parsed = JSON.parse(text)
      if (parsed?.error) message = String(parsed.error)
    } catch { /* 错误体不是 JSON，用默认提示 */ }
    throw new Error(message)
  }
}
