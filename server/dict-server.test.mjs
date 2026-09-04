/**
 * 学习列表接口自测（不占用端口，直接驱动 http.Server 的 request 事件）
 * 运行：npm run test:server
 */
import { Readable } from 'node:stream'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dict-test-'))
process.env.DICT_DATA_DIR = dataDir
process.env.DICT_SERVER_NO_LISTEN = '1'
// 测试不联网：词典查询只走本地缓存，结果才可复现
process.env.DICT_NO_NETWORK = '1'
// 本地词典产物也放到临时目录：此刻还不存在，所以前面的用例行为跟以前一样
process.env.DICT_ECDICT_DIR = path.join(dataDir, 'ecdict')

const origLog = console.log
console.log = () => {}
const { server } = await import(path.join(__dirname, 'dict-server.mjs'))
console.log = origLog

function call(method, url, body) {
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
    Promise.resolve(server.emit('request', req, res)).finally(() => { console.log = silence })
  })
}

/** 等后台补齐队列跑空，免得它在断言之后回写缓存文件 */
async function waitForPrefetch(limit) {
  for (let i = 0; i < (limit || 200); i++) {
    const state = await call('GET', '/api/dict/prefetch')
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

let r = await call('GET', '/api/lists')
check('GET /api/lists 自动创建 default', r.status === 200 && r.body.length === 1 && r.body[0].id === 'default', r.body)

r = await call('POST', '/api/lists', { name: 'IELTS' })
const newId = r.body?.id
check('新建列表', r.body?.ok === true && !!newId, r.body)

r = await call('POST', '/api/lists', { name: 'IELTS' })
check('重名列表 -> 409', r.status === 409 && r.body.ok === false, r.body)

r = await call('GET', '/api/lists')
check('现在有 2 个列表', r.body.length === 2, r.body)

r = await call('POST', '/api/lists/default/words', { text: '  ApPle ', sourceIds: ['a2-key-2020'] })
check('加词并归一化', r.body?.ok === true && r.body.item.word === 'apple' && r.body.item.type === 'word', r.body)

r = await call('POST', '/api/lists/default/words', { text: 'apple' })
check('重复词跳过', r.body?.ok === false && r.body.reason === 'already exists', r.body)

r = await call('POST', '/api/lists/default/words', { text: '  How   are  you? ' })
check('句子识别 + 空白压缩', r.body?.item?.type === 'sentence' && r.body.item.word === 'how are you?', r.body)

r = await call('POST', '/api/lists/default/words', { text: 'a few', sourceIds: ['a2-key-2020'] })
check('命中词库的短语算 word 而非句子', r.body?.item?.type === 'word', r.body)

r = await call('DELETE', '/api/lists/default/words/' + encodeURIComponent('a few'))
check('移除短语', r.body?.ok === true, r.body)

r = await call('GET', '/api/lists/default/words')
check('default 有 2 条', r.body.length === 2, r.body)

r = await call('GET', '/api/word-lists?word=APPLE')
check('查词所属列表（忽略大小写）', JSON.stringify(r.body.listIds) === '["default"]', r.body)

r = await call('POST', '/api/lists/' + newId + '/import', {
  items: [{ text: 'apple' }, { text: 'Banana', sourceIds: ['a2-key-2020'] }, { text: 'apple' }, { text: '   ' }],
})
check('批量导入 added=2 skipped=1', r.body?.added === 2 && r.body.skipped === 1, r.body)

r = await call('GET', '/api/word-lists?word=apple')
check('apple 同时属于 2 个列表', r.body.listIds.length === 2, r.body)

r = await call('DELETE', '/api/lists/default/words/apple')
check('移除单词', r.body?.ok === true, r.body)

r = await call('GET', '/api/lists/default/words')
check('default 剩 1 条', r.body.length === 1, r.body)

r = await call('DELETE', '/api/lists/default/words/' + encodeURIComponent('how are you?'))
check('移除句子（含空格/问号）', r.body?.ok === true, r.body)

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
  melon?.state === 'due' && melon.nextDueAt === startOfDayMs(threeDaysAgo) + DAY_MS, melon)
check('没开始学的词 state=new', r.body.find(w => w.word === 'lemon')?.state === 'new', r.body)

r = await call('POST', '/api/lists/' + studyId + '/review', { words: ['melon'], action: 'done' })
melon = r.body?.items?.find(w => w.word === 'melon')
check('记住了 -> 进入第 2 轮间隔',
  r.body?.updated === 1 && melon.stage === 1 && melon.nextDueAt === startOfDayMs(threeDaysAgo) + 2 * DAY_MS, melon)

r = await call('POST', '/api/lists/' + studyId + '/review', { words: ['melon'], action: 'again' })
melon = r.body?.items?.find(w => w.word === 'melon')
check('没记住 -> 轮次归零并从今天重开',
  melon?.stage === 0 && melon.state === 'scheduled' && melon.reviewedAt.length === 2, melon)

r = await call('POST', '/api/lists/' + studyId + '/review', { words: ['grape'], action: 'stop' })
check('停止学习 -> 回到 new', r.body?.items?.find(w => w.word === 'grape')?.state === 'new', r.body)

r = await call('GET', '/api/lists/' + studyId + '/words')
check('停止学习后不再落盘 startedAt', r.body.find(w => w.word === 'grape')?.startedAt === undefined, r.body)

for (let i = 0; i < 7; i++) {
  r = await call('POST', '/api/lists/' + studyId + '/review', { words: ['melon'], action: 'done' })
}
melon = r.body?.items?.find(w => w.word === 'melon')
check('走完 7 轮 -> 毕业', melon?.state === 'mastered' && melon.nextDueAt === null, melon)

r = await call('POST', '/api/lists/' + studyId + '/review', { words: ['melon'], action: 'sleep' })
check('未知复习动作 -> 400', r.status === 400, r.body)

r = await call('GET', '/api/study/plan')
check('复习计划返回 7 段间隔', r.body?.intervals?.length === 7, r.body)
check('复习计划只含正在学习的词', r.body.items.length === 1 && r.body.items[0].word === 'melon', r.body)
check('复习计划带列表名与周批次',
  r.body.items[0].listId === studyId && r.body.items[0].listName === 'Ebbinghaus'
  && typeof r.body.items[0].weekStart === 'number', r.body.items[0])

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
const weekEnd = monday + 7 * DAY_MS - 1

r = await call('POST', '/api/lists/' + weekId + '/start',
  { words: ['mango', 'papaya', 'guava'], startedAt: monday, scope: 'week' })
check('按周开始学习 3 个词', r.body?.ok === true && r.body.started === 3, r.body)

// 周一开始：第 1 / 2 / 4 天（周二 / 周三 / 周五）都落在这一周内，按周打卡一次过完
r = await call('POST', '/api/lists/' + weekId + '/review',
  { words: ['mango'], action: 'done', scope: 'week', through: weekEnd })
let mango = r.body?.items?.find(w => w.word === 'mango')
check('按周打卡把这周内排到的轮次一次过完',
  mango?.stage === 3 && mango.nextDueAt === monday + 7 * DAY_MS, mango)
check('按周连过多轮也只算一次打卡', mango?.reviewCount === 1 && mango.reviewedAt.length === 1, mango)

r = await call('POST', '/api/lists/' + weekId + '/review', { words: ['papaya'], action: 'done' })
let papaya = r.body?.items?.find(w => w.word === 'papaya')
check('按天打卡仍然只前进一轮',
  papaya?.stage === 1 && papaya.nextDueAt === monday + 2 * DAY_MS, papaya)

r = await call('POST', '/api/lists/' + weekId + '/mark', { words: ['papaya'], action: 'print', scope: 'week' })
check('打标接口只记日志', r.body?.ok === true && r.body.marked === 1, r.body)
papaya = r.body?.items?.find(w => w.word === 'papaya')
check('打标不动复习排期', papaya?.stage === 1 && papaya.nextDueAt === monday + 2 * DAY_MS, papaya)

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
  papaya?.markCount === 3 && papaya.reviewCount === 1 && papaya.marks?.length === 3
  && papaya.marks[0].action === 'start' && papaya.marks[0].scope === 'week'
  && papaya.marks[1].action === 'done' && papaya.marks[1].scope === undefined
  && papaya.marks[2].action === 'print' && papaya.marks[2].scope === 'week'
  && papaya.marks.every(m => typeof m.at === 'number'), papaya)
const guava = r.body.find(w => w.word === 'guava')
check('重开与停止各留一条打标',
  guava?.markCount === 3
  && JSON.stringify(guava.marks.map(m => m.action)) === '["start","restart","stop"]', guava)

r = await call('GET', '/api/study/plan')
const planMango = r.body?.items?.find(w => w.word === 'mango')
check('复习计划不带打标日志但保留次数',
  planMango !== undefined && planMango.marks === undefined && planMango.markCount === 2, planMango)

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

r = await call('GET', '/api/lists/' + studyId + '/words')
check('导入时选的释义已落盘',
  JSON.stringify(r.body.find(w => w.word === 'peach')?.senseIds) === '["noun#0"]', r.body)

// ── 词典缓存：音标 / 释义全集 / 抓齐与否 ───────────────────────────────────

await waitForPrefetch()

fs.writeFileSync(path.join(dataDir, 'dict-cache.json'), JSON.stringify({
  melon: { word: 'melon', phonetic: 'ˈmelən', translation: '瓜', meanings: [], cachedAt: Date.now() },
  lemon: {
    word: 'lemon', cachedAt: Date.now(),
    meanings: [{ partOfSpeech: 'noun', definitions: ['a yellow citrus fruit'], examples: ['a slice of lemon'] }],
  },
}), 'utf8')

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

const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'study-lists.json'), 'utf8'))
check('已落盘', Array.isArray(saved.lists) && saved.lists[0].id === 'default', saved)

const savedLabels = JSON.parse(fs.readFileSync(path.join(dataDir, 'vocab-labels.json'), 'utf8'))
check('标签已落盘', savedLabels.labels['b1-pet'] === 'PET', savedLabels)

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

const savedGoal = JSON.parse(fs.readFileSync(path.join(dataDir, 'study-goal.json'), 'utf8'))
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
  plum?.markCount === 2 && plum.marks[1].action === 'print'
  && plum.marks[1].at === monday && plum.marks[1].scope === 'week', plum)

r = await call('POST', '/api/print-batches', { groups: [{ listId: printListId, words: ['plum'] }] })
const printB = r.body?.batch
check('标题缺省按词数生成', printB?.title === '打印 1 词' && printB.scope === undefined, printB)

r = await call('GET', '/api/print-batches')
check('打印记录新的在前',
  r.body?.total === 2 && r.body.batches[0].id === printB?.id && r.body.batches[1].id === printA?.id, r.body)
check('打印记录带上现算的进度',
  r.body.batches[1].markableCount === 2 && r.body.batches[1].missingCount === 0
  && r.body.batches[1].items.every(i => typeof i.stage === 'number'), r.body?.batches?.[1])

r = await call('POST', '/api/print-batches/' + printA?.id + '/review', { action: 'done' })
check('整批打卡沿用打印时的按周粒度，一次过完周内轮次',
  r.body?.ok === true && r.body.updated === 2
  && r.body.items.every(i => i.stage === 3 && i.marks === undefined), r.body)
check('整批打卡回写批次上的打卡信息',
  r.body.batch?.reviewAction === 'done' && r.body.batch.reviewedCount === 2
  && r.body.batch.reviewCount === 1 && typeof r.body.batch.reviewedAt === 'number', r.body?.batch)

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

const savedPrints = JSON.parse(fs.readFileSync(path.join(dataDir, 'print-batches.json'), 'utf8'))
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
check('删记录不动词的学习进度', plum?.stage === 3, plum)

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
const cacheFile = path.join(dataDir, 'dict-cache.json')
const staleCache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'))
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
fs.writeFileSync(cacheFile, JSON.stringify(staleCache), 'utf8')

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


console.log('')
console.log(pass + ' passed, ' + fail + ' failed')
fs.rmSync(dataDir, { recursive: true, force: true })
process.exit(fail === 0 ? 0 : 1)
