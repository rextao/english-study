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

const EMPTY_STATE = { queue: [], total: 0, done: 0, failed: 0, errors: [] }

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
  }
}

async function writeState(app, state) {
  await app.kv.set(KV_KEYS.ttsPrefill, state)
}

/** 对外进度：running 用 isolate 内的活任务标记，跨 isolate 不保证精确（队列幂等，无碍） */
export function ttsPrefillState(state, running) {
  return {
    total: state.total,
    done: state.done,
    failed: state.failed,
    errors: state.errors,
    pending: state.queue.length,
    running: running ? 1 : 0,
    finished: state.queue.length === 0 && !running,
  }
}

function sleep(ms) { return new Promise(go => setTimeout(go, ms)) }

/** isolate 内的活任务标记：避免同一 isolate 重复跑同一批文本 */
let runningTasks = 0

/** 实际执行队列；由 enqueue 通过 app.waitUntil 启动，也在测试里直接 await */
export async function runTtsQueue(app) {
  runningTasks++
  try {
    while (true) {
      // 先「认领」：把队头弹出并立刻写回，缩小两个执行循环撞车的窗口
      const claimed = await readState(app)
      if (claimed.queue.length === 0) break
      const job = claimed.queue.shift()
      await writeState(app, claimed)

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
        failedState.failed++
        failedState.errors.push({ word: job.text, message: e?.message || '合成失败' })
        failedState.errors = failedState.errors.slice(-20)
        await writeState(app, failedState)
        console.warn('[tts-prefill]', previewText(job.text), e?.message)
      }
      // done 计数在长耗时合成完成后基于最新状态累加，别把并行的进度覆盖掉
      const state = await readState(app)
      state.done++
      await writeState(app, state)
      if (TTS_PREFILL_PACE_MS > 0) await sleep(TTS_PREFILL_PACE_MS)
    }
  } finally {
    runningTasks--
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
  const state = await readState(app)
  const idle = state.queue.length === 0 && runningTasks === 0
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
  if (state.queue.length > 0 && runningTasks < TTS_PREFILL_CONCURRENCY) {
    // waitUntil 由 app 注入：生产环境接 ctx.waitUntil，测试环境收进数组由测试驱动
    app.waitUntil(runTtsQueue(app))
  }
  return queued
}

/** 当前进度（GET /api/tts/prefill） */
export async function currentTtsPrefillState(app) {
  const state = await readState(app)
  return ttsPrefillState(state, runningTasks > 0)
}
