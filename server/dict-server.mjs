/**
 * dict-server.mjs
 *
* GET  /api/dict?word=&refresh=1  词典查询（缓存优先；上次只拿到一半会自动重取）
* POST /api/dict/search-batch 批量查询词典 { words } -> { results, total, succeeded, failed }
* POST /api/dict/batch        批量读缓存 { words } -> { entries, missing, incomplete }
* POST /api/dict/prefetch     后台补齐音标/释义 { words, force? }
* GET  /api/dict/prefetch     补齐进度 { total, done, failed, pending, running, finished }
* POST /api/dict/repair       扫学习列表，把缺音标/释义的词排进补齐队列 { words? }
* GET  /api/dict/sources      词典来源状态 { local: { ready, count, dir, ... }, network }
* GET  /api/cache/stats       缓存统计 { total, complete, incomplete }
 *
 * GET  /api/lists             获取所有学习列表（含 default）
 * POST /api/lists             新建学习列表 { name }
 * PATCH  /api/lists/:id       重命名列表 { name }
 * DELETE /api/lists/:id       删除列表（default 不可删除）
 *
* GET  /api/lists/:id/words   获取某个列表的单词
* POST /api/lists/:id/words   添加单词/句子 { text, sourceIds?, senseIds? }
* PATCH  /api/lists/:id/words/:text  改这个词要背的释义 { senseIds }
* DELETE /api/lists/:id/words/:text  从列表移除
* POST /api/lists/:id/import  批量导入 { items: [{ text, sourceIds?, senseIds?, translationIds?, translation? }] }
* POST /api/lists/:id/remove  批量移除词条 { words: [] }
*
* GET  /api/word-lists?word=  查询某个词在哪些列表中
*
* POST /api/lists/:id/start   标记一批词开始学习 { words, startedAt?, restart? }
* POST /api/lists/:id/review  复习打卡 { words, action: done | again | stop }
* GET  /api/study/plan        所有正在学习的词 + 艾宾浩斯复习节奏
* GET  /api/study/goal        学习目标（目标 = 某个词库）{ libraryId }
* PUT  /api/study/goal        设置 / 清空学习目标 { libraryId }
 *
* GET  /api/print-batches?limit=       打印批次记录（新在前）
* POST /api/print-batches              记一次卡片导出 { title?, kind?, scope?, printedAt?, groups: [{ listId, words }] }
* POST /api/print-batches/:id/review   把这一批词整批打卡 { action: done | again | stop | tally, scope?, successKind? }
* DELETE /api/print-batches/:id        删掉这条打印记录（不动复习进度）
*
 * GET  /api/vocab-labels        词库显示标签 { labels: { 词库id: 标签 } }
 * POST /api/vocab-labels        批量合并标签 { labels }（用于从 localStorage 迁移）
 * PATCH  /api/vocab-labels/:id  修改某个词库的标签 { label }
 * DELETE /api/vocab-labels/:id  重置为默认标签（删除覆写）
 * GET|POST /api/vocab-print-labels        读取 / 批量合并打印标签
 * PATCH|DELETE /api/vocab-print-labels/:id 修改 / 重置打印标签
*/

import http from 'node:http'
import fs   from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { capitalizeSentence, normalizeText } from './text.mjs'
import { ecdictEntry, ecdictInfo, ecdictDir } from './ecdict.mjs'
import { createStudyHistoryStore } from './study-history.mjs'
import { createStudyListsStore } from './study-lists.mjs'
import { createKvStore, KV_KEYS } from './kv.mjs'

const __dirname  = path.dirname(fileURLToPath(import.meta.url))
// 数据目录：默认 ../cache，可用 DICT_DATA_DIR 覆盖（便于测试 / 后续迁移到云端）
const DATA_DIR   = process.env.DICT_DATA_DIR || path.join(__dirname, '../cache')
const CACHE_FILE = path.join(DATA_DIR, 'dict-cache.json')
const LISTS_FILE = path.join(DATA_DIR, 'study-lists.json')
const LABELS_FILE = path.join(DATA_DIR, 'vocab-labels.json')
const GOAL_FILE  = path.join(DATA_DIR, 'study-goal.json')
const PRINTS_FILE = path.join(DATA_DIR, 'print-batches.json')
const PORT       = Number(process.env.DICT_PORT) || 3456

fs.mkdirSync(DATA_DIR, { recursive: true })

/** 默认列表：始终存在，不允许删除 */
const DEFAULT_LIST_ID = 'default'

// 学习历史先建：它要从 study-lists.json 把老的 marks 导成事件，
// 之后学习列表 store 才能把同一个 json 导进 sqlite 并删掉它——顺序不能反
const studyHistory = createStudyHistoryStore({ dataDir: DATA_DIR, listsFile: LISTS_FILE })
const studyLists = createStudyListsStore({
  dataDir: DATA_DIR, listsFile: LISTS_FILE,
  defaultListId: DEFAULT_LIST_ID, defaultListName: '默认列表',
})
// 小文档（词库标签 / 学习目标 / 打印批次 / 词典缓存）也收进同一个 study-history.sqlite：
// 启动时把老 json 迁进库并删掉，之后 sqlite 是唯一落盘来源，不再有两份真相来回同步
const kv = createKvStore({
  dataDir: DATA_DIR,
  legacyFiles: { labels: LABELS_FILE, goal: GOAL_FILE, prints: PRINTS_FILE, dictCache: CACHE_FILE },
})

// ── 释义容量上限 ──────────────────────────────────────────────────────────

/** 单个词性最多保留多少条释义 */
const MAX_SENSES_PER_POS = 12
/** 一个词条最多缓存多少条释义（缓存存全集，够挑就行） */
const MAX_SENSES = 40
/** 批量查询页一次最多处理 200 个去重后的单词或句子，与前端预览上限一致。 */
const MAX_BATCH_SEARCH_ITEMS = 200
/** 控制外部接口并发，避免批量导入时瞬间触发免费词典或百度限流。 */
const BATCH_SEARCH_CONCURRENCY = 2
/** 学习列表里一个词最多勾选多少条释义 */
const MAX_PICKED_SENSES = 12
/** 学习列表里一个词最多勾选多少条中文词义 */
const MAX_PICKED_TRANSLATIONS = 12
/** 一个词最多几条自定义词义；超出部分丢弃，避免快照串过长 */
const MAX_CUSTOM_TRANSLATIONS = 6
/** 单条自定义词义最长多少字，与中文摘要截断保持同一量级 */
const MAX_CUSTOM_TRANSLATION_LEN = 60
/** 离线模式：不访问外部词典，只用本地缓存（测试和断网时用） */
const NO_NETWORK = process.env.DICT_NO_NETWORK === '1'
/** 关掉本地词典（DICT_ECDICT_OFF=1）：只走外部接口，用来对比效果 */
const LOCAL_DICT_OFF = process.env.DICT_ECDICT_OFF === '1'
/** 百度大模型翻译 API 密钥只从环境变量读取，绝不写入代码或缓存 */
const BAIDU_TRANSLATE_API_KEY = process.env.BAIDU_TRANSLATE_API_KEY || ''
/** 百度翻译应用 ID，与 API Key 分开配置 */
const BAIDU_TRANSLATE_APP_ID = process.env.BAIDU_TRANSLATE_APP_ID || ''
/** 可用环境变量覆盖地址，便于切换百度控制台中实际开通的翻译接口 */
const BAIDU_TRANSLATE_API_URL = process.env.BAIDU_TRANSLATE_API_URL
  || 'https://fanyi-api.baidu.com/ait/api/aiTextTranslate'
/** 外部词典和百度请求的最长等待时间；可用环境变量覆盖，避免请求一直挂住。 */
const NETWORK_TIMEOUT_MS = Math.max(1000, Number(process.env.DICT_NETWORK_TIMEOUT_MS) || 10000)

// ── 艾宾浩斯复习进度 ───────────────────────────────────────────────────────

const DAY = 86400000

/** 复习节奏（天）：首次打卡后第 1 / 2 / 4 / 7 / 15 / 30 / 60 天各复习一次 */
const REVIEW_INTERVALS = [1, 2, 4, 7, 15, 30, 60]

/** 复习请求幂等键保留窗口，覆盖网络重试但避免学习列表无限增长。 */
const MAX_REVIEW_KEYS = 80
/** 只记打标、不动复习排期的动作 */
const PURE_MARK_ACTIONS = new Set(['print', 'spelling', 'reading'])
/** 复习打卡动作：done 推进一轮；tally 只计熟悉度，不动排期 */
const REVIEW_ACTIONS = new Set(['done', 'again', 'stop', 'tally'])
/** 熟悉度计数维度：tally 打卡时必传其一，只累计次数 */
const TALLY_KINDS = new Set(['spelling', 'reading', 'meaning'])
/** 打标粒度：按天 / 按周 */
const MARK_SCOPES = new Set(['day', 'week'])

/** 当天 0 点。到期与否按「天」判断，同一天内的小时差不影响结果。 */
function startOfDay(ts) {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** 所在周的周一 0 点，用于把长期复习计划按周分批 */
function startOfWeek(ts) {
  const day = startOfDay(ts)
  const weekday = (new Date(day).getDay() + 6) % 7
  return day - weekday * DAY
}

/** 打标粒度校验，非法值当没传 */
function normalizeScope(input) {
  const scope = String(input ?? '')
  return MARK_SCOPES.has(scope) ? scope : undefined
}

/**
 * 记一次打标：只累加 markCount 这个去规范化的总次数。
 * 打标日志（时间 / 动作 / 粒度 / 轮次）由 SQLite 事件表保存，JSON 里不再留 marks 镜像，
 * 免得两处来源互相打架；要日志走 /api/study/history。
 */
function pushMark(item, action, at, extra) {
  item.markCount = (Number(item.markCount) || 0) + 1
}

/** 去掉残留的 marks 副本：老数据落盘后可能还带着，响应里不往外吐 */
function withoutMarks(item) {
  const out = Object.assign({}, item)
  delete out.marks
  return out
}

/** 兼容旧数据：缺失、非法或负数计数都按 0。 */
function countOf(value) {
  const count = Number(value)
  return Number.isFinite(count) && count >= 0 ? Math.floor(count) : 0
}

function hasReviewKey(item, key) {
  return Boolean(key)
    && Array.isArray(item.processedReviewKeys)
    && item.processedReviewKeys.includes(key)
}

function rememberReviewKey(item, key) {
  if (!key) return
  const history = Array.isArray(item.processedReviewKeys) ? item.processedReviewKeys : []
  if (!history.includes(key)) history.push(key)
  item.processedReviewKeys = history.slice(-MAX_REVIEW_KEYS)
}

/**
 * 下一次该复习的日期；轮次走完返回 null（视为已毕业）。
 * stage=0 是“刚开始、今天待首次推进”，首次 done 后 stage=1。
 * stage>=1 锚定最近一次 done 打卡当天（lastDoneAt），每次推进都按间隔往后顺延。
 */
function nextDueAt(item) {
  if (!item.startedAt) return null
  const stage = item.stage || 0
  if (stage > REVIEW_INTERVALS.length) return null
  if (stage === 0) return startOfDay(item.startedAt)
   if (item.reviewScope === 'week') {
    // 按周模式：一次复习管一周，下次排到下周一；同一周内多次 done 也只钉在下周一
    return startOfWeek(item.lastDoneAt ?? item.startedAt) + 7 * DAY
   }
  return startOfDay(item.lastDoneAt ?? item.startedAt) + REVIEW_INTERVALS[stage - 1] * DAY
}

/** new 未开始 / due 今天该复习 / scheduled 已排期 / mastered 已毕业 */
function studyState(item, now) {
  if (!item.startedAt) return 'new'
  if ((item.stage || 0) > REVIEW_INTERVALS.length) return 'mastered'
  return nextDueAt(item) <= startOfDay(now) ? 'due' : 'scheduled'
}

/** 词条 + 派生的复习信息，前端不用自己算日期 */
function enrichItem(item, now) {
  return Object.assign({}, item, {
    reviewCount: countOf(item.reviewCount),
    spellingCount: countOf(item.spellingCount),
    readingCount: countOf(item.readingCount),
    rememberedCount: countOf(item.rememberedCount),
    forgottenCount: countOf(item.forgottenCount),
    nextDueAt: nextDueAt(item),
    state: studyState(item, now),
  })
}

/**
 * 本周期（按天 / 按周）内各熟悉度维度的点击次数，供复习页按钮直接展示。
 * 直接从事件表现算，撤销软删事件后次数天然回退，不依赖 JSON 镜像。
 */
function tallyPeriodCounts(item, listId, now) {
  return studyHistory.periodTallyCounts({
    listId,
    word: item.word,
    dayStart: startOfDay(now),
    weekStart: startOfWeek(now),
  })
}

/**
 * 复习打卡的唯一实现：列表打卡和按打印批次整批打卡都走这里，语义只有一份。
 * targets 是归一化后的词集合；tally 只累计熟悉度，done/again 才动轮次和排期。
 * 只改内存里的 list，落盘由调用方负责。
 */
function applyReview(list, targets, action, options) {
  const opts    = options || {}
  const now     = Number(opts.now) || Date.now()
  const scope   = normalizeScope(opts.scope)
  const successKind = TALLY_KINDS.has(opts.successKind) ? opts.successKind : undefined
  const requestIds = opts.requestIds instanceof Map ? opts.requestIds : new Map()
  let updated = 0
  const items = []
  for (const item of list.words) {
    if (!targets.has(item.word)) continue
    const requestId = requestIds.get(item.word)
    if (hasReviewKey(item, requestId) || (requestId && opts.hasRequest?.(requestId))) {
      items.push(enrichItem(item, now))
      continue
    }
    if (action === 'tally') {
      // 会拼 / 会读 / 知意：只累计对应维度的次数，轮次和排期都不动
      if (successKind === 'spelling') item.spellingCount = countOf(item.spellingCount) + 1
      else if (successKind === 'reading') item.readingCount = countOf(item.readingCount) + 1
      else if (successKind === 'meaning') item.rememberedCount = countOf(item.rememberedCount) + 1
      else { items.push(enrichItem(item, now)); continue }
      pushMark(item, successKind, now, { scope, stage: item.stage })
      opts.onEvent?.({ item, action: successKind, at: now, scope, stage: item.stage, requestId })
      rememberReviewKey(item, requestId)
      updated++
      } else if (action === 'stop') {
        delete item.startedAt
        delete item.stage
        delete item.reviewedAt
        delete item.lastDoneAt
        delete item.reviewScope
        pushMark(item, 'stop', now, { scope })
      opts.onEvent?.({ item, action: 'stop', at: now, scope, stage: undefined, requestId })
      rememberReviewKey(item, requestId)
      updated++
    } else if (item.startedAt) {
      const history = Array.isArray(item.reviewedAt) ? item.reviewedAt : []
      history.push(now)
      item.reviewedAt = history.slice(-40)
      // 一次坐下来复习算一次打卡
      item.reviewCount = (Number(item.reviewCount) || 0) + 1
      if (action === 'done') {
        // 推进一轮：下次复习锚定本次打卡当天，按间隔往后顺延
        item.stage = Math.min((item.stage || 0) + 1, REVIEW_INTERVALS.length + 1)
        item.lastDoneAt = now
        // 按周打卡的词一次管一周：之后排到下周一，而不是按天顺延
        item.reviewScope = scope === 'week' ? 'week' : 'day'
        } else {
          // 没记住：记忆周期从今天重新开始
          item.stage = 0
          item.startedAt = now
          delete item.lastDoneAt
          item.forgottenCount = countOf(item.forgottenCount) + 1
          item.reviewScope = scope === 'week' ? 'week' : 'day'
        }
      pushMark(item, action, now, { scope, stage: item.stage })
      opts.onEvent?.({
        item, action, at: now, scope,
        stage: item.stage, requestId,
      })
      rememberReviewKey(item, requestId)
      updated++
    }
    items.push(enrichItem(item, now))
  }
  return { updated, items }
}

// ── Data helpers ──────────────────────────────────────────────────────────

function recordStudyEvent(list, event) {
  return studyHistory.record({
    item: event.item, listId: list.id, listName: list.name, action: event.action,
    at: event.at, scope: event.scope, stage: event.stage, requestId: event.requestId,
    eventKey: event.eventKey, metadata: event.metadata,
  })
}

// normalizeText 从 ./text.mjs 引进来：本地词典（ecdict.mjs）也要用同一套主键规则

/**
 * 判定词条类型：
 * - 命中任意词库（sourceIds 非空）→ 词库条目，即使是 "a few" 这类固定短语也算 word
 * - 否则含空白 → 句子
 */
function detectType(input, sourceIds) {
  if (Array.isArray(sourceIds) && sourceIds.length > 0) return 'word'
  return /\s/.test(normalizeText(input)) ? 'sentence' : 'word'
}

/** 要背的释义 id：去空、去重、限量。返回空数组表示「没挑」，调用方不写这个字段。 */
function normalizeSenseIds(input) {
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
function normalizeCustomTranslations(input) {
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
function normalizeTranslationIds(input) {
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

const TRANSLATION_POS_LABELS = {
  noun: 'n.', n: 'n.', verb: 'v.', v: 'v.', vt: 'vt.', vi: 'vi.',
  adjective: 'a.', adj: 'a.', adverb: 'ad.', adv: 'ad.',
  preposition: 'prep.', prep: 'prep.', conjunction: 'conj.', conj: 'conj.',
  pronoun: 'pron.', pron: 'pron.', interjection: 'int.', int: 'int.',
}

function translationPosLabel(pos) {
  const value = String(pos ?? '').trim().toLowerCase().replace(/\.$/, '')
  return TRANSLATION_POS_LABELS[value] || (value ? value + '.' : '')
}

function splitTranslationGroups(text) {
  return String(text ?? '').split(/[；;]\s*(?=[a-zA-Z]{1,8}\.\s*)/).map(value => value.trim()).filter(Boolean)
}

function translationParts(text, fallbackPos) {
  return splitTranslationGroups(text).flatMap(group => {
    const match = /^([a-zA-Z]{1,8})\.\s*(.+)$/.exec(group)
    const pos = match ? match[1].toLowerCase() : String(fallbackPos ?? '').trim()
    const body = match ? match[2] : group
    return body.split(/[，,]/).map(value => ({ text: value.trim(), pos })).filter(item => item.text)
  })
}

function expandedTranslations(choices) {
  let previousPos = ''
  return (Array.isArray(choices) ? choices : []).flatMap(item => {
    const parts = translationParts(item?.text, item?.pos || previousPos)
    const lastPart = parts[parts.length - 1]
    if (lastPart?.pos) previousPos = lastPart.pos
    return parts.map((part, index) => ({ id: parts.length === 1 ? item.id : item.id + '::' + index, ...part }))
  })
}

function formatSelectedTranslations(options) {
  const groups = []
  for (const option of options) {
    const text = String(option?.text ?? '').trim()
    if (!text) continue
    const pos = String(option?.pos ?? '').trim().toLowerCase()
    let group = groups.find(item => item.pos === pos)
    if (!group) { group = { pos, texts: [] }; groups.push(group) }
    if (!group.texts.includes(text)) group.texts.push(text)
  }
  return groups.filter(group => group.texts.length > 0)
    .map(group => (group.pos ? translationPosLabel(group.pos) + ' ' : '') + group.texts.join(','))
    .join('；')
}

function makeDefaultList() {
  return { id: DEFAULT_LIST_ID, name: '默认列表', createdAt: Date.now(), words: [] }
}

/** { lists: [ { id, name, createdAt, words: [{word, type, sourceIds, addedAt, translation?}] } ] } */
function loadLists() {
  // 数据在 study-history.sqlite 的 lists / list_words 表里；store 返回和老 json 同构的结构
  const data = studyLists.load()
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
      // 复习进度字段只在开始学习后才写，未开始的词保持精简
      if (item.startedAt) {
        if (typeof item.stage !== 'number' || !(item.stage >= 0)) item.stage = 0
        if (!Array.isArray(item.reviewedAt)) item.reviewedAt = []
      }
    }
  }
  return data
}
function saveLists(data) {
  // 一次事务整库重写；marks 镜像已废弃，事件表是唯一来源，这里没有 marks 列可清
  studyLists.save(data)
}

/** 把词典里已经拿到的中文翻译同步到学习列表词条；不改变列表页面的展示规则。 */
function selectedTranslation(entry, ids, customs) {
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

/** 只给没有中文快照的旧词条 / 导入词条补翻译；搜索页保存的快照不被后台覆盖。 */
function syncListTranslation(word, entry) {
  const target = normalizeText(word)
  if (!target) return false
  const data = loadLists()
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
  if (changed) saveLists(data)
  return changed
}

// ── Vocab label helpers ───────────────────────────────────────────────────

/** 标签长度上限，避免把整段描述塞进标签里 */
const MAX_LABEL_LENGTH = 40

/**
 * 词库标签：{ labels: { [词库id]: 显示标签 }, printLabels: { [词库id]: 打印标签 } }
 * 词库本体由前端在构建期打包 vocab/*.json，服务端只存「标签覆写」，没有覆写就用词库 id。
 */
function loadLabels() {
  const data = kv.get(KV_KEYS.labels, null)
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
function saveLabels(data) { kv.set(KV_KEYS.labels, data) }

/** 词库 id 再长就是脏数据了 */
const MAX_LIBRARY_ID_LENGTH = 80

/**
 * 学习目标：{ libraryId } 指向某个词库 id，空串表示还没设过目标。
 * 词库本体在前端（构建期打包 vocab 目录下的 json），服务端只记「目标是哪个词库」，
 * 达成度由前端拿本地词库和正在学习的词现算。
 */
function loadGoal() {
  const data = kv.get(KV_KEYS.goal, null)
  const libraryId = data && typeof data.libraryId === 'string' ? data.libraryId.trim() : ''
  return { libraryId }
}
function saveGoal(data) { kv.set(KV_KEYS.goal, data) }

// ── 打印批次（导出卡片的留档） ─────────────────────────────────────────────

/** 最多留多少条打印记录，超了丢最老的 */
const MAX_PRINT_BATCHES = 60
/** GET 默认返回多少条 */
const DEFAULT_PRINT_LIMIT = 20
/** 批次标题长度上限 */
const MAX_PRINT_TITLE = 80
/** 批次来源：start 挑新词 / review 复习计划 / custom 自由挑选打印 */
const PRINT_KINDS = new Set(['start', 'review', 'custom'])

/**
 * { batches: [ { id, printedAt, kind, scope?, title, wordCount, items: [{ listId, listName, word }] } ] }
 * 批次只存「打印了哪些词」，每个词的进度读接口时从学习列表现算，
 * 免得同一个词在两处各存一份状态、互相矛盾。
 */
function loadPrints() {
  const data = kv.get(KV_KEYS.prints, null)
  if (!data || !Array.isArray(data.batches)) return { batches: [] }
  for (const batch of data.batches) {
    if (!Array.isArray(batch.items)) batch.items = []
  }
  return data
}
function savePrints(data) { kv.set(KV_KEYS.prints, data) }

/** 批次 id 用打印时间；同一毫秒内又打了一批就加后缀 */
function uniquePrintId(batches, printedAt) {
  const base = 'print_' + printedAt
  let id = base
  for (let i = 1; batches.some(b => b.id === id); i++) id = base + '_' + i
  return id
}

/**
 * 打印批次按 listId + 规范化后的 word 判定内容是否相同。排序后再序列化，
 * 因此跨列表的同一组词即使传入顺序不同，也只保留最近创建的一条记录。
 */
function printBatchItemsKey(items) {
  if (!Array.isArray(items)) return ''
  return items
    .map(item => [String(item?.listId ?? '').trim(), normalizeText(item?.word)])
    .filter(([listId, word]) => listId && word)
    .map(pair => JSON.stringify(pair))
    .sort()
    .join('\n')
}

/** 批次 + 每个词的当前进度：dueCount / markableCount / missingCount 都是现算的，不落盘 */
function enrichBatch(batch, lists, now) {
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
    const state = studyState(item, now)
    if (state === 'due') dueCount++
    if (item.startedAt) markableCount++
    items.push({
      listId: list.id,
      listName: list.name,
      word: item.word,
      state,
      stage: item.stage || 0,
      nextDueAt: nextDueAt(item),
    })
  }
  return Object.assign({}, batch, { items, dueCount, markableCount, missingCount })
}

// ── Dict helpers ──────────────────────────────────────────────────────────

/**
 * 缓存里的词条统一长这样：
 *   { word, phonetic?, translation?, senses: [{ id, pos, definition }], cachedAt, status }
 *
 * senses 是拍平后的「释义全集」：一个词所有词性下的释义都留着，
 * 学习列表再从里面挑这一阶段要背的几条（item.senseIds）。
 * sense.id = 词性 + '#' + 该词性下的序号（如 noun#0），重新抓取后 id 依然对得上。
 * status: ok = 音标/释义/中文都拿到了；partial = 有一部分没拿到，下次还要再试。
 * spellingStatus: valid = 词典明确命中；suspect = 本地未命中且免费词典明确 404；
 *                 unknown = 网络异常等原因尚未确认；unchecked = 含空格的句子或短语不校验。
 */
function normalizeEntry(word, raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const w = normalizeText(word || src.word)
  const phonetic = String(src.phonetic ?? '').trim() || undefined
  const translation = String(src.translation ?? '').trim() || undefined
  const translations = []
  const translationTexts = new Set()
  let previousTranslationPos = ''
  const pushTranslation = (text, pos, source) => {
    const values = translationParts(text, pos || previousTranslationPos)
    const lastValue = values[values.length - 1]
    if (lastValue?.pos) previousTranslationPos = lastValue.pos
    for (const value of values) {
      const key = value.pos + '\u0000' + value.text
      if (translationTexts.has(key) || translations.length >= MAX_SENSES) continue
      translationTexts.add(key)
      translations.push({
        id: 'translation#' + translations.length,
        text: value.text,
        ...(value.pos ? { pos: value.pos } : {}),
        ...(source === 'ecdict' || source === 'api' ? { source } : {}),
      })
    }
  }
  if (Array.isArray(src.translations)) {
    for (const item of src.translations) {
      if (typeof item === 'string') pushTranslation(item, undefined, src.source)
      else pushTranslation(item?.text, item?.pos, item?.source || src.source)
    }
  }
  // 兼容旧缓存：旧 translation 是摘要，作为一个不可拆分的候选保留。
  if (translations.length === 0 && translation) pushTranslation(translation, undefined, src.source)
  // translation 是兼容旧缓存和卡片的摘要，保留来源提供的原始摘要（例如词性前缀）；
  // translations 则是给用户逐条勾选的中文候选，不把展示信息混回摘要。
  const normalizedTranslation = translation || (translations.length > 0
    ? formatSelectedTranslations(translations)
    : undefined)

  const senses = []
  const seats = {}
  const push = (pos, definition) => {
    const text = String(definition ?? '').trim()
    if (!text || senses.length >= MAX_SENSES) return
    const key = String(pos ?? '').trim() || 'other'
    const seat = seats[key] ?? 0
    if (seat >= MAX_SENSES_PER_POS) return
    seats[key] = seat + 1
    senses.push({ id: key + '#' + seat, pos: key, definition: text })
  }
  if (Array.isArray(src.senses)) {
    for (const s of src.senses) push(s?.pos, s?.definition)
  } else if (Array.isArray(src.meanings)) {
    // 老缓存格式 { partOfSpeech, definitions: [] }；例句字段（examples）读进来就丢掉
    for (const m of src.meanings) {
      const defs = Array.isArray(m?.definitions) ? m.definitions : []
      for (const d of defs) push(m?.partOfSpeech, d)
    }
  }

  const dictOk = isPhrase(w) || !!phonetic || senses.length > 0
  const status = src.status === 'ok' || src.status === 'partial'
    ? src.status
    : (dictOk && normalizedTranslation ? 'ok' : 'partial')

  const validPhoneticStatuses = new Set(['complete', 'partial', 'missing'])
  const phoneticStatus = validPhoneticStatuses.has(src.phoneticStatus)
    ? src.phoneticStatus
    : (phonetic ? 'complete' : 'missing')
  const validTranslationStatuses = new Set(['ok', 'error', 'missing'])
  const translationStatus = validTranslationStatuses.has(src.translationStatus)
    ? src.translationStatus
    : (normalizedTranslation ? 'ok' : 'missing')
  const validSpellingStatuses = new Set(['valid', 'suspect', 'unchecked', 'unknown'])
  let spellingStatus
  if (isPhrase(w)) spellingStatus = 'unchecked'
  else if (validSpellingStatuses.has(src.spellingStatus)) spellingStatus = src.spellingStatus
  // 兼容旧缓存：本地词典来源一定有效；旧外部词典结果有音标或英文释义时也视为明确命中。
  else if (src.source === 'ecdict' || (src.source === 'api' && (phonetic || senses.length > 0))) spellingStatus = 'valid'
  else spellingStatus = 'unknown'
  const errors = []
  const validErrorCodes = new Set(['timeout', 'http_error', 'network_error', 'invalid_response', 'not_found', 'not_configured'])
  if (Array.isArray(src.errors)) {
    for (const item of src.errors.slice(0, 20)) {
      const source = item?.source === 'baidu' || item?.source === 'dictionaryapi' ? item.source : null
      const code = validErrorCodes.has(item?.code) ? item.code : null
      const message = String(item?.message ?? '').trim()
      if (!source || !code || !message) continue
      errors.push({
        source,
        code,
        message,
        ...(Number.isInteger(item?.status) ? { status: item.status } : {}),
        ...(String(item?.target ?? '').trim() ? { target: String(item.target).trim() } : {}),
      })
    }
  }

  // 固定字段顺序，缓存文件 diff 起来干净
  // 候选数组按输入顺序生成，ID 从 translation#0 开始且可跨重抓结果复用。
  for (let i = 0; i < translations.length; i++) translations[i].id = 'translation#' + i

  const entry = { word: w }
  if (phonetic) entry.phonetic = phonetic
  if (normalizedTranslation) entry.translation = normalizedTranslation
  if (translations.length > 0) entry.translations = translations
  entry.senses = senses
  entry.cachedAt = Number(src.cachedAt) || Date.now()
  entry.status = status
  entry.phoneticStatus = phoneticStatus
  entry.translationStatus = translationStatus
  entry.spellingStatus = spellingStatus
  if (errors.length > 0) entry.errors = errors
  // 这条释义是本地词典给的还是外部接口给的，界面上要标一下
  if (src.source === 'ecdict' || src.source === 'api') entry.source = src.source
  // 句子翻译来源单独记录，避免旧缓存（即使 status=ok）绕过百度翻译。
  if (src.translationSource === 'baidu') entry.translationSource = 'baidu'
  return entry
}

// 缓存常驻内存，省掉每个请求都读一遍整个 json
let cacheMap = null
let cacheStamp = NaN

/** 拿缓存；别的连接改了库（PRAGMA data_version 变了）就整表重读一遍 */
function getCache() {
  const version = kv.cacheVersion()
  if (cacheMap && version === cacheStamp) return cacheMap
  const raw = kv.loadCacheMap()
  const next = {}
  for (const [key, value] of Object.entries(raw)) {
    const word = normalizeText(key)
    if (word) next[word] = normalizeEntry(word, value)
  }
  cacheMap = next
  cacheStamp = version
  return cacheMap
}

function putCache(entry) {
  getCache()[entry.word] = entry
  kv.putCacheEntry(entry)
  return entry
}

function makeNetworkError(source, code, status) {
  const messages = {
    timeout: '请求超时（超过 ' + Math.round(NETWORK_TIMEOUT_MS / 1000) + ' 秒）',
    http_error: '请求失败（HTTP ' + status + '）',
    network_error: '网络请求失败',
    invalid_response: '返回格式无效',
    not_found: '未找到词条',
    not_configured: '未完整配置百度翻译 API Key 和 App ID',
  }
  const error = new Error(messages[code] || '请求失败')
  error.source = source
  error.code = code
  if (Number.isInteger(status)) error.status = status
  return error
}

function publicNetworkError(error, source, target) {
  const actualSource = error?.source === 'baidu' || error?.source === 'dictionaryapi'
    ? error.source
    : source
  const code = ['timeout', 'http_error', 'network_error', 'invalid_response', 'not_found', 'not_configured'].includes(error?.code)
    ? error.code
    : 'network_error'
  const result = {
    source: actualSource,
    code,
    message: error?.message || '请求失败',
  }
  if (Number.isInteger(error?.status)) result.status = error.status
  if (String(target ?? '').trim()) result.target = String(target).trim()
  return result
}

async function fetchJson(url, options = {}) {
  const source = options.source === 'baidu' ? 'baidu' : 'dictionaryapi'
  const requestOptions = { ...options }
  delete requestOptions.source
  const controller = new AbortController()
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(makeNetworkError(source, 'timeout'))
    }, NETWORK_TIMEOUT_MS)
  })
  try {
    const request = fetch(url, { ...requestOptions, signal: controller.signal })
    const res = await Promise.race([request, timeout])
    if (!res.ok) {
      throw makeNetworkError(source, res.status === 404 ? 'not_found' : 'http_error', res.status)
    }
    try {
      return await res.json()
    } catch {
      throw makeNetworkError(source, 'invalid_response')
    }
  } catch (error) {
    if (error?.source && error?.code) throw error
    if (error?.name === 'AbortError') throw makeNetworkError(source, 'timeout')
    throw makeNetworkError(source, 'network_error')
  } finally {
    clearTimeout(timer)
  }
}

/** 含空白 = 短语或句子，dictionaryapi.dev 查不到，别浪费一次请求 */
function isPhrase(word) { return /\s/.test(word) }

/**
 * 句子直接走百度翻译；短的固定短语仍允许命中 ECDICT（例如 a few）。
 * 没有本地词条的多词输入同样会走百度，因此不会再走旧的免费机翻接口。
 */
function isSentence(word) {
  const parts = normalizeText(word).split(/\s+/).filter(Boolean)
  return parts.length >= 3 || /[.!?！？。；;]/.test(word)
}

/**
 * 译文至少要包含中文；百度返回错误提示或原文时不写入缓存。
 */
function isBadTranslation(text, word) {
  const t = String(text ?? '').trim()
  if (!t) return true
  if (t.toLowerCase() === word) return true
  return !/[\u4e00-\u9fff]/.test(t)
}

/**
 * 句子没有可直接查询的整句音标，所以按单词查音标再按原句拼回去。
 * 本地 ECDICT 优先，缺少的单词才调用 dictionaryapi.dev。
 */
async function fetchSentencePhonetic(text) {
  const matches = [...String(text).matchAll(/[A-Za-z]+(?:['’][A-Za-z]+)*/g)]
  if (matches.length === 0) return { phonetic: undefined, complete: false, missing: [], errors: [] }

  const tokens = [...new Set(matches.map(match => match[0].toLowerCase()))]
  const phonetics = new Map()
  const missing = []
  const errors = []
  await Promise.all(tokens.map(async token => {
    const local = localEntry(token)
    if (local?.phonetic) {
      phonetics.set(token, local.phonetic)
      return
    }
    if (NO_NETWORK) { missing.push(token); return }
    try {
      const data = await fetchJson(
        'https://api.dictionaryapi.dev/api/v2/entries/en/' + encodeURIComponent(token),
        { source: 'dictionaryapi' },
      )
      const entry = Array.isArray(data) ? data[0] : null
      const phonetic = entry?.phonetic || entry?.phonetics?.find(item => item.text)?.text
      if (phonetic) phonetics.set(token, phonetic)
      else {
        missing.push(token)
        errors.push(publicNetworkError(makeNetworkError('dictionaryapi', 'invalid_response'), 'dictionaryapi', token))
      }
    } catch (e) {
      // 单个单词查不到只影响这一处音标，不能阻塞整句翻译。
      missing.push(token)
      errors.push(publicNetworkError(e, 'dictionaryapi', token))
      if (e.code !== 'not_found') console.warn('[sentence-phonetic]', token, e.message)
    }
  }))

  let cursor = 0
  let result = ''
  for (const match of matches) {
    result += text.slice(cursor, match.index) + (phonetics.get(match[0].toLowerCase()) || match[0])
    cursor = match.index + match[0].length
  }
  return {
    phonetic: phonetics.size > 0 ? (result + text.slice(cursor)).trim() : undefined,
    complete: phonetics.size === tokens.length,
    missing,
    errors,
  }
}

/**
 * 调用百度大模型文本翻译 API。
 * 使用百度大模型文本翻译接口的 Bearer API Key 鉴权；地址可通过环境变量调整，
 * 避免把密钥、账号或特定部署方式写死在项目里。
 */
async function fetchBaiduTranslation(text) {
  if (NO_NETWORK) return { translation: undefined, errors: [] }
  if (!BAIDU_TRANSLATE_API_KEY || !BAIDU_TRANSLATE_APP_ID) {
    return { translation: undefined, errors: [publicNetworkError(makeNetworkError('baidu', 'not_configured'), 'baidu')] }
  }
  try {
    const headers = { 'Content-Type': 'application/json' }
    headers.Authorization = 'Bearer ' + BAIDU_TRANSLATE_API_KEY
    const data = await fetchJson(BAIDU_TRANSLATE_API_URL, {
      source: 'baidu',
      method: 'POST',
      headers,
      body: JSON.stringify({
        appid: BAIDU_TRANSLATE_APP_ID,
        from: 'en',
        to: 'zh',
        q: text,
      }),
    })
    // 兼容百度翻译接口和大模型网关常见的返回包装，统一只取最终译文。
    const candidates = [
      data?.result?.translation,
      data?.result?.translated_text,
      data?.result?.text,
      data?.translation,
      data?.translated_text,
      data?.text,
      ...(Array.isArray(data?.result?.trans_result) ? data.result.trans_result.map(x => x?.dst) : []),
      ...(Array.isArray(data?.trans_result) ? data.trans_result.map(x => x?.dst) : []),
      data?.choices?.[0]?.message?.content,
      data?.choices?.[0]?.text,
    ]
    const translation = candidates.find(value => !isBadTranslation(value, normalizeText(text)))
    if (!translation) throw makeNetworkError('baidu', 'invalid_response')
    return { translation: String(translation).trim(), errors: [] }
  } catch (e) {
    console.warn('[baidu-translate]', normalizeText(text), e.message)
    return { translation: undefined, errors: [publicNetworkError(e, 'baidu')] }
  }
}

/** 抓一次外部接口：单词的音标 + 英文释义（dictionaryapi.dev）+ 中文（百度） */
async function fetchDictEntry(word) {
  const queryText = String(word ?? '').trim().replace(/\s+/g, ' ')
  const w = normalizeText(word)
  if (NO_NETWORK) return normalizeEntry(w, { status: 'partial' })

  let phonetic, translation
  let phoneticStatus = 'missing'
  let translationStatus = 'missing'
  const errors = []
  const senses = []
  let dictOk = isPhrase(w)
  let spellingStatus = isPhrase(w) ? 'unchecked' : 'unknown'

  if (isSentence(w)) {
    const sentence = await fetchSentencePhonetic(capitalizeSentence(queryText))
    phonetic = sentence.phonetic
    phoneticStatus = sentence.complete ? 'complete' : (phonetic ? 'partial' : 'missing')
    errors.push(...sentence.errors)
    // 句子音标允许部分成功；整句中文翻译必须继续执行。
    dictOk = true
  }

  if (!isPhrase(w)) {
    try {
      const data = await fetchJson(
        'https://api.dictionaryapi.dev/api/v2/entries/en/' + encodeURIComponent(w),
        { source: 'dictionaryapi' },
      )
      const e = Array.isArray(data) ? data[0] : null
      if (!e || typeof e !== 'object') throw makeNetworkError('dictionaryapi', 'invalid_response')
      phonetic = e?.phonetic || e?.phonetics?.find(p => p.text)?.text
      // 释义全集：不再每个词性只留 3 条，勾选要背哪几条是前端的事
      for (const m of e?.meanings ?? []) {
        for (const d of m?.definitions ?? []) {
          senses.push({ pos: m.partOfSpeech, definition: d.definition })
        }
      }
      phoneticStatus = phonetic ? 'complete' : 'missing'
      dictOk = true
      spellingStatus = 'valid'
    } catch (e) {
      // 404 = 词典确认没这个词，不用反复重试；超时/限流留着下次补
      if (e.code === 'not_found') {
        dictOk = true
        spellingStatus = 'suspect'
      }
      else console.warn('[dict-api]', w, e.message)
      errors.push(publicNetworkError(e, 'dictionaryapi', w))
    }
  }

  const baidu = await fetchBaiduTranslation(isSentence(w) ? capitalizeSentence(queryText) : w)
  translation = baidu.translation
  translationStatus = translation ? 'ok' : (baidu.errors.some(error => error.code === 'not_configured') ? 'missing' : 'error')
  errors.push(...baidu.errors)

  return normalizeEntry(w, {
    phonetic, translation,
    translations: translation ? [{ text: translation, source: 'api' }] : [],
    senses,
    cachedAt: Date.now(),
    status: dictOk && translation ? 'ok' : 'partial',
    phoneticStatus,
    translationStatus,
    spellingStatus,
    errors,
    source: 'api',
    translationSource: translation ? 'baidu' : undefined,
  })
}

// ── 本地词典优先 ──────────────────────────────────────────────────────────

/** 查本地 ECDICT；没装 / 没这个词 / 读挂了都返回 null，调用方再决定要不要打网络 */
function localEntry(word) {
  if (LOCAL_DICT_OFF) return null
  try {
    const raw = ecdictEntry(word)
    return raw ? normalizeEntry(word, raw) : null
  } catch (e) {
    console.warn('[ecdict]', word, e.message)
    return null
  }
}

/**
 * 挑释义：本地词典给得出来就用本地这份，外部接口那份只在本地查不到时兜底。
 * ECDICT 是人工整理的词典，不留旧缓存的英文释义——
 * 从前为了保住例句会反过来让旧数据顶掉 ECDICT，例句去掉之后就没有这个理由了。
 */
function pickSenses(local, fresh, old) {
  if (local && local.senses.length > 0) return local.senses
  if (fresh && fresh.senses.length > 0) return fresh.senses
  return old?.senses || []
}

/**
 * 这条缓存值得再问一次本地词典吗？
 * 没抓齐的、以及装 ECDICT 之前留下的旧数据（source 不是 ecdict）都算。
 * 有了这一条，历史缓存下次被查到时就自动换成本地词典的音标 / 中文 / 释义，
 * 不用手动跑 repair；本地词典没装（或被 DICT_ECDICT_OFF 关掉）时一律返回 false，
 * 免得白做无用功、也不改动老缓存。
 */
function staleAgainstLocal(entry) {
  if (LOCAL_DICT_OFF || !ecdictInfo().ready) return false
  return !entry || entry.status !== 'ok' || entry.source !== 'ecdict'
}

/**
 * 合并三份来源。音标和中文一律 本地 > 这次抓的 > 旧缓存：
 * ECDICT 是人工整理的词典，百度翻译负责外部文本和句子翻译。
 */
function mergeEntry(word, sources) {
  const { local, fresh, old } = sources
  const senses = pickSenses(local, fresh, old)
  const phonetic    = local?.phonetic    || fresh?.phonetic    || old?.phonetic
  const translations = local?.translations?.length
    ? local.translations
    : (fresh?.translations?.length ? fresh.translations : old?.translations)
  const translation = local?.translation || fresh?.translation || old?.translation
    || (translations?.length ? translations.map(item => item.text).join('；') : undefined)
  const translationSource = local?.translation
    ? undefined
    : (fresh?.translationSource === 'baidu' || old?.translationSource === 'baidu' ? 'baidu' : undefined)
  const phoneticStatus = local?.phonetic
    ? 'complete'
    : (fresh?.phoneticStatus || (fresh?.phonetic ? 'complete' : undefined) || old?.phoneticStatus
      || (old?.phonetic ? 'complete' : 'missing'))
  const translationStatus = translation
    ? 'ok'
    : (fresh?.translationStatus || old?.translationStatus || 'missing')
  const errors = fresh
    ? (fresh.errors || [])
    : (local ? [] : (old?.errors || []))
  const spellingStatus = isPhrase(word)
    ? 'unchecked'
    : (local ? 'valid' : (fresh?.spellingStatus || old?.spellingStatus || 'unknown'))
  const dictOk = isSentence(word) ? true : isPhrase(word) || !!phonetic || senses.length > 0
  return normalizeEntry(word, {
    phonetic, translation, translations, senses,
    cachedAt: Date.now(),
    status: dictOk && translation ? 'ok' : 'partial',
    phoneticStatus,
    translationStatus,
    spellingStatus,
    errors,
    source: local ? 'ecdict' : (fresh?.source || old?.source),
    translationSource,
  })
}

/**
 * 取词条的唯一实现。顺序是「缓存 → 本地词典 → 外部接口」：
 * 本地词典能给出完整词条（音标 + 中文）时直接落盘返回，一次网络请求都不发。
 * 缓存已经抓齐、但是装词典之前抓的（source 不是 ecdict）时，仍然问一次本地词典就地升级，
 * 本地查不到就原样返回旧缓存——这一步永远不打网络。
 * 返回 network 标记，补齐队列据此决定要不要限速。
 */
async function resolveEntry(word, force) {
  const queryText = String(word ?? '').trim().replace(/\s+/g, ' ')
  const w = normalizeText(word)
  if (!w) throw new Error('missing word')
  const old = getCache()[w]
  // 旧版本可能把句子按固定短语写成了 ECDICT 缓存；句子现在必须由百度翻译，不能被这条缓存短路挡住。
  const sentenceNeedsRefresh = isSentence(w)
    && (old?.translationSource !== 'baidu' || !old?.phonetic
      || old?.phoneticStatus === 'partial' || old?.translationStatus !== 'ok')
  if (old && old.status === 'ok' && !force && !sentenceNeedsRefresh) {
    const upgrade = !isSentence(w) && staleAgainstLocal(old) ? localEntry(w) : null
    if (!upgrade || upgrade.status !== 'ok') return { entry: old, network: false }
    return { entry: putCache(mergeEntry(w, { local: upgrade, old })), network: false }
  }

  // 多词句子不使用 ECDICT 的固定短语释义，中文统一由百度翻译；
  // 两词固定搭配（例如 a few）仍可使用本地词典。
  const local = isSentence(w) ? null : localEntry(w)
  if (local && local.status === 'ok') {
    // 本地词典就够了：force 也不打网络，不然刷新一次又被机翻译文盖回去
    return { entry: putCache(mergeEntry(w, { local, old })), network: false }
  }
  if (NO_NETWORK) {
    if (!local) return { entry: old || normalizeEntry(w, { status: 'partial' }), network: false }
    return { entry: putCache(mergeEntry(w, { local, old })), network: false }
  }

  const fresh = await fetchDictEntry(queryText || w)
  return { entry: putCache(mergeEntry(w, { local, fresh, old })), network: true }
}

/**
 * 加入学习后的后台任务只补音标，不重新翻译中文，也不改动已缓存的中文候选。
 * 搜索阶段已经负责完整查询，这里只是处理搜索结果仍缺音标的降级情况。
 */
async function resolvePhoneticOnly(word) {
  const w = normalizeText(word)
  if (!w) throw new Error('missing word')
  const old = getCache()[w]
  if (old?.phonetic && old.phoneticStatus !== 'partial') return { entry: old, network: false }

  if (isSentence(w)) {
    if (NO_NETWORK) return { entry: old || normalizeEntry(w, { status: 'partial' }), network: false }
    const sentence = await fetchSentencePhonetic(capitalizeSentence(w))
    if (!sentence.phonetic && !old) return { entry: normalizeEntry(w, { status: 'partial' }), network: true }
    const errors = [
      ...(old?.errors || []).filter(error => error.source !== 'dictionaryapi'),
      ...sentence.errors,
    ]
    const entry = putCache(normalizeEntry(w, {
      ...old,
      phonetic: sentence.phonetic || old?.phonetic,
      phoneticStatus: sentence.complete ? 'complete' : (sentence.phonetic || old?.phonetic ? 'partial' : 'missing'),
      errors,
      cachedAt: Date.now(),
    }))
    return { entry, network: true }
  }

  const local = localEntry(w)
  if (local?.phonetic) {
    const entry = putCache(normalizeEntry(w, {
      ...old,
      phonetic: local.phonetic,
      phoneticStatus: 'complete',
      spellingStatus: 'valid',
      cachedAt: Date.now(),
    }))
    return { entry, network: false }
  }
  if (NO_NETWORK) return { entry: old || normalizeEntry(w, { status: 'partial' }), network: false }

  const data = await fetchJson(
    'https://api.dictionaryapi.dev/api/v2/entries/en/' + encodeURIComponent(w),
    { source: 'dictionaryapi' },
  )
  const source = Array.isArray(data) ? data[0] : null
  const phonetic = source?.phonetic || source?.phonetics?.find(item => item.text)?.text
  if (!phonetic) throw makeNetworkError('dictionaryapi', 'invalid_response')
  const entry = putCache(normalizeEntry(w, {
    ...old,
    phonetic,
    phoneticStatus: 'complete',
    spellingStatus: 'valid',
    errors: (old?.errors || []).filter(error => error.source !== 'dictionaryapi'),
    cachedAt: Date.now(),
  }))
  return { entry, network: true }
}

/** 保留原签名给别处用 */
async function ensureEntry(word, force) {
  return (await resolveEntry(word, force)).entry
}

/**
 * 批量用本地词典补一遍缓存，只写一次盘。
 * 批量读缓存（打印卡片 / 学习列表）时先过一遍，本地查到的词就不用再排队补齐了。
 */
function fillFromLocal(words) {
  if (LOCAL_DICT_OFF) return 0
  const cache = getCache()
  const changed = []
  let filled = 0
  for (const word of words) {
    const local = isSentence(word) ? null : localEntry(word)
    if (!local) continue
    const entry = mergeEntry(word, { local, old: cache[word] })
    cache[word] = entry
    changed.push(entry)
    filled++
  }
  if (filled > 0) kv.putCacheEntries(changed)
  return filled
}

// ── 后台补齐队列 ──────────────────────────────────────────────────────────

/** 外部词典和百度翻译接口都可能有限流，慢点跑避免触发限制 */
const PREFETCH_CONCURRENCY = 2
const PREFETCH_PACE_MS = NO_NETWORK ? 0 : 250

const prefetch = { queue: [], inQueue: new Set(), running: 0, total: 0, done: 0, failed: 0 }

function prefetchState() {
  return {
    total:    prefetch.total,
    done:     prefetch.done,
    failed:   prefetch.failed,
    pending:  prefetch.queue.length,
    running:  prefetch.running,
    finished: prefetch.queue.length === 0 && prefetch.running === 0,
  }
}

/** 缓存里没有、或者上次没抓齐的词才值得再跑一次 */
function needsFetch(word, force) {
  if (force) return true
  const entry = getCache()[normalizeText(word)]
  if (isSentence(word) && (entry?.translationSource !== 'baidu' || !entry?.phonetic
    || entry?.phoneticStatus === 'partial' || entry?.translationStatus !== 'ok')) return true
  return !entry || entry.status !== 'ok'
}

function sleep(ms) { return new Promise(go => setTimeout(go, ms)) }

async function runPrefetchWorker() {
  prefetch.running++
  try {
    while (prefetch.queue.length > 0) {
      const job = prefetch.queue.shift()
      prefetch.inQueue.delete(job.word)
      let network = false
      try {
        const resolved = job.phoneticOnly
          ? await resolvePhoneticOnly(job.word)
          : await resolveEntry(job.word, job.force)
        network = resolved.network
        if (!job.phoneticOnly) syncListTranslation(job.word, resolved.entry)
      }
      catch (e) { prefetch.failed++; console.warn('[prefetch]', job.word, e.message) }
      prefetch.done++
      // 只有真打了外部接口才需要限速；本地词典命中的词一个接一个过就行
      if (network && PREFETCH_PACE_MS > 0) await sleep(PREFETCH_PACE_MS)
    }
  } finally {
    prefetch.running--
  }
}

/** 把词排进补齐队列，返回真正入队的数量 */
function enqueuePrefetch(words, force) {
  // 上一轮跑完了就把计数归零，前端进度条从 0 开始
  if (prefetch.queue.length === 0 && prefetch.running === 0) {
    prefetch.total = 0
    prefetch.done = 0
    prefetch.failed = 0
  }
  let queued = 0
  for (const raw of Array.isArray(words) ? words : []) {
    const word = normalizeText(raw)
    if (!word || prefetch.inQueue.has(word)) continue
    if (!needsFetch(word, force)) continue
    prefetch.inQueue.add(word)
    prefetch.queue.push({ word, force: force === true })
    prefetch.total++
    queued++
  }
  while (prefetch.running < PREFETCH_CONCURRENCY && prefetch.running < prefetch.queue.length) {
    runPrefetchWorker()
  }
  return queued
}

/** 只把缺失 / 不完整音标排进后台，不触发中文翻译。 */
function enqueuePhoneticPrefetch(words) {
  if (prefetch.queue.length === 0 && prefetch.running === 0) {
    prefetch.total = 0
    prefetch.done = 0
    prefetch.failed = 0
  }
  let queued = 0
  for (const raw of Array.isArray(words) ? words : []) {
    const word = normalizeText(raw)
    if (!word || prefetch.inQueue.has(word)) continue
    const entry = getCache()[word]
    if (entry?.phonetic && entry.phoneticStatus !== 'partial') continue
    prefetch.inQueue.add(word)
    prefetch.queue.push({ word, force: false, phoneticOnly: true })
    prefetch.total++
    queued++
  }
  while (prefetch.running < PREFETCH_CONCURRENCY && prefetch.running < prefetch.queue.length) {
    runPrefetchWorker()
  }
  return queued
}

// ── HTTP helpers ──────────────────────────────────────────────────────────

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
}
function sendJson(res, data, status) {
  cors(res)
  res.writeHead(status || 200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => { try { resolve(JSON.parse(body)) } catch { reject(new Error('invalid JSON')) } })
    req.on('error', reject)
  })
}

/**
 * 保持输入顺序的有限并发映射。每一项由 task 自己转成成功或失败结果，
 * 因此一项查询失败不会 reject 整批，也不会阻止其他 worker 继续处理。
 */
async function mapConcurrent(items, concurrency, task) {
  const results = new Array(items.length)
  let cursor = 0
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await task(items[index], index)
    }
  }
  const count = Math.min(items.length, Math.max(1, concurrency))
  await Promise.all(Array.from({ length: count }, () => worker()))
  return results
}

/** 中文没有拿到时，把搜索链路已有的明确错误透传给批量页。 */
function batchSearchError(entry) {
  const errors = Array.isArray(entry?.errors) ? entry.errors : []
  const detail = errors.find(error => error?.source === 'baidu') || errors[0]
  if (detail) return { ...detail }
  return { code: 'no_translation', message: '未获取到中文翻译' }
}

// ── Router ────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost:' + PORT)
  const { pathname, method } = { pathname: url.pathname, method: req.method }

  if (method === 'OPTIONS') { cors(res); res.writeHead(204); res.end(); return }

  // ── Dict ──────────────────────────────────────────────────────────────
  if (method === 'GET' && pathname === '/api/dict') {
    const queryText = String(url.searchParams.get('word') ?? '').trim().replace(/\s+/g, ' ')
    const word = normalizeText(queryText)
    if (!word) return sendJson(res, { error: 'missing ?word=' }, 400)
    const refresh = url.searchParams.get('refresh') === '1'
    const cached  = getCache()[word]
    // 只有「抓齐了」而且已经是本地词典那份的缓存才敢直接用；
    // 上次半路失败的、装词典之前抓的都往下走一遍（下面那条路只查本地，不打网络）
    const sentenceNeedsRefresh = isSentence(word)
      && (cached?.translationSource !== 'baidu' || !cached?.phonetic
        || cached?.phoneticStatus === 'partial' || cached?.translationStatus !== 'ok')
    if (cached && cached.status === 'ok' && !refresh && !sentenceNeedsRefresh && !staleAgainstLocal(cached)) {
      console.log('[cache hit]', word)
      return sendJson(res, Object.assign({}, cached, { fromCache: true }))
    }
    console.log('[fetch]    ', word)
    try {
      const entry = await ensureEntry(queryText, refresh)
      return sendJson(res, Object.assign({}, entry, { fromCache: false }))
    } catch (e) {
      console.warn('[dict]', word, e.message)
      // 抓取彻底失败时，有旧缓存就先给旧的，别让页面空着
      if (cached) return sendJson(res, Object.assign({}, cached, { fromCache: true }))
      return sendJson(res, { error: 'fetch failed' }, 502)
    }
  }

  // POST /api/dict/search-batch  — 批量执行与首页相同的完整查询链路。
  // body: { words: string[] }
  // 每个结果独立返回 ok；没有中文时仍附带 partial entry，便于页面展示已拿到的音标和错误。
  if (method === 'POST' && pathname === '/api/dict/search-batch') {
    let body
    try { body = await readBody(req) } catch { return sendJson(res, { error: 'invalid JSON' }, 400) }
    if (!Array.isArray(body?.words)) return sendJson(res, { error: 'missing words' }, 400)

    const words = []
    const seen = new Set()
    for (const raw of body.words) {
      const word = normalizeText(raw)
      if (!word || seen.has(word)) continue
      seen.add(word)
      words.push({ word, queryText: String(raw ?? '').trim().replace(/\s+/g, ' ') })
    }
    if (words.length === 0) return sendJson(res, { error: 'missing words' }, 400)
    if (words.length > MAX_BATCH_SEARCH_ITEMS) {
      return sendJson(res, { error: 'too many words', max: MAX_BATCH_SEARCH_ITEMS }, 400)
    }

    const results = await mapConcurrent(words, BATCH_SEARCH_CONCURRENCY, async ({ word, queryText }) => {
      try {
        // ensureEntry 是首页 GET /api/dict 使用的同一条缓存 → ECDICT → 外部接口链路。
        const entry = await ensureEntry(queryText || word, false)
        if (String(entry?.translation ?? '').trim()) return { word, ok: true, entry }
        return { word, ok: false, entry, error: batchSearchError(entry) }
      } catch (error) {
        console.warn('[dict-batch]', word, error?.message || error)
        return {
          word,
          ok: false,
          error: { code: 'fetch_failed', message: error?.message || '查询失败' },
        }
      }
    })
    const succeeded = results.filter(result => result.ok).length
    return sendJson(res, {
      results,
      total: results.length,
      succeeded,
      failed: results.length - succeeded,
    })
  }

  if (method === 'GET' && pathname === '/api/cache/stats') {
    const all = Object.values(getCache())
    const complete = all.filter(e => e.status === 'ok').length
    return sendJson(res, { total: all.length, complete, incomplete: all.length - complete })
  }

  // GET /api/dict/sources  — 词典来源状态：本地词典装没装、能不能联网
  if (method === 'GET' && pathname === '/api/dict/sources') {
    const local = LOCAL_DICT_OFF
      ? { ready: false, disabled: true, count: 0, dir: ecdictDir() }
      : ecdictInfo()
    return sendJson(res, { local, network: !NO_NETWORK })
  }

  // POST /api/dict/batch  — 只读缓存的批量查询，打印卡片前先把已有释义捞出来
  if (method === 'POST' && pathname === '/api/dict/batch') {
    let body
    try { body = await readBody(req) } catch { return sendJson(res, { error: 'invalid JSON' }, 400) }
    const words = Array.isArray(body?.words) ? body.words : []
    // 先用本地词典把缺的 / 没抓齐的 / 装词典之前留下的旧数据补一遍（只写一次盘），
    // 能少排一大堆补齐任务
    const want = []
    const seenWant = new Set()
    for (const raw of words) {
      const word = normalizeText(raw)
      if (!word || seenWant.has(word)) continue
      seenWant.add(word)
      const entry = getCache()[word]
      if (!entry || entry.status !== 'ok' || staleAgainstLocal(entry)
        || (isSentence(word) && (!entry.phonetic || entry.phoneticStatus === 'partial'
          || entry.translationStatus !== 'ok'))) want.push(word)
    }
    if (want.length > 0) fillFromLocal(want)
    const cache = getCache()
    const entries = {}
    const missing = []
    const incomplete = []
    for (const raw of words) {
      const word = normalizeText(raw)
      if (!word || entries[word]) continue
      const entry = cache[word]
      if (!entry) {
        if (!missing.includes(word)) missing.push(word)
        continue
      }
      entries[word] = entry
      // 在缓存里但没抓齐：前端可以据此提示「还能补齐」
      if (entry.status !== 'ok' || (isSentence(word) && (!entry.phonetic
        || entry.phoneticStatus === 'partial' || entry.translationStatus !== 'ok'))) incomplete.push(word)
    }
    return sendJson(res, { entries, missing, incomplete })
  }

  // /api/dict/prefetch  — GET 查补齐进度，POST 把词排进后台补齐队列
  if (pathname === '/api/dict/prefetch') {
    if (method === 'GET') return sendJson(res, prefetchState())
    if (method === 'POST') {
      let body
      try { body = await readBody(req) } catch { return sendJson(res, { error: 'invalid JSON' }, 400) }
      const queued = enqueuePrefetch(body?.words, body?.force === true)
      return sendJson(res, Object.assign({ ok: true, queued }, prefetchState()))
    }
  }

  // POST /api/dict/repair  — 不传 words 就扫所有学习列表，把缺音标/释义的词排队补齐
  if (method === 'POST' && pathname === '/api/dict/repair') {
    let body = {}
    try { body = await readBody(req) } catch { body = {} }
    let words = Array.isArray(body?.words) ? body.words.map(normalizeText).filter(Boolean) : []
    if (words.length === 0) {
      const seen = new Set()
      for (const list of loadLists().lists) {
        for (const item of list.words) {
          if (seen.has(item.word)) continue
          seen.add(item.word)
          words.push(item.word)
        }
      }
    }
    const queued = enqueuePrefetch(words, body?.force === true)
    console.log('[repair]   ', words.length, 'scanned,', queued, 'queued')
    return sendJson(res, Object.assign({ ok: true, scanned: words.length, queued }, prefetchState()))
  }

  // ── Lists ─────────────────────────────────────────────────────────────

  // GET /api/lists
  if (method === 'GET' && pathname === '/api/lists') {
    const { lists } = loadLists()
    return sendJson(res, lists.map(l => ({
      id: l.id, name: l.name, createdAt: l.createdAt, wordCount: l.words.length
    })))
  }

  // POST /api/lists  — create new list
  if (method === 'POST' && pathname === '/api/lists') {
    let body
    try { body = await readBody(req) } catch { return sendJson(res, { error: 'invalid JSON' }, 400) }
    const name = body?.name?.trim()
    if (!name) return sendJson(res, { error: 'missing name' }, 400)
    const data = loadLists()
    if (data.lists.some(l => l.name === name)) {
      return sendJson(res, { ok: false, error: '同名列表已存在' }, 409)
    }
    const id = 'list_' + Date.now()
    data.lists.push({ id, name, createdAt: Date.now(), words: [] })
    saveLists(data)
    console.log('[list +]   ', name)
    return sendJson(res, { ok: true, id, name })
  }

  // Match /api/lists/:id  和  /api/lists/:id/<subpath>
  const listMatch = pathname.match(/^\/api\/lists\/([^/]+)(?:\/(.+))?$/)
  if (listMatch) {
    const listId  = decodeURIComponent(listMatch[1])
    const subpath = listMatch[2] || ''
    const data    = loadLists()
    const list    = data.lists.find(l => l.id === listId)
    if (!list) return sendJson(res, { error: 'list not found' }, 404)

    // PATCH /api/lists/:id  — rename
    if (method === 'PATCH' && subpath === '') {
      let body
      try { body = await readBody(req) } catch { return sendJson(res, { error: 'invalid JSON' }, 400) }
      const name = body?.name?.trim()
      if (!name) return sendJson(res, { error: 'missing name' }, 400)
      if (data.lists.some(l => l.id !== listId && l.name === name)) {
        return sendJson(res, { ok: false, error: '同名列表已存在' }, 409)
      }
      list.name = name
      saveLists(data)
      console.log('[list ~]   ', listId, '->', name)
      return sendJson(res, { ok: true, id: listId, name })
    }

    // DELETE /api/lists/:id  — 默认列表不可删除
    if (method === 'DELETE' && subpath === '') {
      if (listId === DEFAULT_LIST_ID) {
        return sendJson(res, { ok: false, error: '默认列表不可删除' }, 400)
      }
      data.lists = data.lists.filter(l => l.id !== listId)
      saveLists(data)
      console.log('[list -]   ', listId)
      return sendJson(res, { ok: true })
    }

    // GET /api/lists/:id/words
    if (method === 'GET' && subpath === 'words') {
      const now = Date.now()
      return sendJson(res, list.words.map(w => enrichItem(w, now)))
    }

    // POST /api/lists/:id/words  — add single word / sentence
    if (method === 'POST' && subpath === 'words') {
      let body
      try { body = await readBody(req) } catch { return sendJson(res, { error: 'invalid JSON' }, 400) }
      const word = normalizeText(body?.text ?? body?.word)
      if (!word) return sendJson(res, { error: 'missing text' }, 400)
      if (list.words.find(w => w.word === word)) {
        return sendJson(res, { ok: false, reason: 'already exists' })
      }
      const sourceIds = Array.isArray(body.sourceIds) ? body.sourceIds : []
      const senseIds  = normalizeSenseIds(body?.senseIds)
      const translationIds = normalizeTranslationIds(body?.translationIds)
      const customTranslations = normalizeCustomTranslations(body?.customTranslations)
      const type = detectType(word, sourceIds)
      const item = {
        word,
        type,
        sourceIds,
        addedAt: Date.now(),
      }
      if (type === 'sentence') item.displayText = capitalizeSentence(body?.text ?? body?.word ?? word)
      const phonetic = String(body?.phonetic ?? '').trim()
      if (phonetic) item.phonetic = phonetic
      if (senseIds.length) item.senseIds = senseIds
      if (translationIds.length) item.translationIds = translationIds
      if (customTranslations.length) item.customTranslations = customTranslations
      const translation = String(body?.translation ?? '').trim()
        || (customTranslations.length ? selectedTranslation(undefined, [], customTranslations) : '')
      if (translation) item.translation = translation
      list.words.push(item)
      saveLists(data)
      // 加入学习只保存搜索页传来的快照；缺失的音标等数据交给后台补齐，不阻塞响应。
      const queued = enqueuePhoneticPrefetch([word])
      console.log('[word +]   ', word, '->', listId)
      return sendJson(res, { ok: true, item, queued })
    }

    // GET /api/lists/:id/batches  — 每个批次（自然日）的显示名
    if (method === 'GET' && subpath === 'batches') {
      return sendJson(res, { batchNames: list.batchNames ?? {} })
    }

    // PATCH /api/lists/:id/batches  — 重命名某个批次；name 空串=重置为日期
    // body: { date: '2026-09-15', name: '秋词汇' }
    if (method === 'PATCH' && subpath === 'batches') {
      let body
      try { body = await readBody(req) } catch { return sendJson(res, { error: 'invalid JSON' }, 400) }
      const date = String(body?.date ?? '').trim()
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return sendJson(res, { error: 'invalid date' }, 400)
      const name = String(body?.name ?? '').trim()
      if (name.length > 40) return sendJson(res, { ok: false, error: '标签过长' }, 409)
      if (name) list.batchNames[date] = name
      else delete list.batchNames[date]
      saveLists(data)
      console.log('[list ~]   ', listId, 'batch', date, '->', name || '(日期)')
      return sendJson(res, { ok: true, batchNames: list.batchNames })
    }

    // DELETE /api/lists/:id/words/:text  — remove one item
    const wordPathMatch = subpath.match(/^words\/(.+)$/)
    if (method === 'DELETE' && wordPathMatch) {
      const target = normalizeText(decodeURIComponent(wordPathMatch[1]))
      const before = list.words.length
      list.words = list.words.filter(w => w.word !== target)
      if (list.words.length === before) return sendJson(res, { ok: false, reason: 'not found' }, 404)
      saveLists(data)
      console.log('[word -]   ', target, '<-', listId)
      return sendJson(res, { ok: true })
    }

    // PATCH /api/lists/:id/words/:text  — 改这个词这一阶段要背的释义
    // body: { senseIds?: [], translationIds?: [], translation?: string }，传空数组 = 恢复自动
    if (method === 'PATCH' && wordPathMatch) {
      let body
      try { body = await readBody(req) } catch { return sendJson(res, { error: 'invalid JSON' }, 400) }
      const target = normalizeText(decodeURIComponent(wordPathMatch[1]))
      const item = list.words.find(w => w.word === target)
      if (!item) return sendJson(res, { ok: false, reason: 'not found' }, 404)
      if ('senseIds' in (body || {})) {
        const senseIds = normalizeSenseIds(body?.senseIds)
        if (senseIds.length) item.senseIds = senseIds
        else delete item.senseIds
      }
      if ('translationIds' in (body || {})) {
        const translationIds = normalizeTranslationIds(body?.translationIds)
        if (translationIds.length) item.translationIds = translationIds
        else delete item.translationIds
      }
      if ('customTranslations' in (body || {})) {
        const customTranslations = normalizeCustomTranslations(body?.customTranslations)
        if (customTranslations.length) item.customTranslations = customTranslations
        else delete item.customTranslations
      }
      if ('translation' in (body || {})) {
        const translation = String(body?.translation ?? '').trim()
        if (translation) item.translation = translation
        else if (item.customTranslations?.length) item.translation = selectedTranslation(undefined, [], item.customTranslations)
        else delete item.translation
      }
      saveLists(data)
      console.log('[word ~]   ', target, 'updated selections')
      return sendJson(res, { ok: true, item: enrichItem(item, Date.now()) })
    }

    // POST /api/lists/:id/remove  — 批量移除词条
    // body: { words: [] }，和 /import 对称：一次算完只写一次盘
    // 传进来的词照样走 normalizeText，所以界面上什么大小写都能对上
    if (method === 'POST' && subpath === 'remove') {
      let body
      try { body = await readBody(req) } catch { return sendJson(res, { error: 'invalid JSON' }, 400) }
      const targets = new Set()
      for (const raw of (Array.isArray(body?.words) ? body.words : [])) {
        const word = normalizeText(typeof raw === 'string' ? raw : raw?.text ?? raw?.word)
        if (word) targets.add(word)
      }
      if (targets.size === 0) return sendJson(res, { error: 'missing words' }, 400)
      const before = list.words.length
      list.words = list.words.filter(w => !targets.has(w.word))
      const removed = before - list.words.length
      // 一个都没对上就不写盘（比如界面上的选中项已经被别处删掉了）
      if (removed > 0) saveLists(data)
      console.log('[word -]   ', removed, 'removed <-', listId)
      return sendJson(res, { ok: true, removed, missing: targets.size - removed })
    }

    // POST /api/lists/:id/import  — bulk import
    // body: { items: [{ text, sourceIds?, senseIds?, translationIds?, translation? }] }
    // 或旧格式 { words: string[], sourceIds? }
    if (method === 'POST' && subpath === 'import') {
      let body
      try { body = await readBody(req) } catch { return sendJson(res, { error: 'invalid JSON' }, 400) }
      const raw = Array.isArray(body?.items)
        ? body.items
        : (body?.words || []).map(w => ({ text: w, sourceIds: body?.sourceIds }))
      let added = 0, skipped = 0
      const fresh = []
      const seen = new Set(list.words.map(w => w.word))
      for (const entry of raw) {
        const word = normalizeText(entry?.text ?? entry)
        if (!word || seen.has(word)) { if (word) skipped++; continue }
        const sourceIds = Array.isArray(entry?.sourceIds) ? entry.sourceIds : []
        const senseIds  = normalizeSenseIds(entry?.senseIds)
        const translationIds = normalizeTranslationIds(entry?.translationIds)
        const customTranslations = normalizeCustomTranslations(entry?.customTranslations)
        const type = detectType(word, sourceIds)
        const item = {
          word,
          type,
          sourceIds,
          addedAt: Date.now(),
        }
        if (type === 'sentence') item.displayText = capitalizeSentence(entry?.text ?? entry ?? word)
        const phonetic = String(entry?.phonetic ?? '').trim()
        if (phonetic) item.phonetic = phonetic
        if (senseIds.length) item.senseIds = senseIds
        if (translationIds.length) item.translationIds = translationIds
        if (customTranslations.length) item.customTranslations = customTranslations
        // 批量查询页已经完成查词和中文选择：优先原样保存前端快照。
        // 旧调用方没有传 translation 时，仍可复用当前缓存（自定义词义一并并入），但这里绝不发起查询。
        const snapshot = String(entry?.translation ?? '').trim()
        const selected = snapshot || selectedTranslation(getCache()[word], translationIds, customTranslations)
        if (selected) item.translation = selected
        list.words.push(item)
        seen.add(word)
        fresh.push(word)
        added++
      }
      saveLists(data)
      // 中文已在批量查询阶段确定；导入后最多后台补音标，不重新翻译、不覆盖中文快照。
      const queued = enqueuePhoneticPrefetch(fresh)
      console.log('[import]   ', added, 'added,', skipped, 'skipped ->', listId)
      return sendJson(res, { ok: true, added, skipped, queued })
    }

    // POST /api/lists/:id/start  — 标记一批词开始学习（写入开始时间，进入复习计划）
    // body: { words: [], startedAt?, restart?, scope? }
    // scope = day | week，只写进打标日志，不影响排期
    if (method === 'POST' && subpath === 'start') {
      let body
      try { body = await readBody(req) } catch { return sendJson(res, { error: 'invalid JSON' }, 400) }
      const raw = Array.isArray(body?.words) ? body.words : []
      const targets = new Set(raw.map(normalizeText).filter(Boolean))
      if (targets.size === 0) return sendJson(res, { error: 'missing words' }, 400)
      const at = Number(body?.startedAt) || Date.now()
      const scope = normalizeScope(body?.scope)
      let started = 0, skipped = 0
      const items = []
      for (const item of list.words) {
        if (!targets.has(item.word)) continue
        // 已经在学的词默认不动，避免重复打印时把进度清零；restart 才强制重开
        if (item.startedAt && !body?.restart) {
          skipped++
        } else {
          const again = Boolean(item.startedAt)
          item.startedAt = at
          item.stage = 0
          item.reviewedAt = []
          pushMark(item, again ? 'restart' : 'start', at, { scope, stage: 0 })
          recordStudyEvent(list, { item, action: again ? 'restart' : 'start', at, scope, stage: 0 })
          started++
        }
        items.push(enrichItem(item, at))
      }
      saveLists(data)
      console.log('[study +]  ', started, 'started,', skipped, 'skipped ->', listId)
      return sendJson(res, { ok: true, started, skipped, startedAt: at, items })
    }

    // POST /api/lists/:id/review  — 复习打卡
    // body: { words: [], action: 'done' | 'again' | 'stop' | 'tally', scope?, successKind? }
    // tally 只累计熟悉度（successKind 必传），done/again 才动轮次和排期
    if (method === 'POST' && subpath === 'review') {
      let body
      try { body = await readBody(req) } catch { return sendJson(res, { error: 'invalid JSON' }, 400) }
      const action = String(body?.action || 'done')
      if (!REVIEW_ACTIONS.has(action)) return sendJson(res, { error: 'unknown action' }, 400)
      if (action === 'tally' && !TALLY_KINDS.has(body?.successKind)) {
        return sendJson(res, { error: 'tally requires successKind' }, 400)
      }
      const raw = Array.isArray(body?.words) ? body.words : []
      const targets = new Set(raw.map(normalizeText).filter(Boolean))
      if (targets.size === 0) return sendJson(res, { error: 'missing words' }, 400)
      const rawIds = body?.requestIds && typeof body.requestIds === 'object' ? body.requestIds : {}
      const requestIds = new Map()
      for (const word of targets) {
        const supplied = typeof rawIds[word] === 'string' ? rawIds[word] : ''
        const current = list.words.find(item => item.word === word)
        const fallback = [
          listId,
          word,
          current?.stage ?? 0,
          current ? nextDueAt(current) ?? 'new' : 'new',
          action,
          body?.scope || '',
          body?.successKind || '',
        ].join('|')
        requestIds.set(word, supplied || fallback)
      }
      const { updated, items } = applyReview(list, targets, action, {
        scope: body?.scope,
        successKind: body?.successKind,
        requestIds,
        now: Date.now(),
        hasRequest: requestId => studyHistory.hasRequest(requestId),
        onEvent: event => recordStudyEvent(list, event),
      })
     saveLists(data)
     console.log('[study ~]  ', action, updated, '->', listId)
     return sendJson(res, { ok: true, updated, items })
   }

    // POST /api/lists/:id/tally-undo  — 撤销本周期内最近一次会拼 / 会读 / 知意
    // body: { words: [], successKind: 'spelling' | 'reading' | 'meaning', scope?: 'day' | 'week', now? }
    // 只回退一次：删最近一条本周期内的 tally mark，对应计数 -1（下限 0），并软删永久事件
    if (method === 'POST' && subpath === 'tally-undo') {
      let body
      try { body = await readBody(req) } catch { return sendJson(res, { error: 'invalid JSON' }, 400) }
      const kind = String(body?.successKind || '')
      if (!TALLY_KINDS.has(kind)) return sendJson(res, { error: 'invalid successKind' }, 400)
      const scope = normalizeScope(body?.scope)
      const now = Number(body?.now) || Date.now()
      const from = scope === 'week' ? startOfWeek(now) : startOfDay(now)
      const raw = Array.isArray(body?.words) ? body.words : []
      const targets = new Set(raw.map(normalizeText).filter(Boolean))
      if (targets.size === 0) return sendJson(res, { error: 'missing words' }, 400)
      let undone = 0
      const items = []
      for (const item of list.words) {
        if (!targets.has(item.word)) continue
        // 事件表是唯一来源：软删本周期内最近一条 tally 事件，累计计数跟着回退
        const result = studyHistory.undoTallyEvent({ listId, word: item.word, action: kind, from })
        if (result.deleted > 0) {
          if (kind === 'spelling') item.spellingCount = Math.max(0, countOf(item.spellingCount) - 1)
          else if (kind === 'reading') item.readingCount = Math.max(0, countOf(item.readingCount) - 1)
          else item.rememberedCount = Math.max(0, countOf(item.rememberedCount) - 1)
          item.markCount = Math.max(0, countOf(item.markCount) - 1)
          undone++
        }
        items.push(enrichItem(item, now))
      }
      saveLists(data)
      console.log('[study ~]  tally-undo', kind, undone, '->', listId)
      return sendJson(res, { ok: true, undone, items })
    }

    // POST /api/lists/:id/mark  — 只记一次打标，不动复习排期
    // body: { words: [], action?: 'print' | 'spelling' | 'reading', scope?: 'day' | 'week' }
    if (method === 'POST' && subpath === 'mark') {
      let body
      try { body = await readBody(req) } catch { return sendJson(res, { error: 'invalid JSON' }, 400) }
      const action = String(body?.action || 'print')
      if (!PURE_MARK_ACTIONS.has(action)) {
        return sendJson(res, { error: 'unknown action' }, 400)
      }
      const raw = Array.isArray(body?.words) ? body.words : []
      const targets = new Set(raw.map(normalizeText).filter(Boolean))
      if (targets.size === 0) return sendJson(res, { error: 'missing words' }, 400)
      const scope = normalizeScope(body?.scope)
      const now = Date.now()
      let marked = 0
      const items = []
      const rawIds = body?.requestIds && typeof body.requestIds === 'object' ? body.requestIds : {}
      for (const item of list.words) {
        if (!targets.has(item.word)) continue
        const requestId = typeof rawIds[item.word] === 'string'
          ? rawIds[item.word]
          : [listId, item.word, action, scope || ''].join('|')
        if (hasReviewKey(item, requestId) || studyHistory.hasRequest(requestId)) {
          items.push(enrichItem(item, now))
          continue
        }
        pushMark(item, action, now, { scope, stage: item.stage })
        if (action === 'spelling') item.spellingCount = countOf(item.spellingCount) + 1
        if (action === 'reading') item.readingCount = countOf(item.readingCount) + 1
        recordStudyEvent(list, { item, action, at: now, scope, stage: item.stage, requestId })
        rememberReviewKey(item, requestId)
        marked++
        items.push(enrichItem(item, now))
      }
      saveLists(data)
      console.log('[mark +]   ', action, scope || 'day', marked, '->', listId)
      return sendJson(res, { ok: true, marked, items })
    }
  }

  // GET /api/word-lists?word=  — which lists contain this word
  if (method === 'GET' && pathname === '/api/word-lists') {
    const word = normalizeText(url.searchParams.get('word'))
    if (!word) return sendJson(res, { error: 'missing ?word=' }, 400)
    const { lists } = loadLists()
    const found = lists
      .filter(l => l.words.find(w => w.word === word))
      .map(l => l.id)
    return sendJson(res, { word, listIds: found })
  }

  // ── Study plan ────────────────────────────────────────────────────────

  // GET /api/study/plan  — 所有列表里正在学习的词，按下次复习日期排序
  // 不带 marks：一次可能几百个词，打标日志跟着走响应体会撑得很大；要日志去 /api/lists/:id/words
  if (method === 'GET' && pathname === '/api/study/plan') {
    const now = Date.now()
    const { lists } = loadLists()
    const items = []
    for (const list of lists) {
      for (const item of list.words) {
        if (!item.startedAt) continue
        items.push(Object.assign(withoutMarks(enrichItem(item, now)), {
          listId: list.id,
          listName: list.name,
          weekStart: startOfWeek(item.startedAt),
        }))
        // 本周期会拼 / 会读 / 知意次数：按钮直接展示，撤销也只认这段镜像
        const planItem = items[items.length - 1]
       planItem.tallyCounts = tallyPeriodCounts(item, list.id, now)
      }
    }
    items.sort((a, b) => {
      const da = a.nextDueAt === null ? Infinity : a.nextDueAt
      const db = b.nextDueAt === null ? Infinity : b.nextDueAt
      return da === db ? a.word.localeCompare(b.word) : da - db
    })
    return sendJson(res, { intervals: REVIEW_INTERVALS, today: startOfDay(now), items })
  }

  // ── 永久学习成果与历史 ───────────────────────────────────────────────

  if (method === 'GET' && pathname === '/api/study/achievements') {
    return sendJson(res, studyHistory.achievements({ libraryId: url.searchParams.get('libraryId') }))
  }

  if (method === 'GET' && pathname === '/api/study/history') {
    return sendJson(res, studyHistory.history({
      libraryId: url.searchParams.get('libraryId'), word: url.searchParams.get('word'),
      action: url.searchParams.get('action'), limit: url.searchParams.get('limit'),
      offset: url.searchParams.get('offset'),
    }))
  }

  if (method === 'GET' && pathname === '/api/study/history/integrity') {
    return sendJson(res, { ok: studyHistory.integrityCheck() === 'ok', result: studyHistory.integrityCheck() })
  }

  if (method === 'POST' && pathname === '/api/study/history/purge') {
    let body
    try { body = await readBody(req) } catch { return sendJson(res, { ok: false, error: 'invalid JSON' }, 400) }
    const all = body?.all === true
    const rawWords = body?.words
    if (!all && !Array.isArray(rawWords)) {
      return sendJson(res, { ok: false, error: 'words 必须是字符串数组' }, 400)
    }
    if (Array.isArray(rawWords) && (rawWords.length > 500 || rawWords.some(word => typeof word !== 'string'))) {
      return sendJson(res, { ok: false, error: 'words 必须是不超过 500 项的字符串数组' }, 400)
    }
    const words = Array.isArray(rawWords) ? rawWords.map(word => word.trim()).filter(Boolean) : []
    if (!all && words.length === 0) {
      return sendJson(res, { ok: false, error: '至少选择一个单词' }, 400)
    }
    const result = studyHistory.purge({ all, words })
    // 事件删了，列表里冗余的累计计数 / 复习时间也一起回退，两边重新对齐
    if (result.deletedEvents > 0) {
      studyLists.resetStats({ words, all })
    }
    return sendJson(res, { ok: true, ...result })
  }

  const historyEventMatch = pathname.match(/^\/api\/study\/history\/events\/([^/]+)$/)
  if (method === 'DELETE' && historyEventMatch) {
    const result = studyHistory.deleteEvent(decodeURIComponent(historyEventMatch[1]))
    return sendJson(res, { ok: true, ...result })
  }

  const historyWordMatch = pathname.match(/^\/api\/study\/history\/words\/([^/]+)$/)
  if (method === 'DELETE' && historyWordMatch) {
    const result = studyHistory.clearWord(decodeURIComponent(historyWordMatch[1]))
    return sendJson(res, { ok: true, ...result })
  }

  // GET /api/study/goal  — 当前学习目标
  if (method === 'GET' && pathname === '/api/study/goal') {
    return sendJson(res, loadGoal())
  }

  // PUT /api/study/goal  — 设置目标词库；libraryId 传空串表示不设目标
  if (method === 'PUT' && pathname === '/api/study/goal') {
    let body
    try { body = await readBody(req) } catch { return sendJson(res, { error: 'invalid JSON' }, 400) }
    const raw = body?.libraryId
    if (raw != null && typeof raw !== 'string') {
      return sendJson(res, { ok: false, error: 'libraryId 必须是字符串' }, 400)
    }
    const libraryId = String(raw ?? '').trim()
    if (libraryId.length > MAX_LIBRARY_ID_LENGTH) {
      return sendJson(res, { ok: false, error: 'libraryId 过长' }, 400)
    }
    saveGoal({ libraryId })
    console.log('[goal ~]   ', libraryId || '(none)')
    return sendJson(res, { ok: true, libraryId })
  }

  // ── 打印批次（导出卡片的留档） ─────────────────────────────────────────

  // GET /api/print-batches?limit=  — 打印记录，新的在前
  if (method === 'GET' && pathname === '/api/print-batches') {
    const now   = Date.now()
    const asked = Number(url.searchParams.get('limit'))
    const limit = Number.isFinite(asked) && asked > 0
      ? Math.min(Math.floor(asked), MAX_PRINT_BATCHES)
      : DEFAULT_PRINT_LIMIT
    const { lists } = loadLists()
    const { batches } = loadPrints()
    const out = batches
      .slice()
      .sort((a, b) => b.printedAt - a.printedAt)
      .slice(0, limit)
      .map(batch => enrichBatch(batch, lists, now))
    return sendJson(res, { batches: out, total: batches.length })
  }

  // POST /api/print-batches  — 记一次卡片导出
  // body: { title?, kind?, scope?, printedAt?, groups: [{ listId, words: [] }] }
  // 一批词可能跨列表（复习计划里的词就是），所以按列表分组传
  if (method === 'POST' && pathname === '/api/print-batches') {
    let body
    try { body = await readBody(req) } catch { return sendJson(res, { error: 'invalid JSON' }, 400) }
    const groups = Array.isArray(body?.groups) ? body.groups : []
    if (groups.length === 0) return sendJson(res, { ok: false, error: 'missing groups' }, 400)
    const printedAt = Number(body?.printedAt) || Date.now()
    const scope     = normalizeScope(body?.scope)
    const kindRaw   = String(body?.kind || 'start')
    const kind      = PRINT_KINDS.has(kindRaw) ? kindRaw : 'start'
    const data      = loadLists()
    const items   = []
    const missing = []
    for (const group of groups) {
      const list  = data.lists.find(l => l.id === String(group?.listId ?? ''))
      const words = Array.isArray(group?.words) ? group.words : []
      for (const raw of words) {
        const word = normalizeText(raw)
        if (!word) continue
        const item = list ? list.words.find(w => w.word === word) : undefined
        if (!item) { missing.push(word); continue }
        // 打印本身也是一次打标：记时间、粒度和当时轮次
        pushMark(item, 'print', printedAt, { scope, stage: item.stage })
        recordStudyEvent(list, {
          item, action: 'print', at: printedAt, scope, stage: item.stage,
          eventKey: ['print', printedAt, list.id, item.word].join('|'),
        })
        items.push({ listId: list.id, listName: list.name, word: item.word })
      }
    }
    // 一个词都没对上（列表删了 / 词删了）就别留空记录
    if (items.length === 0) {
      return sendJson(res, { ok: false, error: '没有匹配到学习列表里的词', missing }, 400)
    }
    saveLists(data)
    const store = loadPrints()
    const title = String(body?.title ?? '').trim().slice(0, MAX_PRINT_TITLE)
      || ('打印 ' + items.length + ' 词')
    const batch = { id: uniquePrintId(store.batches, printedAt), printedAt, kind, title, wordCount: items.length, items }
    if (scope) batch.scope = scope
    const itemsKey = printBatchItemsKey(items)
    const differentBatches = store.batches
      .filter(saved => printBatchItemsKey(saved.items) !== itemsKey)
      .sort((a, b) => b.printedAt - a.printedAt)
    // 相同的一组打印单词只保留本次记录，并把本次记录放在最前。
    store.batches = [batch, ...differentBatches].slice(0, MAX_PRINT_BATCHES)
    savePrints(store)
    console.log('[print +]  ', items.length, 'words', kind, scope || 'day', '->', batch.id)
    return sendJson(res, { ok: true, batch: enrichBatch(batch, data.lists, Date.now()), missing })
  }

  const printMatch = pathname.match(/^\/api\/print-batches\/([^/]+)(?:\/(.+))?$/)
  if (printMatch) {
    const batchId = decodeURIComponent(printMatch[1])
    const subpath = printMatch[2] || ''
    const store   = loadPrints()
    const batch   = store.batches.find(b => b.id === batchId)
    if (!batch) return sendJson(res, { ok: false, error: '打印记录不存在' }, 404)

    // POST /api/print-batches/:id/review  — 把这一批词整批打卡
    // body: { action: 'done' | 'again' | 'stop' | 'tally', scope?, successKind? }
    // scope 不传就沿用打印时的粒度：按周印的卡片，按周打卡
    if (method === 'POST' && subpath === 'review') {
      let body
      try { body = await readBody(req) } catch { return sendJson(res, { error: 'invalid JSON' }, 400) }
      const action = String(body?.action || 'done')
      if (!REVIEW_ACTIONS.has(action)) return sendJson(res, { ok: false, error: 'unknown action' }, 400)
      if (action === 'tally' && !TALLY_KINDS.has(body?.successKind)) {
        return sendJson(res, { ok: false, error: 'tally requires successKind' }, 400)
      }
      const now   = Date.now()
      const scope = normalizeScope(body?.scope) || batch.scope
      const data  = loadLists()
      const rawIds = body?.requestIds && typeof body.requestIds === 'object' ? body.requestIds : {}
      let updated = 0
      const items = []
      for (const list of data.lists) {
        const batchItems = batch.items.filter(i => i.listId === list.id)
        const targets = new Set(batchItems.map(i => i.word))
        if (targets.size === 0) continue
        const requestIds = new Map()
        for (const item of batchItems) {
          const supplied = typeof rawIds[list.id + '|' + item.word] === 'string'
            ? rawIds[list.id + '|' + item.word]
            : (typeof rawIds[item.word] === 'string' ? rawIds[item.word] : '')
          const current = list.words.find(word => word.word === item.word)
          const fallback = [
            batchId,
            list.id,
            item.word,
            current?.stage ?? 0,
            current ? nextDueAt(current) ?? 'new' : 'new',
            action,
            scope || '',
            body?.successKind || '',
          ].join('|')
          requestIds.set(item.word, supplied || fallback)
        }
        const result = applyReview(list, targets, action, {
          scope,
          successKind: body?.successKind,
          requestIds,
          now,
          hasRequest: requestId => studyHistory.hasRequest(requestId),
          onEvent: event => recordStudyEvent(list, event),
        })
        updated += result.updated
        for (const item of result.items) {
          items.push(Object.assign(withoutMarks(item), { listId: list.id, listName: list.name }))
        }
      }
      saveLists(data)
      if (updated > 0) {
        batch.reviewedAt    = now
        batch.reviewAction  = action
        batch.reviewedCount = updated
        batch.reviewCount   = (Number(batch.reviewCount) || 0) + 1
      }
      savePrints(store)
      console.log('[print ~]  ', action, updated, '->', batchId)
      return sendJson(res, { ok: true, updated, items, batch: enrichBatch(batch, data.lists, now) })
    }

    // DELETE /api/print-batches/:id  — 只删这条记录，词的学习进度不动
    if (method === 'DELETE') {
      store.batches = store.batches.filter(b => b.id !== batchId)
      savePrints(store)
      console.log('[print -]  ', batchId)
      return sendJson(res, { ok: true, id: batchId })
    }
  }

  // ── Vocab labels ──────────────────────────────────────────────────────

  // GET /api/vocab-labels
  if (method === 'GET' && pathname === '/api/vocab-labels') {
    return sendJson(res, loadLabels())
  }

  // POST /api/vocab-labels  — 批量合并，前端把 localStorage 里的旧标签迁上来时用
  if (method === 'POST' && pathname === '/api/vocab-labels') {
    let body
    try { body = await readBody(req) } catch { return sendJson(res, { error: 'invalid JSON' }, 400) }
    const incoming = body?.labels
    if (!incoming || typeof incoming !== 'object') return sendJson(res, { error: 'missing labels' }, 400)
    const data = loadLabels()
    let merged = 0
    for (const [id, label] of Object.entries(incoming)) {
      const value = String(label ?? '').trim()
      if (!id || !value || value.length > MAX_LABEL_LENGTH) continue
      data.labels[id] = value
      merged++
    }
    saveLabels(data)
    console.log('[label ^]  ', merged, 'merged')
    return sendJson(res, { ok: true, merged, labels: data.labels })
  }

  // 打印标签与页面显示标签分开管理；未设置时由前端回落到显示标签。
  if (method === 'GET' && pathname === '/api/vocab-print-labels') {
    return sendJson(res, { printLabels: loadLabels().printLabels })
  }

  if (method === 'POST' && pathname === '/api/vocab-print-labels') {
    let body
    try { body = await readBody(req) } catch { return sendJson(res, { error: 'invalid JSON' }, 400) }
    const incoming = body?.printLabels
    if (!incoming || typeof incoming !== 'object') return sendJson(res, { error: 'missing printLabels' }, 400)
    const data = loadLabels()
    let merged = 0
    for (const [id, label] of Object.entries(incoming)) {
      const value = String(label ?? '').trim()
      if (!id || !value || value.length > MAX_LABEL_LENGTH) continue
      data.printLabels[id] = value
      merged++
    }
    saveLabels(data)
    console.log('[print-label ^]  ', merged, 'merged')
    return sendJson(res, { ok: true, merged, printLabels: data.printLabels })
  }

  const printLabelMatch = pathname.match(/^\/api\/vocab-print-labels\/([^/]+)$/)
  if (printLabelMatch) {
    const libId = decodeURIComponent(printLabelMatch[1])
    const data = loadLabels()

    if (method === 'PATCH') {
      let body
      try { body = await readBody(req) } catch { return sendJson(res, { error: 'invalid JSON' }, 400) }
      const label = String(body?.label ?? '').trim()
      if (!label) return sendJson(res, { ok: false, error: '打印标签不能为空' }, 400)
      if (label.length > MAX_LABEL_LENGTH) {
        return sendJson(res, { ok: false, error: '打印标签最多 ' + MAX_LABEL_LENGTH + ' 个字符' }, 400)
      }
      data.printLabels[libId] = label
      saveLabels(data)
      console.log('[print-label ~]  ', libId, '->', label)
      return sendJson(res, { ok: true, id: libId, label })
    }

    if (method === 'DELETE') {
      const existed = libId in data.printLabels
      delete data.printLabels[libId]
      saveLabels(data)
      console.log('[print-label -]  ', libId)
      return sendJson(res, { ok: true, id: libId, existed })
    }
  }

  const labelMatch = pathname.match(/^\/api\/vocab-labels\/([^/]+)$/)
  if (labelMatch) {
    const libId = decodeURIComponent(labelMatch[1])
    const data  = loadLabels()

    // PATCH /api/vocab-labels/:id  — 改标签
    if (method === 'PATCH') {
      let body
      try { body = await readBody(req) } catch { return sendJson(res, { error: 'invalid JSON' }, 400) }
      const label = String(body?.label ?? '').trim()
      if (!label) return sendJson(res, { ok: false, error: '标签不能为空' }, 400)
      if (label.length > MAX_LABEL_LENGTH) {
        return sendJson(res, { ok: false, error: '标签最多 ' + MAX_LABEL_LENGTH + ' 个字符' }, 400)
      }
      // 标签会显示在搜索结果上，重复了就分不清是哪个词库
      const clash = Object.entries(data.labels).find(([id, value]) => id !== libId && value === label)
      if (clash) return sendJson(res, { ok: false, error: '这个标签已被 ' + clash[0] + ' 占用' }, 409)
      data.labels[libId] = label
      saveLabels(data)
      console.log('[label ~]  ', libId, '->', label)
      return sendJson(res, { ok: true, id: libId, label })
    }

    // DELETE /api/vocab-labels/:id  — 重置为默认（回落到词库 id）
    if (method === 'DELETE') {
      const existed = libId in data.labels
      delete data.labels[libId]
      saveLabels(data)
      console.log('[label -]  ', libId)
      return sendJson(res, { ok: true, id: libId, existed })
    }
  }

  sendJson(res, { error: 'not found' }, 404)
})

// 设 DICT_SERVER_NO_LISTEN=1 时只导出 server，不监听端口（用于测试）
if (process.env.DICT_SERVER_NO_LISTEN !== '1') {
  server.listen(PORT, '127.0.0.1', () => {
    console.log('dict-server  http://127.0.0.1:' + PORT)
    // 词典缓存 / 词库标签 / 学习目标 / 打印批次 / 学习列表 / 学习历史都在这一个库里
    console.log('study    db: ' + studyHistory.dbFile)
    const local = LOCAL_DICT_OFF ? null : ecdictInfo()
    if (LOCAL_DICT_OFF) console.log('本地词典: 已关闭（DICT_ECDICT_OFF=1）')
    else if (local.ready) console.log('本地词典: ' + local.count + ' 条 · ' + local.dir)
    else console.log('本地词典: 未安装（跑 npm run ecdict:fetch 装上，装上后查词优先用它）')
  })
}

export { server }
