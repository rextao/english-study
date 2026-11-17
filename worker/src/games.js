/**
 * games.js — 单词游戏的家长配置
 *
 * 目前只有一项：无尽模式的取词范围（从哪些学习列表里抽词）。
 * 空数组 = 不限定，从全部学习列表里抽，这也是默认值。
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

/**
 * { endlessListIds: string[], endlessWords: string[] }
 * listIds 空 = 全部学习列表；words 空 = 范围内全部单词。
 * 老配置只有 listIds，读出来时 words 补空数组。
 */
export async function loadGameConfig(app) {
  const data = await app.kv.get(KV_KEYS.gameConfig, null)
  return {
    endlessListIds: normalizeGameListIds(data?.endlessListIds),
    endlessWords: normalizeGameWords(data?.endlessWords),
  }
}

export async function saveGameConfig(app, data) {
  await app.kv.set(KV_KEYS.gameConfig, {
    endlessListIds: normalizeGameListIds(data?.endlessListIds),
    endlessWords: normalizeGameWords(data?.endlessWords),
  })
}
