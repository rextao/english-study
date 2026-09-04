/**
 * text.mjs — 文本归一化
 *
 * 单独拆一个文件是因为 dict-server.mjs 和 ecdict.mjs 都要用同一套规则：
 * 两边算出来的主键必须一模一样，否则本地词典永远查不中缓存里的词。
 */

/** 统一归一化：去首尾空白、压缩连续空白、转小写。作为去重主键。 */
export function normalizeText(input) {
  return String(input ?? '').trim().replace(/\s+/g, ' ').toLowerCase()
}
