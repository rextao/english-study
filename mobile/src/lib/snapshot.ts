/**
 * snapshot.ts — 拉取并解析整库快照
 *
 * 快照格式和 server/sync.mjs 导出的完全一致：
 *   { version, exportedAt, deviceLabel, tables: { 表名: { columns, rows } } }
 * 行是按列顺序排好的数组，这里按列名对齐成对象再用。
 * 手机端只读不改：单词记录来自 list_words，学习成果由 learning_events 聚合，
 * 聚合规则和桌面端 server/study-history.mjs 的 aggregate() 一致。
 */

/** 同步配置：只需 Bearer 令牌。同步地址固定用当前站点 origin —— 手机端页面与同步 API
 *  合并部署在同一个 Worker、同一个域名，不用再单独填云端地址，也就没有跨域。 */
export interface SyncConfig {
  token: string
}

/** 快照里一张表：列定义 + 按列顺序排好的行 */
export interface SnapshotTable {
  columns: { name: string; type: string }[]
  rows: (string | number | null)[][]
}

export interface Snapshot {
  version: number
  exportedAt: number
  deviceLabel: string
  tables: Record<string, SnapshotTable>
}

/** 词库标签：词库 id → 显示名（kv 表里的 vocab-labels） */
export type VocabLabels = Record<string, string>

/** 单词记录：单词记录 tab 的一行 */
export interface WordRecord {
  word: string
  listId: string
  listName: string
  /** 展示用的原始大小写（display_text），没有就回落到规范化词 */
  displayText: string
  phonetic: string
  translation: string
  addedAt: number
  startedAt: number | null
  stage: number | null
  /** 学习状态文案：未开始 / 已开始 / 已学 N 轮 / 已完成 */
  status: string
  /** 来源词库 id 列表 */
  sourceIds: string[]
}

/** 成果里逐词义的小计 */
export interface AchievementMeaning {
  text: string
  pos: string
  reviewCount: number
  rememberedCount: number
  forgottenCount: number
}

/** 学习成果：学习成果 tab 的一行 */
export interface Achievement {
  word: string
  /** 规范化词键（learning_events.word_key），加减写回时按它定位事件 */
  wordKey: string
  sourceIds: string[]
  reviewCount: number
  spellingCount: number
  readingCount: number
  rememberedCount: number
  forgottenCount: number
  lastAt: number | null
  meanings: AchievementMeaning[]
}

/** 解析后的快照：界面直接用的形状 */
export interface ParsedSnapshot {
  exportedAt: number
  deviceLabel: string
  listCount: number
  wordCount: number
  eventCount: number
  records: WordRecord[]
  achievements: Achievement[]
  labels: VocabLabels
}

const REQUEST_TIMEOUT_MS = 30000

/** 拉取云端整库快照；失败时抛中文错误给界面直接显示 */
/** 同步基址：默认用当前站点 origin（同源部署）；本地开发可用 VITE_SYNC_BASE 指向已部署的 Worker */
export function syncBase(): string {
  const override = (import.meta.env.VITE_SYNC_BASE as string | undefined)?.trim()
  const base = override && override.length > 0 ? override : window.location.origin
  return base.replace(/\/+$/, '')
}

export async function fetchSnapshot(config: SyncConfig): Promise<Snapshot> {
  const base = syncBase()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const res = await fetch(base + '/sync/snapshot', {
      headers: { Authorization: 'Bearer ' + config.token.trim() },
      signal: controller.signal,
    })
    const text = await res.text()
    if (!res.ok) {
      let message = '云端返回错误（HTTP ' + res.status + '）'
      try {
        const parsed = JSON.parse(text)
        if (parsed?.error) message = String(parsed.error)
      } catch { /* 错误体不是 JSON，用默认提示 */ }
      throw new Error(message)
    }
    let snapshot: Snapshot
    try {
      snapshot = JSON.parse(text)
    } catch {
      throw new Error('云端返回的不是有效 JSON')
    }
    if (!snapshot || typeof snapshot !== 'object') throw new Error('快照数据无效')
    if (snapshot.version !== 1 || !snapshot.tables || typeof snapshot.tables !== 'object') {
      throw new Error('快照格式不兼容（期望 version=1 且带 tables）')
    }
    return snapshot
  } catch (error) {
    if (error instanceof Error) {
      if (error.name === 'AbortError') throw new Error('连接云端超时')
      throw error
    }
    throw new Error('拉取快照失败')
  } finally {
    clearTimeout(timer)
  }
}

/** 把快照的一张表对齐成「列名 → 值」的对象数组 */
function tableRows(table: SnapshotTable | undefined): Record<string, string | number | null>[] {
  if (!table || !Array.isArray(table.columns) || !Array.isArray(table.rows)) return []
  const names = table.columns.map(col => col.name)
  return table.rows.map(row => {
    const object: Record<string, string | number | null> = {}
    names.forEach((name, index) => { object[name] = row[index] ?? null })
    return object
  })
}

/** 快照里存成 JSON 字符串的数组字段，解析失败给空数组 */
function parseJsonArray(value: string | number | null): string[] {
  if (typeof value !== 'string') return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.map(item => String(item)) : []
  } catch {
    return []
  }
}

function numberOf(value: string | number | null): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function textOf(value: string | number | null): string {
  return value === null || value === undefined ? '' : String(value)
}

/** 学习状态文案；桌面端节奏是 7 档间隔，stage 走完到 8 算通关 */
function stageStatus(startedAt: number | null, stage: number | null): string {
  if (!startedAt) return '未开始'
  if (stage === null) return '已开始'
  if (stage >= 8) return '已完成'
  if (stage === 0) return '已开始'
  return '已学 ' + stage + ' 轮'
}

/** 计入成果的复习类动作（和桌面端 aggregate 的 'review' 过滤一致） */
const REVIEW_ACTIONS = new Set(['done', 'again', 'spelling', 'reading', 'meaning'])

export function parseSnapshot(snapshot: Snapshot): ParsedSnapshot {
  const listRows = tableRows(snapshot.tables['lists'])
  const wordRows = tableRows(snapshot.tables['list_words'])
  const eventRows = tableRows(snapshot.tables['learning_events'])
  const linkRows = tableRows(snapshot.tables['learning_event_meanings'])
  const profileRows = tableRows(snapshot.tables['meaning_profiles'])
  const kvRows = tableRows(snapshot.tables['kv'])

  // 列表 id → 显示名
  const listNames = new Map<string, string>()
  for (const row of listRows) {
    const id = textOf(row.id)
    if (id) listNames.set(id, textOf(row.name) || id)
  }
  // 列表在快照里的顺序，单词记录按它分组排序
  const listOrder = new Map<string, number>()
  listRows.forEach((row, index) => {
    const id = textOf(row.id)
    if (id && !listOrder.has(id)) listOrder.set(id, index)
  })

  // 词库标签（kv 里一行 JSON），损坏就用词库 id 当显示名
  const labels: VocabLabels = {}
  for (const row of kvRows) {
    if (textOf(row.key) !== 'vocab-labels') continue
    try {
      const parsed = JSON.parse(textOf(row.value_json) || '{}')
      const labelMap = parsed && typeof parsed === 'object' ? parsed.labels : null
      if (labelMap && typeof labelMap === 'object') {
        for (const [id, label] of Object.entries(labelMap)) {
          if (typeof label === 'string' && label.trim()) labels[id] = label.trim()
        }
      }
    } catch { /* 标签坏了就回落词库 id */ }
  }

  // ── 单词记录：按列表顺序 + 字母排序 ──────────────────────────
  const records: WordRecord[] = wordRows.map(row => {
    const listId = textOf(row.list_id)
    const startedAt = row.started_at === null ? null : numberOf(row.started_at)
    const stage = row.stage === null ? null : numberOf(row.stage)
    return {
      word: textOf(row.word),
      listId,
      listName: listNames.get(listId) || listId || '默认列表',
      displayText: textOf(row.display_text) || textOf(row.word),
      phonetic: textOf(row.phonetic),
      translation: textOf(row.translation),
      addedAt: numberOf(row.added_at),
      startedAt,
      stage,
      status: stageStatus(startedAt, stage),
      sourceIds: parseJsonArray(row.source_ids_json),
    }
  }).sort((a, b) => {
    const orderDiff = (listOrder.get(a.listId) ?? 999) - (listOrder.get(b.listId) ?? 999)
    if (orderDiff !== 0) return orderDiff
    return a.word.localeCompare(b.word, 'en')
  })

  // ── 学习成果：复刻 server/study-history.mjs 的 aggregate() ────
  const meaningProfile = new Map<string, { text: string; pos: string }>()
  for (const row of profileRows) {
    meaningProfile.set(textOf(row.meaning_key), {
      text: textOf(row.text_snapshot),
      pos: textOf(row.pos),
    })
  }
  // 事件 → 它挂的词义（一个事件可挂多条）
  const eventMeanings = new Map<string, string[]>()
  for (const row of linkRows) {
    const eventId = textOf(row.event_id)
    const meaningKey = textOf(row.meaning_key)
    if (!eventId || !meaningKey) continue
    const list = eventMeanings.get(eventId)
    if (list) list.push(meaningKey)
    else eventMeanings.set(eventId, [meaningKey])
  }

  interface AchievementDraft extends Omit<Achievement, 'meanings'> {
    meaningStats: Map<string, AchievementMeaning>
  }
  const groups = new Map<string, AchievementDraft>()
  for (const row of eventRows) {
    if (row.deleted_at !== null) continue
    const action = textOf(row.action)
    if (!REVIEW_ACTIONS.has(action)) continue
    const wordKey = textOf(row.word_key)
    if (!wordKey) continue

    let item = groups.get(wordKey)
    if (!item) {
      item = {
        word: textOf(row.word_snapshot) || wordKey,
        wordKey,
        sourceIds: [],
        reviewCount: 0, spellingCount: 0, readingCount: 0,
        rememberedCount: 0, forgottenCount: 0, lastAt: null,
        meaningStats: new Map(),
      }
      groups.set(wordKey, item)
    }
    item.sourceIds = [...new Set([...item.sourceIds, ...parseJsonArray(row.source_ids_json)])]
    // done / again 推进轮次才算复习；会拼 / 会读 / 知意是熟悉度计数，各算各的
    if (action === 'done' || action === 'again') item.reviewCount++
    if (action === 'meaning') item.rememberedCount++
    if (action === 'again') item.forgottenCount++
    if (action === 'spelling') item.spellingCount++
    if (action === 'reading') item.readingCount++
    const occurredAt = numberOf(row.occurred_at)
    item.lastAt = item.lastAt === null ? occurredAt : Math.max(item.lastAt, occurredAt)

    for (const meaningKey of eventMeanings.get(textOf(row.id)) ?? []) {
      const profile = meaningProfile.get(meaningKey)
      const stats = item.meaningStats.get(meaningKey) ?? {
        text: profile?.text ?? '',
        pos: profile?.pos ?? '',
        reviewCount: 0, rememberedCount: 0, forgottenCount: 0,
      }
      if (action === 'done' || action === 'again') stats.reviewCount++
      if (action === 'meaning') stats.rememberedCount++
      if (action === 'again') stats.forgottenCount++
      item.meaningStats.set(meaningKey, stats)
    }
  }

  const achievements: Achievement[] = [...groups.values()]
    .map(item => ({
      word: item.word,
      wordKey: item.wordKey,
      sourceIds: item.sourceIds,
      reviewCount: item.reviewCount,
      spellingCount: item.spellingCount,
      readingCount: item.readingCount,
      rememberedCount: item.rememberedCount,
      forgottenCount: item.forgottenCount,
      lastAt: item.lastAt,
      // 只要有文本的词义，按 知意 → 复习 排序，最多展示 4 条
      meanings: [...item.meaningStats.values()]
        .filter(meaning => meaning.text)
        .sort((a, b) => b.rememberedCount - a.rememberedCount || b.reviewCount - a.reviewCount)
        .slice(0, 4),
    }))
    .sort((a, b) => b.reviewCount - a.reviewCount || a.word.localeCompare(b.word, 'en'))

  return {
    exportedAt: numberOf(snapshot.exportedAt),
    deviceLabel: textOf(snapshot.deviceLabel),
    listCount: listRows.length,
    wordCount: wordRows.length,
    eventCount: eventRows.length,
    records,
    achievements,
    labels,
  }
}
