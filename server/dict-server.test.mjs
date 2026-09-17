/**
 * 学习列表接口自测（不占用端口，直接驱动 http.Server 的 request 事件）
 * 运行：npm run test:server
 */
import { Readable } from 'node:stream'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createStudyListsStore, readStudyLists } from './study-lists.mjs'
import { createKvStore, readKv, readDictCache, writeDictCache, KV_KEYS } from './kv.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dict-test-'))
process.env.DICT_DATA_DIR = dataDir
process.env.DICT_SERVER_NO_LISTEN = '1'
// 测试不联网：词典查询只走本地缓存，结果才可复现
process.env.DICT_NO_NETWORK = '1'
process.env.BAIDU_TRANSLATE_API_KEY = ''
// 本地词典产物也放到临时目录：此刻还不存在，所以前面的用例行为跟以前一样
process.env.DICT_ECDICT_DIR = path.join(dataDir, 'ecdict')

const origLog = console.log
console.log = () => {}
const { server } = await import(path.join(__dirname, 'dict-server.mjs'))
console.log = origLog

function callOn(target, method, url, body) {
  return new Promise((resolve) => {
    const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)])
    req.method = method
    req.url = url
    req.headers = { 'content-type': 'application/json' }
    let statusCode = 200
    const chunks = []
    const res = {
      setHeader() {},
      writeHead(code) { statusCode = code; return res },
      end(chunk) {
        if (chunk) chunks.push(chunk)
        let json = null
        try { json = JSON.parse(chunks.join('')) } catch { /* non-json */ }
        resolve({ status: statusCode, body: json })
      },
    }
    const silence = console.log
    console.log = () => {}
    Promise.resolve(target.emit('request', req, res)).finally(() => { console.log = silence })
  })
}

function call(method, url, body) {
  return callOn(server, method, url, body)
}

/** 等后台补齐队列跑空，免得它在断言之后回写缓存文件 */
async function waitForPrefetch(limit) {
  return waitForPrefetchOn(server, limit)
}

/** 等指定服务实例的后台补齐队列跑空。 */
async function waitForPrefetchOn(target, limit) {
  for (let i = 0; i < (limit || 200); i++) {
    const state = await callOn(target, 'GET', '/api/dict/prefetch')
    if (state.body?.finished) return state.body
    await new Promise(go => setTimeout(go, 10))
  }
  return null
}

let pass = 0, fail = 0
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name) }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  <- ' + JSON.stringify(extra) : '')) }
}

/**
 * 进度字段必须齐全：前端直接拿 total / done / finished 渲染进度，
 * 少一个字段界面就会显示「补齐中 undefined/undefined」并且永远转圈。
 */
function hasProgressShape(body) {
  if (body === null || typeof body !== 'object') return false
  const nums = ['total', 'done', 'failed', 'pending', 'running']
  return nums.every(key => Number.isFinite(body[key])) && typeof body.finished === 'boolean'
}

/** 永久成果接口按单词返回汇总；这里兼容直接数组，便于测试错误响应时给出完整上下文。 */
function achievementItems(body) {
  if (Array.isArray(body)) return body
  if (Array.isArray(body?.items)) return body.items
  return []
}

function achievementOf(body, word) {
  const key = String(word).trim().toLowerCase()
  return achievementItems(body).find(item => String(item?.word ?? item?.wordKey).trim().toLowerCase() === key)
}

/** 永久历史可以按单词分组返回；管理页只需展开每组的 events。 */
function historyEvents(body, word) {
  const key = String(word ?? '').trim().toLowerCase()
  const direct = Array.isArray(body?.events) ? body.events : []
  const items = Array.isArray(body?.items) ? body.items : []
  const nested = items.flatMap(item => {
    if (Array.isArray(item?.events)) {
      return item.events.map(event => ({ ...event, word: event.word ?? item.word ?? item.wordKey }))
    }
    return item?.action ? [item] : []
  })
  return [...direct, ...nested].filter(event => {
    if (!key) return true
    return String(event?.word ?? event?.wordKey).trim().toLowerCase() === key
  })
}

/** 打标日志以 SQLite 事件表为唯一来源：按动作筛选某个词的永久事件。 */
async function wordEvents(word, action) {
  const params = new URLSearchParams({ word, limit: '100' })
  if (action) params.set('action', action)
  const r = await call('GET', '/api/study/history?' + params)
  return historyEvents(r.body, word)
}

function eventAt(event) {
  return Number(event?.at ?? event?.occurredAt)
}

function meaningIdentity(event) {
  if (event?.meaningProfileId) return String(event.meaningProfileId)
  if (event?.meaningKey) return String(event.meaningKey)
  if (event?.selectionKey) return String(event.selectionKey)
  if (Array.isArray(event?.meaningKeys)) return JSON.stringify([...event.meaningKeys].sort())
  if (Array.isArray(event?.meanings)) {
    return JSON.stringify(event.meanings.map(item => item?.meaningKey ?? item?.id ?? item).sort())
  }
  return ''
}

/**
 * 在全新的 Node 进程里驱动一次服务，用于验证真正重启后的 SQLite 持久化与迁移幂等。
 * 子进程只读写传入的临时目录，不接触开发者的真实 cache。
 */
function runHistoryProbe(probeDir, mode) {
  const moduleUrl = new URL('./dict-server.mjs', import.meta.url).href
  const script = `
    import { Readable } from 'node:stream'
    const { server } = await import(${JSON.stringify(moduleUrl)})
    function call(method, url, body) {
      return new Promise(resolve => {
        const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)])
        req.method = method
        req.url = url
        req.headers = { 'content-type': 'application/json' }
        let status = 200
        const chunks = []
        const res = {
          setHeader() {},
          writeHead(code) { status = code; return res },
          end(chunk) {
            if (chunk) chunks.push(chunk)
            let parsed = null
            try { parsed = JSON.parse(chunks.join('')) } catch {}
            resolve({ status, body: parsed })
          },
        }
        server.emit('request', req, res)
      })
    }
    const mode = process.env.HISTORY_PROBE_MODE
    if (mode === 'seed') {
      const made = await call('POST', '/api/lists', { name: 'Restart persistence' })
      const listId = made.body?.id
      await call('POST', '/api/lists/' + listId + '/import', {
        items: [{ text: 'restart-history', translation: 'n. 重启记录', translationIds: ['translation#0'] }],
      })
      await call('POST', '/api/lists/' + listId + '/start', { words: ['restart-history'], startedAt: 1700000000000 })
      await call('POST', '/api/lists/' + listId + '/review', {
        words: ['restart-history'], action: 'done', requestIds: { 'restart-history': 'restart-history-done-1' },
      })
      await call('POST', '/api/lists/' + listId + '/review', {
        words: ['restart-history'], action: 'tally', successKind: 'meaning',
        requestIds: { 'restart-history': 'restart-history-meaning-1' },
      })
    }
    const history = await call('GET', '/api/study/history?word=restart-history&limit=100')
    const achievements = await call('GET', '/api/study/achievements')
    process.stdout.write('\\n__HISTORY_PROBE__' + JSON.stringify({ history, achievements }))
    process.exit(0)
  `
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...process.env,
      DICT_DATA_DIR: probeDir,
      DICT_ECDICT_DIR: path.join(probeDir, 'ecdict'),
      DICT_SERVER_NO_LISTEN: '1',
      DICT_NO_NETWORK: '1',
      HISTORY_PROBE_MODE: mode,
    },
  })
  const marker = '__HISTORY_PROBE__'
  const start = child.stdout.lastIndexOf(marker)
  if (child.status !== 0 || start < 0) {
    return { error: child.error?.message || child.stderr || child.stdout, status: child.status }
  }
  try { return JSON.parse(child.stdout.slice(start + marker.length)) }
  catch (error) { return { error: error.message, stdout: child.stdout, stderr: child.stderr } }
}

let r = await call('GET', '/api/lists')
check('GET /api/lists 自动创建 default', r.status === 200 && r.body.length === 1 && r.body[0].id === 'default', r.body)

r = await call('POST', '/api/lists', { name: 'IELTS' })
const newId = r.body?.id
check('新建列表', r.body?.ok === true && !!newId, r.body)

r = await call('POST', '/api/lists', { name: 'IELTS' })
check('重名列表 -> 409', r.status === 409 && r.body.ok === false, r.body)

r = await call('GET', '/api/lists')
check('现在有 2 个列表', r.body.length === 2, r.body)

// 首页加入学习直接保存搜索结果快照，不由写列表接口重新查询词典。
writeDictCache(dataDir, {
  apple: {
    word: 'apple', phonetic: '/ˈæpəl/', translation: '苹果',
    senses: [{ id: 'noun#0', pos: 'noun', definition: 'a fruit' }],
    cachedAt: Date.now(), status: 'ok', source: 'api',
  },
})
r = await call('POST', '/api/lists/default/words', {
  text: '  ApPle ', sourceIds: ['a2-key-2020'], phonetic: '/ˈæpəl/', translation: 'n. 苹果',
  translationIds: ['api#0::0'],
})
check('加词并归一化且保存中文翻译',
  r.body?.ok === true && r.body.item.word === 'apple'
  && r.body.item.type === 'word' && r.body.item.translation === 'n. 苹果'
  && r.body.item.phonetic === '/ˈæpəl/'
  && JSON.stringify(r.body.item.translationIds) === '["api#0::0"]', r.body)

r = await call('POST', '/api/lists/default/words', {
  text: "i've got a dog", translation: '我有一只狗。',
})
check('加句子直接保存前端中文快照，不依赖词典缓存',
  r.body?.ok === true && r.body.item.translation === '我有一只狗。', r.body)
check('单条添加句子保留小写主键并返回首字母大写展示文本',
  r.body?.item?.word === "i've got a dog"
  && r.body?.item?.displayText === "I've got a dog", r.body)

r = await call('PATCH', '/api/lists/default/words/' + encodeURIComponent("I've got a dog"), {
  translationIds: ['baidu#0'], translation: '我养了一只狗。',
})
check('补充中文词义直接更新前端快照',
  r.body?.ok === true && r.body.item.translation === '我养了一只狗。'
  && JSON.stringify(r.body.item.translationIds) === '["baidu#0"]', r.body)

r = await call('POST', '/api/lists/default/words', { text: 'apple' })
check('重复词跳过', r.body?.ok === false && r.body.reason === 'already exists', r.body)

r = await call('POST', '/api/lists/default/words', { text: '  How   are  you? ' })
check('句子识别 + 空白压缩，同时返回首字母大写展示文本',
  r.body?.item?.type === 'sentence' && r.body.item.word === 'how are you?'
  && r.body.item.displayText === 'How are you?', r.body)

r = await call('POST', '/api/lists/default/words', { text: 'a few', sourceIds: ['a2-key-2020'] })
check('命中词库的短语算 word 而非句子', r.body?.item?.type === 'word', r.body)

r = await call('DELETE', '/api/lists/default/words/' + encodeURIComponent('a few'))
check('移除短语', r.body?.ok === true, r.body)

r = await call('GET', '/api/lists/default/words')
check('default 有 3 条', r.body.length === 3, r.body)

r = await call('GET', '/api/word-lists?word=APPLE')
check('查词所属列表（忽略大小写）', JSON.stringify(r.body.listIds) === '["default"]', r.body)

r = await call('GET', '/api/word-lists?word=' + encodeURIComponent('HOW ARE YOU?'))
check('句子仍可用任意大小写按小写主键匹配所属列表',
  JSON.stringify(r.body.listIds) === '["default"]', r.body)

r = await call('POST', '/api/lists/' + newId + '/import', {
  items: [
    { text: 'apple' },
    { text: 'Banana', sourceIds: ['a2-key-2020'] },
    { text: 'we enjoy coding.', translation: '我们喜欢编程。' },
    { text: 'apple' },
    { text: '   ' },
  ],
})
check('批量导入 added=3 skipped=1', r.body?.added === 3 && r.body.skipped === 1, r.body)

const importedDisplayWords = await call('GET', '/api/lists/' + newId + '/words')
const importedSentence = importedDisplayWords.body?.find(item => item.word === 'we enjoy coding.')
check('批量导入句子保留小写主键并提供首字母大写展示文本',
  importedSentence?.type === 'sentence'
  && importedSentence?.displayText === 'We enjoy coding.'
  && importedSentence?.translation === '我们喜欢编程。', importedDisplayWords.body)

r = await call('GET', '/api/word-lists?word=apple')
check('apple 同时属于 2 个列表', r.body.listIds.length === 2, r.body)

// ---- 批次显示名 batchNames ----
r = await call('POST', '/api/lists', { name: '批次命名' })
const batchListId = r.body?.id

r = await call('GET', '/api/lists/' + batchListId + '/batches')
check('新列表 GET batches 返回空对象', r.status === 200 && r.body?.batchNames && Object.keys(r.body.batchNames).length === 0, r.body)

r = await call('PATCH', '/api/lists/' + batchListId + '/batches', { date: '2026-09-15', name: '秋词汇' })
check('PATCH 批次名成功', r.status === 200 && r.body?.ok === true && r.body.batchNames['2026-09-15'] === '秋词汇', r.body)
r = await call('GET', '/api/lists/' + batchListId + '/batches')
check('GET 返回设置的批次名', r.body?.batchNames?.['2026-09-15'] === '秋词汇', r.body)
r = await call('PATCH', '/api/lists/' + batchListId + '/batches', { date: '2026-09-15', name: '新名' })
r = await call('GET', '/api/lists/' + batchListId + '/batches')
check('同日期重命名覆盖旧名', r.body?.batchNames?.['2026-09-15'] === '新名', r.body)

r = await call('PATCH', '/api/lists/' + batchListId + '/batches', { date: '2026-09-15', name: '' })
check('空串重置批次名成功', r.status === 200 && r.body?.ok === true, r.body)
r = await call('GET', '/api/lists/' + batchListId + '/batches')
check('重置后 GET 不再含该日期', r.status === 200 && !('2026-09-15' in (r.body?.batchNames ?? {})), r.body)

r = await call('PATCH', '/api/lists/' + batchListId + '/batches', { date: '2026-9-15', name: 'x' })
check('非法日期 -> 400 invalid date', r.status === 400 && r.body?.error === 'invalid date', r.body)
r = await call('PATCH', '/api/lists/' + batchListId + '/batches', { date: '2026-09-15', name: 'a'.repeat(41) })
check('41 字批次名 -> 409 标签过长', r.status === 409 && r.body?.error === '标签过长', r.body)

// batchNames 落盘持久化
r = await call('PATCH', '/api/lists/' + batchListId + '/batches', { date: '2026-09-15', name: '秋词汇' })
const savedBatchList = readStudyLists(dataDir).lists.find(l => l.id === batchListId)
check('batchNames 字段落盘', savedBatchList?.batchNames?.['2026-09-15'] === '秋词汇', savedBatchList)

// 重复单词永远留在旧批次：addedAt 不变
r = await call('POST', '/api/lists/' + batchListId + '/import', { items: [{ text: 'batch-dup' }] })
check('首次导入 batch-dup added=1', r.body?.added === 1, r.body)
let dupWords = await call('GET', '/api/lists/' + batchListId + '/words')
const dupAddedAt = dupWords.body?.find(i => i.word === 'batch-dup')?.addedAt
await new Promise(go => setTimeout(go, 50))
r = await call('POST', '/api/lists/' + batchListId + '/import', { items: [{ text: 'batch-dup' }] })
check('重复导入 skipped=1', r.body?.skipped === 1 && r.body?.added === 0, r.body)
dupWords = await call('GET', '/api/lists/' + batchListId + '/words')
const dupItems = dupWords.body?.filter(i => i.word === 'batch-dup') ?? []
check('重复单词只有一条且 addedAt 不变（留在旧批次）',
  dupItems.length === 1 && dupItems[0].addedAt === dupAddedAt, dupWords.body)

// 空列表的批次接口：新建列表自带空 batchNames，不能因为没批次就报错
await waitForPrefetch()
r = await call('POST', '/api/lists', { name: 'empty-batches' })
const emptyBatchesId = r.body?.id
check('空批次列表创建成功', r.status === 200 && r.body?.ok === true && !!emptyBatchesId, r.body)
r = await call('GET', '/api/lists/' + emptyBatchesId + '/words')
check('空列表 GET words 正常', r.status === 200 && Array.isArray(r.body) && r.body.length === 0, r.body)
r = await call('GET', '/api/lists/' + emptyBatchesId + '/batches')
check('空列表 GET batches 返回空对象不报错',
  r.status === 200 && r.body?.batchNames && Object.keys(r.body.batchNames).length === 0, r.body)
r = await call('DELETE', '/api/lists/' + emptyBatchesId)
check('删除空批次测试列表', r.body?.ok === true, r.body)
// 清掉本组用例创建的列表，免得影响后面「回到 1 个列表」的断言
r = await call('DELETE', '/api/lists/' + batchListId)
check('删除批次测试列表', r.body?.ok === true, r.body)

r = await call('DELETE', '/api/lists/default/words/apple')
check('移除单词', r.body?.ok === true, r.body)

r = await call('GET', '/api/lists/default/words')
check('default 剩 2 条', r.body.length === 2, r.body)

r = await call('DELETE', '/api/lists/default/words/' + encodeURIComponent('how are you?'))
check('移除句子（含空格/问号）', r.body?.ok === true, r.body)

r = await call('DELETE', '/api/lists/default/words/' + encodeURIComponent("I've got a dog"))
check('移除带缩写的句子', r.body?.ok === true, r.body)

r = await call('DELETE', '/api/lists/default')
check('default 不可删除', r.status === 400 && r.body.ok === false, r.body)

r = await call('PATCH', '/api/lists/' + newId, { name: 'IELTS core' })
check('重命名列表', r.body?.ok === true && r.body.name === 'IELTS core', r.body)

r = await call('PATCH', '/api/lists/' + newId, { name: '默认列表' })
check('重命名撞名 -> 409', r.status === 409, r.body)

r = await call('POST', '/api/lists/' + newId + '/import', { words: ['kiwi', 'pear'], sourceIds: ['legacy'] })
check('兼容旧的 words 格式', r.body?.added === 2, r.body)

r = await call('GET', '/api/lists/' + newId + '/words')
check('旧格式 sourceIds 生效', r.body.find(w => w.word === 'kiwi')?.sourceIds[0] === 'legacy', r.body)

r = await call('DELETE', '/api/lists/' + newId)
check('删除自建列表', r.body?.ok === true, r.body)

r = await call('GET', '/api/lists')
check('回到 1 个列表', r.body.length === 1, r.body)

r = await call('GET', '/api/lists/nope/words')
check('不存在的列表 -> 404', r.status === 404, r.body)

// ── 批量移除（学习列表页的多选删除走这个接口）─────────────────────────────

r = await call('POST', '/api/lists/default/import', {
  items: [{ text: 'mango' }, { text: 'papaya' }, { text: 'guava' }],
})
check('批量移除：先放 3 个词进 default', r.body?.added === 3, r.body)

r = await call('POST', '/api/lists/default/remove', {
  words: ['  MANGO ', 'papaya', 'papaya', 'never-added'],
})
check('批量移除：归一化 + 去重 + 报缺失',
  r.body?.ok === true && r.body.removed === 2 && r.body.missing === 1, r.body)

r = await call('GET', '/api/lists/default/words')
check('批量移除只删选中的那些', r.body.length === 1 && r.body[0].word === 'guava', r.body)

r = await call('POST', '/api/lists/default/remove', { words: [] })
check('批量移除没给词 -> 400', r.status === 400, r.body)

r = await call('POST', '/api/lists/nope/remove', { words: ['guava'] })
check('批量移除不存在的列表 -> 404', r.status === 404, r.body)

r = await call('POST', '/api/lists/default/remove', { words: ['GUAVA'] })
check('批量移除收尾：default 清空', r.body?.removed === 1 && r.body.missing === 0, r.body)

// ── 艾宾浩斯学习进度 ──────────────────────────────────────────────────────

const DAY_MS = 86400000
function startOfDayMs(ts) { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime() }

r = await call('POST', '/api/lists', { name: 'Ebbinghaus' })
const studyId = r.body?.id
r = await call('POST', '/api/lists/' + studyId + '/import', {
  items: [{ text: 'melon' }, { text: 'grape' }, { text: 'lemon' }],
})
check('学习进度：准备 3 个词', r.body?.added === 3, r.body)

const threeDaysAgo = Date.now() - 3 * DAY_MS
r = await call('POST', '/api/lists/' + studyId + '/start', { words: ['melon', 'GRAPE'], startedAt: threeDaysAgo })
check('开始学习 2 个词（忽略大小写）', r.body?.ok === true && r.body.started === 2, r.body)

r = await call('POST', '/api/lists/' + studyId + '/start', { words: ['melon'] })
check('已在学习中的词不会被重置', r.body?.started === 0 && r.body.skipped === 1, r.body)

r = await call('POST', '/api/lists/' + studyId + '/start', { words: [] })
check('start 没给词 -> 400', r.status === 400, r.body)

r = await call('GET', '/api/lists/' + studyId + '/words')
let melon = r.body.find(w => w.word === 'melon')
check('词条返回 state / nextDueAt',
  melon?.state === 'due' && melon.nextDueAt === startOfDayMs(threeDaysAgo), melon)
check('没开始学的词 state=new', r.body.find(w => w.word === 'lemon')?.state === 'new', r.body)
check('旧数据缺少独立计数字段时按 0 返回',
  melon?.spellingCount === 0 && melon?.rememberedCount === 0, melon)

const today = startOfDayMs(Date.now())
r = await call('POST', '/api/lists/' + studyId + '/start', { words: ['lemon'] })
let lemon = r.body?.items?.find(w => w.word === 'lemon')
check('今天开始学习后立即进入今天待复习',
  lemon?.stage === 0 && lemon.state === 'due' && lemon.nextDueAt === today, lemon)

r = await call('POST', '/api/lists/' + studyId + '/review', { words: ['lemon'], action: 'done' })
lemon = r.body?.items?.find(w => w.word === 'lemon')
check('首次真正打卡后才进入第一个 1 天间隔',
  lemon?.stage === 1 && lemon.state === 'scheduled' && lemon.nextDueAt === today + DAY_MS, lemon)

r = await call('POST', '/api/lists/' + studyId + '/review', { words: ['lemon'], action: 'stop' })
check('回归用词停止学习后恢复 new',
  r.body?.items?.find(w => w.word === 'lemon')?.state === 'new', r.body)

r = await call('POST', '/api/lists/' + studyId + '/review', { words: ['melon'], action: 'tally' })
check('tally 没给 successKind -> 400', r.status === 400, r.body)

const spellingRequestId = [studyId, 'melon', 'tally-spelling', 'day', '1'].join('|')
r = await call('POST', '/api/lists/' + studyId + '/review', {
  words: ['melon'], action: 'tally', successKind: 'spelling', requestIds: { melon: spellingRequestId },
})
melon = r.body?.items?.find(w => w.word === 'melon')
check('会拼只累计拼写次数，不动轮次和排期',
  r.body?.updated === 1 && melon?.spellingCount === 1
  && melon?.readingCount === 0 && melon?.rememberedCount === 0 && melon?.reviewCount === 0
  && melon.stage === 0 && melon.nextDueAt === startOfDayMs(threeDaysAgo)
  && (await wordEvents('melon', 'spelling')).some(e => e.action === 'spelling'), melon)

r = await call('POST', '/api/lists/' + studyId + '/review', {
  words: ['melon'], action: 'tally', successKind: 'spelling', requestIds: { melon: spellingRequestId },
})
melon = r.body?.items?.find(w => w.word === 'melon')
check('重复提交会拼写任务不重复统计', r.body?.updated === 0 && melon?.spellingCount === 1 && melon?.reviewCount === 0, melon)

r = await call('POST', '/api/lists/' + studyId + '/review', {
  words: ['melon'], action: 'tally', successKind: 'spelling', requestIds: { melon: spellingRequestId + '-2' },
})
melon = r.body?.items?.find(w => w.word === 'melon')
check('重新点击会拼各算一次，轮次仍然不动',
  r.body?.updated === 1 && melon?.spellingCount === 2 && melon.stage === 0, melon)

// 会读（reading）与知意（meaning）互相独立：只累计自己的次数，同样不推进轮次
r = await call('POST', '/api/lists/' + studyId + '/import', { items: [{ text: 'apricot' }] })
check('会读用例：准备 apricot', r.body?.added === 1, r.body)
r = await call('POST', '/api/lists/' + studyId + '/start', { words: ['apricot'], startedAt: threeDaysAgo })
check('会读用例：开始学习 apricot', r.body?.started === 1, r.body)
r = await call('POST', '/api/lists/' + studyId + '/review', {
  words: ['apricot'], action: 'tally', successKind: 'reading',
  requestIds: { apricot: 'apricot-reading-1' },
})
let apricot = r.body?.items?.find(w => w.word === 'apricot')
check('会读只累计阅读次数，不影响记住 / 拼写次数和轮次',
  r.body?.updated === 1 && apricot?.readingCount === 1
  && apricot?.rememberedCount === 0 && apricot?.spellingCount === 0
  && apricot?.reviewCount === 0 && apricot.stage === 0
  && apricot.nextDueAt === startOfDayMs(threeDaysAgo)
  && (await wordEvents('apricot', 'reading')).some(e => e.action === 'reading'), apricot)

r = await call('POST', '/api/lists/' + studyId + '/review', {
  words: ['apricot'], action: 'tally', successKind: 'reading',
  requestIds: { apricot: 'apricot-reading-1' },
})
apricot = r.body?.items?.find(w => w.word === 'apricot')
check('重复提交会读任务不重复统计', r.body?.updated === 0 && apricot?.readingCount === 1 && apricot?.reviewCount === 0, apricot)

r = await call('GET', '/api/study/history?action=reading&word=apricot&limit=100')
const readingOnlyEvents = historyEvents(r.body, 'apricot')
check('学习记录可单独筛选会读',
  readingOnlyEvents.length === 1 && readingOnlyEvents[0]?.action === 'reading', r.body)

r = await call('POST', '/api/lists/' + studyId + '/review', { words: ['apricot'], action: 'stop' })
check('会读用例：停止学习 apricot', r.body?.updated === 1, r.body)

// 会拼 / 会读 / 知意可撤销：按钮上的「−」减掉本周期内最近一次，计数下限 0
r = await call('POST', '/api/lists/' + studyId + '/review', {
  words: ['apricot'], action: 'tally', successKind: 'reading',
  requestIds: { apricot: 'apricot-reading-2' },
})
check('撤销用例：再记一次会读',
  r.body?.updated === 1 && r.body?.items?.find(w => w.word === 'apricot')?.readingCount === 2, r.body)

r = await call('POST', '/api/lists/' + studyId + '/tally-undo', { words: ['apricot'], successKind: 'bogus' })
check('撤销接口非法 successKind -> 400', r.status === 400, r.body)
r = await call('POST', '/api/lists/' + studyId + '/tally-undo', { words: [], successKind: 'reading' })
check('撤销接口缺词 -> 400', r.status === 400, r.body)

r = await call('GET', '/api/study/achievements')
check('撤销前学习成果页能看到两次会读',
  achievementOf(r.body, 'apricot')?.readingCount === 2, r.body)

r = await call('POST', '/api/lists/' + studyId + '/tally-undo', { words: ['apricot'], successKind: 'reading' })
apricot = r.body?.items?.find(w => w.word === 'apricot')
check('撤销一次：会读次数减一，永久事件软删一条',
  r.body?.ok === true && r.body?.undone === 1 && apricot?.readingCount === 1
  && (await wordEvents('apricot', 'reading')).length === 1, apricot)

r = await call('POST', '/api/lists/' + studyId + '/tally-undo', { words: ['apricot'], successKind: 'reading' })
apricot = r.body?.items?.find(w => w.word === 'apricot')
check('再撤销一次：会读次数归零，事件表一条不剩',
  r.body?.undone === 1 && apricot?.readingCount === 0
  && (await wordEvents('apricot', 'reading')).length === 0, apricot)

r = await call('POST', '/api/lists/' + studyId + '/tally-undo', { words: ['apricot'], successKind: 'reading' })
apricot = r.body?.items?.find(w => w.word === 'apricot')
check('无可撤销记录时 undone=0 且计数不低于 0',
  r.body?.ok === true && r.body?.undone === 0 && apricot?.readingCount === 0, apricot)

r = await call('GET', '/api/study/achievements')
check('撤销后永久事件同步软删，成果页不再计这两次会读',
  !achievementOf(r.body, 'apricot') || achievementOf(r.body, 'apricot')?.readingCount === 0, r.body)

// 按天 / 按周窗口：周期以外的 tally 撤销不到（now 可以由调用方指定，测试才好造时间）
r = await call('POST', '/api/lists/' + studyId + '/import', { items: [{ text: 'undo-window' }] })
check('撤销用例：准备 undo-window', r.body?.added === 1, r.body)
r = await call('POST', '/api/lists/' + studyId + '/review', {
  words: ['undo-window'], action: 'tally', successKind: 'spelling',
  requestIds: { 'undo-window': 'undo-window-spelling-1' },
})
check('撤销用例：记一次会拼',
  r.body?.updated === 1 && r.body?.items?.find(w => w.word === 'undo-window')?.spellingCount === 1, r.body)
r = await call('POST', '/api/lists/' + studyId + '/tally-undo', {
  words: ['undo-window'], successKind: 'spelling', scope: 'day', now: Date.now() + DAY_MS,
})
check('按天撤销只覆盖当天：明天撤销不到今天的记录',
  r.body?.undone === 0
  && r.body?.items?.find(w => w.word === 'undo-window')?.spellingCount === 1, r.body)
r = await call('POST', '/api/lists/' + studyId + '/tally-undo', {
  words: ['undo-window'], successKind: 'spelling', scope: 'week',
})
check('按周撤销能覆盖本周内的记录',
  r.body?.undone === 1
  && r.body?.items?.find(w => w.word === 'undo-window')?.spellingCount === 0, r.body)

r = await call('POST', '/api/lists/' + studyId + '/review', { words: ['melon'], action: 'done' })
melon = r.body?.items?.find(w => w.word === 'melon')
check('进入下一轮 -> 只推进轮次并锚定打卡当天，不加知意计数',
  r.body?.updated === 1 && melon.rememberedCount === 0
  && melon.stage === 1 && melon.nextDueAt === startOfDayMs(Date.now()) + DAY_MS
  && typeof melon.lastDoneAt === 'number', melon)

const againRequestId = [studyId, 'melon', melon?.stage ?? 0, melon?.nextDueAt ?? 'new', 'again', 'day'].join('|')
r = await call('POST', '/api/lists/' + studyId + '/review', {
  words: ['melon'], action: 'again', requestIds: { melon: againRequestId },
})
melon = r.body?.items?.find(w => w.word === 'melon')
check('没记住 -> 轮次归零并从今天重开',
  melon?.stage === 0 && melon.state === 'due' && melon.nextDueAt === startOfDayMs(Date.now())
  && melon.reviewedAt.length === 2 && melon.lastDoneAt === undefined
  && melon.rememberedCount === 0 && melon.forgottenCount === 1
  && (await wordEvents('melon', 'again')).some(e => e.action === 'again'), melon)

r = await call('POST', '/api/lists/' + studyId + '/review', {
  words: ['melon'], action: 'again', requestIds: { melon: againRequestId },
})
melon = r.body?.items?.find(w => w.word === 'melon')
check('重复提交没记住任务不重复统计', r.body?.updated === 0 && melon?.forgottenCount === 1 && melon?.reviewCount === 2, melon)

r = await call('POST', '/api/lists/' + studyId + '/review', { words: ['grape'], action: 'stop' })
check('停止学习 -> 回到 new', r.body?.items?.find(w => w.word === 'grape')?.state === 'new', r.body)

r = await call('GET', '/api/lists/' + studyId + '/words')
check('停止学习后不再落盘 startedAt', r.body.find(w => w.word === 'grape')?.startedAt === undefined, r.body)

for (let i = 0; i < 8; i++) {
  r = await call('POST', '/api/lists/' + studyId + '/review', { words: ['melon'], action: 'done' })
}
melon = r.body?.items?.find(w => w.word === 'melon')
check('首次打卡及 7 段间隔全部完成 -> 毕业',
  melon?.state === 'mastered' && melon.nextDueAt === null, melon)

r = await call('POST', '/api/lists/' + studyId + '/review', { words: ['melon'], action: 'sleep' })
check('未知复习动作 -> 400', r.status === 400, r.body)

r = await call('GET', '/api/study/plan')
check('复习计划返回 7 段间隔', r.body?.intervals?.length === 7, r.body)
check('复习计划只含正在学习的词', r.body.items.length === 1 && r.body.items[0].word === 'melon', r.body)
check('复习计划带列表名与周批次',
  r.body.items[0].listId === studyId && r.body.items[0].listName === 'Ebbinghaus'
  && typeof r.body.items[0].weekStart === 'number', r.body.items[0])
check('复习计划带本周期熟悉度计数（melon 今天会拼过两次）',
  r.body.items[0].tallyCounts?.day?.spelling === 2
  && r.body.items[0].tallyCounts?.week?.spelling === 2
  && r.body.items[0].tallyCounts?.day?.reading === 0, r.body.items[0])

// ── 按周维度的打卡 + 打标日志 ─────────────────────────────────────────────

function startOfWeekMs(ts) {
  const day = startOfDayMs(ts)
  const weekday = (new Date(day).getDay() + 6) % 7
  return day - weekday * DAY_MS
}

r = await call('POST', '/api/lists', { name: 'Weekly' })
const weekId = r.body?.id
r = await call('POST', '/api/lists/' + weekId + '/import', {
  items: [{ text: 'mango' }, { text: 'papaya' }, { text: 'guava' }],
})
check('按周：准备 3 个词', r.body?.added === 3, r.body)

const monday  = startOfWeekMs(Date.now())

r = await call('POST', '/api/lists/' + weekId + '/start',
  { words: ['mango', 'papaya', 'guava'], startedAt: monday, scope: 'week' })
check('按周开始学习 3 个词', r.body?.ok === true && r.body.started === 3, r.body)

// 按周打卡一次管一周：排到下周一；按天打卡仍按天顺延
r = await call('POST', '/api/lists/' + weekId + '/review',
  { words: ['mango'], action: 'done', scope: 'week' })
let mango = r.body?.items?.find(w => w.word === 'mango')
check('按周打卡只推进一轮，排到下周一',
  mango?.stage === 1 && mango.nextDueAt === monday + 7 * DAY_MS, mango)
check('一次打卡只算一次复习', mango?.reviewCount === 1 && mango.reviewedAt.length === 1, mango)

r = await call('POST', '/api/lists/' + weekId + '/review',
  { words: ['mango'], action: 'done', scope: 'week' })
mango = r.body?.items?.find(w => w.word === 'mango')
check('同一周内再点一次仍停在下周一，不继续往后滚',
  mango?.stage === 2 && mango.nextDueAt === monday + 7 * DAY_MS, mango)

r = await call('POST', '/api/lists/' + weekId + '/review',
  { words: ['mango'], action: 'tally', successKind: 'meaning', scope: 'week' })
mango = r.body?.items?.find(w => w.word === 'mango')
check('知意计数只累计次数，不推进轮次',
  mango?.stage === 2 && mango.rememberedCount === 1
  && mango.nextDueAt === monday + 7 * DAY_MS, mango)

r = await call('POST', '/api/lists/' + weekId + '/review', { words: ['papaya'], action: 'done' })
let papaya = r.body?.items?.find(w => w.word === 'papaya')
check('按天打卡也只前进一轮',
  papaya?.stage === 1 && papaya.nextDueAt === startOfDayMs(Date.now()) + DAY_MS, papaya)

r = await call('POST', '/api/lists/' + weekId + '/mark', { words: ['papaya'], action: 'print', scope: 'week' })
check('打标接口只记日志', r.body?.ok === true && r.body.marked === 1, r.body)
papaya = r.body?.items?.find(w => w.word === 'papaya')
check('打标不动复习排期', papaya?.stage === 1 && papaya.nextDueAt === startOfDayMs(Date.now()) + DAY_MS, papaya)

r = await call('POST', '/api/lists/' + weekId + '/mark', { words: ['papaya'], action: 'done' })
check('打标接口不接受复习动作 -> 400', r.status === 400, r.body)

r = await call('POST', '/api/lists/' + weekId + '/mark', { words: [] })
check('打标没给词 -> 400', r.status === 400, r.body)

r = await call('POST', '/api/lists/' + weekId + '/start', { words: ['guava'], startedAt: monday, restart: true })
check('重开学习会重置进度', r.body?.started === 1 && r.body.skipped === 0, r.body)

r = await call('POST', '/api/lists/' + weekId + '/review', { words: ['guava'], action: 'stop' })
check('停止学习 -> updated', r.body?.updated === 1, r.body)

r = await call('GET', '/api/lists/' + weekId + '/words')
papaya = r.body.find(w => w.word === 'papaya')
check('打标日志落盘：时间 / 动作 / 粒度 / 次数',
  papaya?.markCount === 3 && papaya.reviewCount === 1
  && (await wordEvents('papaya', 'start')).some(e => e.scope === 'week' && typeof e.at === 'number')
  && (await wordEvents('papaya', 'done')).some(e => e.scope === undefined && typeof e.at === 'number')
  && (await wordEvents('papaya', 'print')).some(e => e.scope === 'week' && typeof e.at === 'number'), papaya)
const guava = r.body.find(w => w.word === 'guava')
check('重开与停止各留一条打标',
  guava?.markCount === 3
  && (await wordEvents('guava', 'start')).length >= 1
  && (await wordEvents('guava', 'restart')).length >= 1
  && (await wordEvents('guava', 'stop')).length >= 1, guava)

r = await call('GET', '/api/study/plan')
const planMango = r.body?.items?.find(w => w.word === 'mango')
check('复习计划不带打标日志但保留次数',
  planMango !== undefined && planMango.marks === undefined && planMango.markCount === 4, planMango)

r = await call('DELETE', '/api/lists/' + weekId)
check('清理按周测试用的列表', r.body?.ok === true, r.body)

// ── 这一阶段要背哪几条释义（senseIds） ────────────────────────────────────

r = await call('POST', '/api/lists/' + studyId + '/words', { text: 'kiwi', senseIds: ['noun#0', 'noun#0', '   ', 'verb#1'] })
check('加词时记下要背的释义（去重去空）',
  JSON.stringify(r.body?.item?.senseIds) === '["noun#0","verb#1"]', r.body)

r = await call('PATCH', '/api/lists/' + studyId + '/words/kiwi', { senseIds: ['noun#2'] })
check('换一批要背的释义', JSON.stringify(r.body?.item?.senseIds) === '["noun#2"]', r.body)

r = await call('PATCH', '/api/lists/' + studyId + '/words/kiwi', { senseIds: [] })
check('释义清空 -> 恢复自动，字段不落盘', r.body?.ok === true && r.body.item.senseIds === undefined, r.body)

r = await call('PATCH', '/api/lists/' + studyId + '/words/nope', { senseIds: ['noun#0'] })
check('给不存在的词改释义 -> 404', r.status === 404, r.body)

r = await call('POST', '/api/lists/' + studyId + '/import', { items: [{ text: 'peach', senseIds: ['noun#0'] }] })
check('批量导入带释义并排队补齐', r.body?.added === 1 && typeof r.body.queued === 'number', r.body)

r = await call('POST', '/api/lists/' + studyId + '/import', {
  items: [{ text: 'nectarine', phonetic: '/ˈnektəriːn/', translation: 'n. 油桃', translationIds: ['translation#0'] }],
})
check('批量导入直接保存前端中文快照',
  r.body?.added === 1 && typeof r.body.queued === 'number', r.body)

r = await call('GET', '/api/lists/' + studyId + '/words')
check('导入时选的释义已落盘',
  JSON.stringify(r.body.find(w => w.word === 'peach')?.senseIds) === '["noun#0"]', r.body)
check('批量导入的中文快照已落盘',
  r.body.find(w => w.word === 'nectarine')?.translation === 'n. 油桃'
  && r.body.find(w => w.word === 'nectarine')?.phonetic === '/ˈnektəriːn/'
  && JSON.stringify(r.body.find(w => w.word === 'nectarine')?.translationIds) === '["translation#0"]', r.body)

// ── 自定义词义（customTranslations）──────────────────────────────────────
// 词典给的词义不一定是要背的那几条；允许手填自定义词义，与选中的词典词义一并写进中文快照。

r = await call('POST', '/api/lists/' + studyId + '/words', {
  text: 'longan',
  customTranslations: ['我自己的叫法', '我自己的叫法', '   ', 'x'.repeat(61)],
})
check('加词时自定义词义去重去空限长',
  r.body?.ok === true
  && JSON.stringify(r.body?.item?.customTranslations) === '["我自己的叫法"]'
  && r.body?.item?.translation === '我自己的叫法', r.body)

r = await call('PATCH', '/api/lists/' + studyId + '/words/longan', {
  customTranslations: ['改过的叫法', '另一条'],
})
check('自定义词义可二次编辑，已存快照不动',
  JSON.stringify(r.body?.item?.customTranslations) === '["改过的叫法","另一条"]'
  && r.body?.item?.translation === '我自己的叫法', r.body)

r = await call('PATCH', '/api/lists/' + studyId + '/words/longan', { translation: '' })
check('清空中文快照时用自定义词义重建',
  r.body?.item?.translation === '改过的叫法,另一条', r.body)

r = await call('PATCH', '/api/lists/' + studyId + '/words/longan', { customTranslations: [] })
check('清空自定义词义 -> 字段不落盘，快照保留',
  r.body?.item?.customTranslations === undefined
  && r.body?.item?.translation === '改过的叫法,另一条', r.body)

// 选中的词典词义与自定义词义合并：词典词义按词性分组在前，自定义跟在后面
writeDictCache(dataDir, {
  ...readDictCache(dataDir),
  loquat: {
    word: 'loquat', phonetic: '/ˈloʊkwɑːt/', translation: 'n. 枇杷',
    translations: [
      { id: 'translation#0', text: '枇杷', pos: 'noun' },
      { id: 'translation#1', text: '枇杷树', pos: 'noun' },
    ],
    senses: [], cachedAt: Date.now(), status: 'ok', source: 'ecdict',
  },
})

r = await call('POST', '/api/lists/' + studyId + '/import', {
  items: [{ text: 'loquat', translationIds: ['translation#0'], customTranslations: ['我背的就是这个'] }],
})
r = await call('POST', '/api/lists/' + studyId + '/import', {
  items: [{ text: 'pomelo', customTranslations: ['柚子', '柚子汁'] }],
})
r = await call('GET', '/api/lists/' + studyId + '/words')
const loquat = r.body.find(w => w.word === 'loquat')
check('导入时词典词义与自定义词义合并',
  JSON.stringify(loquat?.customTranslations) === '["我背的就是这个"]'
  && loquat?.translation === 'n. 枇杷；我背的就是这个', loquat)
const pomelo = r.body.find(w => w.word === 'pomelo')
check('没有词典词义时中文快照只用自定义词义',
  JSON.stringify(pomelo?.customTranslations) === '["柚子","柚子汁"]'
  && pomelo?.translation === '柚子,柚子汁', pomelo)

// ── SQLite 永久学习历史 ───────────────────────────────────────────────────
// 学习列表只保存当前排期；成果和每次操作的具体时间由独立事件账本负责。

r = await call('POST', '/api/lists', { name: 'Permanent history' })
const historyListId = r.body?.id
r = await call('POST', '/api/lists/' + historyListId + '/import', {
  items: [
    {
      text: 'archive-one', sourceIds: ['a2-key-2020'], translation: 'n. 归档一',
      translationIds: ['translation#0'], senseIds: ['noun#0'],
    },
    { text: 'archive-list', sourceIds: ['a2-key-2020'], translation: 'n. 归档列表' },
  ],
})
check('永久历史：准备删除词与删除列表两个场景',
  r.body?.added === 2 && typeof historyListId === 'string', r.body)

const archiveStartedAt = 1700000000123
r = await call('POST', '/api/lists/' + historyListId + '/start', {
  words: ['archive-one', 'archive-list'], startedAt: archiveStartedAt,
})
check('永久历史：start 成功', r.body?.started === 2, r.body)

const archiveDoneId = 'permanent-archive-one-done-1'
r = await call('POST', '/api/lists/' + historyListId + '/review', {
  words: ['archive-one'], action: 'done', requestIds: { 'archive-one': archiveDoneId },
})
check('永久历史：done 成功', r.body?.updated === 1, r.body)

r = await call('POST', '/api/lists/' + historyListId + '/review', {
  words: ['archive-one'], action: 'again', requestIds: { 'archive-one': 'permanent-archive-one-again-1' },
})
check('永久历史：again 成功', r.body?.updated === 1, r.body)

r = await call('POST', '/api/lists/' + historyListId + '/review', {
  words: ['archive-one'], action: 'tally', successKind: 'meaning',
  requestIds: { 'archive-one': 'permanent-archive-one-meaning-1' },
})
check('永久历史：知意计数成功', r.body?.updated === 1, r.body)

r = await call('GET', '/api/study/history?word=archive-one&limit=100')
let archiveEvents = historyEvents(r.body, 'archive-one')
check('学习记录管理默认只返回复习与熟悉度动作',
  r.status === 200
  && ['done', 'again'].every(action => archiveEvents.some(event => event.action === action))
  && archiveEvents.every(event => ['done', 'again', 'spelling', 'reading', 'meaning'].includes(event.action)),
  r.body)
check('永久事件保存每次具体时间',
  archiveEvents.length === 3
  && archiveEvents.every(event => Number.isFinite(eventAt(event)) && eventAt(event) > 0)
  && archiveEvents.some(event => event.action === 'done'),
  archiveEvents)

r = await call('GET', '/api/study/history?word=melon&action=spelling&limit=100')
const spellingOnlyEvents = historyEvents(r.body, 'melon')
check('学习记录可单独筛选会拼',
  spellingOnlyEvents.length === 2 && spellingOnlyEvents.every(event => event.action === 'spelling'), r.body)

r = await call('GET', '/api/study/achievements')
let archiveAchievement = achievementOf(r.body, 'archive-one')
check('成果按单词聚合 done / again 次数',
  archiveAchievement?.reviewCount === 2
  && archiveAchievement.rememberedCount === 1
  && archiveAchievement.forgottenCount === 1, archiveAchievement)

r = await call('DELETE', '/api/lists/' + historyListId + '/words/archive-one')
check('永久历史：从学习列表移除单词', r.body?.ok === true, r.body)
r = await call('GET', '/api/study/achievements')
archiveAchievement = achievementOf(r.body, 'archive-one')
check('移除学习列表单词后成果仍存在',
  archiveAchievement?.rememberedCount === 1 && archiveAchievement?.forgottenCount === 1, archiveAchievement)

r = await call('POST', '/api/lists/' + historyListId + '/review', {
  words: ['archive-list'], action: 'done', requestIds: { 'archive-list': 'permanent-archive-list-done-1' },
})
check('永久历史：删除列表前先产生一次成果', r.body?.updated === 1, r.body)
r = await call('POST', '/api/lists/' + historyListId + '/review', {
  words: ['archive-list'], action: 'tally', successKind: 'meaning',
  requestIds: { 'archive-list': 'permanent-archive-list-meaning-1' },
})
check('永久历史：删除列表前再留一次知意计数', r.body?.updated === 1, r.body)
r = await call('DELETE', '/api/lists/' + historyListId)
check('永久历史：删除整个学习列表', r.body?.ok === true, r.body)
r = await call('GET', '/api/study/achievements')
check('删除整个学习列表后成果仍存在',
  achievementOf(r.body, 'archive-list')?.rememberedCount === 1, r.body)

// 同一个单词更换词义再学习：底层身份不同，成果页仍只能把每次事件算一次。
r = await call('POST', '/api/lists', { name: 'Meaning profiles' })
const meaningListId = r.body?.id
r = await call('POST', '/api/lists/' + meaningListId + '/words', {
  text: 'meaning-word', translation: 'n. 第一义', translationIds: ['translation#0'], senseIds: ['noun#0'],
})
r = await call('POST', '/api/lists/' + meaningListId + '/start', { words: ['meaning-word'], startedAt: 1700000100000 })
r = await call('POST', '/api/lists/' + meaningListId + '/review', {
  words: ['meaning-word'], action: 'done', requestIds: { 'meaning-word': 'meaning-profile-done-a' },
})
check('词义身份：第一组词义产生事件', r.body?.updated === 1, r.body)
r = await call('PATCH', '/api/lists/' + meaningListId + '/words/meaning-word', {
  translation: 'v. 第二义', translationIds: ['translation#1'], senseIds: ['verb#0'],
})
r = await call('POST', '/api/lists/' + meaningListId + '/review', {
  words: ['meaning-word'], action: 'again', requestIds: { 'meaning-word': 'meaning-profile-again-b' },
})
check('词义身份：第二组词义产生事件', r.body?.updated === 1, r.body)
r = await call('GET', '/api/study/history?word=meaning-word&limit=100')
const meaningReviewEvents = historyEvents(r.body, 'meaning-word')
  .filter(event => event.action === 'done' || event.action === 'again')
const meaningIdentities = new Set(meaningReviewEvents.map(meaningIdentity).filter(Boolean))
check('不同 translationIds / senseIds 形成不同的永久词义身份',
  meaningReviewEvents.length === 2 && meaningIdentities.size === 2, meaningReviewEvents)
r = await call('GET', '/api/study/achievements')
const meaningAchievement = achievementOf(r.body, 'meaning-word')
check('成果页按事件聚合，不因一次事件关联多个词义而重复计数',
  meaningAchievement?.reviewCount === 2
  && meaningAchievement.rememberedCount === 0
  && meaningAchievement.forgottenCount === 1, meaningAchievement)

// 删除单条永久事件后，聚合必须由剩余事件重新计算。
const eventToDelete = meaningReviewEvents.find(event => event.action === 'done')
r = await call('DELETE', '/api/study/history/events/' + encodeURIComponent(eventToDelete?.id ?? ''))
check('永久历史：可删除单条事件', r.status === 200 && r.body?.ok === true, r.body)
r = await call('GET', '/api/study/achievements')
const afterEventDelete = achievementOf(r.body, 'meaning-word')
check('删除单条事件后成果统计重算',
  afterEventDelete?.reviewCount === 1
  && afterEventDelete.rememberedCount === 0
  && afterEventDelete.forgottenCount === 1, afterEventDelete)

// 清空某词历史只管理成果，不能反向删除词条或重置复习排期。
r = await call('GET', '/api/lists/' + meaningListId + '/words')
const scheduleBeforeClear = r.body?.find(item => item.word === 'meaning-word')
r = await call('DELETE', '/api/study/history/words/' + encodeURIComponent('meaning-word'))
check('永久历史：可清空某个单词的历史', r.status === 200 && r.body?.ok === true, r.body)
r = await call('GET', '/api/study/achievements')
check('清空某词历史后成果中不再显示该词',
  achievementOf(r.body, 'meaning-word') === undefined, r.body)
r = await call('GET', '/api/lists/' + meaningListId + '/words')
const scheduleAfterClear = r.body?.find(item => item.word === 'meaning-word')
check('清空某词历史不删除学习列表词条', scheduleAfterClear !== undefined, r.body)
check('清空某词历史不改变当前复习排期',
  scheduleAfterClear?.startedAt === scheduleBeforeClear?.startedAt
  && scheduleAfterClear?.stage === scheduleBeforeClear?.stage
  && scheduleAfterClear?.nextDueAt === scheduleBeforeClear?.nextDueAt
  && scheduleAfterClear?.state === scheduleBeforeClear?.state,
  { before: scheduleBeforeClear, after: scheduleAfterClear })

// 旧实现只保留 40 条 marks/reviewedAt；永久事件账本必须完整保存更多记录。
r = await call('POST', '/api/lists', { name: 'Long history' })
const longHistoryListId = r.body?.id
r = await call('POST', '/api/lists/' + longHistoryListId + '/words', {
  text: 'long-history', translation: 'n. 长历史', translationIds: ['translation#0'],
})
r = await call('POST', '/api/lists/' + longHistoryListId + '/start', { words: ['long-history'], startedAt: 1700000200000 })
for (let index = 0; index < 45; index++) {
  r = await call('POST', '/api/lists/' + longHistoryListId + '/review', {
    words: ['long-history'],
    action: index % 2 === 0 ? 'again' : 'done',
    requestIds: { 'long-history': 'long-history-event-' + index },
  })
}
r = await call('GET', '/api/study/history?word=long-history&limit=200')
const longHistoryEvents = historyEvents(r.body, 'long-history')
check('超过 40 条后永久历史仍可查询全部事件',
  longHistoryEvents.filter(event => event.action === 'done' || event.action === 'again').length === 45,
  { count: longHistoryEvents.length, body: r.body })
check('超过 40 条后每条事件的具体时间仍保留',
  longHistoryEvents.length === 45 && longHistoryEvents.every(event => Number.isFinite(eventAt(event)) && eventAt(event) > 0),
  longHistoryEvents)

const idempotentRequestId = 'long-history-idempotent-request'
r = await call('POST', '/api/lists/' + longHistoryListId + '/review', {
  words: ['long-history'], action: 'again', requestIds: { 'long-history': idempotentRequestId },
})
const firstIdempotentResponse = r.body
r = await call('POST', '/api/lists/' + longHistoryListId + '/review', {
  words: ['long-history'], action: 'again', requestIds: { 'long-history': idempotentRequestId },
})
check('同一个 requestId 重试不重复执行复习',
  firstIdempotentResponse?.updated === 1 && r.body?.updated === 0, r.body)
r = await call('GET', '/api/study/history?word=long-history&limit=200')
check('同一个 requestId 重试不重复插入永久事件',
  historyEvents(r.body, 'long-history').filter(event => event.requestId === idempotentRequestId).length === 1, r.body)

// 物理删除按单词清除 SQLite 事件，并回退同一个库里的列表累计计数，但保留当前复习排期。
r = await call('GET', '/api/lists/' + longHistoryListId + '/words')
const scheduleBeforePurge = r.body?.find(item => item.word === 'long-history')
const backupDir = path.join(dataDir, 'backups')
const backupsBeforePurge = fs.existsSync(backupDir) ? fs.readdirSync(backupDir).length : 0
r = await call('POST', '/api/study/history/purge', { words: ['long-history'] })
check('物理删除选中单词返回删除数量并创建备份',
  r.status === 200 && r.body?.ok === true && r.body?.deletedEvents >= 46
  && fs.readdirSync(backupDir).length >= backupsBeforePurge + 1, r.body)
r = await call('GET', '/api/study/history?word=long-history&limit=100')
check('物理删除包含正常和已逻辑删除的历史行',
  historyEvents(r.body, 'long-history').length === 0 && r.body?.total === 0, r.body)
r = await call('GET', '/api/lists/' + longHistoryListId + '/words')
const scheduleAfterPurge = r.body?.find(item => item.word === 'long-history')
check('物理删除不改变学习列表和当前复习排期',
  scheduleAfterPurge?.startedAt === scheduleBeforePurge?.startedAt
  && scheduleAfterPurge?.stage === scheduleBeforePurge?.stage,
  { before: scheduleBeforePurge, after: scheduleAfterPurge })
check('物理删除同步清理学习列表次数镜像',
  scheduleAfterPurge?.reviewCount === 0 && scheduleAfterPurge?.spellingCount === 0
  && scheduleAfterPurge?.rememberedCount === 0 && scheduleAfterPurge?.forgottenCount === 0,
  scheduleAfterPurge)

r = await call('POST', '/api/study/history/purge', { words: [] })
check('物理删除拒绝空单词数组', r.status === 400 && r.body?.ok === false, r.body)
r = await call('POST', '/api/study/history/purge', { words: ['ok', 3] })
check('物理删除拒绝非字符串单词', r.status === 400 && r.body?.ok === false, r.body)

const listsBeforePurgeAll = await call('GET', '/api/lists')
r = await call('POST', '/api/study/history/purge', { all: true })
check('全部物理删除成功', r.status === 200 && r.body?.ok === true, r.body)
const afterPurgeAll = await call('GET', '/api/study/achievements')
check('全部物理删除后学习成果为空', achievementItems(afterPurgeAll.body).length === 0, afterPurgeAll.body)
const listsAfterPurgeAll = await call('GET', '/api/lists')
check('全部物理删除不删除学习列表',
  JSON.stringify(listsAfterPurgeAll.body.map(item => item.id))
  === JSON.stringify(listsBeforePurgeAll.body.map(item => item.id)), listsAfterPurgeAll.body)
try {
  const { DatabaseSync } = await import('node:sqlite')
  const historyDatabase = new DatabaseSync(path.join(dataDir, 'study-history.sqlite'), { readOnly: true })
  const migrationCount = Number(historyDatabase.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get()?.count || 0)
  const eventCount = Number(historyDatabase.prepare('SELECT COUNT(*) AS count FROM learning_events').get()?.count || 0)
  const eventMeaningCount = Number(historyDatabase.prepare('SELECT COUNT(*) AS count FROM learning_event_meanings').get()?.count || 0)
  const meaningCount = Number(historyDatabase.prepare('SELECT COUNT(*) AS count FROM meaning_profiles').get()?.count || 0)
  historyDatabase.close()
  check('全部物理删除清空历史表但保留迁移标记',
    migrationCount > 0 && eventCount === 0 && eventMeaningCount === 0 && meaningCount === 0,
    { migrationCount, eventCount, eventMeaningCount, meaningCount })
} catch (error) {
  check('全部物理删除数据库结构可读取', false, error.message)
}

// 真正拉起两个 Node 进程，验证重启持久化，以及旧 JSON -> SQLite 的启动迁移不会重复。
const restartDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dict-history-restart-'))
const restartSeed = runHistoryProbe(restartDir, 'seed')
const restartRead = runHistoryProbe(restartDir, 'read')
const restartSeedEvents = historyEvents(restartSeed.history?.body, 'restart-history')
const restartReadEvents = historyEvents(restartRead.history?.body, 'restart-history')
check('服务重启后永久历史仍存在',
  restartRead.history?.status === 200
  && restartReadEvents.some(event => event.action === 'done')
  && restartReadEvents.every(event => ['done', 'again', 'spelling', 'reading', 'meaning'].includes(event.action))
  && achievementOf(restartRead.achievements?.body, 'restart-history')?.rememberedCount === 1,
  restartRead)
check('重复启动迁移幂等，不重复导入历史',
  restartSeedEvents.length > 0 && restartReadEvents.length === restartSeedEvents.length,
  { first: restartSeedEvents, second: restartReadEvents })

const sqliteFile = path.join(restartDir, 'study-history.sqlite')
let integrityResult = ''
let integrityError = ''
try {
  const { DatabaseSync } = await import('node:sqlite')
  const database = new DatabaseSync(sqliteFile, { readOnly: true })
  integrityResult = String(database.prepare('PRAGMA integrity_check').get()?.integrity_check ?? '')
  database.close()
} catch (error) {
  integrityError = error.message
}
check('永久历史使用独立 SQLite 文件', fs.existsSync(sqliteFile), { sqliteFile, restartSeed, restartRead })
check('SQLite integrity_check = ok', integrityResult === 'ok', { integrityResult, integrityError })
fs.rmSync(restartDir, { recursive: true, force: true })

// ── 词典缓存：音标 / 释义全集 / 抓齐与否 ───────────────────────────────────

await waitForPrefetch()

writeDictCache(dataDir, {
  melon: { word: 'melon', phonetic: 'ˈmelən', translation: '瓜', meanings: [], cachedAt: Date.now() },
  lemon: {
    word: 'lemon', cachedAt: Date.now(),
    meanings: [{ partOfSpeech: 'noun', definitions: ['a yellow citrus fruit'], examples: ['a slice of lemon'] }],
  },
})

r = await call('POST', '/api/dict/batch', { words: ['Melon', 'grape', 'LEMON'] })
check('批量取缓存：命中 melon、缺 grape',
  r.body?.entries?.melon?.translation === '瓜' && JSON.stringify(r.body.missing) === '["grape"]', r.body)
check('lemon 在缓存里但没抓齐（缺音标和中文）',
  JSON.stringify(r.body.incomplete) === '["lemon"]' && r.body.entries.lemon.status === 'partial', r.body)
check('老 meanings 缓存自动迁移成 senses，例句字段一并丢掉',
  r.body.entries.lemon.senses[0].id === 'noun#0'
  && r.body.entries.lemon.senses[0].definition === 'a yellow citrus fruit'
  && r.body.entries.lemon.senses[0].example === undefined, r.body.entries.lemon)

r = await call('GET', '/api/cache/stats')
check('缓存统计区分抓齐 / 没抓齐',
  r.body?.total === 2 && r.body.complete === 1 && r.body.incomplete === 1, r.body)

r = await call('GET', '/api/dict?word=' + encodeURIComponent('  MELON '))
check('抓齐的缓存直接命中', r.body?.fromCache === true && r.body.word === 'melon', r.body)

r = await call('GET', '/api/dict/prefetch')
check('补齐进度可查', r.status === 200 && typeof r.body?.finished === 'boolean', r.body)
check('进度响应带齐 total/done/failed/pending/running/finished', hasProgressShape(r.body), r.body)

r = await call('POST', '/api/dict/repair', {})
check('repair 扫出学习列表里没抓齐的词', r.body?.ok === true && r.body.scanned > 0, r.body)
check('repair 响应同样带齐进度字段（前端据此显示 x/y）',
  hasProgressShape(r.body) && Number.isFinite(r.body.queued), r.body)
await waitForPrefetch()

r = await call('GET', '/api/cache/stats')
check('断网时 repair 不会往缓存里塞空壳', r.body?.total === 2, r.body)

r = await call('DELETE', '/api/lists/' + studyId)
check('清理学习进度用的列表', r.body?.ok === true, r.body)

// ── 词库显示标签 ──────────────────────────────────────────────────────────

r = await call('GET', '/api/vocab-labels')
check('标签初始为空', r.status === 200 && JSON.stringify(r.body.labels) === '{}', r.body)

r = await call('PATCH', '/api/vocab-labels/a2-key-2020', { label: '  KET  ' })
check('改标签并去掉首尾空白', r.body?.ok === true && r.body.label === 'KET', r.body)

r = await call('PATCH', '/api/vocab-labels/a2-key-2020', { label: '   ' })
check('空标签 -> 400', r.status === 400 && r.body.ok === false, r.body)

r = await call('PATCH', '/api/vocab-labels/b1-pet', { label: 'KET' })
check('标签撞名 -> 409', r.status === 409 && r.body.ok === false, r.body)

r = await call('PATCH', '/api/vocab-labels/a2-key-2020', { label: 'KET' })
check('改回自己原来的标签不算撞名', r.body?.ok === true, r.body)

r = await call('PATCH', '/api/vocab-labels/b1-pet', { label: 'x'.repeat(41) })
check('标签超长 -> 400', r.status === 400 && r.body.ok === false, r.body)

r = await call('POST', '/api/vocab-labels', { labels: { 'b1-pet': 'PET', 'blank-id': '   ' } })
check('批量合并跳过空标签', r.body?.ok === true && r.body.merged === 1 && r.body.labels['b1-pet'] === 'PET', r.body)

r = await call('GET', '/api/vocab-labels')
check('标签读回 2 条', Object.keys(r.body.labels).length === 2, r.body)

r = await call('DELETE', '/api/vocab-labels/a2-key-2020')
check('重置标签', r.body?.ok === true && r.body.existed === true, r.body)

r = await call('DELETE', '/api/vocab-labels/a2-key-2020')
check('重复重置仍返回 ok', r.body?.ok === true && r.body.existed === false, r.body)

r = await call('GET', '/api/vocab-labels')
check('只剩 1 条标签覆写', JSON.stringify(r.body.labels) === '{"b1-pet":"PET"}', r.body)

r = await call('GET', '/api/vocab-print-labels')
check('打印标签初始为空', r.status === 200 && JSON.stringify(r.body.printLabels) === '{}', r.body)

r = await call('PATCH', '/api/vocab-print-labels/a2-key-2020', { label: '  KET PRINT  ' })
check('打印标签保存并去掉首尾空白', r.body?.ok === true && r.body.label === 'KET PRINT', r.body)

r = await call('PATCH', '/api/vocab-print-labels/a2-key-2020', { label: '   ' })
check('空打印标签 -> 400', r.status === 400 && r.body.ok === false, r.body)

r = await call('POST', '/api/vocab-print-labels', { printLabels: { 'b1-pet': 'PET PRINT' } })
check('批量合并打印标签', r.body?.ok === true && r.body.printLabels['b1-pet'] === 'PET PRINT', r.body)

r = await call('DELETE', '/api/vocab-print-labels/a2-key-2020')
check('重置打印标签', r.body?.ok === true && r.body.existed === true, r.body)

r = await call('GET', '/api/vocab-print-labels')
check('打印标签重置后只剩一条', JSON.stringify(r.body.printLabels) === '{"b1-pet":"PET PRINT"}', r.body)

const saved = readStudyLists(dataDir)
check('已落盘', Array.isArray(saved.lists) && saved.lists[0].id === 'default', saved)

const savedLabels = readKv(dataDir, KV_KEYS.labels, { labels: {}, printLabels: {} })
check('标签已落盘', savedLabels.labels['b1-pet'] === 'PET', savedLabels)
check('打印标签已落盘', savedLabels.printLabels['b1-pet'] === 'PET PRINT', savedLabels)

// ── 学习目标（目标 = 某个词库） ────────────────────────────────────────────

r = await call('GET', '/api/study/goal')
check('目标初始为空', r.status === 200 && r.body.libraryId === '', r.body)

r = await call('PUT', '/api/study/goal', { libraryId: '  a2-key-2020  ' })
check('设置目标并去掉首尾空白', r.body?.ok === true && r.body.libraryId === 'a2-key-2020', r.body)

r = await call('GET', '/api/study/goal')
check('目标读回', r.body?.libraryId === 'a2-key-2020', r.body)

r = await call('PUT', '/api/study/goal', { libraryId: 123 })
check('目标 libraryId 非字符串 -> 400', r.status === 400 && r.body.ok === false, r.body)

r = await call('GET', '/api/study/goal')
check('非法请求不会覆盖已存的目标', r.body?.libraryId === 'a2-key-2020', r.body)

const savedGoal = readKv(dataDir, KV_KEYS.goal, {})
check('目标已落盘', savedGoal.libraryId === 'a2-key-2020', savedGoal)

r = await call('PUT', '/api/study/goal', { libraryId: '' })
check('清空目标', r.body?.ok === true && r.body.libraryId === '', r.body)

r = await call('GET', '/api/study/goal')
check('清空后读回空串', r.body?.libraryId === '', r.body)

// ── 打印批次记录 + 整批打卡 ────────────────────────────────────────────────

r = await call('POST', '/api/lists', { name: 'Printed' })
const printListId = r.body?.id
r = await call('POST', '/api/lists/' + printListId + '/import', { items: [{ text: 'plum' }, { text: 'fig' }] })
check('打印批次：准备 2 个词', r.body?.added === 2, r.body)

r = await call('POST', '/api/lists/' + printListId + '/start',
  { words: ['plum', 'fig'], startedAt: monday, scope: 'week' })
check('打印批次：2 个词按周开始学习', r.body?.started === 2, r.body)

r = await call('POST', '/api/print-batches', {
  title: 'Printed · 本周批次',
  kind: 'start',
  scope: 'week',
  printedAt: monday,
  groups: [{ listId: printListId, words: ['FIG ', 'plum', 'nope'] }],
})
const printA = r.body?.batch
check('记一次打印：归一化 + 跳过不在列表里的词',
  r.body?.ok === true && printA?.wordCount === 2
  && JSON.stringify(r.body.missing) === '["nope"]', r.body)
check('打印记录带上来源与打印时的粒度',
  printA?.kind === 'start' && printA.scope === 'week' && printA.printedAt === monday, printA)

r = await call('GET', '/api/lists/' + printListId + '/words')
let plum = r.body.find(w => w.word === 'plum')
check('打印本身也记一条打标',
  plum?.markCount === 2
  && (await wordEvents('plum', 'print')).some(e => e.at === monday && e.scope === 'week'), plum)

r = await call('POST', '/api/print-batches', { groups: [{ listId: printListId, words: ['plum'] }] })
const printB = r.body?.batch
check('标题缺省按词数生成', printB?.title === '打印 1 词' && printB.scope === undefined, printB)

r = await call('POST', '/api/print-batches', {
  title: '自由挑选打印',
  kind: 'custom',
  printedAt: monday + 123,
  groups: [{ listId: printListId, words: ['fig'] }],
})
const customPrint = r.body?.batch
check('自由挑选打印使用独立的批次类型', customPrint?.kind === 'custom', customPrint)
r = await call('DELETE', '/api/print-batches/' + customPrint?.id)
check('清理自由挑选打印测试记录', r.body?.ok === true, r.body)

r = await call('POST', '/api/lists', { name: 'Printed Other' })
const otherPrintListId = r.body?.id
r = await call('POST', '/api/lists/' + otherPrintListId + '/import', { items: [{ text: 'pear' }] })
check('打印去重：准备另一个列表的词', r.body?.added === 1, r.body)

r = await call('POST', '/api/print-batches', {
  title: '跨列表旧批次',
  kind: 'custom',
  printedAt: monday + 200,
  groups: [
    { listId: printListId, words: ['plum'] },
    { listId: otherPrintListId, words: ['pear'] },
  ],
})
const oldCrossListPrint = r.body?.batch
r = await call('POST', '/api/print-batches', {
  title: '跨列表最新批次',
  kind: 'review',
  printedAt: monday + 300,
  groups: [
    { listId: otherPrintListId, words: [' PEAR '] },
    { listId: printListId, words: ['PLUM'] },
  ],
})
const latestCrossListPrint = r.body?.batch
check('相同跨列表词组忽略次序和单词格式，只保留最新记录',
  latestCrossListPrint?.id !== oldCrossListPrint?.id, { oldCrossListPrint, latestCrossListPrint })

r = await call('GET', '/api/print-batches')
check('相同词组的旧打印记录已移除，其他批次仍保留',
  r.body?.total === 3
  && !r.body.batches.some(b => b.id === oldCrossListPrint?.id)
  && r.body.batches.some(b => b.id === latestCrossListPrint?.id)
  && r.body.batches.some(b => b.id === printA?.id)
  && r.body.batches.some(b => b.id === printB?.id), r.body)

const dedupedPrints = readKv(dataDir, KV_KEYS.prints, { batches: [] })
check('最新的相同词组记录落盘在最前', dedupedPrints.batches[0]?.id === latestCrossListPrint?.id, dedupedPrints)

r = await call('DELETE', '/api/print-batches/' + latestCrossListPrint?.id)
check('清理跨列表打印去重测试记录', r.body?.ok === true, r.body)
r = await call('DELETE', '/api/lists/' + otherPrintListId)
check('清理跨列表打印去重测试列表', r.body?.ok === true, r.body)

r = await call('GET', '/api/print-batches')
check('打印记录新的在前',
  r.body?.total === 2 && r.body.batches[0].id === printB?.id && r.body.batches[1].id === printA?.id, r.body)
check('打印记录带上现算的进度',
  r.body.batches[1].markableCount === 2 && r.body.batches[1].missingCount === 0
  && r.body.batches[1].items.every(i => typeof i.stage === 'number'), r.body?.batches?.[1])

r = await call('POST', '/api/print-batches/' + printA?.id + '/review', { action: 'done' })
check('整批打卡沿用打印时的按周粒度，一次只推进一轮',
  r.body?.ok === true && r.body.updated === 2
  && r.body.items.every(i => i.stage === 1 && i.marks === undefined), r.body)
check('整批打卡回写批次上的打卡信息',
  r.body.batch?.reviewAction === 'done' && r.body.batch.reviewedCount === 2
  && r.body.batch.reviewCount === 1 && typeof r.body.batch.reviewedAt === 'number', r.body?.batch)

const printRetryIds = {}
for (const item of printA.items) {
  // 服务端的 fallback 幂等键取打卡前的状态：stage 0、nextDueAt = 开始当天
  printRetryIds[item.listId + '|' + item.word] = [
    printA.id, item.listId, item.word, 0, monday, 'done', 'week', '',
  ].join('|')
}
r = await call('POST', '/api/print-batches/' + printA?.id + '/review', {
  action: 'done', requestIds: printRetryIds,
})
check('重复提交打印批次不重复统计',
  r.body?.ok === true && r.body.updated === 0 && r.body.batch?.reviewCount === 1
  && r.body.batch?.reviewedCount === 2, r.body)

r = await call('POST', '/api/print-batches/' + printA?.id + '/review', { action: 'nope' })
check('整批打卡非法动作 -> 400', r.status === 400 && r.body.ok === false, r.body)

r = await call('POST', '/api/print-batches/print_0/review', { action: 'done' })
check('批次不存在 -> 404', r.status === 404 && r.body.ok === false, r.body)

r = await call('POST', '/api/print-batches', { groups: [] })
check('打印记录没给分组 -> 400', r.status === 400 && r.body.ok === false, r.body)

r = await call('POST', '/api/print-batches', { groups: [{ listId: printListId, words: ['zzz'] }] })
check('一个词都没对上就不留空记录', r.status === 400 && r.body.ok === false, r.body)

r = await call('DELETE', '/api/lists/' + printListId + '/words/fig')
check('打印之后把词从学习列表里删掉', r.body?.ok === true, r.body)

r = await call('GET', '/api/print-batches')
const afterDrop = r.body?.batches?.find(b => b.id === printA?.id)
check('被移除的词标成 missing 且不参与打卡',
  afterDrop?.missingCount === 1 && afterDrop.markableCount === 1
  && afterDrop.items.find(i => i.word === 'fig')?.missing === true, afterDrop)

const savedPrints = readKv(dataDir, KV_KEYS.prints, { batches: [] })
const storedA = savedPrints.batches.find(b => b.id === printA?.id)
check('打印记录已落盘且不含派生字段',
  storedA?.reviewAction === 'done' && storedA.items[0].word === 'fig'
  && storedA.dueCount === undefined && storedA.items[0].state === undefined, storedA)

r = await call('DELETE', '/api/print-batches/' + printA?.id)
check('删掉一条打印记录', r.body?.ok === true, r.body)

r = await call('GET', '/api/print-batches')
check('只剩另一条打印记录', r.body?.total === 1 && r.body.batches[0].id === printB?.id, r.body)

r = await call('GET', '/api/lists/' + printListId + '/words')
plum = r.body.find(w => w.word === 'plum')
check('删记录不动词的学习进度', plum?.stage === 1, plum)

r = await call('DELETE', '/api/lists/' + printListId)
check('清理打印批次测试用的列表', r.body?.ok === true, r.body)

// ── 本地词典（ECDICT） ────────────────────────────────────────────────────

console.log('')
console.log('本地词典（ECDICT）')

// 造一份和 ECDICT 同结构的小 csv：多义项用字面量 \n 分行，字段里带逗号 / 换行 / TAB / 反斜杠
const ecdictCsv = path.join(dataDir, 'small-ecdict.csv')
fs.writeFileSync(ecdictCsv, [
  'word,phonetic,definition,translation,pos,collins,oxford,tag,bnc,frq,exchange,detail,audio',
  'apple,\'æpl,"n. fruit with red or yellow or green skin\\nn. native Eurasian tree","n. 苹果, 家伙\\n[医] 苹果",n:100,3,1,zk gk,1000,2000,s:apples,,',
  'apples,,,,,,,,,,0:apple/1:s,,',
  '"a few",,"adj. more than one but indefinitely small in number","adj. 有些, 几个",,,,,,,,,',
  '"quoted,word",kwoʊt,"n. a word, with a comma","n. 带逗号的词",,,,,,,,,',
  'multi,mʌlti,"n. line one\nline two","n. 第一行\n第二行",,,,,,,,,',
  'Banana,bəˈnɑːnə,n. elongated crescent-shaped yellow fruit,n. 香蕉,,,,,,,,,',
  'longzh,,,"n. 一二三四五六七八九十，一二三四五六七八九十，一二三四五六七八九十，一二三四五六七八九十，一二三四五六七八九十，一二三四五六七八九十",,,,,,,,,',
  'dup,,,"n. 第一次出现",,,,,,,,,',
  'dup,dupph,"n. second time","n. 第二次出现更全",,,,,,,,,',
  'esc,,"n. tab\there","n. 制表符",,,,,,,,,',
  'bslash,,"n. path C:\\dir","n. 反斜杠",,,,,,,,,',
  '',
].join('\n'), 'utf8')

const { buildEcdict } = await import(path.join(__dirname, '../scripts/ecdict-build.mjs'))
const { ecdictEntry, ecdictInfo, resetEcdict } = await import(path.join(__dirname, 'ecdict.mjs'))
const built = await buildEcdict({ csv: ecdictCsv })
resetEcdict()

check('构建出 10 条词条（dup 两行合成一条）', built.count === 10, { count: built.count, skipped: built.skipped })
const info = ecdictInfo()
check('ecdictInfo 报 ready', info.ready === true && info.count === 10, info)

const eApple = ecdictEntry('  APPLE  ')
check('查 apple 命中（首尾空白 + 大写都归一化）', !!eApple, eApple)
check('裸音标包成斜杠形式', eApple?.phonetic === "/'æpl/", eApple?.phonetic)
check('中文释义取前两行、跳过 [医] 这类标注', eApple?.translation === 'n. 苹果, 家伙', eApple?.translation)
check('英文释义按字面量 \\n 拆成两条', eApple?.senses.length === 2, eApple?.senses)
check('词性缩写 n. 映射成 noun 并剥掉前缀',
  eApple?.senses[0].pos === 'noun' && eApple.senses[0].definition.startsWith('fruit with red'), eApple?.senses[0])
check('本地词条标 source=ecdict', eApple?.source === 'ecdict', eApple?.source)
check('同一词性下的中文词义都保留词性',
  eApple?.translations?.every(item => item.pos === 'noun'), eApple?.translations)

const eApples = ecdictEntry('APPLES')
check('变形词经 exchange 回原形取释义', eApples?.translation === 'n. 苹果, 家伙', eApples)
check('变形词仍然返回自己的词形', eApples?.word === 'apples', eApples?.word)

const eFew = ecdictEntry('A Few')
check('带空格的短语也能查到', eFew?.senses[0]?.pos === 'adjective', eFew)

const eQuoted = ecdictEntry('quoted,word')
check('引号包裹的字段里逗号不当分隔符',
  eQuoted?.senses[0]?.definition === 'a word, with a comma', eQuoted?.senses[0])

const eMulti = ecdictEntry('multi')
check('字段里的真换行拆成两条释义', eMulti?.senses.length === 2, eMulti?.senses)
check('两行中文用分号拼起来', eMulti?.translation === 'n. 第一行；第二行', eMulti?.translation)

check('大写开头的词按小写主键存', ecdictEntry('banana')?.translation === 'n. 香蕉')

const eLong = ecdictEntry('longzh')
check('过长的中文在标点处截断（卡片放得下）',
  eLong?.translation.endsWith('…') && eLong.translation.length <= 61,
  [eLong?.translation, eLong?.translation.length])

const eDup = ecdictEntry('dup')
check('同一个词出现多次留信息更全的那条',
  eDup?.phonetic === '/dupph/' && eDup.translation === 'n. 第二次出现更全', eDup)

check('字段里的 TAB 转义后能原样还原', ecdictEntry('esc')?.senses[0].definition === 'tab\there',
  ecdictEntry('esc')?.senses[0])
check('字段里的反斜杠转义后能原样还原', ecdictEntry('bslash')?.senses[0].definition === 'path C:\\dir',
  ecdictEntry('bslash')?.senses[0])

check('词典里没有的词返回 null', ecdictEntry('zzznosuchword') === null)
check('空词返回 null', ecdictEntry('   ') === null)

// ── 词典接口走本地优先 ────────────────────────────────────────────────────

console.log('')
console.log('查词接口（本地优先）')

r = await call('GET', '/api/dict?word=Apple')
check('查词接口返回本地词典的完整词条',
  r.body?.status === 'ok' && r.body?.source === 'ecdict', r.body)
check('查词接口带上本地音标', r.body?.phonetic === "/'æpl/", r.body?.phonetic)
check('释义 id 仍是词性 + 序号', r.body?.senses?.[0]?.id === 'noun#0', r.body?.senses?.[0])

r = await call('GET', '/api/dict?word=apple&refresh=1')
check('refresh=1 也不去网上重抓（本地够用）',
  r.body?.source === 'ecdict' && r.body?.translation === 'n. 苹果, 家伙', r.body)
check('本地词典命中的单词标记为拼写有效', r.body?.spellingStatus === 'valid', r.body)

r = await call('GET', '/api/dict?word=a%20few')
check('短语也能从本地词典查到', r.body?.status === 'ok' && r.body?.source === 'ecdict', r.body)

r = await call('POST', '/api/dict/batch', { words: ['APPLE', 'zzznosuchword'] })
check('批量查询先用本地词典补齐', r.body?.entries?.apple?.source === 'ecdict', r.body?.entries?.apple)
check('本地也没有的词才算 missing',
  r.body?.missing?.includes('zzznosuchword') && !r.body.missing.includes('apple'), r.body?.missing)
check('本地补齐后不再算 incomplete', r.body?.incomplete?.length === 0, r.body?.incomplete)

// ── 装词典之前留下的旧缓存要被就地升级 ────────────────────────────────────
// 模拟真实场景：这两条是外部接口时代抓的，status 已经是 ok、还带着例句，
// 从前会被「缓存 ok 就直接返回」挡住，永远换不成 ECDICT 的释义。
const staleCache = readDictCache(dataDir)
staleCache.banana = {
  word: 'banana', phonetic: '/old-api/', translation: '香蕉（机翻）',
  senses: [{ id: 'noun#0', pos: 'noun', definition: 'stale english definition', example: 'I ate a banana.' }],
  cachedAt: Date.now(), status: 'ok', source: 'api',
}
staleCache.multi = {
  word: 'multi', phonetic: '/old-api/', translation: '旧机翻',
  senses: [{ id: 'noun#0', pos: 'noun', definition: 'stale def', example: 'stale example' }],
  cachedAt: Date.now(), status: 'ok', source: 'api',
}
writeDictCache(dataDir, staleCache)

r = await call('GET', '/api/dict?word=banana')
check('抓齐但不是本地词典的旧缓存，查词时就地换成 ECDICT',
  r.body?.source === 'ecdict' && r.body?.translation === 'n. 香蕉'
  && r.body?.phonetic === '/bəˈnɑːnə/', r.body)
check('升级后旧缓存里的例句不再保留',
  Array.isArray(r.body?.senses) && r.body.senses.every(s => s.example === undefined), r.body?.senses)

r = await call('POST', '/api/dict/batch', { words: ['MULTI'] })
check('批量读缓存也会把旧数据换成 ECDICT',
  r.body?.entries?.multi?.source === 'ecdict'
  && r.body.entries.multi.translation === 'n. 第一行；第二行', r.body?.entries?.multi)
check('批量升级后例句同样被丢掉',
  r.body?.entries?.multi?.senses?.length === 2
  && r.body.entries.multi.senses.every(s => s.example === undefined), r.body?.entries?.multi?.senses)

r = await call('GET', '/api/dict?word=banana')
check('升级过一次之后就当普通缓存命中，不再重复升级', r.body?.fromCache === true, r.body)

r = await call('GET', '/api/dict/sources')
check('来源接口报本地词典就绪',
  r.body?.local?.ready === true && r.body?.local?.count === 10, r.body)
check('来源接口报当前不联网', r.body?.network === false, r.body)

// ── 百度翻译链路（本地 mock，不访问真实网络）──────────────────────────────

console.log('')
console.log('百度翻译链路（mock）')

const baiduDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dict-baidu-test-'))
const oldEnv = {
  data: process.env.DICT_DATA_DIR,
  noNetwork: process.env.DICT_NO_NETWORK,
  key: process.env.BAIDU_TRANSLATE_API_KEY,
  appId: process.env.BAIDU_TRANSLATE_APP_ID,
  url: process.env.BAIDU_TRANSLATE_API_URL,
  timeout: process.env.DICT_NETWORK_TIMEOUT_MS,
}
const oldFetch = globalThis.fetch
const fetchCalls = []
globalThis.fetch = async (url, options = {}) => {
  const target = String(url)
  fetchCalls.push({ url: target, options })
  if (target.includes('dictionaryapi.dev')) {
    const token = decodeURIComponent(target.split('/').pop())
    if (token === 'slow') return new Promise(() => {})
    if (token === 'got') {
      return { ok: false, status: 404, async json() { return { title: 'No entry found' } } }
    }
    if (['how', 'are', 'you', "i've", 'a', 'dog'].includes(token)) {
      const phonetics = {
        how: '/haʊ/', are: '/ɑːr/', you: '/juː/',
        "i've": '/aɪv/', a: '/ə/', dog: '/dɔːɡ/',
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return [{ word: token, phonetic: phonetics[token], meanings: [] }]
        },
      }
    }
    return {
      ok: true,
      status: 200,
      async json() {
      return [{
          word: 'kiwi',
          phonetic: '/ˈkiːwi/',
          meanings: [{ partOfSpeech: 'noun', definitions: [{ definition: 'a small fruit' }] }],
      }]
      },
    }
  }
  if (target === 'http://baidu.mock/translate') {
    const payload = JSON.parse(options.body)
    const translation = payload.q === 'kiwi'
      ? '猕猴桃'
      : (payload.q === 'untranslatable' ? 'untranslatable' : '你今天好吗？')
    return {
      ok: true,
      status: 200,
      async json() { return { result: { trans_result: [{ src: payload.q, dst: translation }] } } },
    }
  }
  throw new Error('unexpected mock URL: ' + target)
}
process.env.DICT_DATA_DIR = baiduDir
process.env.DICT_NO_NETWORK = '0'
process.env.BAIDU_TRANSLATE_API_KEY = 'test-key-not-real'
process.env.BAIDU_TRANSLATE_APP_ID = 'test-app-id-not-real'
process.env.BAIDU_TRANSLATE_API_URL = 'http://baidu.mock/translate'
process.env.DICT_NETWORK_TIMEOUT_MS = '1000'
const { server: baiduServer } = await import(path.join(__dirname, 'dict-server.mjs?baidu-test'))

fetchCalls.length = 0
r = await callOn(baiduServer, 'GET', '/api/dict?word=apple')
check('ECDICT 命中的单词不调用百度',
  r.body?.source === 'ecdict' && !fetchCalls.some(c => c.url === 'http://baidu.mock/translate'), fetchCalls)

fetchCalls.length = 0
r = await callOn(baiduServer, 'GET', '/api/dict?word=kiwi')
check('本地词典没有的单词调用百度并返回中文',
  r.body?.translation === '猕猴桃' && r.body?.status === 'ok'
  && fetchCalls.some(c => c.url === 'http://baidu.mock/translate'), r.body)
check('免费词典命中的单词标记为拼写有效', r.body?.spellingStatus === 'valid', r.body)
const kiwiBaiduCall = fetchCalls.find(call => call.url === 'http://baidu.mock/translate')
const kiwiBaiduBody = JSON.parse(kiwiBaiduCall?.options?.body || '{}')
check('百度大模型翻译请求使用 appid/from/to/q 格式',
  kiwiBaiduCall?.options?.headers?.Authorization === 'Bearer test-key-not-real'
  && kiwiBaiduBody.appid === 'test-app-id-not-real'
  && kiwiBaiduBody.from === 'en'
  && kiwiBaiduBody.to === 'zh'
  && kiwiBaiduBody.q === 'kiwi'
  && kiwiBaiduBody.model === undefined, { headers: kiwiBaiduCall?.options?.headers, body: kiwiBaiduBody })
const kiwiCache = readDictCache(baiduDir)
check('百度中文会写入缓存', kiwiCache.kiwi?.translation === '猕猴桃', kiwiCache.kiwi)
check('拼写状态会持久化到缓存', kiwiCache.kiwi?.spellingStatus === 'valid', kiwiCache.kiwi)

fetchCalls.length = 0
r = await callOn(baiduServer, 'GET', '/api/dict?word=got')
check('本地未命中且免费词典明确 404 时标记为可能拼写错误',
  r.body?.spellingStatus === 'suspect'
  && r.body?.errors?.some(error => error.source === 'dictionaryapi' && error.code === 'not_found'), r.body)
const suspectCache = readDictCache(baiduDir)
check('可能拼写错误状态会持久化到缓存', suspectCache.got?.spellingStatus === 'suspect', suspectCache.got)

fetchCalls.length = 0
r = await callOn(baiduServer, 'POST', '/api/dict/search-batch', {
  words: [' Kiwi ', 'untranslatable', 'KIWI', 'apple'],
})
const batchKiwi = r.body?.results?.find(item => item.word === 'kiwi')
const batchMissing = r.body?.results?.find(item => item.word === 'untranslatable')
const batchLocal = r.body?.results?.find(item => item.word === 'apple')
check('批量查询归一化去重并复用单条查询结果',
  r.status === 200 && r.body?.total === 3 && batchKiwi?.ok === true
  && batchKiwi.entry.translation === '猕猴桃', r.body)
check('批量查询中一项缺少中文不会使其他项目失败',
  r.body?.succeeded === 2 && r.body?.failed === 1
  && batchMissing?.ok === false && batchMissing?.error?.source === 'baidu'
  && batchLocal?.ok === true && batchLocal.entry.translation === 'n. 苹果, 家伙', r.body)
check('批量失败项仍返回已经取得的部分词典数据',
  batchMissing?.entry?.phonetic === '/ˈkiːwi/'
  && Array.isArray(batchMissing.entry.senses), batchMissing)

r = await callOn(baiduServer, 'POST', '/api/dict/search-batch', { words: [] })
check('批量查询没有有效输入 -> 400', r.status === 400 && r.body?.error === 'missing words', r.body)

fetchCalls.length = 0
r = await callOn(baiduServer, 'POST', '/api/lists/default/import', {
  items: [{ text: 'We enjoy coding.', translation: '我们喜欢编程。', translationIds: ['baidu#0'] }],
})
await waitForPrefetchOn(baiduServer)
const importFetchCalls = [...fetchCalls]
const importedSnapshot = await callOn(baiduServer, 'GET', '/api/lists/default/words')
check('批量导入立即保存前端中文快照，后台不重新调用百度',
  r.body?.added === 1
  && !importFetchCalls.some(call => call.url === 'http://baidu.mock/translate')
  && importedSnapshot.body?.find(item => item.word === 'we enjoy coding.')?.translation === '我们喜欢编程。',
  { response: r.body, fetchCalls: importFetchCalls, words: importedSnapshot.body })

fetchCalls.length = 0
r = await callOn(baiduServer, 'GET', '/api/dict?word=how%20are%20you%3F')
const sentenceBaiduCall = fetchCalls.find(call => call.url === 'http://baidu.mock/translate')
const sentenceBaiduBody = JSON.parse(sentenceBaiduCall?.options?.body || '{}')
check('小写句子查询时以首字母大写形式调用百度翻译',
  sentenceBaiduBody.q === 'How are you?', sentenceBaiduBody)
check('小写英语句子直接调用百度翻译',
  r.body?.translation === '你今天好吗？'
  && r.body?.phonetic === '/haʊ/ /ɑːr/ /juː/?'
  && fetchCalls.some(call => call.url === 'http://baidu.mock/translate')
  && fetchCalls.filter(call => call.url.includes('dictionaryapi.dev')).length === 3, r)
check('英语句子不执行整句拼写校验', r.body?.spellingStatus === 'unchecked', r.body)

fetchCalls.length = 0
r = await callOn(baiduServer, 'GET', '/api/dict?word=I%27ve%20got%20a%20dog')
check('句子部分音标失败仍继续百度整句翻译',
  r.body?.translation === '你今天好吗？'
  && r.body?.phonetic?.includes('got')
  && r.body?.phoneticStatus === 'partial'
  && r.body?.errors?.some(error => error.source === 'dictionaryapi' && error.code === 'not_found' && error.target === 'got')
  && fetchCalls.some(call => call.url === 'http://baidu.mock/translate'), r.body)

fetchCalls.length = 0
r = await callOn(baiduServer, 'POST', '/api/lists/default/words', {
  text: "I've got a dog", translation: '我有一只狗。',
})
await waitForPrefetchOn(baiduServer)
check('加入学习立即保存中文，后台只补音标且不重复调用百度',
  r.body?.ok === true && r.body.item.translation === '我有一只狗。'
  && !fetchCalls.some(call => call.url === 'http://baidu.mock/translate'), fetchCalls)
r = await callOn(baiduServer, 'GET', '/api/lists/default/words')
check('后台补音标不覆盖加入时保存的中文快照',
  r.body?.find(item => item.word === "i've got a dog")?.translation === '我有一只狗。', r.body)

fetchCalls.length = 0
r = await callOn(baiduServer, 'GET', '/api/dict?word=slow')
check('免费词典超时后仍能独立完成百度翻译',
  r.body?.translation === '你今天好吗？'
  && r.body?.errors?.some(error => error.source === 'dictionaryapi' && error.code === 'timeout')
  && fetchCalls.some(call => call.url === 'http://baidu.mock/translate'), r.body)
check('免费词典网络异常时不误判为拼写错误', r.body?.spellingStatus === 'unknown', r.body)

fetchCalls.length = 0
r = await callOn(baiduServer, 'POST', '/api/dict/batch', { words: ['How are you?'] })
check('批量查询把缺句子音标的缓存标为 incomplete',
  r.body?.incomplete?.length === 0, r.body)

// 已有中文但缺句子音标的旧缓存需要重新补齐。
const sentenceCache = readDictCache(baiduDir)
delete sentenceCache['how are you?'].phonetic
writeDictCache(baiduDir, sentenceCache)
fetchCalls.length = 0
r = await callOn(baiduServer, 'POST', '/api/dict/batch', { words: ['How are you?'] })
check('批量查询把缺句子音标的缓存标为 incomplete',
  r.body?.incomplete?.includes('how are you?'), r.body)

// 旧的 ECDICT 句子缓存也不能挡住百度翻译
const baiduCache = readDictCache(baiduDir)
baiduCache['how are you?'] = {
  word: 'how are you?', phonetic: '/old/', translation: '旧中文', senses: [],
  cachedAt: Date.now(), status: 'ok', source: 'ecdict',
}
writeDictCache(baiduDir, baiduCache)
fetchCalls.length = 0
r = await callOn(baiduServer, 'GET', '/api/dict?word=How%20are%20you%3F')
check('旧的句子缓存也会更新为百度结果',
  r.body?.translation === '你今天好吗？'
  && r.body?.phonetic === '/haʊ/ /ɑːr/ /juː/?'
  && fetchCalls.some(call => call.url === 'http://baidu.mock/translate')
  && fetchCalls.filter(call => call.url.includes('dictionaryapi.dev')).length === 3, r.body)

r = await callOn(baiduServer, 'POST', '/api/lists/default/import', {
  items: [{ text: 'kiwi' }, { text: 'How are you?' }],
})
await waitForPrefetchOn(baiduServer)
r = await callOn(baiduServer, 'GET', '/api/lists/default/words')
check('批量导入词条能同步保存中文翻译',
  r.body?.find(item => item.word === 'kiwi')?.translation === '猕猴桃'
  && r.body?.find(item => item.word === 'how are you?')?.translation === '你今天好吗？', r.body)

await new Promise(resolve => baiduServer.close(resolve))
globalThis.fetch = oldFetch
process.env.DICT_DATA_DIR = oldEnv.data
process.env.DICT_NO_NETWORK = oldEnv.noNetwork
process.env.BAIDU_TRANSLATE_API_KEY = oldEnv.key
if (oldEnv.appId === undefined) delete process.env.BAIDU_TRANSLATE_APP_ID
else process.env.BAIDU_TRANSLATE_APP_ID = oldEnv.appId
if (oldEnv.url === undefined) delete process.env.BAIDU_TRANSLATE_API_URL
else process.env.BAIDU_TRANSLATE_API_URL = oldEnv.url
if (oldEnv.timeout === undefined) delete process.env.DICT_NETWORK_TIMEOUT_MS
else process.env.DICT_NETWORK_TIMEOUT_MS = oldEnv.timeout
fs.rmSync(baiduDir, { recursive: true, force: true })

// ── 解 zip（ecdict-fetch 的零依赖解压）────────────────────────────────────

console.log('')
console.log('解压 zip')

const zipCsv = 'word,phonetic,definition,translation\nzip,zip,n. zipped,n. 压缩包\n'

/** 手搓一个最小 zip：本地文件头 + 数据 + 中央目录 + EOCD */
function makeZip(entries) {
  const parts = []
  const central = []
  let offset = 0
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8')
    const raw = Buffer.from(e.data, 'utf8')
    const comp = e.method === 8 ? zlib.deflateRawSync(raw) : raw
    const crc = typeof zlib.crc32 === 'function' ? zlib.crc32(raw) : 0
    const lfh = Buffer.alloc(30)
    lfh.writeUInt32LE(0x04034b50, 0)
    lfh.writeUInt16LE(20, 4)
    lfh.writeUInt16LE(e.method, 8)
    lfh.writeUInt32LE(crc, 14)
    lfh.writeUInt32LE(comp.length, 18)
    lfh.writeUInt32LE(raw.length, 22)
    lfh.writeUInt16LE(nameBuf.length, 26)
    parts.push(lfh, nameBuf, comp)
    const cdh = Buffer.alloc(46)
    cdh.writeUInt32LE(0x02014b50, 0)
    cdh.writeUInt16LE(20, 4)
    cdh.writeUInt16LE(20, 6)
    cdh.writeUInt16LE(e.method, 10)
    cdh.writeUInt32LE(crc, 16)
    cdh.writeUInt32LE(comp.length, 20)
    cdh.writeUInt32LE(raw.length, 24)
    cdh.writeUInt16LE(nameBuf.length, 28)
    cdh.writeUInt32LE(offset, 42)
    central.push(cdh, nameBuf)
    offset += 30 + nameBuf.length + comp.length
  }
  const cd = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([Buffer.concat(parts), cd, eocd])
}

const { unzipFirstCsv } = await import(path.join(__dirname, '../scripts/ecdict-fetch.mjs'))

const zipDeflate = path.join(dataDir, 'deflate.zip')
fs.writeFileSync(zipDeflate, makeZip([
  { name: '__MACOSX/._data.csv', data: 'junk', method: 0 },
  { name: 'readme.txt', data: 'not a csv', method: 0 },
  { name: 'data.csv', data: zipCsv, method: 8 },
]))
const unzipOut = path.join(dataDir, 'unzipped.csv')
let un = await unzipFirstCsv(zipDeflate, unzipOut)
check('解 zip 跳过 __MACOSX 和非 csv，挑出真 csv', un.name === 'data.csv', un)
check('deflate 压缩的 csv 原样还原', fs.readFileSync(unzipOut, 'utf8') === zipCsv)

const zipStored = path.join(dataDir, 'stored.zip')
const storedOut = path.join(dataDir, 'stored.csv')
fs.writeFileSync(zipStored, makeZip([{ name: 'plain.csv', data: zipCsv, method: 0 }]))
un = await unzipFirstCsv(zipStored, storedOut)
check('不压缩（store）的 csv 也能解出来', fs.readFileSync(storedOut, 'utf8') === zipCsv, un)

const notZip = path.join(dataDir, 'not-a-zip.bin')
fs.writeFileSync(notZip, Buffer.alloc(200, 7))
let zipErr = ''
try { await unzipFirstCsv(notZip, path.join(dataDir, 'never.csv')) }
catch (e) { zipErr = e.message }
check('不是 zip 就报错而不是写出半个文件',
  zipErr.includes('zip') && !fs.existsSync(path.join(dataDir, 'never.csv')), zipErr)


// ── study-lists.json -> sqlite 一次性迁移（真实数据路径）────────────────────
// 老用户第一次启动会走这条路径：老 json 必须完整搬进库、然后删掉，重启不能再跑
{
  const migrateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dict-migrate-'))
  const migrateListsFile = path.join(migrateDir, 'study-lists.json')
  fs.writeFileSync(migrateListsFile, JSON.stringify({
    lists: [
      { id: 'default', name: '默认列表', createdAt: 1789000000000,
        batchNames: { '2026-09-01': '秋词汇' },
        words: [
          { word: 'apple', type: 'word', sourceIds: ['a2-key-2020'], addedAt: 1789100000000,
            phonetic: '/æpl/', translation: 'n. 苹果', translationIds: ['noun#0'],
            customTranslations: ['自家苹果'], startedAt: 1789200000000, stage: 2,
            reviewedAt: [1789300000000, 1789350000000], lastDoneAt: 1789400000000,
            reviewScope: 'week', markCount: 3, reviewCount: 2, spellingCount: 1,
            rememberedCount: 1, forgottenCount: 1, processedReviewKeys: ['req-1', 'req-2'] },
          { word: 'a few', type: 'sentence', displayText: 'A few', sourceIds: [],
            addedAt: 1789150000000, translation: '少数几个' },
        ] },
      { id: 'list_extra', name: '额外列表', createdAt: 1789050000000,
        words: [{ word: 'grape', type: 'word', sourceIds: [], addedAt: 1789120000000 }] },
    ],
  }, null, 2), 'utf8')

  const migrated = createStudyListsStore({ dataDir: migrateDir, listsFile: migrateListsFile }).load()
  const defaultList = migrated.lists.find(l => l.id === 'default')
  const apple = defaultList.words.find(w => w.word === 'apple')
  const few = defaultList.words.find(w => w.word === 'a few')
  check('迁移：两个列表都进库且保持顺序',
    migrated.lists.length === 2 && migrated.lists[0].id === 'default'
    && migrated.lists[1].id === 'list_extra', migrated)
  check('迁移：批次名保留', defaultList.batchNames['2026-09-01'] === '秋词汇', defaultList)
  check('迁移：复习进度 / 词义快照 / 计数 / 幂等键原样往返',
    apple.phonetic === '/æpl/' && apple.translation === 'n. 苹果'
    && apple.customTranslations.join() === '自家苹果'
    && apple.startedAt === 1789200000000 && apple.stage === 2
    && apple.reviewedAt.join() === '1789300000000,1789350000000'
    && apple.lastDoneAt === 1789400000000 && apple.reviewScope === 'week'
    && apple.markCount === 3 && apple.reviewCount === 2 && apple.spellingCount === 1
    && apple.rememberedCount === 1 && apple.forgottenCount === 1
    && apple.processedReviewKeys.join() === 'req-1,req-2', apple)
  check('迁移：句子保留 displayText，词保持 word 类型',
    few.type === 'sentence' && few.displayText === 'A few' && few.translation === '少数几个'
    && apple.type === 'word' && !('displayText' in apple), few)
  check('迁移：老 json 删除并留了备份',
    !fs.existsSync(migrateListsFile)
    && fs.readdirSync(path.join(migrateDir, 'backups'))
      .some(f => f.startsWith('study-lists.before-sqlite-')))

  // 模拟重启：迁移标记已入库，不能再跑；数据必须原样还在
  const restarted = createStudyListsStore({ dataDir: migrateDir, listsFile: migrateListsFile }).load()
  const apple2 = restarted.lists.find(l => l.id === 'default').words.find(w => w.word === 'apple')
  check('迁移：二次启动幂等不重跑，数据不丢',
    restarted.lists.length === 2 && apple2.startedAt === 1789200000000
    && apple2.markCount === 3 && apple2.processedReviewKeys.join() === 'req-1,req-2'
    && !fs.existsSync(migrateListsFile), apple2)
}

// ── kv 小文档 json -> sqlite 一次性迁移（真实数据路径）──────────────────────
// 老用户的 vocab-labels / study-goal / print-batches / dict-cache 四个 json
// 第一次启动都要搬进同一个库然后删掉，重启不能再跑
{
  const kvDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dict-kv-'))
  const legacy = {
    labels: path.join(kvDir, 'vocab-labels.json'),
    goal: path.join(kvDir, 'study-goal.json'),
    prints: path.join(kvDir, 'print-batches.json'),
    dictCache: path.join(kvDir, 'dict-cache.json'),
  }
  fs.writeFileSync(legacy.labels, JSON.stringify({
    labels: { 'a2-key-2020': 'A2' }, printLabels: { 'ket': 'KET 打印' },
  }), 'utf8')
  fs.writeFileSync(legacy.goal, JSON.stringify({ libraryId: 'a2-key-2020' }), 'utf8')
  fs.writeFileSync(legacy.prints, JSON.stringify({
    batches: [{ id: 'print_1', printedAt: 1789000000000, kind: 'start', scope: 'day',
      title: '第一批', wordCount: 2,
      items: [{ listId: 'default', listName: '默认列表', word: 'apple' },
              { listId: 'default', listName: '默认列表', word: 'grape' }] }],
  }), 'utf8')
  fs.writeFileSync(legacy.dictCache, JSON.stringify({
    apple: { word: 'apple', phonetic: '/æpl/', translation: '苹果',
      senses: [{ id: 'noun#0', pos: 'noun', definition: 'a fruit' }],
      cachedAt: 1789100000000, status: 'ok', source: 'ecdict' },
    grape: { word: 'grape', phonetic: '/ɡreɪp/', translation: '葡萄',
      senses: [], cachedAt: 1789110000000, status: 'partial', source: 'api' },
  }), 'utf8')

  createKvStore({ dataDir: kvDir, legacyFiles: legacy })
  const after = createKvStore({ dataDir: kvDir, legacyFiles: legacy })
  const labels = after.get(KV_KEYS.labels, null)
  const goal = after.get(KV_KEYS.goal, null)
  const prints = after.get(KV_KEYS.prints, null)
  const cache = after.loadCacheMap()
  check('kv 迁移：标签 / 打印标签 / 目标 / 打印批次 / 词典缓存都原样进库',
    labels?.labels?.['a2-key-2020'] === 'A2' && labels?.printLabels?.['ket'] === 'KET 打印'
    && goal?.libraryId === 'a2-key-2020'
    && prints?.batches?.length === 1 && prints.batches[0].items.length === 2
    && cache.apple?.translation === '苹果' && cache.grape?.status === 'partial',
    { labels, goal, printsBatchCount: prints?.batches?.length, cacheKeys: Object.keys(cache) })
  check('kv 迁移：四个老 json 删除并留了备份',
    !fs.existsSync(legacy.labels) && !fs.existsSync(legacy.goal)
    && !fs.existsSync(legacy.prints) && !fs.existsSync(legacy.dictCache)
    && fs.readdirSync(path.join(kvDir, 'backups'))
      .filter(f => f.includes('.before-sqlite-')).length === 4,
    fs.readdirSync(path.join(kvDir, 'backups')))
  check('kv 迁移：二次启动幂等不重跑，数据不丢',
    Object.keys(after.loadCacheMap()).length === 2 && goal.libraryId === 'a2-key-2020',
    { cacheKeys: Object.keys(after.loadCacheMap()), goal })
  fs.rmSync(kvDir, { recursive: true, force: true })
}

console.log('')
console.log(pass + ' passed, ' + fail + ' failed')
fs.rmSync(dataDir, { recursive: true, force: true })
process.exit(fail === 0 ? 0 : 1)
