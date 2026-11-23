/**
 * game-results.js — 单词游戏的错词 / 配对统计（所有游戏共用的统一能力）。
 *
 * 游戏组件在配对成功或配错时按单词上报，外壳攒一小批后 POST /api/games/results，
 * 这里落到 D1 的 game_word_results；设置页「游戏记录」再用 GET /api/games/results
 * 按天 + 单词聚合读出来，看清哪天哪些词出过错、对过几次。
 *
 * 写的是行级 INSERT（一次一批），不做整表读写；按天分桶用的是复习计划同一套时区，
 * 所以「今天」和复习计划里的今天一致。
 */

import { DAY, startOfDay, tzOffsetMs } from './review.js'

/** 只接受这两种结果：配对 / 判定正确、配错 / 失误 */
export const GAME_WORD_OUTCOMES = new Set(['correct', 'wrong'])
/** 一次上报最多多少条（外壳按 1.5 秒一批，正常远小于这个数） */
export const MAX_GAME_RESULT_ITEMS = 200
export const MAX_GAME_RESULT_GAME_ID = 64
export const MAX_GAME_RESULT_MODE = 32
export const MAX_GAME_RESULT_WORD = 160
export const MAX_GAME_RESULT_TRANSLATION = 400
export const DEFAULT_GAME_RESULT_DAYS = 30
export const MAX_GAME_RESULT_DAYS = 180
/** 一次最多返回多少条「天 + 单词」聚合结果，防止历史长了以后一次读太多 */
const MAX_SUMMARY_ROWS = 1500

function badRequest(message, code) {
  const error = new Error(message)
  if (code) error.code = code
  return error
}

/** 配置时区下的日期串（YYYY-MM-DD） */
function dayKey(ts, env) {
  const shifted = new Date(startOfDay(ts, env) + tzOffsetMs(env))
  return shifted.toISOString().slice(0, 10)
}

export function createGameResultStore(db) {
  /** 批量记录一次游戏里的配对结果；非法条目直接跳过，一条都没有就报错 */
  async function save({ gameId, mode, results, now = Date.now(), env = null }) {
    const game = String(gameId ?? '').trim()
    if (!game || game.length > MAX_GAME_RESULT_GAME_ID) {
      throw badRequest('游戏标识无效', 'GAME_RESULT_GAME_ID')
    }
    const modeText = String(mode ?? '').trim() || 'normal'
    if (modeText.length > MAX_GAME_RESULT_MODE) {
      throw badRequest('游戏模式无效', 'GAME_RESULT_MODE')
    }
    if (!Array.isArray(results)) throw badRequest('results 必须是数组', 'GAME_RESULT_ITEMS')
    if (results.length === 0) throw badRequest('没有要记录的结果', 'GAME_RESULT_EMPTY')
    if (results.length > MAX_GAME_RESULT_ITEMS) {
      throw badRequest('一次最多上报 ' + MAX_GAME_RESULT_ITEMS + ' 条结果', 'GAME_RESULT_TOO_MANY')
    }

    const at = Number(now) || Date.now()
    const day = dayKey(at, env)
    const statements = []
    for (const raw of results) {
      const word = String(raw?.word ?? '').trim()
      if (!word || word.length > MAX_GAME_RESULT_WORD) continue
      const outcome = String(raw?.outcome ?? '')
      if (!GAME_WORD_OUTCOMES.has(outcome)) continue
      const translation = String(raw?.translation ?? '').trim().slice(0, MAX_GAME_RESULT_TRANSLATION)
      statements.push([
        `INSERT INTO game_word_results (day, game_id, mode, word, display, translation, outcome, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        day, game, modeText, word.toLowerCase(), word, translation || null, outcome, at,
      ])
    }
    if (statements.length === 0) throw badRequest('没有有效的游戏结果', 'GAME_RESULT_INVALID')
    await db.batch(statements)
    return { recorded: statements.length, day }
  }

  /** 最近 days 天按「日期 + 单词」聚合：每个词对了几次、错了几次、哪几个游戏里出过 */
  async function summary({ days, now = Date.now(), env = null } = {}) {
    const asked = Number(days)
    const window = Number.isFinite(asked) && asked > 0
      ? Math.min(Math.floor(asked), MAX_GAME_RESULT_DAYS)
      : DEFAULT_GAME_RESULT_DAYS
    const since = startOfDay(Number(now) || Date.now(), env) - (window - 1) * DAY
    const rows = await db.all(
      `SELECT day, word,
              MAX(display) AS display,
              MAX(translation) AS translation,
              SUM(CASE WHEN outcome = 'correct' THEN 1 ELSE 0 END) AS correct_count,
              SUM(CASE WHEN outcome = 'wrong' THEN 1 ELSE 0 END) AS wrong_count,
              MAX(created_at) AS last_at,
              GROUP_CONCAT(DISTINCT game_id) AS games
       FROM game_word_results
       WHERE created_at >= ?
       GROUP BY day, word
       ORDER BY day DESC, wrong_count DESC, last_at DESC
       LIMIT ?`,
      since, MAX_SUMMARY_ROWS,
    )
    return rows.map(row => ({
      day: row.day,
      word: row.word,
      display: row.display,
      translation: row.translation ?? '',
      correct: Number(row.correct_count || 0),
      wrong: Number(row.wrong_count || 0),
      lastAt: Number(row.last_at || 0),
      games: String(row.games || '').split(',').filter(Boolean),
    }))
  }

  return { save, summary }
}
