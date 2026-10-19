/**
 * prefetch.js — 后台补齐队列（Workers 版）
 *
 * 本地版是进程内的内存队列 + 常驻 worker 协程；Workers 没有常驻进程，
 * 队列状态改存 D1 kv 表（key = prefetch-state），实际执行用 ctx.waitUntil()
 * 在响应返回后继续跑（平台给 waitUntil 约 30s 的存活窗口，按 250ms 限速
 * 约能补 100 个真打网络的词；没跑完的部分留在队列里，下次 repair 续上）。
 *
 * 进度字段的形状和本地版完全一致（total/done/failed/pending/running/finished），
 * 前端轮询逻辑不变。
 */

import { normalizeText } from './text.js'
import { resolveEntry, resolvePhoneticOnly, isSentence, getCacheEntry } from './dict.js'
import { syncListTranslation, syncListPhonetic } from './lists.js'
import { KV_KEYS } from './kv.js'

/** 外部词典和百度翻译接口都可能有限流，慢点跑避免触发限制 */
export const PREFETCH_CONCURRENCY = 2
export const PREFETCH_PACE_MS = 250

const EMPTY_STATE = { queue: [], total: 0, done: 0, failed: 0, errors: [] }

async function readState(app) {
  const state = await app.kv.get(KV_KEYS.prefetch, null)
  if (!state || !Array.isArray(state.queue)) return { ...EMPTY_STATE, queue: [] }
  return {
    queue: state.queue.filter(item => (
      typeof item === 'string'
      || (item !== null && typeof item === 'object' && typeof item.word === 'string')
    )),
    total: Number(state.total) || 0,
    done: Number(state.done) || 0,
    failed: Number(state.failed) || 0,
    errors: Array.isArray(state.errors) ? state.errors.slice(-20) : [],
  }
}

async function writeState(app, state) {
  await app.kv.set(KV_KEYS.prefetch, state)
}

/** 对外进度：running 用 isolate 内的活任务标记，跨 isolate 不保证精确（队列词幂等，无碍） */
export function prefetchState(state, running) {
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

/** 缓存里没有、或者上次没抓齐的词才值得再跑一次 */
async function needsFetch(word, force, app) {
  if (force) return true
  const entry = await getCacheEntry(word, app)
  if (isSentence(word) && (entry?.translationSource !== 'baidu' || !entry?.phonetic
    || entry?.phoneticStatus === 'partial' || entry?.translationStatus !== 'ok')) return true
  return !entry || entry.status !== 'ok'
}

function sleep(ms) { return new Promise(go => setTimeout(go, ms)) }

/**
 * isolate 内的活任务标记：同一 isolate 里的并发请求共用一个执行循环，
 * 避免同一批词被同一个 isolate 重复跑。
 */
let runningTasks = 0

/** 实际执行队列；由 enqueue 通过 app.waitUntil 启动，也在测试里直接 await */
export async function runQueue(app) {
  runningTasks++
  try {
    while (true) {
      // 先「认领」：把队头弹出并立刻写回，缩小两个执行循环撞车的窗口
      const claimed = await readState(app)
      if (claimed.queue.length === 0) break
      const job = typeof claimed.queue[0] === 'object' && claimed.queue[0] !== null
        ? claimed.queue[0]
        : { word: claimed.queue[0] }
      claimed.queue.shift()
      await writeState(app, claimed)

      let network = false
      try {
        const cached = job.fullChain ? await getCacheEntry(job.word, app) : null
        const resolved = job.fullChain && cached?.phonetic && cached.phoneticStatus !== 'partial'
          ? { entry: cached, network: false }
          : job.fullChain
            ? await resolveEntry(job.word, true, app)
            : job.phoneticOnly
              ? await resolvePhoneticOnly(job.word, app)
              : await resolveEntry(job.word, job.force === true, app)
        network = resolved.network
        if (job.fullChain) {
          if (resolved.entry.phoneticStatus === 'complete' && resolved.entry.phonetic) {
            await syncListPhonetic(job.word, resolved.entry, app)
          }
          // 完整执行查词链路，但只给学习列表补缺失字段，不覆盖用户已保存的中文释义。
          await syncListTranslation(job.word, resolved.entry, app)
          if (Array.isArray(resolved.entry.errors) && resolved.entry.errors.length > 0) {
            const details = resolved.entry.errors.map(error => {
              const target = error.target ? `（${error.target}）` : ''
              return `${error.source}${target}：${error.message}`
            }).join('；')
            throw new Error(details || '查词链路返回错误')
          }
          if (resolved.entry.phoneticStatus !== 'complete' || !resolved.entry.phonetic) {
            throw new Error('未获得完整音标')
          }
        } else if (job.phoneticOnly) {
          await syncListPhonetic(job.word, resolved.entry, app)
        } else {
          await syncListTranslation(job.word, resolved.entry, app)
        }
      } catch (e) {
        const failedState = await readState(app)
        failedState.failed++
        failedState.errors.push({ word: job.word, message: e?.message || '补充失败' })
        failedState.errors = failedState.errors.slice(-20)
        await writeState(app, failedState)
        console.warn('[prefetch]', job.word, e.message)
      }
      // done 计数在长耗时处理完成后基于最新状态累加，别把并行的进度覆盖掉
      const state = await readState(app)
      state.done++
      await writeState(app, state)
      // 只有真打了外部接口才需要限速
      if (network && PREFETCH_PACE_MS > 0) await sleep(PREFETCH_PACE_MS)
    }
  } finally {
    runningTasks--
  }
}

async function enqueueJobs(app, jobs, { resetWhenIdle = true } = {}) {
  const state = await readState(app)
  const idle = state.queue.length === 0 && runningTasks === 0
  if (idle && resetWhenIdle) {
    // 上一轮跑完了就把计数归零，前端进度条从 0 开始
    state.total = 0
    state.done = 0
    state.failed = 0
    state.errors = []
  }
  const known = new Set(state.queue.map(item => (typeof item === 'object' && item !== null ? item.word : item)))
  let queued = 0
  for (const job of jobs) {
    const word = normalizeText(job.word)
    if (!word || known.has(word)) continue
    // 音标专用任务还要把已有词典缓存同步回 list_words，不能被 status=ok 短路。
    if (!job.phoneticOnly && !job.fullChain && !await needsFetch(word, job.force === true, app)) continue
    known.add(word)
    state.queue.push({
      word,
      force: job.force === true,
      phoneticOnly: job.phoneticOnly === true,
      fullChain: job.fullChain === true,
    })
    state.total++
    queued++
  }
  await writeState(app, state)
  if (state.queue.length > 0 && runningTasks < PREFETCH_CONCURRENCY) {
    // waitUntil 由 app 注入：生产环境接 ctx.waitUntil，测试环境收进数组由测试驱动
    app.waitUntil(runQueue(app))
  }
  return queued
}

/** 把词排进补齐队列，返回真正入队的数量 */
export async function enqueuePrefetch(words, force, app) {
  const jobs = (Array.isArray(words) ? words : []).map(word => ({ word, force: force === true }))
  return enqueueJobs(app, jobs)
}

/** 只把缺失 / 不完整音标排进后台，不触发中文翻译。 */
export async function enqueuePhoneticPrefetch(words, app) {
  const jobs = (Array.isArray(words) ? words : []).map(word => ({ word, phoneticOnly: true }))
  return enqueueJobs(app, jobs)
}

/** 设置页使用完整查词链路，但学习列表只同步缺失字段。 */
export async function enqueueFullPhoneticPrefetch(words, app) {
  const jobs = (Array.isArray(words) ? words : []).map(word => ({ word, fullChain: true }))
  return enqueueJobs(app, jobs)
}

/** 当前进度（GET /api/dict/prefetch） */
export async function currentPrefetchState(app) {
  const state = await readState(app)
  return prefetchState(state, runningTasks > 0)
}

/** 测试辅助：等队列跑空（本地版 waitForPrefetch 的对等物） */
export async function waitForIdle(app, limit = 200) {
  for (let i = 0; i < limit; i++) {
    const state = await currentPrefetchState(app)
    if (state.finished) return state
    await sleep(10)
  }
  return null
}
