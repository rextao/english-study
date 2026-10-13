/**
 * text.js — 文本归一化
 *
 * 从 server/text.mjs 原样移植：normalizeText 是全库唯一的主键规则，
 * 词典缓存、学习列表、事件日志全靠它对齐；改它必须重建/迁移数据。
 */

/** 统一归一化：去首尾空白、压缩连续空白、转小写。作为去重主键。 */
export function normalizeText(input) {
  return String(input ?? '').trim().replace(/\s+/g, ' ').toLowerCase()
}

/** 保留原有大小写地整理空白，并把第一个英文字母改成大写。 */
export function capitalizeSentence(input) {
  return String(input ?? '').trim().replace(/\s+/g, ' ').replace(/[A-Za-z]/, letter => letter.toUpperCase())
}
