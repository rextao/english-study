/**
 * review.js — 艾宾浩斯复习算法（从 dict-server.mjs 原样移植）
 *
 * 与本地版唯一的语义差异：startOfDay / startOfWeek 按配置的时区偏移取 0 点——
 * Worker 的进程时区是 UTC，直接取 0 点会让「今天该复习」在北京时间早上 8 点才翻转。
 * 默认偏移 +8（Asia/Shanghai，无夏令时），和原本地版（用户机器时区）行为一致；
 * 可用环境变量 DICT_TZ_OFFSET_HOURS 调整。
 */

export const DAY = 86400000

/** 复习节奏（天）：首次打卡后第 1 / 2 / 4 / 7 / 15 / 30 / 60 天各复习一次 */
export const REVIEW_INTERVALS = [1, 2, 4, 7, 15, 30, 60]

/** 复习请求幂等键保留窗口，覆盖网络重试但避免学习列表无限增长。 */
export const MAX_REVIEW_KEYS = 80
/** 只记打标、不动复习排期的动作 */
export const PURE_MARK_ACTIONS = new Set(['print', 'spelling', 'reading'])
/** 复习打卡动作：done 推进一轮；tally 只计熟悉度，不动排期 */
export const REVIEW_ACTIONS = new Set(['done', 'again', 'stop', 'tally'])
/** 熟悉度计数维度：tally 打卡时必传其一，只累计次数 */
export const TALLY_KINDS = new Set(['spelling', 'reading', 'meaning'])
/** 打标粒度：按天 / 按周 */
export const MARK_SCOPES = new Set(['day', 'week'])

function tzOffsetMs(env) {
  const hours = Number(env?.DICT_TZ_OFFSET_HOURS)
  return (Number.isFinite(hours) ? hours : 8) * 3600000
}

/** 配置时区下的当天 0 点。到期与否按「天」判断，同一天内的小时差不影响结果。 */
export function startOfDay(ts, env) {
  const offset = tzOffsetMs(env)
  const shifted = new Date(Number(ts) + offset)
  shifted.setUTCHours(0, 0, 0, 0)
  return shifted.getTime() - offset
}

/** 配置时区下所在周的周一 0 点，用于把长期复习计划按周分批 */
export function startOfWeek(ts, env) {
  const day = startOfDay(ts, env)
  const weekday = (new Date(day + tzOffsetMs(env)).getUTCDay() + 6) % 7
  return day - weekday * DAY
}

/** 打标粒度校验，非法值当没传 */
export function normalizeScope(input) {
  const scope = String(input ?? '')
  return MARK_SCOPES.has(scope) ? scope : undefined
}

/**
 * 记一次打标：只累加 markCount 这个去规范化的总次数。
 * 打标日志（时间 / 动作 / 粒度 / 轮次）由事件表保存，词条上不留 marks 镜像。
 */
export function pushMark(item, action, at, extra) {
  item.markCount = (Number(item.markCount) || 0) + 1
}

/** 去掉残留的 marks 副本：老数据落盘后可能还带着，响应里不往外吐 */
export function withoutMarks(item) {
  const out = Object.assign({}, item)
  delete out.marks
  return out
}

/** 兼容旧数据：缺失、非法或负数计数都按 0。 */
export function countOf(value) {
  const count = Number(value)
  return Number.isFinite(count) && count >= 0 ? Math.floor(count) : 0
}

export function hasReviewKey(item, key) {
  return Boolean(key)
    && Array.isArray(item.processedReviewKeys)
    && item.processedReviewKeys.includes(key)
}

export function rememberReviewKey(item, key) {
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
export function nextDueAt(item, env) {
  if (!item.startedAt) return null
  const stage = item.stage || 0
  if (stage > REVIEW_INTERVALS.length) return null
  if (stage === 0) return startOfDay(item.startedAt, env)
  if (item.reviewScope === 'week') {
    // 按周模式：一次复习管一周，下次排到下周一；同一周内多次 done 也只钉在下周一
    return startOfWeek(item.lastDoneAt ?? item.startedAt, env) + 7 * DAY
  }
  return startOfDay(item.lastDoneAt ?? item.startedAt, env) + REVIEW_INTERVALS[stage - 1] * DAY
}

/** new 未开始 / due 今天该复习 / scheduled 已排期 / mastered 已毕业 */
export function studyState(item, now, env) {
  if (!item.startedAt) return 'new'
  if ((item.stage || 0) > REVIEW_INTERVALS.length) return 'mastered'
  return nextDueAt(item, env) <= startOfDay(now, env) ? 'due' : 'scheduled'
}

/** 词条 + 派生的复习信息，前端不用自己算日期 */
export function enrichItem(item, now, env) {
  return Object.assign({}, item, {
    reviewCount: countOf(item.reviewCount),
    spellingCount: countOf(item.spellingCount),
    readingCount: countOf(item.readingCount),
    rememberedCount: countOf(item.rememberedCount),
    forgottenCount: countOf(item.forgottenCount),
    nextDueAt: nextDueAt(item, env),
    state: studyState(item, now, env),
  })
}

/**
 * 复习打卡的唯一实现：列表打卡和按打印批次整批打卡都走这里，语义只有一份。
 * targets 是归一化后的词集合；tally 只累计熟悉度，done/again 才动轮次和排期。
 * 只改内存里的 list，落盘由调用方负责。
 *
 * 与本地版的差异：事件落库（opts.onEvent）从同步改成收集后统一 await——
 * D1 写入是异步的，但事件表和 list_words 之间没有外键约束，先后顺序不影响结果。
 */
export async function applyReview(list, targets, action, options, app) {
  const opts    = options || {}
  const env     = app.env
  const now     = Number(opts.now) || Date.now()
  const scope   = normalizeScope(opts.scope)
  const successKind = TALLY_KINDS.has(opts.successKind) ? opts.successKind : undefined
  const requestIds = opts.requestIds instanceof Map ? opts.requestIds : new Map()
  let updated = 0
  const items = []
  const events = []
  for (const item of list.words) {
    if (!targets.has(item.word)) continue
    const requestId = requestIds.get(item.word)
    if (hasReviewKey(item, requestId) || (requestId && opts.hasRequest && await opts.hasRequest(requestId))) {
      items.push(enrichItem(item, now, env))
      continue
    }
    if (action === 'tally') {
      // 会拼 / 会读 / 知意：只累计对应维度的次数，轮次和排期都不动
      if (successKind === 'spelling') item.spellingCount = countOf(item.spellingCount) + 1
      else if (successKind === 'reading') item.readingCount = countOf(item.readingCount) + 1
      else if (successKind === 'meaning') item.rememberedCount = countOf(item.rememberedCount) + 1
      else { items.push(enrichItem(item, now, env)); continue }
      pushMark(item, successKind, now, { scope, stage: item.stage })
      events.push({ item, action: successKind, at: now, scope, stage: item.stage, requestId })
      rememberReviewKey(item, requestId)
      updated++
    } else if (action === 'stop') {
      delete item.startedAt
      delete item.stage
      delete item.reviewedAt
      delete item.lastDoneAt
      delete item.reviewScope
      pushMark(item, 'stop', now, { scope })
      events.push({ item, action: 'stop', at: now, scope, stage: undefined, requestId })
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
      events.push({
        item, action, at: now, scope,
        stage: item.stage, requestId,
      })
      rememberReviewKey(item, requestId)
      updated++
    }
    items.push(enrichItem(item, now, env))
  }
  for (const event of events) await opts.onEvent?.(event)
  return { updated, items }
}
