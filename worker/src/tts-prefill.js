/**
 * tts-prefill.js — 发音预合成队列（设置页「补充音频」）
 *
 * 学习列表里还没有 tts_cache 缓存的词 / 句子排进后台队列，逐个调 Google 合成
 * 并写回缓存，等孩子点喇叭时直接命中、不再走外网。队列状态存 D1 kv
 * （key = tts-prefill-state），执行走 app.waitUntil（平台给 waitUntil 约 30s
 * 存活窗口，按限速能跑几十个；没跑完的留在队列里，下次补充续上）。
 *
 * 进度字段形状与 prefetch.js 完全一致（total/done/failed/pending/running/finished），
 * 前端轮询逻辑照抄。
 */

import { synthesizeSpeech, MAX_TTS_TEXT_LENGTH } from './tts.js'
import { normalizeText } from './text.js'
import { KV_KEYS } from './kv.js'

/** Google 合成按次计费且上游有限流，串行 + 限速，避免一次补充压垮配额 */
const TTS_PREFILL_CONCURRENCY = 1
const TTS_PREFILL_PACE_MS = 250
/**
 * 单次执行最多跑多久：平台给 waitUntil 约 30s 存活窗口，跑满会被直接回收，
 * 所以在窗口用完前主动收手，把没跑完的部分干净地交回队列。
 */
const TTS_PREFILL_MAX_RUN_MS = 22_000
/**
 * 执行租约：跑一轮的 isolate 每次取任务都续期。isolate 被平台回收后租约自然过期，
 * 轮询接口（GET）看到「队列非空且没人持有租约」就重新启动执行循环——
 * 否则前端会永远停在「补充中」，只能刷新页面重来。
 */
const TTS_PREFILL_LEASE_MS = 25_000

const EMPTY_STATE = {
  queue: [], total: 0, done: 0, failed: 0, errors: [],
  leaseUntil: 0, leaseOwner: '', inflight: null,
}

/** 日志里的文本只留一段，避免整句内容刷屏 */
function previewText(value, limit = 120) {
  const text = String(value ?? '')
  return text.length > limit ? text.slice(0, limit) + '…' : text
}

async function readState(app) {
  const state = await app.kv.get(KV_KEYS.ttsPrefill, null)
  if (!state || !Array.isArray(state.queue)) return { ...EMPTY_STATE, queue: [] }
  return {
    queue: state.queue.filter(item => item !== null && typeof item === 'object' && typeof item.text === 'string'),
    total: Number(state.total) || 0,
    done: Number(state.done) || 0,
    failed: Number(state.failed) || 0,
    errors: Array.isArray(state.errors) ? state.errors.slice(-20) : [],
    leaseUntil: Number(state.leaseUntil) || 0,
    leaseOwner: typeof state.leaseOwner === 'string' ? state.leaseOwner : '',
    // 正在合成的那一条：留在盘上，isolate 被回收后还能放回队列重跑
    inflight: state.inflight !== null && typeof state.inflight === 'object'
      && typeof state.inflight.text === 'string' ? { text: state.inflight.text } : null,
  }
}

/** 租约还有效 = 另一次执行循环正在跑这批任务 */
function leaseActive(state) {
  return Number(state.leaseUntil) > Date.now()
}

async function writeState(app, state) {
  await app.kv.set(KV_KEYS.ttsPrefill, state)
}

/**
 * 对外进度。
 * finished 只看「还有没有活」：队列空、也没有在途的那一条，就算跑完了。
 * 不能把 running（isolate 内存标记 / 租约）算进来——那个值只要有一点残留，
 * 前端就会永远轮询下去；租约只用来决定「要不要重新点火」，不参与完成判定。
 */
export function ttsPrefillState(state, running) {
  return {
    total: state.total,
    done: state.done,
    failed: state.failed,
    errors: state.errors,
    pending: state.queue.length + (state.inflight ? 1 : 0),
    running: running ? 1 : 0,
    finished: state.queue.length === 0 && !state.inflight,
  }
}

function sleep(ms) { return new Promise(go => setTimeout(go, ms)) }

/** isolate 内的活任务标记：避免同一 isolate 重复跑同一批文本 */
let runningTasks = 0

/** 这一轮执行的标识：收尾时只有租约还是自己的才清掉，别把别人的执行踢下线 */
function newRunId() {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : String(Date.now()) + '-' + Math.random().toString(16).slice(2)
}

/** 每次落盘都续一次租约，让轮询接口知道队列还有人管 */
function renewLease(state, runId) {
  state.leaseUntil = Date.now() + TTS_PREFILL_LEASE_MS
  state.leaseOwner = runId
  return state
}

/**
 * 租约已经过期却还挂着在途任务 = 上一次执行被平台回收在半路，
 * 把那条放回队头，不然这个词永远补不上。
 */
async function recoverInflight(app, state) {
  if (!state.inflight || leaseActive(state)) return state
  state.queue.unshift(state.inflight)
  state.inflight = null
  await writeState(app, state)
  return state
}

/** 实际执行队列；由 enqueue / 轮询续跑通过 app.waitUntil 启动，也在测试里直接 await */
export async function runTtsQueue(app) {
  runningTasks++
  const runId = newRunId()
  const startedAt = Date.now()
  try {
    while (true) {
      // waitUntil 窗口用掉之前主动停下；剩下的留在队列里，下一次轮询接着跑
      if (Date.now() - startedAt > TTS_PREFILL_MAX_RUN_MS) break
      // 先「认领」：把队头弹出并立刻写回，缩小两个执行循环撞车的窗口
      const claimed = await readState(app)
      if (claimed.queue.length === 0) break
      const job = claimed.queue.shift()
      // 取出来的这条同时记成在途，页面看 pending 不会提前归零，isolate 被杀也能找回
      claimed.inflight = job
      await writeState(app, renewLease(claimed, runId))

      try {
        const result = await synthesizeSpeech(app, job.text)
        if (result.status !== 200) {
          const message = result?.body && typeof result.body === 'object' && typeof result.body.error === 'string'
            ? result.body.error
            : 'HTTP ' + result.status
          throw new Error(message)
        }
      } catch (e) {
        const failedState = await readState(app)
        failedState.inflight = null
        failedState.failed++
        failedState.errors.push({ word: job.text, message: e?.message || '合成失败' })
        failedState.errors = failedState.errors.slice(-20)
        await writeState(app, renewLease(failedState, runId))
        console.warn('[tts-prefill]', previewText(job.text), e?.message)
      }
      // done 计数在长耗时合成完成后基于最新状态累加，别把并行的进度覆盖掉
      const state = await readState(app)
      state.inflight = null
      state.done++
      await writeState(app, renewLease(state, runId))
      if (TTS_PREFILL_PACE_MS > 0) await sleep(TTS_PREFILL_PACE_MS)
    }
  } finally {
    runningTasks--
    // 正常收手就把租约放开，下一次轮询立刻接上；
    // isolate 被平台回收时这段不会执行，靠租约过期自动放开。
    try {
      const state = await readState(app)
      if (state.leaseOwner === runId) {
        state.leaseUntil = 0
        state.leaseOwner = ''
        await writeState(app, state)
      }
    } catch {
      // 收尾失败不影响队列本身，租约到期后照样能续跑
    }
  }
}

/**
 * 把文本排进预合成队列。已在本轮队列里的不重复排；新一轮开始（上一轮跑完）时
 * 计数归零，前端进度条从 0 开始。返回真正入队的数量。
 */
export async function enqueueTtsPrefill(texts, app) {
  const list = (Array.isArray(texts) ? texts : [])
    .map(text => normalizeText(text))
    .filter(text => text.length > 0 && text.length <= MAX_TTS_TEXT_LENGTH)
  let state = await readState(app)
  if (runningTasks === 0) state = await recoverInflight(app, state)
  const idle = state.queue.length === 0 && !state.inflight && runningTasks === 0
  if (idle) {
    state.total = 0
    state.done = 0
    state.failed = 0
    state.errors = []
  }
  const known = new Set(state.queue.map(item => item.text))
  let queued = 0
  for (const text of list) {
    if (known.has(text)) continue
    known.add(text)
    state.queue.push({ text })
    state.total++
    queued++
  }
  await writeState(app, state)
  if (state.queue.length > 0 && runningTasks < TTS_PREFILL_CONCURRENCY && !leaseActive(state)) {
    // waitUntil 由 app 注入：生产环境接 ctx.waitUntil，测试环境收进数组由测试驱动
    app.waitUntil(runTtsQueue(app))
  }
  return queued
}

/**
 * 当前进度（GET /api/tts/prefill）。
 * resume=true 时顺手续跑：队列里还有任务、却没有任何 isolate 持有租约（上一次执行
 * 被平台回收在半路），就当场重新启动执行循环，前端不用刷新页面才能继续补充。
 */
export async function currentTtsPrefillState(app, { resume = false } = {}) {
  let state = await readState(app)
  const busyHere = runningTasks > 0
  if (resume && !busyHere && !leaseActive(state)) {
    state = await recoverInflight(app, state)
    if (state.queue.length > 0) app.waitUntil(runTtsQueue(app))
  }
  return ttsPrefillState(state, busyHere || leaseActive(state))
}
