import type { DictionaryTranslation } from '../types/vocab'

/** 词典里的词性全称与用户界面使用的简写。 */
const POS_LABELS: Record<string, string> = {
  noun: 'n.',
  n: 'n.',
  verb: 'v.',
  v: 'v.',
  vt: 'vt.',
  vi: 'vi.',
  adjective: 'a.',
  adj: 'a.',
  adverb: 'ad.',
  adv: 'ad.',
  preposition: 'prep.',
  prep: 'prep.',
  conjunction: 'conj.',
  conj: 'conj.',
  pronoun: 'pron.',
  pron: 'pron.',
  interjection: 'int.',
  int: 'int.',
}

export interface TranslationOption {
  id: string
  text: string
  pos?: string
}

/** 把词性统一成页面显示的简写；无法识别的词性不显示。 */
export function translationPosLabel(pos?: string): string {
  const value = String(pos ?? '').trim().toLowerCase().replace(/\.$/, '')
  return POS_LABELS[value] ?? (value ? value + '.' : '')
}

/** 拆开一段中文摘要：分号是词性组，逗号是同一词性下的独立词义。 */
export function splitTranslationText(text: string, fallbackPos?: string): Array<{ text: string; pos?: string }> {
  return String(text ?? '')
    .split(/[；;]/)
    .flatMap(group => {
      const value = group.trim()
      if (!value) return []
      const match = /^([a-zA-Z]{1,8})\.\s*(.+)$/.exec(value)
      const pos = match ? match[1] : fallbackPos
      const body = match ? match[2] : value
      return body.split(/[，,]/)
        .map(item => ({ text: item.trim(), pos }))
        .filter(item => item.text)
    })
}

/** 为前端选项展开旧缓存中仍未拆开的摘要，并保持可回传服务端的 ID。 */
export function translationOptions(translations: DictionaryTranslation[]): TranslationOption[] {
  let previousPos: string | undefined
  return translations.flatMap(item => {
    const parts = splitTranslationText(item.text, item.pos ?? previousPos)
    const lastPart = parts[parts.length - 1]
    if (lastPart?.pos) previousPos = lastPart.pos
    return parts.map((part, index) => ({
      id: parts.length === 1 ? item.id : item.id + '::' + index,
      text: part.text,
      pos: part.pos,
    }))
  })
}

/** 根据已保存的 ID 找回候选；兼容旧版把逗号项挂在同一个 ID 后的写法。 */
export function selectedTranslationOptions(
  translations: DictionaryTranslation[], ids: string[],
): TranslationOption[] {
  const options = translationOptions(translations)
  return ids.flatMap(id => {
    const exact = options.find(option => option.id === id)
    return exact ? [exact] : options.filter(option => option.id.startsWith(id + '::'))
  })
}

/** 按词性分组拼接选中的中文词义，格式如 n. 天气,气象；a. 迎风的。 */
export function formatTranslationOptions(options: TranslationOption[]): string {
  const groups: { pos?: string; texts: string[] }[] = []
  for (const option of options) {
    const text = option.text.trim()
    if (!text) continue
    const pos = option.pos?.trim() || undefined
    let group = groups.find(item => item.pos === pos)
    if (!group) {
      group = { pos, texts: [] }
      groups.push(group)
    }
    if (!group.texts.includes(text)) group.texts.push(text)
  }
  return groups
    .filter(group => group.texts.length > 0)
    .map(group => (group.pos ? translationPosLabel(group.pos) + ' ' : '') + group.texts.join(','))
    .join('；')
}
