/**
 * dict-server.mjs
 *
* GET  /api/dict?word=&refresh=1  词典查询（缓存优先；上次只拿到一半会自动重取）
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
* POST /api/lists/:id/import  批量导入 { items: [{ text, sourceIds?, senseIds? }] }
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
* POST /api/print-batches/:id/review   把这一批词整批打卡 { action: done | again | stop, scope?, through? }
* DELETE /api/print-batches/:id        删掉这条打印记录（不动复习进度）
*
 * GET  /api/vocab-labels        词库显示标签 { labels: { 词库id: 标签 } }
 * POST /api/vocab-labels        批量合并标签 { labels }（用于从 localStorage 迁移）
 * PATCH  /api/vocab-labels/:id  修改某个词库的标签 { label }
 * DELETE /api/vocab-labels/:id  重置为默认标签（删除覆写）
*/

import http from 'node:http'
import fs   from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeText } from './text.mjs'
import { ecdictEntry, ecdictInfo, ecdictDir } from './ecdict.mjs'

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

// ── 释义容量上限 ──────────────────────────────────────────────────────────

/** 单个词性最多保留多少条释义 */
const MAX_SENSES_PER_POS = 12
/** 一个词条最多缓存多少条释义（缓存存全集，够挑就行） */
const MAX_SENSES = 40
/** 学习列表里一个词最多勾选多少条释义 */
const MAX_PICKED_SENSES = 12
/** 离线模式：不访问外部词典，只用本地缓存（测试和断网时用） */
const NO_NETWORK = process.env.DICT_NO_NETWORK === '1'
/** 关掉本地词典（DICT_ECDICT_OFF=1）：只走外部接口，用来对比效果 */
const LOCAL_DICT_OFF = process.env.DICT_ECDICT_OFF === '1'

// ── 艾宾浩斯复习进度 ───────────────────────────────────────────────────────

const DAY = 86400000

/** 复习节奏（天）：开始学习后第 1 / 2 / 4 / 7 / 15 / 30 / 60 天各复习一次 */
const REVIEW_INTERVALS = [1, 2, 4, 7, 15, 30, 60]

/** 一个词最多留多少条打标日志（界面不显示，只给后续功能用） */
const MAX_MARKS = 40
/** 只记打标、不动复习排期的动作 */
const PURE_MARK_ACTIONS = new Set(['print'])
/** 复习打卡动作 */
const REVIEW_ACTIONS = new Set(['done', 'again', 'stop'])
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

/** 所在周的最后一毫秒（周日 23:59:59.999），按周打卡时作为「过完这一周」的界限 */
function endOfWeek(ts) {
  return startOfWeek(ts) + 7 * DAY - 1
}

/** 打标粒度校验，非法值当没传 */
function normalizeScope(input) {
  const scope = String(input ?? '')
  return MARK_SCOPES.has(scope) ? scope : undefined
}

/**
 * 追加一条打标日志：记时间、动作、粒度和当时轮次。
 * marks 只留最近 MAX_MARKS 条，markCount 记总次数所以截断也不丢。
 */
function pushMark(item, action, at, extra) {
  const mark = { at, action }
  const scope = normalizeScope(extra && extra.scope)
  if (scope) mark.scope = scope
  if (Number.isFinite(extra && extra.stage)) mark.stage = extra.stage
  const history = Array.isArray(item.marks) ? item.marks : []
  history.push(mark)
  item.marks = history.slice(-MAX_MARKS)
  item.markCount = (Number(item.markCount) || 0) + 1
  return mark
}

/** 去掉打标日志的副本：复习计划一次返回几百个词，日志跟着走响应体会很大 */
function withoutMarks(item) {
  const out = Object.assign({}, item)
  delete out.marks
  return out
}

/** 下一次该复习的日期；轮次走完返回 null（视为已毕业） */
function nextDueAt(item) {
  if (!item.startedAt) return null
  const stage = item.stage || 0
  if (stage >= REVIEW_INTERVALS.length) return null
  return startOfDay(item.startedAt) + REVIEW_INTERVALS[stage] * DAY
}

/** new 未开始 / due 今天该复习 / scheduled 已排期 / mastered 已毕业 */
function studyState(item, now) {
  if (!item.startedAt) return 'new'
  if ((item.stage || 0) >= REVIEW_INTERVALS.length) return 'mastered'
  return nextDueAt(item) <= startOfDay(now) ? 'due' : 'scheduled'
}

/** 词条 + 派生的复习信息，前端不用自己算日期 */
function enrichItem(item, now) {
  return Object.assign({}, item, { nextDueAt: nextDueAt(item), state: studyState(item, now) })
}

/**
 * 按周打卡时「过完这一周」的界限：
 * 显式传 through 就用它（可以指定别的一周），否则按周取本周最后一毫秒、按天不追赶。
 */
function resolveThrough(scope, asked, now) {
  const value = Number(asked)
  if (Number.isFinite(value) && value > 0) return value
  return scope === 'week' ? endOfWeek(now) : 0
}

/**
 * 复习打卡的唯一实现：列表打卡和按打印批次整批打卡都走这里，语义只有一份。
 * targets 是归一化后的词集合；through > 0 时把界限之前还排到的轮次一并算过（按周打卡）。
 * 只改内存里的 list，落盘由调用方负责。
 */
function applyReview(list, targets, action, options) {
  const opts    = options || {}
  const now     = Number(opts.now) || Date.now()
  const scope   = normalizeScope(opts.scope)
  const through = resolveThrough(scope, opts.through, now)
  const catchUp = through > 0
  let updated = 0
  const items = []
  for (const item of list.words) {
    if (!targets.has(item.word)) continue
    if (action === 'stop') {
      delete item.startedAt
      delete item.stage
      delete item.reviewedAt
      pushMark(item, 'stop', now, { scope })
      updated++
    } else if (item.startedAt) {
      const history = Array.isArray(item.reviewedAt) ? item.reviewedAt : []
      history.push(now)
      item.reviewedAt = history.slice(-40)
      // 一次坐下来复习算一次打卡，即使按周把多个轮次一起过完
      item.reviewCount = (Number(item.reviewCount) || 0) + 1
      if (action === 'done') {
        item.stage = Math.min((item.stage || 0) + 1, REVIEW_INTERVALS.length)
        // 按周打卡：界限之前还排到的后续轮次一并算过
        if (catchUp) {
          for (let guard = 0; guard < REVIEW_INTERVALS.length; guard++) {
            const due = nextDueAt(item)
            if (due === null || due > through) break
            item.stage = Math.min(item.stage + 1, REVIEW_INTERVALS.length)
          }
        }
      } else {
        // 没记住：记忆周期从今天重新开始
        item.stage = 0
        item.startedAt = now
      }
      pushMark(item, action, now, { scope, stage: item.stage })
      updated++
    }
    items.push(enrichItem(item, now))
  }
  return { updated, items }
}

// ── Data helpers ──────────────────────────────────────────────────────────

function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) }
  catch { return fallback }
}
function saveJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8')
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

function makeDefaultList() {
  return { id: DEFAULT_LIST_ID, name: '默认列表', createdAt: Date.now(), words: [] }
}

/** { lists: [ { id, name, createdAt, words: [{word, type, sourceIds, addedAt}] } ] } */
function loadLists() {
  const data = loadJson(LISTS_FILE, null)
  if (!data || !Array.isArray(data.lists)) {
    const init = { lists: [makeDefaultList()] }
    saveJson(LISTS_FILE, init)
    return init
  }
  // default 列表必须存在
  if (!data.lists.some(l => l.id === DEFAULT_LIST_ID)) {
    data.lists.unshift(makeDefaultList())
  }
  // 老数据补齐字段
  for (const list of data.lists) {
    if (!Array.isArray(list.words)) list.words = []
    for (const item of list.words) {
      if (!Array.isArray(item.sourceIds)) item.sourceIds = []
      if (!item.type) item.type = detectType(item.word, item.sourceIds)
      // 只背某几条释义；空数组不落盘，字段缺省 = 自动（中文 + 第一条英文释义）
      if ('senseIds' in item) {
        const ids = normalizeSenseIds(item.senseIds)
        if (ids.length) item.senseIds = ids
        else delete item.senseIds
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
function saveLists(data) { saveJson(LISTS_FILE, data) }

// ── Vocab label helpers ───────────────────────────────────────────────────

/** 标签长度上限，避免把整段描述塞进标签里 */
const MAX_LABEL_LENGTH = 40

/**
 * 词库显示标签：{ labels: { [词库id]: 标签 } }
 * 词库本体由前端在构建期打包 vocab/*.json，服务端只存「标签覆写」，没有覆写就用词库 id。
 */
function loadLabels() {
  const data = loadJson(LABELS_FILE, null)
  const labels = {}
  if (data && typeof data.labels === 'object' && data.labels !== null) {
    for (const [id, label] of Object.entries(data.labels)) {
      if (typeof label === 'string' && label.trim()) labels[id] = label.trim()
    }
  }
  return { labels }
}
function saveLabels(data) { saveJson(LABELS_FILE, data) }

/** 词库 id 再长就是脏数据了 */
const MAX_LIBRARY_ID_LENGTH = 80

/**
 * 学习目标：{ libraryId } 指向某个词库 id，空串表示还没设过目标。
 * 词库本体在前端（构建期打包 vocab 目录下的 json），服务端只记「目标是哪个词库」，
 * 达成度由前端拿本地词库和正在学习的词现算。
 */
function loadGoal() {
  const data = loadJson(GOAL_FILE, null)
  const libraryId = data && typeof data.libraryId === 'string' ? data.libraryId.trim() : ''
  return { libraryId }
}
function saveGoal(data) { saveJson(GOAL_FILE, data) }

// ── 打印批次（导出卡片的留档） ─────────────────────────────────────────────

/** 最多留多少条打印记录，超了丢最老的 */
const MAX_PRINT_BATCHES = 60
/** GET 默认返回多少条 */
const DEFAULT_PRINT_LIMIT = 20
/** 批次标题长度上限 */
const MAX_PRINT_TITLE = 80
/** 批次来源：start 挑新词那一批 / review 复习面板导出的那一批 */
const PRINT_KINDS = new Set(['start', 'review'])

/**
 * { batches: [ { id, printedAt, kind, scope?, title, wordCount, items: [{ listId, listName, word }] } ] }
 * 批次只存「打印了哪些词」，每个词的进度读接口时从学习列表现算，
 * 免得同一个词在两处各存一份状态、互相矛盾。
 */
function loadPrints() {
  const data = loadJson(PRINTS_FILE, null)
  if (!data || !Array.isArray(data.batches)) return { batches: [] }
  for (const batch of data.batches) {
    if (!Array.isArray(batch.items)) batch.items = []
  }
  return data
}
function savePrints(data) { saveJson(PRINTS_FILE, data) }

/** 批次 id 用打印时间；同一毫秒内又打了一批就加后缀 */
function uniquePrintId(batches, printedAt) {
  const base = 'print_' + printedAt
  let id = base
  for (let i = 1; batches.some(b => b.id === id); i++) id = base + '_' + i
  return id
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
 */
function normalizeEntry(word, raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const w = normalizeText(word || src.word)
  const phonetic = String(src.phonetic ?? '').trim() || undefined
  const translation = String(src.translation ?? '').trim() || undefined

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
    : (dictOk && translation ? 'ok' : 'partial')

  // 固定字段顺序，缓存文件 diff 起来干净
  const entry = { word: w }
  if (phonetic) entry.phonetic = phonetic
  if (translation) entry.translation = translation
  entry.senses = senses
  entry.cachedAt = Number(src.cachedAt) || Date.now()
  entry.status = status
  // 这条释义是本地词典给的还是外部接口给的，界面上要标一下
  if (src.source === 'ecdict' || src.source === 'api') entry.source = src.source
  return entry
}

// 缓存常驻内存，省掉每个请求都读一遍整个 json
let cacheMap = null
let cacheStamp = ''

function cacheFileStamp() {
  try { const st = fs.statSync(CACHE_FILE); return st.mtimeMs + ':' + st.size }
  catch { return '' }
}

/** 拿缓存；文件被外部动过（修改时间或体积变了）就重新读一遍 */
function getCache() {
  const stamp = cacheFileStamp()
  if (cacheMap && stamp === cacheStamp) return cacheMap
  const raw = loadJson(CACHE_FILE, {})
  const next = {}
  for (const [key, value] of Object.entries(raw && typeof raw === 'object' ? raw : {})) {
    const word = normalizeText(key)
    if (word) next[word] = normalizeEntry(word, value)
  }
  cacheMap = next
  cacheStamp = stamp
  return cacheMap
}

function putCache(entry) {
  const cache = getCache()
  cache[entry.word] = entry
  saveJson(CACHE_FILE, cache)
  cacheStamp = cacheFileStamp()
  return entry
}

async function fetchJson(url) {
  const res = await fetch(url)
  if (!res.ok) {
    const err = new Error('HTTP ' + res.status)
    err.status = res.status
    throw err
  }
  return res.json()
}

/** 含空白 = 短语或句子，dictionaryapi.dev 查不到，别浪费一次请求 */
function isPhrase(word) { return /\s/.test(word) }

/**
 * 译文可信吗？mymemory 配额用完时会把一句英文警告当译文返回，
 * 所以「一个汉字都没有」的结果一律当失败，下次重试。
 */
function isBadTranslation(text, word) {
  const t = String(text ?? '').trim()
  if (!t) return true
  if (t.toLowerCase() === word) return true
  return !/[\u4e00-\u9fff]/.test(t)
}

/** 抓一次外部接口：音标 + 英文释义全集（dictionaryapi.dev）+ 中文（mymemory） */
async function fetchDictEntry(word) {
  const w = normalizeText(word)
  if (NO_NETWORK) return normalizeEntry(w, { status: 'partial' })

  let phonetic, translation
  const senses = []
  let dictOk = isPhrase(w)

  if (!dictOk) {
    try {
      const data = await fetchJson(
        'https://api.dictionaryapi.dev/api/v2/entries/en/' + encodeURIComponent(w)
      )
      const e = Array.isArray(data) ? data[0] : null
      phonetic = e?.phonetic || e?.phonetics?.find(p => p.text)?.text
      // 释义全集：不再每个词性只留 3 条，勾选要背哪几条是前端的事
      for (const m of e?.meanings ?? []) {
        for (const d of m?.definitions ?? []) {
          senses.push({ pos: m.partOfSpeech, definition: d.definition })
        }
      }
      dictOk = true
    } catch (e) {
      // 404 = 词典确认没这个词，不用反复重试；超时/限流留着下次补
      if (e.status === 404) dictOk = true
      else console.warn('[dict-api]', w, e.message)
    }
  }

  try {
    const data = await fetchJson(
      'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(w) + '&langpair=en|zh'
    )
    if (Number(data?.responseStatus) !== 200) throw new Error('responseStatus ' + data?.responseStatus)
    const t = data?.responseData?.translatedText
    if (!isBadTranslation(t, w)) translation = String(t).trim()
  } catch (e) { console.warn('[mymemory]', w, e.message) }

  return normalizeEntry(w, {
    phonetic, translation, senses,
    cachedAt: Date.now(),
    status: dictOk && translation ? 'ok' : 'partial',
    source: 'api',
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
 * ECDICT 是人工整理的词典，mymemory 是机器翻译还会限流，本地的更可信。
 */
function mergeEntry(word, sources) {
  const { local, fresh, old } = sources
  const senses = pickSenses(local, fresh, old)
  const phonetic    = local?.phonetic    || fresh?.phonetic    || old?.phonetic
  const translation = local?.translation || fresh?.translation || old?.translation
  const dictOk = isPhrase(word) || !!phonetic || senses.length > 0
  return normalizeEntry(word, {
    phonetic, translation, senses,
    cachedAt: Date.now(),
    status: dictOk && translation ? 'ok' : 'partial',
    source: local ? 'ecdict' : (fresh?.source || old?.source),
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
  const w = normalizeText(word)
  if (!w) throw new Error('missing word')
  const old = getCache()[w]
  if (old && old.status === 'ok' && !force) {
    const upgrade = staleAgainstLocal(old) ? localEntry(w) : null
    if (!upgrade || upgrade.status !== 'ok') return { entry: old, network: false }
    return { entry: putCache(mergeEntry(w, { local: upgrade, old })), network: false }
  }

  const local = localEntry(w)
  if (local && local.status === 'ok') {
    // 本地词典就够了：force 也不打网络，不然刷新一次又被机翻译文盖回去
    return { entry: putCache(mergeEntry(w, { local, old })), network: false }
  }
  if (NO_NETWORK) {
    if (!local) return { entry: old || normalizeEntry(w, { status: 'partial' }), network: false }
    return { entry: putCache(mergeEntry(w, { local, old })), network: false }
  }

  const fresh = await fetchDictEntry(w)
  return { entry: putCache(mergeEntry(w, { local, fresh, old })), network: true }
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
  let filled = 0
  for (const word of words) {
    const local = localEntry(word)
    if (!local) continue
    cache[word] = mergeEntry(word, { local, old: cache[word] })
    filled++
  }
  if (filled > 0) {
    saveJson(CACHE_FILE, cache)
    cacheStamp = cacheFileStamp()
  }
  return filled
}

// ── 后台补齐队列 ──────────────────────────────────────────────────────────

/** 两个免费接口都有限流，慢点跑别把人家打挂 */
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
      try { network = (await resolveEntry(job.word, job.force)).network }
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

// ── Router ────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost:' + PORT)
  const { pathname, method } = { pathname: url.pathname, method: req.method }

  if (method === 'OPTIONS') { cors(res); res.writeHead(204); res.end(); return }

  // ── Dict ──────────────────────────────────────────────────────────────
  if (method === 'GET' && pathname === '/api/dict') {
    const word = normalizeText(url.searchParams.get('word'))
    if (!word) return sendJson(res, { error: 'missing ?word=' }, 400)
    const refresh = url.searchParams.get('refresh') === '1'
    const cached  = getCache()[word]
    // 只有「抓齐了」而且已经是本地词典那份的缓存才敢直接用；
    // 上次半路失败的、装词典之前抓的都往下走一遍（下面那条路只查本地，不打网络）
    if (cached && cached.status === 'ok' && !refresh && !staleAgainstLocal(cached)) {
      console.log('[cache hit]', word)
      return sendJson(res, Object.assign({}, cached, { fromCache: true }))
    }
    console.log('[fetch]    ', word)
    try {
      const entry = await ensureEntry(word, refresh)
      return sendJson(res, Object.assign({}, entry, { fromCache: false }))
    } catch (e) {
      console.warn('[dict]', word, e.message)
      // 抓取彻底失败时，有旧缓存就先给旧的，别让页面空着
      if (cached) return sendJson(res, Object.assign({}, cached, { fromCache: true }))
      return sendJson(res, { error: 'fetch failed' }, 502)
    }
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
      if (!entry || entry.status !== 'ok' || staleAgainstLocal(entry)) want.push(word)
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
      if (entry.status !== 'ok') incomplete.push(word)
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
      const item = {
        word,
        type: detectType(word, sourceIds),
        sourceIds,
        addedAt: Date.now(),
      }
      if (senseIds.length) item.senseIds = senseIds
      list.words.push(item)
      saveLists(data)
      console.log('[word +]   ', word, '->', listId)
      // 加词时顺手把音标/释义落盘，之后打印卡片才有东西可印
      const entry = await ensureEntry(word).catch(() => null)
      return sendJson(res, { ok: true, item, entry })
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
    // body: { senseIds: [] }，传空数组 = 恢复自动（中文 + 第一条英文释义）
    if (method === 'PATCH' && wordPathMatch) {
      let body
      try { body = await readBody(req) } catch { return sendJson(res, { error: 'invalid JSON' }, 400) }
      const target = normalizeText(decodeURIComponent(wordPathMatch[1]))
      const item = list.words.find(w => w.word === target)
      if (!item) return sendJson(res, { ok: false, reason: 'not found' }, 404)
      const senseIds = normalizeSenseIds(body?.senseIds)
      if (senseIds.length) item.senseIds = senseIds
      else delete item.senseIds
      saveLists(data)
      console.log('[word ~]   ', target, senseIds.length, 'senses')
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
    // body: { items: [{ text, sourceIds?, senseIds? }] }  或旧格式 { words: string[], sourceIds? }
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
        const item = {
          word,
          type: detectType(word, sourceIds),
          sourceIds,
          addedAt: Date.now(),
        }
        if (senseIds.length) item.senseIds = senseIds
        list.words.push(item)
        seen.add(word)
        fresh.push(word)
        added++
      }
      saveLists(data)
      // 音标和释义在后台慢慢补，导入本身立刻返回，不然几百个词要等很久
      const queued = enqueuePrefetch(fresh)
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
          started++
        }
        items.push(enrichItem(item, at))
      }
      saveLists(data)
      console.log('[study +]  ', started, 'started,', skipped, 'skipped ->', listId)
      return sendJson(res, { ok: true, started, skipped, startedAt: at, items })
    }

    // POST /api/lists/:id/review  — 复习打卡
    // body: { words: [], action: 'done' | 'again' | 'stop', scope?, through? }
    // through：按周打卡时传这一周的最后一毫秒，把这周内排到的轮次一次过完
    if (method === 'POST' && subpath === 'review') {
      let body
      try { body = await readBody(req) } catch { return sendJson(res, { error: 'invalid JSON' }, 400) }
      const action = String(body?.action || 'done')
      if (!REVIEW_ACTIONS.has(action)) return sendJson(res, { error: 'unknown action' }, 400)
      const raw = Array.isArray(body?.words) ? body.words : []
      const targets = new Set(raw.map(normalizeText).filter(Boolean))
      if (targets.size === 0) return sendJson(res, { error: 'missing words' }, 400)
      const { updated, items } = applyReview(list, targets, action, {
        scope: body?.scope,
        through: body?.through,
        now: Date.now(),
      })
      saveLists(data)
      console.log('[study ~]  ', action, updated, '->', listId)
      return sendJson(res, { ok: true, updated, items })
    }

    // POST /api/lists/:id/mark  — 只记一次打标，不动复习排期
    // body: { words: [], action?: 'print', scope?: 'day' | 'week' }
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
      for (const item of list.words) {
        if (!targets.has(item.word)) continue
        pushMark(item, action, now, { scope, stage: item.stage })
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
      }
    }
    items.sort((a, b) => {
      const da = a.nextDueAt === null ? Infinity : a.nextDueAt
      const db = b.nextDueAt === null ? Infinity : b.nextDueAt
      return da === db ? a.word.localeCompare(b.word) : da - db
    })
    return sendJson(res, { intervals: REVIEW_INTERVALS, today: startOfDay(now), items })
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
    store.batches.push(batch)
    // 只留最近 MAX_PRINT_BATCHES 条
    store.batches.sort((a, b) => a.printedAt - b.printedAt)
    if (store.batches.length > MAX_PRINT_BATCHES) {
      store.batches = store.batches.slice(-MAX_PRINT_BATCHES)
    }
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
    // body: { action: 'done' | 'again' | 'stop', scope?, through? }
    // scope 不传就沿用打印时的粒度：按周印的卡片，按周打卡
    if (method === 'POST' && subpath === 'review') {
      let body
      try { body = await readBody(req) } catch { return sendJson(res, { error: 'invalid JSON' }, 400) }
      const action = String(body?.action || 'done')
      if (!REVIEW_ACTIONS.has(action)) return sendJson(res, { ok: false, error: 'unknown action' }, 400)
      const now   = Date.now()
      const scope = normalizeScope(body?.scope) || batch.scope
      const data  = loadLists()
      let updated = 0
      const items = []
      for (const list of data.lists) {
        const targets = new Set(batch.items.filter(i => i.listId === list.id).map(i => i.word))
        if (targets.size === 0) continue
        const result = applyReview(list, targets, action, { scope, through: body?.through, now })
        updated += result.updated
        for (const item of result.items) {
          items.push(Object.assign(withoutMarks(item), { listId: list.id, listName: list.name }))
        }
      }
      saveLists(data)
      batch.reviewedAt    = now
      batch.reviewAction  = action
      batch.reviewedCount = updated
      batch.reviewCount   = (Number(batch.reviewCount) || 0) + 1
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
    console.log('dict  cache: ' + CACHE_FILE)
    console.log('lists file:  ' + LISTS_FILE)
    console.log('labels file: ' + LABELS_FILE)
    console.log('goal  file:  ' + GOAL_FILE)
    console.log('print file:  ' + PRINTS_FILE)
    const local = LOCAL_DICT_OFF ? null : ecdictInfo()
    if (LOCAL_DICT_OFF) console.log('本地词典: 已关闭（DICT_ECDICT_OFF=1）')
    else if (local.ready) console.log('本地词典: ' + local.count + ' 条 · ' + local.dir)
    else console.log('本地词典: 未安装（跑 npm run ecdict:fetch 装上，装上后查词优先用它）')
  })
}

export { server }
