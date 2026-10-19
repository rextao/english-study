/**
 * my_words.csv 的运行时查找器。
 * 数据由构建脚本预先解析成 JS，Worker 请求路径只做一次 Map 风格的对象查询。
 */

import { normalizeText } from './text.js'
import { MY_WORDS, MY_WORDS_COUNT } from './my-words-data.js'

export { MY_WORDS_COUNT }

export function getMyWord(word) {
  const row = MY_WORDS[normalizeText(word)]
  if (!Array.isArray(row)) return null
  return {
    phonetic: String(row[0] ?? '').trim(),
    translation: String(row[1] ?? '').trim(),
    definition: String(row[2] ?? '').trim(),
  }
}

/** ECDICT 导出的 definition 用字面量的 \n 分隔词性。 */
export function myWordSenses(definition) {
  return String(definition ?? '').split(/\\(?:r\\)?n/).map(value => {
    const text = value.trim()
    if (!text) return null
    const match = /^([a-zA-Z]{1,8})\.\s*(.+)$/.exec(text)
    return {
      pos: match ? match[1].toLowerCase() : 'other',
      definition: match ? match[2].trim() : text,
    }
  }).filter(Boolean)
}

/** 把 CSV 中的字面量换行变成前端可读的词性分隔符。 */
export function cleanMyWordTranslation(translation) {
  return String(translation ?? '').replace(/\\(?:r\\)?n/g, '；').trim()
}
