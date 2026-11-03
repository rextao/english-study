#!/usr/bin/env node
/**
 * 本地命令行：通过线上 Worker 的 /api 操作学习数据，并把词导出成可直接打印的 HTML。
 *
 * 用法见 `npm run study -- help`。线上地址和令牌从项目根目录 .env.local 的
 * STUDY_API_BASE / STUDY_API_TOKEN 读取（shell 环境变量优先），不走命令行参数；
 * 令牌不写日志、不写进生成的 HTML。
 *
 * 新增命令时：在 COMMANDS 里加一项 `{ run, help }`，run(context) 里复用 context.api。
 */
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

// ── 线上服务配置：命令行不接受 --base / --token ──────────────────────────
// 默认 Worker 根地址，末尾不要带 /；.env.local 或环境变量里的 STUDY_API_BASE 优先。
const DEFAULT_API_BASE = 'https://study.rextao666.xyz'
// 访问令牌只从 STUDY_API_TOKEN 读取（项目 .env.local，已被 gitignore），不写进代码。

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_LIST_ID = 'default'

// Node 24 才原生支持直接 import .ts（类型擦除），这里先拦一下，免得报错难懂。
const nodeMajor = Number.parseInt(process.versions.node.split('.')[0], 10)
if (nodeMajor < 24) {
  console.error(`需要 Node 24.x（当前 v${process.versions.node}）。先 nvm use，再重试。`)
  process.exit(1)
}

const { buildABPrintHtml, buildFlashcardsHtml, fetchCards } = await import('../src/utils/flashcards.ts')
const { DEFAULT_VOCAB_LABELS, primaryVocabIdForWord } = await import('../src/utils/vocabOrder.ts')
const { groupStudyWords } = await import('../src/utils/studyWordGroups.ts')

const USAGE = `本地调用线上背单词服务（Node 24+）

用法：
  npm run study -- <命令> [参数]

命令：
  lists                 列出学习列表（id / 名称 / 词数）
  groups                列出每个学习列表的分组（与学习页「挑选要打印的单词」一致）
  print                 导出可打印的 HTML，默认同时在线上留一条打印记录
  help                  显示这份帮助

配置（项目根目录 .env.local，环境变量优先）：
  STUDY_API_BASE        Worker 根地址，默认 https://study.rextao666.xyz
  STUDY_API_TOKEN       Worker 的 API_TOKEN

print 参数：
  --list <名称|id>      学习列表，默认 default；只给 --words / --group 时自动判断
  --words <a,b,c>       只导出这些词（逗号 / 中文逗号分隔，短语可含空格）
  --group <键|名称>     只导出这个分组；与 --words 互斥，分组键用 groups 命令查看
  --mode <ab|card>      默认 ab（A/B 双页，与线上默认一致）；card = 正反面卡片
  --layout <列x行>      card 模式版面，默认 2x3（列 1-6，行 1-8）
  --no-record           不写线上打印记录（词条快照缺音标/释义时仍可能补词典缓存）
  --json                stdout 只输出 JSON 结果，进度走 stderr

示例：
  npm run study -- lists
  npm run study -- groups
  npm run study -- print --list default --words "apple,banana"
  npm run study -- print --list 默认列表 --group "10 月 30 日"
  npm run study -- print --mode card --layout 3x4 --words "a few,in front of"

打印稿固定保存在当前目录的 prints/ 下，文件名为时间戳。
`

class CliError extends Error {}
class UsageError extends CliError {}

const VALUE_FLAGS = new Set(['list', 'words', 'group', 'mode', 'layout'])
const BOOL_FLAGS = new Set(['no-record', 'json', 'help'])

function parseArgs(argv) {
  const flags = {}
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (token === '--') {
      positional.push(...argv.slice(i + 1))
      break
    }
    if (token === '-h' || token === '--help') {
      flags.help = true
      continue
    }
    if (!token.startsWith('--')) {
      positional.push(token)
      continue
    }
    const eq = token.indexOf('=')
    const name = eq === -1 ? token.slice(2) : token.slice(2, eq)
    const inlineValue = eq === -1 ? undefined : token.slice(eq + 1)
    if (BOOL_FLAGS.has(name)) {
      if (inlineValue !== undefined) throw new UsageError(`--${name} 不接受值`)
      flags[name] = true
      continue
    }
    if (!VALUE_FLAGS.has(name)) throw new UsageError(`未知参数 --${name}`)
    if (inlineValue !== undefined) {
      flags[name] = inlineValue
      continue
    }
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) throw new UsageError(`--${name} 需要一个值`)
    flags[name] = next
    i++
  }
  return { flags, positional }
}

/** 只读取项目根目录 .env.local / .env 里的 STUDY_* 配置；shell 环境变量优先 */
async function loadStudyEnv() {
  const keys = new Set(['STUDY_API_BASE', 'STUDY_API_TOKEN'])
  for (const name of ['.env.local', '.env']) {
    let text
    try {
      text = await readFile(join(ROOT, name), 'utf8')
    } catch {
      continue
    }
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
      if (!match) continue
      const key = match[1]
      if (!keys.has(key) || process.env[key] !== undefined) continue
      let value = match[2].trim()
      if (
        (value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith("'") && value.endsWith("'"))
      ) value = value.slice(1, -1)
      process.env[key] = value
    }
  }
}

function createApi({ base, token }) {
  const nativeFetch = globalThis.fetch.bind(globalThis)

  async function request(path, init = {}) {
    const headers = new Headers(init.headers)
    headers.set('Authorization', 'Bearer ' + token)
    if (init.body !== undefined && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json')
    }
    let response
    try {
      response = await nativeFetch(base + path, { ...init, headers })
    } catch (error) {
      const reason = error?.cause?.code || error?.cause?.message || error?.message || String(error)
      throw new CliError(`连不上 ${base}（${reason}）。检查 .env.local 里的 STUDY_API_BASE 和网络。`)
    }
    const text = await response.text()
    let data = null
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      // 非 JSON：交给下面的状态码分支报错
    }
    if (response.status === 401) {
      throw new CliError('访问令牌无效（HTTP 401）。检查 .env.local 里的 STUDY_API_TOKEN 是否等于 Worker 的 API_TOKEN。')
    }
    if (!response.ok) {
      const message = data?.error || data?.message || `HTTP ${response.status}`
      throw new CliError(String(message))
    }
    return data
  }

  return {
    request,
    getLists: () => request('/api/lists'),
    getListWords: listId => request('/api/lists/' + encodeURIComponent(listId) + '/words'),
    getBatches: listId => request('/api/lists/' + encodeURIComponent(listId) + '/batches'),
    getLabels: () => request('/api/vocab-labels'),
    getWordLists: word => request('/api/word-lists?word=' + encodeURIComponent(word)),
  }
}

/**
 * 前端 apiFetch 用相对路径（浏览器同源），Node 的 fetch 必须绝对 URL。
 * 装上这个壳子后，flashcards.ts 里的 fetchCards / apiJson 可以原样复用。
 */
function installFetchShim({ base, token }) {
  const nativeFetch = globalThis.fetch.bind(globalThis)
  globalThis.fetch = (input, init) => {
    const raw = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input.url
    const url = raw.startsWith('/') ? base + raw : raw
    const headers = new Headers(
      init?.headers ?? (typeof input === 'object' && !(input instanceof URL) ? input.headers : undefined),
    )
    if (!headers.has('Authorization')) headers.set('Authorization', 'Bearer ' + token)
    return nativeFetch(url, { ...init, headers })
  }
}

const keyOf = word => word.trim().replace(/\s+/g, ' ').toLowerCase()

function batchKeyOf(ts) {
  const d = new Date(ts)
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')
    + '-' + String(d.getDate()).padStart(2, '0')
}

function defaultBatchLabel(key) {
  if (key === 'default') return ''
  if (/^\d{4}-\d{2}-\d{2}$/.test(key)) {
    const [year, month, day] = key.split('-').map(Number)
    return year + ' 年 ' + month + ' 月 ' + day + ' 日'
  }
  return key
}

function fmtDay(ts) {
  const d = new Date(ts)
  return d.getFullYear() + ' 年 ' + (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日'
}

function stampOf(ts) {
  const d = new Date(ts)
  return String(d.getFullYear())
    + String(d.getMonth() + 1).padStart(2, '0')
    + String(d.getDate()).padStart(2, '0')
    + '-' + String(d.getHours()).padStart(2, '0')
    + String(d.getMinutes()).padStart(2, '0')
    + String(d.getSeconds()).padStart(2, '0')
}

/** 拆分 --words：英文 / 中文逗号都行，去空、去重、保留用户顺序 */
function splitWords(value) {
  if (!value) return []
  const seen = new Set()
  const out = []
  for (const raw of value.split(/[,，]/)) {
    const word = raw.trim().replace(/\s+/g, ' ')
    const key = keyOf(word)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(word)
  }
  return out
}

function parseLayout(value) {
  const match = /^(\d+)\s*[x×]\s*(\d+)$/.exec((value ?? '').trim())
  if (!match) throw new UsageError('--layout 格式应为「列x行」，例如 2x3')
  const cols = Number(match[1])
  const rows = Number(match[2])
  if (cols < 1 || cols > 6 || rows < 1 || rows > 8) {
    throw new UsageError('--layout 的列只能是 1-6、行只能是 1-8')
  }
  return { cols, rows }
}

/** 读 vocab/*.json，只用来把词条还原成卡片右上角的打印标签 */
async function loadVocabLibraries() {
  const dir = join(ROOT, 'vocab')
  let files = []
  try {
    files = (await readdir(dir)).filter(name => name.endsWith('.json'))
  } catch {
    return []
  }
  const libraries = []
  for (const file of files) {
    try {
      const data = JSON.parse(await readFile(join(dir, file), 'utf8'))
      if (data && Array.isArray(data.words)) libraries.push({ ...data, file: 'vocab/' + file })
    } catch {
      // 单个词库文件坏了不影响打印，跳过
    }
  }
  return libraries
}

function matchList(lists, wanted) {
  return lists.find(list => list.id === wanted)
    ?? lists.find(list => list.name === wanted)
    ?? lists.find(list => list.name.toLowerCase() === wanted.toLowerCase())
}

async function resolveList(api, flags) {
  const lists = await api.getLists()
  if (!Array.isArray(lists) || lists.length === 0) {
    throw new CliError('线上还没有学习列表。先在网页里新建一个，或确认令牌对应的是正确的库。')
  }
  const wanted = String(flags.list ?? '').trim()
  if (wanted) {
    const found = matchList(lists, wanted)
    if (!found) {
      throw new CliError('找不到学习列表「' + wanted + '」。现有列表：'
        + lists.map(list => list.name + '（' + list.id + '）').join('、'))
    }
    return found
  }

  const words = splitWords(flags.words)
  if (words.length === 0) {
    const fallback = lists.find(list => list.id === DEFAULT_LIST_ID) ?? lists[0]
    return fallback
  }

  // 只给词不给列表：每个词必须唯一属于同一个列表，否则让用户显式指定 --list
  const owners = new Map()
  const problems = []
  for (const word of words) {
    const reply = await api.getWordLists(word)
    const ids = Array.isArray(reply?.listIds) ? reply.listIds : []
    if (ids.length === 0) {
      problems.push('「' + word + '」不在任何学习列表里')
      continue
    }
    if (ids.length > 1) {
      problems.push('「' + word + '」同时属于多个列表：'
        + ids.map(id => lists.find(list => list.id === id)?.name ?? id).join('、'))
      continue
    }
    owners.set(ids[0], (owners.get(ids[0]) ?? 0) + 1)
  }
  if (problems.length > 0) {
    throw new CliError('无法自动判断学习列表，请加 --list：\n- ' + problems.join('\n- '))
  }
  if (owners.size > 1) {
    const detail = Array.from(owners.keys())
      .map(id => (lists.find(list => list.id === id)?.name ?? id) + '（' + id + '）')
      .join('、')
    throw new CliError('这些词分散在多个列表：' + detail + '。请用 --list 指定一个列表。')
  }
  const listId = Array.from(owners.keys())[0]
  const found = lists.find(list => list.id === listId)
  if (!found) throw new CliError('词条所属的列表已不存在：' + listId)
  return found
}

/** 读取一个列表的词条，用学习页同一套分组函数还原「挑选要打印的单词」里的分组 */
async function loadListGroups(api, list) {
  const [items, meta] = await Promise.all([api.getListWords(list.id), api.getBatches(list.id)])
  const words = Array.isArray(items) ? items : []
  const batchNames = meta?.batchNames ?? {}
  return {
    list,
    items: words,
    batchNames,
    groups: groupStudyWords(words, batchNames, Date.now()),
  }
}

/** 分组既能用 key 选，也能用页面上的显示名（含「今天 / 昨天」或不含）选 */
function findGroup(groups, wanted) {
  const target = wanted.trim().toLowerCase()
  const baseLabel = label => label.replace(/\s*·\s*(?:今天|昨天)$/, '').trim().toLowerCase()
  return groups.find(group => group.key === wanted)
    ?? groups.find(group => group.label.toLowerCase() === target)
    ?? groups.find(group => baseLabel(group.label) === target)
    ?? groups.find(group => defaultBatchLabel(group.key).toLowerCase() === target)
    ?? null
}

/**
 * 按分组定位要打印的词。只给 --group 不给 --list 时扫全部列表；
 * 同名分组落在多个列表里就报错，让用户显式指定。
 */
async function resolveGroup(api, flags) {
  const wanted = String(flags.group ?? '').trim()
  const listWanted = String(flags.list ?? '').trim()
  const lists = await api.getLists()
  if (!Array.isArray(lists) || lists.length === 0) {
    throw new CliError('线上还没有学习列表。先在网页里新建一个，或确认令牌对应的是正确的库。')
  }
  let candidates = lists
  if (listWanted) {
    const found = matchList(lists, listWanted)
    if (!found) {
      throw new CliError('找不到学习列表「' + listWanted + '」。现有列表：'
        + lists.map(list => list.name + '（' + list.id + '）').join('、'))
    }
    candidates = [found]
  }
  const loaded = await Promise.all(candidates.map(list => loadListGroups(api, list)))
  const matches = []
  for (const entry of loaded) {
    const group = findGroup(entry.groups, wanted)
    if (group) matches.push({ ...entry, group })
  }
  if (matches.length === 1) return matches[0]
  if (matches.length > 1) {
    throw new CliError('分组「' + wanted + '」在多个学习列表里：'
      + matches.map(match => match.list.name + '（' + match.list.id + '）').join('、')
      + '。请加 --list 指定一个列表。')
  }
  const available = loaded.filter(entry => entry.groups.length > 0)
  const detail = available.length === 0
    ? '这些列表里还没有分组。'
    : '现有分组：\n' + available.map(entry => '  ' + entry.list.name + '（' + entry.list.id + '）\n'
      + entry.groups.map(group => '    ' + group.key + '  ' + group.label + '（' + group.items.length + ' 词）').join('\n')).join('\n')
  throw new CliError('找不到分组「' + wanted + '」。' + detail)
}

function formatListLine(list) {
  return '  ' + String(list.id).padEnd(22) + String(list.name).padEnd(18) + ' ' + list.wordCount + ' 词'
}

async function commandLists(context) {
  const lists = await context.api.getLists()
  if (context.flags.json) {
    context.json({ ok: true, command: 'lists', lists })
    return
  }
  if (!Array.isArray(lists) || lists.length === 0) {
    console.log('还没有学习列表。')
    return
  }
  console.log('学习列表（' + lists.length + ' 个）')
  console.log('  ' + 'id'.padEnd(22) + '名称'.padEnd(17) + ' 词数')
  for (const list of lists) console.log(formatListLine(list))
}

async function commandGroups(context) {
  const { api, flags } = context
  const lists = await api.getLists()
  if (!Array.isArray(lists) || lists.length === 0) {
    throw new CliError('线上还没有学习列表。先在网页里新建一个，或确认令牌对应的是正确的库。')
  }
  const wanted = String(flags.list ?? '').trim()
  let targets = lists
  if (wanted) {
    const found = matchList(lists, wanted)
    if (!found) {
      throw new CliError('找不到学习列表「' + wanted + '」。现有列表：'
        + lists.map(list => list.name + '（' + list.id + '）').join('、'))
    }
    targets = [found]
  }
  const loaded = await Promise.all(targets.map(list => loadListGroups(api, list)))
  const output = loaded.map(entry => ({
    id: entry.list.id,
    name: entry.list.name,
    wordCount: entry.list.wordCount,
    groups: entry.groups.map(group => ({
      key: group.key,
      label: group.label,
      count: group.items.length,
      words: group.items.map(item => item.word),
    })),
  }))
  if (flags.json) {
    context.json({ ok: true, command: 'groups', lists: output })
    return
  }
  console.log('学习列表分组（' + output.length + ' 个列表）')
  for (const entry of output) {
    console.log('')
    console.log(entry.name + '（' + entry.id + '）· ' + entry.groups.length + ' 组')
    if (entry.groups.length === 0) {
      console.log('  （还没有分组）')
      continue
    }
    for (const group of entry.groups) {
      console.log('  ' + group.key + '  ' + group.label + '  · ' + group.count + ' 词')
    }
  }
}

async function commandPrint(context) {
  const { api, flags, log } = context
  const mode = String(flags.mode ?? 'ab').trim()
  if (mode !== 'ab' && mode !== 'card') throw new UsageError('--mode 只能是 ab 或 card')
  const layout = parseLayout(flags.layout ?? '2x3')
  const requested = splitWords(flags.words)
  if (flags.words !== undefined && requested.length === 0) {
    throw new UsageError('--words 里没有有效单词')
  }
  const groupWanted = String(flags.group ?? '').trim()
  if (flags.group !== undefined && !groupWanted) {
    throw new UsageError('--group 需要一个分组键或分组名称')
  }
  if (groupWanted && flags.words !== undefined) {
    throw new UsageError('--words 和 --group 不能同时使用')
  }

  log('正在读取学习列表…')
  let list
  let items
  let batchMeta = null
  let pickedGroup = null
  if (groupWanted) {
    const picked = await resolveGroup(api, flags)
    list = picked.list
    items = picked.items
    batchMeta = { batchNames: picked.batchNames }
    pickedGroup = picked.group
  } else {
    list = await resolveList(api, flags)
    items = await api.getListWords(list.id)
  }
  log('列表：' + list.name + '（' + list.id + '）')
  if (pickedGroup) log('分组：' + pickedGroup.label + '（' + pickedGroup.items.length + ' 词）')

  if (!Array.isArray(items) || items.length === 0) {
    throw new CliError('列表「' + list.name + '」里还没有词。')
  }
  const byKey = new Map(items.map(item => [keyOf(item.word), item]))
  const targetWords = pickedGroup
    ? pickedGroup.items.map(item => item.word)
    : requested.length > 0 ? requested : items.map(item => item.word)
  const missing = targetWords.filter(word => !byKey.has(keyOf(word)))
  if (missing.length > 0) {
    throw new CliError('这些词不在列表「' + list.name + '」里：' + missing.join('、')
      + '\n（用 npm run study -- lists 看列表名，或去掉 --list 让 CLI 自动判断）')
  }
  const selected = targetWords.map(word => byKey.get(keyOf(word)))

  const [labels, batches, libraries] = await Promise.all([
    api.getLabels(),
    batchMeta ? Promise.resolve(batchMeta) : api.getBatches(list.id),
    loadVocabLibraries(),
  ])
  const printLabels = labels?.printLabels ?? {}
  const displayLabels = labels?.labels ?? {}
  const batchNames = batches?.batchNames ?? {}
  const getPrintLabel = id => printLabels[id] ?? displayLabels[id] ?? DEFAULT_VOCAB_LABELS[id] ?? id

  const requests = selected.map(item => {
    const sourceIds = item.type === 'sentence' ? [] : (item.sourceIds ?? [])
    const vocabularyId = primaryVocabIdForWord(item.word, sourceIds, libraries)
    const groupKey = item.batchKey || batchKeyOf(item.addedAt)
    return {
      word: item.word,
      displayText: item.type === 'sentence' ? item.displayText : undefined,
      type: item.type,
      senseIds: item.senseIds,
      phonetic: item.phonetic,
      translation: item.translation,
      libraryLabels: vocabularyId ? [getPrintLabel(vocabularyId)] : [],
      fromLibrary: sourceIds.length > 0,
      groupKey,
      groupLabel: batchNames[groupKey] || defaultBatchLabel(groupKey),
    }
  })

  log('取卡片内容（缺音标 / 释义时才查词典）…')
  const cards = await fetchCards(requests, (done, total) => {
    if (total <= 0) return
    const text = '  补齐词典 ' + done + '/' + total
    if (process.stderr.isTTY) process.stderr.write('\r' + text + '   ')
    if (done === total) {
      if (process.stderr.isTTY) process.stderr.write('\n')
      else log(text.trim())
    }
  })

  const printedAt = Date.now()
  // 标题固定用年月日；文件名用完整时间戳
  const title = fmtDay(printedAt)
  const html = mode === 'ab'
    ? buildABPrintHtml(cards, { title, cols: 2 })
    : buildFlashcardsHtml(cards, { title, cols: layout.cols, rows: layout.rows })

  const outPath = join(process.cwd(), 'prints', stampOf(printedAt) + '.html')
  await mkdir(dirname(outPath), { recursive: true })
  await writeFile(outPath, html, 'utf8')
  log('已保存：' + outPath + '（' + cards.length + ' 词，' + mode + ' 模式）')

  let record
  if (flags['no-record']) {
    record = { saved: false, reason: 'skipped' }
  } else {
    log('正在写线上打印记录…')
    try {
      const reply = await api.request('/api/print-batches', {
        method: 'POST',
        body: JSON.stringify({
          title,
          kind: 'custom',
          printedAt,
          groups: [{ listId: list.id, words: selected.map(item => item.word) }],
        }),
      })
      record = {
        saved: true,
        id: reply?.batch?.id,
        title: reply?.batch?.title,
        missing: Array.isArray(reply?.missing) ? reply.missing : [],
      }
      log('打印记录已保存：' + (record.id ?? '(无 id)'))
      if (record.missing.length > 0) log('注意：服务端没匹配到这些词：' + record.missing.join('、'))
    } catch (error) {
      // 文件已经写好了，明确告诉用户「本地成功、线上失败」
      throw new CliError('HTML 已保存到 ' + outPath + '，但线上打印记录写入失败：' + error.message
        + '\n去掉 --no-record 重试，或加 --no-record 只保留本地文件。')
    }
  }

  const result = {
    ok: true,
    command: 'print',
    list: { id: list.id, name: list.name },
    group: pickedGroup
      ? { key: pickedGroup.key, label: pickedGroup.label, count: pickedGroup.items.length }
      : undefined,
    words: selected.map(item => item.word),
    count: selected.length,
    mode,
    layout: mode === 'card' ? layout : undefined,
    title,
    file: outPath,
    bytes: Buffer.byteLength(html, 'utf8'),
    record,
  }
  if (flags.json) {
    context.json(result)
    return
  }
  console.log('')
  console.log('已生成打印稿：' + outPath)
  if (pickedGroup) console.log('  分组：' + pickedGroup.label + '（' + pickedGroup.key + '）')
  console.log('  ' + selected.length + ' 词 · ' + mode + ' 模式 · ' + title)
  console.log('  打印记录：' + (record.saved ? '已保存（' + record.id + '）' : '未写入（--no-record）'))
  console.log('用浏览器打开文件后按「打印」即可，也可以另存为 PDF。')
}

const COMMANDS = {
  lists: {
    run: commandLists,
    help: '列出学习列表（id / 名称 / 词数）',
  },
  groups: {
    run: commandGroups,
    help: '列出每个学习列表的分组（与学习页挑词弹窗一致）',
  },
  print: {
    run: commandPrint,
    help: '导出可打印的 HTML，默认同时在线上留一条打印记录',
  },
}

function resolveConfig() {
  const base = String(process.env.STUDY_API_BASE || DEFAULT_API_BASE).trim().replace(/\/+$/, '')
  const token = String(process.env.STUDY_API_TOKEN || '').trim()
  if (!base) {
    throw new CliError('还没有配置 API 地址：在项目根目录 .env.local 里填写 STUDY_API_BASE。')
  }
  if (!token) {
    throw new CliError('缺少 STUDY_API_TOKEN：在项目根目录 .env.local 里配置（值就是 Worker secret 里的 API_TOKEN）。')
  }
  let url
  try {
    url = new URL(base)
  } catch {
    throw new CliError('STUDY_API_BASE 不是合法的 URL：' + base)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new CliError('STUDY_API_BASE 只能是 http / https 地址：' + base)
  }
  return { base, token }
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2))
  const name = positional[0]
  if (flags.help || !name || name === 'help') {
    console.log(USAGE)
    return
  }
  if (positional.length > 1) throw new UsageError('只能指定一个命令，多余的参数：' + positional.slice(1).join(' '))
  const command = COMMANDS[name]
  if (!command) throw new UsageError('未知命令：' + name + '\n\n' + USAGE)

  await loadStudyEnv()
  const config = resolveConfig()
  installFetchShim(config)
  const context = {
    api: createApi(config),
    flags,
    log: message => {
      // --json 时进度走 stderr，保证 stdout 只有一段 JSON
      if (flags.json) console.error(message)
      else console.log(message)
    },
    json: value => console.log(JSON.stringify(value, null, 2)),
  }
  await command.run(context)
}

try {
  await main()
} catch (error) {
  if (error instanceof UsageError) {
    console.error('✗ ' + error.message)
    console.error('')
    console.error(USAGE)
    process.exitCode = 2
  } else if (error instanceof CliError) {
    console.error('✗ ' + error.message)
    process.exitCode = 1
  } else {
    console.error('✗ ' + (error?.stack || error))
    process.exitCode = 1
  }
}
