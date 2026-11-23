/**
 * games.js — 单词游戏的家长配置
 *
 * 两项：
 * 1. 无尽模式 / 闯关模式的取词范围（从哪些学习列表里抽词），空数组 = 不限定，从全部学习列表里抽。
 * 2. 闯关模式的关卡数与每关单词数，默认 3 关 × 20 词。
 * 存在 kv 表里（与学习目标同一套小文档 store），换设备也能读到。
 */

import { KV_KEYS } from './kv.js'

/** 一次最多记多少个学习列表，防止脏数据无限长 */
export const MAX_GAME_LIST_IDS = 200
/** 单个列表 id 的长度上限 */
export const MAX_GAME_LIST_ID_LENGTH = 120
/** 取词范围最多锁定多少个具体单词 */
export const MAX_GAME_WORDS = 1000
/** 单个单词 / 句子的长度上限，与学习列表词条同一量级 */
export const MAX_GAME_WORD_LENGTH = 160

/** 闯关模式的默认关卡数与每关单词数 */
export const DEFAULT_CHALLENGE_LEVELS = 3
export const DEFAULT_CHALLENGE_WORDS_PER_LEVEL = 20
/** 关卡数 / 每关单词数的上下限 */
export const MAX_CHALLENGE_LEVELS = 10
export const MIN_CHALLENGE_WORDS_PER_LEVEL = 3
export const MAX_CHALLENGE_WORDS_PER_LEVEL = 50

/** 去空白、去重、截断超长 id；非数组一律当「不限定」 */
export function normalizeGameListIds(input) {
  if (!Array.isArray(input)) return []
  const out = []
  for (const raw of input) {
    const id = String(raw ?? '').trim()
    if (!id || id.length > MAX_GAME_LIST_ID_LENGTH || out.includes(id)) continue
    out.push(id)
    if (out.length >= MAX_GAME_LIST_IDS) break
  }
  return out
}

/** 具体单词：去空白、按小写去重（保留第一次的写法）、截断超长文本 */
export function normalizeGameWords(input) {
  if (!Array.isArray(input)) return []
  const out = []
  const seen = new Set()
  for (const raw of input) {
    const word = String(raw ?? '').trim()
    if (!word || word.length > MAX_GAME_WORD_LENGTH) continue
    const key = word.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(word)
    if (out.length >= MAX_GAME_WORDS) break
  }
  return out
}

/** 整数开关卡范围：非法值退回默认值，超界夹到上下限 */
function clampInt(value, fallback, min, max) {
  const num = Math.floor(Number(value))
  if (!Number.isFinite(num)) return fallback
  return Math.min(max, Math.max(min, num))
}

export function normalizeChallengeLevels(input) {
  return clampInt(input, DEFAULT_CHALLENGE_LEVELS, 1, MAX_CHALLENGE_LEVELS)
}

export function normalizeChallengeWordsPerLevel(input) {
  return clampInt(input, DEFAULT_CHALLENGE_WORDS_PER_LEVEL, MIN_CHALLENGE_WORDS_PER_LEVEL, MAX_CHALLENGE_WORDS_PER_LEVEL)
}

/**
 * { endlessListIds, endlessWords, challengeLevels, challengeWordsPerLevel }
 * listIds 空 = 全部学习列表；words 空 = 范围内全部单词。
 * 老配置没有闯关字段，读出来时补默认值（3 关 × 20 词）。
 */
export async function loadGameConfig(app) {
  const data = await app.kv.get(KV_KEYS.gameConfig, null)
  return {
    endlessListIds: normalizeGameListIds(data?.endlessListIds),
    endlessWords: normalizeGameWords(data?.endlessWords),
    challengeLevels: normalizeChallengeLevels(data?.challengeLevels),
    challengeWordsPerLevel: normalizeChallengeWordsPerLevel(data?.challengeWordsPerLevel),
  }
}

export async function saveGameConfig(app, data) {
  await app.kv.set(KV_KEYS.gameConfig, {
    endlessListIds: normalizeGameListIds(data?.endlessListIds),
    endlessWords: normalizeGameWords(data?.endlessWords),
    challengeLevels: normalizeChallengeLevels(data?.challengeLevels),
    challengeWordsPerLevel: normalizeChallengeWordsPerLevel(data?.challengeWordsPerLevel),
  })
}
