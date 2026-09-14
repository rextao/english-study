/**
 * ecdict.mjs — 本地英汉词典（ECDICT）读取层
 *
 * 为什么不把 77 万词的 csv 整个读进内存：那样要一整个 G 的内存、启动还要愣几秒。
 * 这里的做法是先把 csv 编译成三个文件（scripts/ecdict-build.mjs 负责生成）：
 *
 *   records.tsv  一行一条词，TAB 分隔，列顺序见 RECORD_COLUMNS
 *   index.bin    定长 16 字节一条：词的哈希(h1,h2) + 这条在 records.tsv 里的字节偏移和长度，按哈希升序
 *   meta.json    { format, count, builtAt, source, sourceBytes, columns }，构建时最后才写
 *
 * 查词时只把 index.bin（77 万词约 12MB）读进内存做二分，命中后按偏移量从
 * records.tsv 里读那一行。内存占用小，单次查询微秒级。
 *
 * 产物不存在时所有接口都返回 null / ready:false，服务照常跑（回落到外部接口）。
 */

import fs   from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeText } from './text.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** 产物格式版本号：meta 里对不上就当没装，免得读到旧结构 */
export const STORE_FORMAT = 1

/** 三个产物文件名（构建脚本和读取层共用一份，别各写一遍） */
export const STORE_FILES = {
  records: 'records.tsv',
  index:   'index.bin',
  meta:    'meta.json',
}

/** records.tsv 的列顺序 */
export const RECORD_COLUMNS = [
  'key', 'word', 'phonetic', 'translation', 'definition', 'exchange', 'tag', 'frq',
]

/** index.bin 每条固定 16 字节：h1 / h2 / offset / length，全是 uint32BE */
export const INDEX_RECORD_SIZE = 16

/** 产物目录：默认 ../data/ecdict，可用 DICT_ECDICT_DIR 覆盖（测试用） */
export function ecdictDir() {
  return process.env.DICT_ECDICT_DIR || path.join(__dirname, '../data/ecdict')
}

/** 主键算法必须和服务端缓存完全一致，否则本地词典查不中缓存里的词 */
export const ecdictKey = normalizeText

/**
 * 双 32 位哈希（FNV 变体，纯 Math.imul 不碰 BigInt）。
 * 两个 32 位拼起来当 64 位用：77 万词下碰撞概率极低，真撞了也会往后逐条比 key。
 */
export function hashKey(key) {
  let h1 = 0x811c9dc5 | 0
  let h2 = 0x01000193 | 0
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193)
    h2 = Math.imul(h2 ^ (c + i), 0x85ebca6b)
  }
  return [h1 >>> 0, h2 >>> 0]
}

/** 写进 records.tsv 前转义：TAB 和换行是行 / 列分隔符，不能原样留 */
export function encodeField(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/\t/g, '\\t')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
}

/** encodeField 的反操作 */
export function decodeField(value) {
  const s = String(value ?? '')
  if (s.indexOf('\\') < 0) return s
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c !== '\\') { out += c; continue }
    const n = s[i + 1]
    if (n === undefined) { out += '\\'; break }
    i++
    if (n === 't') out += '\t'
    else if (n === 'r') out += '\r'
    else if (n === 'n') out += '\n'
    else if (n === '\\') out += '\\'
    else out += n
  }
  return out
}

// ── 打开产物 ──────────────────────────────────────────────────────────────

/** 单条记录的缓存条数上限（满了整体清空，简单够用） */
const RECORD_CACHE_MAX = 4000
/** 已经开着的产物，隔多久才复查一次文件戳 */
const STAMP_RECHECK_MS = 2000

let store = null
let lastCheck = 0
let lastError = ''

function metaStamp(dir) {
  const st = fs.statSync(path.join(dir, STORE_FILES.meta), { throwIfNoEntry: false })
  return st ? st.mtimeMs + ':' + st.size : ''
}

function closeStore() {
  if (store && store.fd != null) {
    try { fs.closeSync(store.fd) } catch { /* 关不上就算了 */ }
  }
  store = null
}

/**
 * 拿到可用的产物句柄，没装 / 装坏了返回 null。
 * 已经开着时隔 2 秒才复查 meta.json 的戳（重建过就换新的）；
 * 还没开着时每次都查——这样构建完不用重启服务也能立刻生效。
 */
function openStore() {
  const dir = ecdictDir()
  if (store) {
    if (store.dir !== dir) closeStore()
    else {
      const now = Date.now()
      if (now - lastCheck < STAMP_RECHECK_MS) return store
      lastCheck = now
      if (metaStamp(dir) === store.stamp) return store
      closeStore()
    }
  }

  lastCheck = Date.now()
  lastError = ''
  const stamp = metaStamp(dir)
  if (!stamp) { lastError = 'not built'; return null }
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, STORE_FILES.meta), 'utf8'))
    if (Number(meta && meta.format) !== STORE_FORMAT) {
      lastError = 'format ' + (meta && meta.format) + ' != ' + STORE_FORMAT + '，请重新构建'
      return null
    }
    const index = fs.readFileSync(path.join(dir, STORE_FILES.index))
    const fd = fs.openSync(path.join(dir, STORE_FILES.records), 'r')
    store = {
      dir, stamp, meta, index,
      count: Math.floor(index.length / INDEX_RECORD_SIZE),
      fd,
      cache: new Map(),
    }
    return store
  } catch (e) {
    lastError = e.message
    store = null
    return null
  }
}

// ── 二分查找 ──────────────────────────────────────────────────────────────

function slotH1(st, slot) { return st.index.readUInt32BE(slot * INDEX_RECORD_SIZE) }
function slotH2(st, slot) { return st.index.readUInt32BE(slot * INDEX_RECORD_SIZE + 4) }

/** 找到 (h1,h2) 的第一条；哈希可能重复，所以要的是「第一条」不是「任意一条」 */
function findFirst(st, h1, h2) {
  let lo = 0
  let hi = st.count - 1
  let hit = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const m1 = slotH1(st, mid)
    const m2 = slotH2(st, mid)
    if (m1 === h1 && m2 === h2) { hit = mid; hi = mid - 1; continue }
    if (m1 < h1 || (m1 === h1 && m2 < h2)) lo = mid + 1
    else hi = mid - 1
  }
  return hit
}

function readRow(st, slot) {
  const at = slot * INDEX_RECORD_SIZE
  const offset = st.index.readUInt32BE(at + 8)
  const length = st.index.readUInt32BE(at + 12)
  const buf = Buffer.allocUnsafe(length)
  let read = 0
  while (read < length) {
    const n = fs.readSync(st.fd, buf, read, length - read, offset + read)
    if (n <= 0) break
    read += n
  }
  const cols = buf.toString('utf8', 0, read).split('\t')
  const row = {}
  for (let i = 0; i < RECORD_COLUMNS.length; i++) row[RECORD_COLUMNS[i]] = decodeField(cols[i])
  return row
}

function lookupRow(st, key) {
  const [h1, h2] = hashKey(key)
  let slot = findFirst(st, h1, h2)
  if (slot < 0) return null
  // 同一个哈希下可能有多条（碰撞），往后逐条比 key
  while (slot < st.count && slotH1(st, slot) === h1 && slotH2(st, slot) === h2) {
    const row = readRow(st, slot)
    if (row.key === key) return row
    slot++
  }
  return null
}

/** 查一条原始记录（没有就 null）。查不到也进缓存，免得反复二分 */
export function ecdictRecord(word) {
  const key = ecdictKey(word)
  if (!key) return null
  const st = openStore()
  if (!st) return null
  if (st.cache.has(key)) return st.cache.get(key)
  let row = null
  try { row = lookupRow(st, key) }
  catch (e) { lastError = e.message; return null }
  if (st.cache.size >= RECORD_CACHE_MAX) st.cache.clear()
  st.cache.set(key, row)
  return row
}

// ── 记录 → DictionaryEntry ────────────────────────────────────────────────

/** ECDICT 的词性缩写 → dictionaryapi.dev 那套全称，两边缓存里的 pos 才对得上 */
const POS_MAP = {
  n: 'noun', pl: 'noun',
  v: 'verb', vi: 'verb', vt: 'verb', aux: 'verb', modal: 'verb', vbl: 'verb',
  a: 'adjective', adj: 'adjective',
  ad: 'adverb', adv: 'adverb',
  prep: 'preposition', conj: 'conjunction', pron: 'pronoun',
  int: 'interjection', interj: 'interjection',
  num: 'numeral', art: 'article', det: 'determiner', abbr: 'abbreviation',
}

/** 一条词最多取多少条释义（缓存那边还有 MAX_SENSES / MAX_SENSES_PER_POS 再兜一层） */
const MAX_LOCAL_SENSES = 20
/** 中文释义最长多少字：卡片反面字号很大，太长会挤成一团 */
const MAX_TRANSLATION_LEN = 60

function splitLines(text) {
  return String(text ?? '').split('\n').map(s => s.trim()).filter(Boolean)
}

/** 剥掉行首词性：'n. 苹果' → ['noun', '苹果']；认不出来的前缀原样留着 */
function splitPos(line) {
  const m = /^([a-zA-Z]{1,6})\.\s*(.+)$/.exec(line)
  if (!m) return ['other', line]
  const pos = POS_MAP[m[1].toLowerCase()]
  return pos ? [pos, m[2].trim()] : ['other', line]
}

/** 释义列里的分号表示下一个词性组，不能把它误当成同一词性的文本。 */
function splitTranslationGroups(text) {
  return String(text ?? '')
    .split(/[；;]\s*(?=[a-zA-Z]{1,8}\.\s*)/)
    .map(s => s.trim())
    .filter(Boolean)
}

/** 音标：ECDICT 存的是裸音标（æpl），统一包成 /æpl/ 和外部接口对齐 */
function pickPhonetic(row) {
  const p = String(row.phonetic ?? '').trim()
  if (!p) return undefined
  if (p.startsWith('/') || p.startsWith('[')) return p
  return '/' + p + '/'
}

/**
 * 中文释义：取前两行拼起来，太长在标点处截断。
 * 以 [ 开头的是学科标注（[医] / [化]），排到后面去。
 */
function pickTranslation(row) {
  const lines = splitLines(row.translation)
  const parsed = lines.map(line => {
    const [pos, text] = splitPos(line)
    return { pos, text, original: line }
  })
  const plain = parsed.filter(item => !item.text.startsWith('['))
  const selected = (plain.length > 0 ? plain : parsed).slice(0, 2)
  let text = selected.map(item => item.original).join('；')
  if (text.length > MAX_TRANSLATION_LEN) {
    const cut = text.slice(0, MAX_TRANSLATION_LEN)
    const at = Math.max(
      cut.lastIndexOf('；'), cut.lastIndexOf('，'),
      cut.lastIndexOf(';'),  cut.lastIndexOf(','),
      cut.lastIndexOf(' '),
    )
    text = (at > 12 ? cut.slice(0, at) : cut).trim() + '…'
  }
  return text || undefined
}

/**
 * 把 ECDICT 的中文行拆成可单独勾选的候选词义。
 * 词性前缀只作为展示信息保留在 pos，不混进 text；学科标注行排在普通释义后面。
 */
function pickTranslations(row) {
  const lines = splitLines(row.translation).flatMap(splitTranslationGroups)
  if (lines.length === 0) return []
  const parsed = lines.map(line => {
    const [pos, text] = splitPos(line)
    return { text, pos }
  })
  const plain = parsed.filter(item => !item.text.startsWith('['))
  return (plain.length > 0 ? plain : parsed)
    .flatMap(item => item.text.split(/[，,]/).map(text => ({ text: text.trim(), pos: item.pos })))
    .filter(item => item.text)
    .map(item => {
      let text = item.text
      if (text.length > MAX_TRANSLATION_LEN) {
        const cut = text.slice(0, MAX_TRANSLATION_LEN)
        const at = Math.max(cut.lastIndexOf('；'), cut.lastIndexOf('，'), cut.lastIndexOf(';'), cut.lastIndexOf(','), cut.lastIndexOf(' '))
        text = (at > 12 ? cut.slice(0, at) : cut).trim() + '…'
      }
      return { text, pos: item.pos }
    })
}

/** 释义全集：优先用英文 definition，没有才拿中文 translation 顶上 */
function buildSenses(row) {
  const english = splitLines(row.definition)
  const lines = english.length > 0 ? english : splitLines(row.translation)
  const senses = []
  for (const line of lines) {
    if (senses.length >= MAX_LOCAL_SENSES) break
    const [pos, definition] = splitPos(line)
    if (definition) senses.push({ pos, definition })
  }
  return senses
}

/** 从 exchange 里找原形：'0:apple/1:s' → 'apple' */
function lemmaOf(row) {
  const raw = String(row.exchange ?? '').trim()
  if (!raw) return ''
  for (const part of raw.split('/')) {
    const at = part.indexOf(':')
    if (at < 0) continue
    if (part.slice(0, at).trim() !== '0') continue
    return ecdictKey(part.slice(at + 1))
  }
  return ''
}

/** 表面形式查不到时的几种改写：连字符 ↔ 空格 ↔ 直接连起来 */
function altKeys(key) {
  const out = []
  const push = k => { if (k && k !== key && !out.includes(k)) out.push(k) }
  if (key.includes('-')) {
    push(key.replace(/-/g, ' '))
    push(key.replace(/-/g, ''))
  }
  if (key.includes(' ')) {
    push(key.replace(/ /g, '-'))
    push(key.replace(/ /g, ''))
  }
  return out
}

/**
 * 查一个词，返回和缓存同构的词条（没有 status，交给 normalizeEntry 算）。
 * 查不到返回 null——调用方据此决定要不要打外部接口。
 */
export function ecdictEntry(word) {
  const surface = ecdictKey(word)
  if (!surface) return null
  let row = ecdictRecord(surface)
  if (!row) {
    for (const alt of altKeys(surface)) {
      row = ecdictRecord(alt)
      if (row) break
    }
  }
  if (!row) return null

  let phonetic = pickPhonetic(row)
  let translation = pickTranslation(row)
  let translations = pickTranslations(row)
  let senses = buildSenses(row)

  // 变形词（apples / running）自己那条常常只有 exchange 没有释义，回原形取
  if (!translation && senses.length === 0) {
    const lemma = lemmaOf(row)
    if (lemma && lemma !== surface) {
      const base = ecdictRecord(lemma)
      if (base) {
        phonetic = phonetic || pickPhonetic(row) || pickPhonetic(base)   // 音标优先用这个词形自己的
        translation = pickTranslation(base)
        translations = pickTranslations(base)
        senses = buildSenses(base)
      }
    }
  }
  if (!phonetic && !translation && senses.length === 0) return null

  const entry = { word: surface, senses, source: 'ecdict', cachedAt: Date.now() }
  if (phonetic) entry.phonetic = phonetic
  if (translation) entry.translation = translation
  if (translations.length > 0) entry.translations = translations
  return entry
}

/** 本地词典状态，给 /api/dict/sources 用 */
export function ecdictInfo() {
  const dir = ecdictDir()
  const st = openStore()
  if (!st) return { ready: false, dir, count: 0, error: lastError || 'not built' }
  return {
    ready: true,
    dir,
    count: Number(st.meta && st.meta.count) || st.count,
    builtAt: Number(st.meta && st.meta.builtAt) || 0,
    source: String((st.meta && st.meta.source) ?? ''),
    format: Number(st.meta && st.meta.format) || STORE_FORMAT,
  }
}

/** 丢掉已打开的句柄（换目录 / 刚重建完时用） */
export function resetEcdict() {
  closeStore()
  lastCheck = 0
  lastError = ''
}
