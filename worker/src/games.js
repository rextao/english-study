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

/** { endlessListIds: string[] } */
export async function loadGameConfig(app) {
  const data = await app.kv.get(KV_KEYS.gameConfig, null)
  return { endlessListIds: normalizeGameListIds(data?.endlessListIds) }
}

export async function saveGameConfig(app, data) {
  await app.kv.set(KV_KEYS.gameConfig, { endlessListIds: normalizeGameListIds(data?.endlessListIds) })
}
