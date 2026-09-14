import { pinyin } from 'pinyin-pro'

// 打印卡片：A4 横向双面排版，偶数页按行左右镜像。
// 每组按“单词正面 → 音标与翻译反面”相邻输出，双面打印时奇数页是正面、偶数页是反面。

const SERVER = 'http://127.0.0.1:3456'

export interface FlashCard {
  word: string
  /** 句子卡片的展示文本；词典查询仍使用 word。 */
  displayText?: string
  /** 单词保持单行自动缩放；语句允许换行并使用独立字号 */
  type?: 'word' | 'sentence'
  phonetic?: string
  translation?: string
  /** 卡片右上角显示的词库标签；句子不传 */
  libraryLabels?: string[]
  /** 这一阶段挑中的英文释义。反面现在只印音标 + 中文，字段留着方便以后改回去印释义 */
  senses: string[]
}

/** 要印的一张卡：词 + 这一阶段要背的释义 id */
export interface CardRequest {
  word: string
  /** 句子卡片的展示文本；词典查询仍使用 word。 */
  displayText?: string
  type?: 'word' | 'sentence'
  senseIds?: string[]
  /** 加入学习列表时保存的音标快照，优先于词典缓存 */
  phonetic?: string
  /** 加入学习列表时保存的中文快照，优先于词典默认摘要 */
  translation?: string
  /** 已由调用方通过 getLabelById 转成显示文案的词库标签；句子不传 */
  libraryLabels?: string[]
}

export interface FlashcardOptions {
  /** 每页列数，1-6，默认 2 */
  cols?: number
  /** 每页行数，1-8，默认 3 */
  rows?: number
  title?: string
  /** 开始学习时间，会印在顶部信息栏里 */
  startedAt?: number
}

function escHtml(input: unknown): string {
  return String(input ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 给中文翻译逐字标注拼音；非中文字符保留原样，所有内容都经过转义。 */
function rubyTranslation(input: string): string {
  return pinyin(input, { type: 'all', toneType: 'symbol', nonZh: 'consecutive' })
    .map(part => part.isZh && part.pinyin
      ? '<ruby><span>' + escHtml(part.origin) + '</span><rt>' +
        escHtml(part.pinyin) + '</rt></ruby>'
      : '<span class="ruby-non-zh">' + escHtml(part.origin) + '</span>')
    .join('')
}

/** 每行内部左右翻转，让偶数页在双面打印并裁切后与对应单词对齐。 */
export function mirrorRows<T>(arr: T[], cols: number, rows: number): T[] {
  const out: T[] = []
  for (let r = 0; r < rows; r++) {
    const row = arr.slice(r * cols, r * cols + cols)
    row.reverse()
    out.push(...row)
  }
  return out
}

/** 与服务端 normalizeText 一致的归一化，用来对齐缓存 key */
const keyOf = (word: string) => word.trim().replace(/\s+/g, ' ').toLowerCase()

function clamp(value: number, min: number, max: number): number {
  const n = Math.round(value)
  if (!Number.isFinite(n)) return min
  return Math.max(min, Math.min(max, n))
}

interface CachedEntry {
  word?: string
  phonetic?: string
  translation?: string
  senses?: CachedSense[]
  status?: string
}

interface CachedSense {
  id?: string
  pos?: string
  definition?: string
}

interface BatchReply {
  entries: Record<string, CachedEntry>
  missing: string[]
  /** 有缓存但没抓齐的词，打印前顺手补一次 */
  incomplete?: string[]
}

/** 一次把本地缓存里已有的释义全捞出来 */
async function fetchCached(words: string[]): Promise<BatchReply | null> {
  try {
    const res = await fetch(SERVER + '/api/dict/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ words }),
    })
    const data = await res.json() as BatchReply
    if (!data || typeof data.entries !== 'object' || !Array.isArray(data.missing)) return null
    return data
  } catch {
    return null
  }
}

/** 缺释义的词现查一次，服务端会顺手写进缓存 */
async function fetchOne(word: string): Promise<CachedEntry> {
  try {
    const res = await fetch(SERVER + '/api/dict?word=' + encodeURIComponent(word))
    return await res.json() as CachedEntry
  } catch {
    return {}
  }
}

/** 卡片反面只印音标 + 中文，这两样齐了就没必要再抓一次（英文释义缺不缺都不影响打印） */
function printable(entry: CachedEntry | undefined): boolean {
  if (!entry) return false
  return !!entry.phonetic && !!entry.translation
}

/** 自动挑释义时最多印几条，印太多卡片就看不清了 */
const AUTO_SENSE_LIMIT = 3

/**
 * 卡片反面要印的英文释义：
 * 勾了就按勾的顺序取；没勾（或勾的 id 因为重抓而失效）就每个词性取第一条。
 */
export function pickSenses(
  entry: { senses?: CachedSense[] } | null | undefined,
  senseIds?: string[],
): string[] {
  const senses = entry?.senses ?? []
  if (senses.length === 0) return []

  if (senseIds && senseIds.length > 0) {
    const picked: string[] = []
    for (const id of senseIds) {
      const text = senses.find((sense) => sense.id === id)?.definition?.trim()
      if (text) picked.push(text)
    }
    if (picked.length > 0) return picked
  }

  const auto: string[] = []
  const seenPos = new Set<string>()
  for (const sense of senses) {
    if (auto.length >= AUTO_SENSE_LIMIT) break
    const pos = sense.pos ?? ''
    if (seenPos.has(pos)) continue
    const text = sense.definition?.trim()
    if (!text) continue
    seenPos.add(pos)
    auto.push(text)
  }
  return auto
}

/**
 * 取卡片正反面内容：先批量读缓存，缺的（含缺音标的）用 4 个并发现查。
 * 返回结果与传入顺序一一对应，正面显示的词沿用调用方给的原文。
 */
export async function fetchCards(
  items: CardRequest[],
  onProgress?: (done: number, total: number) => void,
): Promise<FlashCard[]> {
  // 快照已经同时有音标和中文时，卡片可以直接生成，不需要再查词典。
  // 只有旧数据或快照缺一项时才读取缓存 / 补齐词典。
  const words = items
    .filter(item => !item.phonetic || !item.translation)
    .map(item => item.word)
  const found = new Map<string, CachedEntry>()
  let missing: string[] = []

  if (words.length > 0) {
    const cached = await fetchCached(words)
    if (cached) {
      for (const key of Object.keys(cached.entries)) found.set(key, cached.entries[key])
      missing = cached.missing.slice()
      // 有缓存但音标 / 中文 / 释义缺一块的，趁打印这一趟一起补回来；
      // 该印的三样都齐了就跳过，否则每次打印都要白等一轮网络请求
      for (const key of cached.incomplete ?? []) {
        if (printable(found.get(key))) continue
        if (!missing.includes(key)) missing.push(key)
      }
    } else {
      // 批量接口不可用（老版本服务端）时退回逐个查
      for (const word of words) {
        const key = keyOf(word)
        if (key && !missing.includes(key)) missing.push(key)
      }
    }
  }

  const total = missing.length
  if (total > 0) {
    onProgress?.(0, total)
    let cursor = 0
    let done = 0
    const worker = async () => {
      while (cursor < missing.length) {
        const key = missing[cursor++]
        found.set(key, await fetchOne(key))
        done++
        onProgress?.(done, total)
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, total) }, worker))
  }

  return items.map(item => {
    const entry = found.get(keyOf(item.word))
    return {
      word: item.word.trim() || item.word,
      displayText: item.type === 'sentence' && item.displayText?.trim()
        ? item.displayText.trim()
        : undefined,
      type: item.type,
      phonetic: item.phonetic || entry?.phonetic,
      translation: item.translation || entry?.translation,
      libraryLabels: item.libraryLabels
        ?.map(label => label.trim())
        .filter((label, index, labels) => label.length > 0 && labels.indexOf(label) === index),
      senses: pickSenses(entry, item.senseIds),
    }
  })
}

/** 打印样式：A4 横向、虚线裁切格、正反面各自成页 */
const PRINT_CSS = [
  '* { margin: 0; padding: 0; box-sizing: border-box; }',
  "body { font-family: 'Georgia', 'Times New Roman', serif; background: #f0f0f0; }",
  '#controls {',
  '  position: fixed; top: 0; left: 0; right: 0;',
  '  background: #2c3e50; color: #fff;',
  '  padding: 10px 20px; display: flex; align-items: center;',
  '  gap: 16px; z-index: 9999; flex-wrap: wrap; font-family: sans-serif;',
  '}',
  '#controls h2 { font-size: 14px; font-weight: bold; color: #f39c12; }',
  '#controls button {',
  '  padding: 7px 18px; border-radius: 5px; border: none;',
  '  cursor: pointer; font-size: 13px; font-weight: bold;',
  '}',
  '#btn-print { background: #27ae60; color: #fff; }',
  '.mode-switch { display: inline-flex; padding: 2px; border-radius: 6px; background: #1d2b38; }',
  '.mode-switch button { padding: 5px 10px !important; background: transparent; color: #b8c3cc; }',
  '.mode-switch button.active { background: #fff; color: #263746; }',
  '.font-control { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }',
  '.font-control span { font-size: 11px; color: #dfe6e9; }',
'.font-control input {',
'  width: 58px; height: 29px; padding: 3px 4px; border: 1px solid #718093;',
'  border-radius: 4px; background: #fff; color: #2c3e50; font-size: 12px;',
'}',
'.font-control input[type="number"] { appearance: auto; -webkit-appearance: auto; }',
'.font-control input[type="number"]::-webkit-inner-spin-button,',
'.font-control input[type="number"]::-webkit-outer-spin-button {',
'  display: block; opacity: 1; -webkit-appearance: inner-spin-button;',
'}',
'.preview-scale input { width: 66px; }',
  '.exam-controls { display: inline-flex; align-items: center; gap: 14px; }',
  '.exam-controls[hidden] { display: none !important; }',
  '.exam-toggle {',
  '  display: inline-flex; align-items: center; gap: 6px; color: #dfe6e9;',
  '  font-size: 11px; white-space: nowrap; cursor: pointer;',
  '}',
  '.exam-toggle input { width: 15px; height: 15px; accent-color: #27ae60; cursor: pointer; }',
  '.flip-hint {',
  '  padding: 4px 9px; border: 1px solid rgba(243,156,18,.55); border-radius: 999px;',
  '  color: #f8c471; font-size: 11px; font-weight: bold; white-space: nowrap;',
  '}',
  '#print-area {',
  '  margin-top: var(--controls-height, 62px); padding: 16px; display: flex; flex-wrap: wrap;',
  '  align-items: flex-start; justify-content: center; gap: 16px;',
  '}',
  '.sheet-set { display: contents; }',
  '.sheet-set[hidden] { display: none !important; }',
  '.sheet-preview { zoom: var(--preview-scale, .35); }',
  '.sheet-label {',
  '  width: 297mm; margin: 0 0 3px; font-size: 11px; color: #888;',
  '  text-align: right; padding-right: 4mm; font-family: sans-serif;',
  '}',
  '.a4-sheet {',
  '  width: 297mm; height: 210mm; margin: 0; background: #fff;',
  '  border: 1px solid #bbb; box-shadow: 0 2px 8px rgba(0,0,0,.15);',
  '  padding: 0; display: grid; gap: 0;',
  '}',
  '.card {',
  '  border: 1px dashed #c8c8c8; display: flex; flex-direction: column;',
  '  justify-content: center; align-items: center; text-align: center;',
  '  padding: 6px 10px; overflow: hidden; position: relative;',
  '}',
  '.card.empty { border-color: #eee; }',
  '.card.front .word {',
  '  max-width: 100%; font-weight: bold; color: #1a1a2e;',
  '  letter-spacing: .5px; line-height: 1.15;',
  '}',
  '.card.front .word[data-kind="word"] { white-space: nowrap; word-break: normal; }',
  '.card.front .word[data-kind="sentence"] { white-space: normal; word-break: normal; overflow-wrap: break-word; }',
  '.card.front .card-num {',
  '  position: absolute; top: 4px; left: 6px;',
  '  font-size: 9px; color: #ccc; font-family: sans-serif;',
  '}',
  '.card.front .library-labels {',
  '  position: absolute; top: 0; right: 0; width: 62px; height: 62px;',
  '  overflow: hidden; background: #000;',
  '  clip-path: polygon(100% 0, 100% 100%, 0 0); font-family: sans-serif;',
  '  -webkit-print-color-adjust: exact; print-color-adjust: exact;',
  '}',
  '.card.front .library-label {',
  '  position: absolute; top: 10px; right: 1px; width: 39px; color: #fff;',
  '  font-size: 10px; font-weight: bold; line-height: 1; text-align: center;',
  '  transform: rotate(45deg); transform-origin: center; white-space: nowrap;',
  '}',
  '.card.back .phonetic {',
  '  width: 100%; color: #555; line-height: 1.12;',
  '  margin-bottom: 7px; font-style: italic; white-space: nowrap;',
  '}',
  '.card.back .translation {',
  '  width: 100%; font-weight: bold; color: #1a1a1a;',
  '  line-height: 1.12; word-break: normal; overflow-wrap: break-word;',
  '}',
  '.card.exam { justify-content: space-evenly; padding: 10px 16px; font-family: sans-serif; }',
  '.exam-translation {',
  '  width: 100%; height: 45%; display: flex; align-items: center; justify-content: center;',
  '  color: #161616; font-weight: bold; line-height: 1.2; white-space: pre-wrap;',
  '  word-break: normal; overflow-wrap: break-word;',
  '}',
  '.exam-translation ruby { ruby-position: over; ruby-align: center; margin: 0 .035em; }',
  '.exam-translation rt { font-size: .3em; line-height: 1; font-weight: normal; letter-spacing: 0; }',
  '.hide-exam-pinyin .exam-translation rt { display: none; }',
  '.writing-guide {',
  '  position: relative; width: 92%; height: 42%; display: flex;',
  '  align-items: center; justify-content: center; overflow: hidden;',
  '  border-top: 1px solid #686868; border-bottom: 1px solid #686868;',
  '  background-image: linear-gradient(to bottom,',
  '    transparent calc(33.333% - .5px), #8a8a8a calc(33.333% - .5px),',
  '    #8a8a8a calc(33.333% + .5px), transparent calc(33.333% + .5px),',
  '    transparent calc(66.666% - .5px), #8a8a8a calc(66.666% - .5px),',
  '    #8a8a8a calc(66.666% + .5px), transparent calc(66.666% + .5px));',
  '}',
  '.exam-word {',
  '  position: relative; z-index: 1; height: 100%; padding: 0 6px; color: #222;',
  '  display: inline-flex; align-items: stretch; white-space: pre; letter-spacing: 0;',
  "  font-family: 'Comic Sans MS', 'Trebuchet MS', sans-serif; line-height: 1;",
  '}',
  '.exam-letter {',
  '  position: relative; display: inline-block; width: .64em; height: 100%; flex: 0 0 .64em;',
  '}',
  '.exam-letter--space { width: .42em; flex-basis: .42em; }',
  '.exam-glyph {',
  '  position: absolute; left: 50%; display: flex; align-items: center; justify-content: center;',
  '  width: 100%; transform: translateX(-50%); font-weight: normal;',
  '}',
  '.exam-letter--middle .exam-glyph, .exam-letter--punctuation .exam-glyph {',
  '  top: 33.333%; height: 33.333%; font-size: .72em;',
  '}',
  '.exam-letter--ascender .exam-glyph {',
  '  top: 0; height: 66.666%; align-items: flex-end; font-size: 1.08em;',
  '}',
  '.exam-letter--descender .exam-glyph {',
  '  top: 33.333%; height: 66.667%; align-items: flex-start; font-size: 1.08em;',
  '}',
  '.exam-letter--blank .exam-glyph {',
  '  top: 33.333%; height: 33.333%; align-items: flex-end; font-family: Arial, sans-serif;',
  '  font-size: .78em; font-weight: normal;',
  '}',
  '@media print {',
  '  @page { size: A4 landscape; margin: 0; }',
  '  body { background: #fff; }',
  '  #controls { display: none !important; }',
  '  #print-area { margin-top: 0; padding: 0; display: block; }',
  '  .sheet-preview { zoom: 1; break-after: page; page-break-after: always; }',
  '  .sheet-preview:last-child { break-after: auto; page-break-after: auto; }',
  '  .sheet-label { display: none; }',
  '  .a4-sheet {',
  '    margin: 0; border: none; box-shadow: none;',
  '    width: 297mm; height: 210mm; padding: 0;',
  '    page-break-after: auto; break-after: auto;',
  '  }',
  '  .card { border-color: #aaa; }',
  '  .card.front .library-labels { background: #000 !important; }',
  '}',
].join('\n')

/** 打印页内按卡片空间缩小文字：输入值是目标字号，内容放不下时才自动缩小。 */
const FIT_TEXT_SCRIPT = [
  '(function () {',
  "  var wordInput = document.getElementById('word-font-size');",
  "  var sentenceInput = document.getElementById('sentence-font-size');",
  "  var translationInput = document.getElementById('translation-font-size');",
  "  var scaleInput = document.getElementById('preview-scale');",
  "  var hiddenInput = document.getElementById('hidden-letter-count');",
  "  var pinyinInput = document.getElementById('show-pinyin');",
  "  var normalSheets = document.getElementById('normal-sheets');",
  "  var examSheets = document.getElementById('exam-sheets');",
  "  var flipHint = document.querySelector('.flip-hint');",
  "  var examControls = document.getElementById('exam-controls');",
  '  function numberValue(input, fallback) {',
  '    var value = Number(input && input.value);',
  '    return Number.isFinite(value) ? value : fallback;',
  '  }',
  '  function fitText(el, maximum, minimum) {',
  '    var card = el.parentElement;',
  '    if (!card) return;',
  '    var availableWidth = Math.max(1, card.clientWidth - 20);',
  '    var availableHeight = Math.max(1, card.clientHeight - 20);',
  '    var low = minimum;',
  '    var high = Math.max(minimum, Math.round(maximum));',
  '    var best = minimum;',
  '    while (low <= high) {',
  '      var size = Math.floor((low + high) / 2);',
  "      el.style.fontSize = size + 'px';",
  '      var rect = el.getBoundingClientRect();',
  '      var fits = el.scrollWidth <= availableWidth + 1 &&',
  '        el.scrollHeight <= availableHeight + 1 &&',
  '        rect.width <= availableWidth + 1 && rect.height <= availableHeight + 1;',
  '      if (fits) { best = size; low = size + 1; } else { high = size - 1; }',
  '    }',
  "    el.style.fontSize = best + 'px';",
  '  }',
  '  function fitBack(card, maximum) {',
  "    var phonetic = card.querySelector('.phonetic');",
  "    var translation = card.querySelector('.translation');",
  '    if (!translation) return;',
  '    var availableWidth = Math.max(1, card.clientWidth - 20);',
  '    var availableHeight = Math.max(1, card.clientHeight - 12);',
  '    var low = 10;',
  '    var high = Math.max(10, Math.round(maximum));',
  '    var best = 10;',
  '    while (low <= high) {',
  '      var size = Math.floor((low + high) / 2);',
  "      translation.style.fontSize = size + 'px';",
  "      if (phonetic) phonetic.style.fontSize = Math.max(12, Math.round(size * 0.42)) + 'px';",
  '      var translationRect = translation.getBoundingClientRect();',
  '      var phoneticRect = phonetic ? phonetic.getBoundingClientRect() : null;',
  '      var totalHeight = translationRect.height + (phoneticRect ? phoneticRect.height + 7 : 0);',
  '      var fitsWidth = translation.scrollWidth <= availableWidth + 1 &&',
  '        (!phonetic || phonetic.scrollWidth <= availableWidth + 1);',
  '      var fits = fitsWidth && translation.scrollHeight <= availableHeight + 1 &&',
  '        totalHeight <= availableHeight + 1;',
  '      if (fits) { best = size; low = size + 1; } else { high = size - 1; }',
  '    }',
  "    translation.style.fontSize = best + 'px';",
  "    if (phonetic) phonetic.style.fontSize = Math.max(12, Math.round(best * 0.42)) + 'px';",
  '  }',
  '  function fitExamTranslation(el, maximum) {',
  '    var availableWidth = Math.max(1, el.clientWidth);',
  '    var availableHeight = Math.max(1, el.clientHeight);',
  '    var low = 12;',
  '    var high = Math.max(12, Math.round(maximum));',
  '    var best = 12;',
  '    while (low <= high) {',
  '      var size = Math.floor((low + high) / 2);',
  "      el.style.fontSize = size + 'px';",
  '      var fits = el.scrollWidth <= availableWidth + 1 && el.scrollHeight <= availableHeight + 1;',
  '      if (fits) { best = size; low = size + 1; } else { high = size - 1; }',
  '    }',
  "    el.style.fontSize = best + 'px';",
  '  }',
  '  function fitExamWord(el, maximum) {',
  '    var guide = el.parentElement;',
  '    if (!guide) return;',
  '    var availableWidth = Math.max(1, guide.clientWidth - 12);',
  '    var low = 16;',
  '    var high = Math.max(16, Math.round(maximum));',
  '    var best = 16;',
  '    while (low <= high) {',
  '      var size = Math.floor((low + high) / 2);',
  "      el.style.fontSize = size + 'px';",
  '      if (el.scrollWidth <= availableWidth + 1) { best = size; low = size + 1; }',
  '      else { high = size - 1; }',
  '    }',
  "    el.style.fontSize = best + 'px';",
  '  }',
  '  function fitAll() {',
  '    var wordSize = numberValue(wordInput, 96);',
  '    var sentenceSize = numberValue(sentenceInput, 52);',
  '    var translationSize = numberValue(translationInput, 54);',
  "    document.querySelectorAll('.word[data-kind=\"word\"]').forEach(function (el) {",
  '      fitText(el, wordSize, 10);',
  '    });',
  "    document.querySelectorAll('.word[data-kind=\"sentence\"]').forEach(function (el) {",
  '      fitText(el, sentenceSize, 12);',
  '    });',
  "    document.querySelectorAll('.card.back').forEach(function (card) {",
  '      fitBack(card, translationSize);',
  '    });',
  "    document.querySelectorAll('#exam-sheets .exam-translation').forEach(function (el) {",
  '      fitExamTranslation(el, translationSize);',
  '    });',
  "    document.querySelectorAll('#exam-sheets .exam-word').forEach(function (el) {",
  '      fitExamWord(el, 48);',
  '    });',
  '  }',
  '  function maskWord(word, count) {',
  "    var letters = (word.match(/[A-Za-z]/g) || []).length;",
  '    var remaining = Math.max(0, Math.min(letters, Math.floor(count)));',
  '    if (!remaining) return word;',
  "    return Array.from(word).reverse().map(function (char) {",
  "      if (remaining > 0 && /[A-Za-z]/.test(char)) { remaining--; return '_'; }",
  "      return char;",
  "    }).reverse().join('');",
  '  }',
  '  function letterKind(char) {',
  "    if (char === '_') return 'blank';",
  "    if (/\\s/.test(char)) return 'space';",
  "    if (/[A-Zbdfhklt]/.test(char)) return 'ascender';",
  "    if (/[gjpqy]/.test(char)) return 'descender';",
  "    if (/[a-z]/.test(char)) return 'middle';",
  "    return 'punctuation';",
  '  }',
  '  function renderGuidedWord(el, text) {',
  "    el.textContent = '';",
  '    Array.from(text).forEach(function (char) {',
  '      var kind = letterKind(char);',
  "      var slot = document.createElement('span');",
  "      slot.className = 'exam-letter exam-letter--' + kind;",
  "      slot.setAttribute('aria-hidden', 'true');",
  "      if (kind !== 'space') {",
  "        var glyph = document.createElement('span');",
  "        glyph.className = 'exam-glyph';",
  '        glyph.textContent = char;',
  '        slot.appendChild(glyph);',
  '      }',
  '      el.appendChild(slot);',
  '    });',
  "    el.setAttribute('aria-label', text);",
  '  }',
  '  function updateExamWords() {',
  '    var count = Math.max(0, numberValue(hiddenInput, 0));',
  "    document.querySelectorAll('#exam-sheets .exam-word').forEach(function (el) {",
  "      renderGuidedWord(el, maskWord(el.getAttribute('data-word') || '', count));",
  '    });',
  '    fitAll();',
  '  }',
  '  function updatePinyin() {',
  '    var show = !pinyinInput || pinyinInput.checked;',
  "    document.documentElement.classList.toggle('hide-exam-pinyin', !show);",
  '    fitAll();',
  '  }',
  '  function syncControlsHeight() {',
  "    var controls = document.getElementById('controls');",
  "    if (controls) document.documentElement.style.setProperty('--controls-height', controls.offsetHeight + 12 + 'px');",
  '  }',
  '  function setMode(mode) {',
  "    var exam = mode === 'exam';",
  '    if (normalSheets) normalSheets.hidden = exam;',
  '    if (examSheets) examSheets.hidden = !exam;',
  '    if (flipHint) flipHint.hidden = exam;',
  '    if (examControls) examControls.hidden = !exam;',
  "    document.querySelectorAll('.mode-switch button').forEach(function (button) {",
  "      button.classList.toggle('active', button.getAttribute('data-mode') === mode);",
  '    });',
  '    syncControlsHeight();',
  '    window.requestAnimationFrame(fitAll);',
  '  }',
  '  function updateScale() {',
  '    var scale = Math.max(20, Math.min(100, numberValue(scaleInput, 35)));',
  "    document.documentElement.style.setProperty('--preview-scale', String(scale / 100));",
  '  }',
  "  if (wordInput) wordInput.addEventListener('input', fitAll);",
  "  if (sentenceInput) sentenceInput.addEventListener('input', fitAll);",
  "  if (translationInput) translationInput.addEventListener('input', fitAll);",
  "  if (scaleInput) scaleInput.addEventListener('input', updateScale);",
  "  if (hiddenInput) hiddenInput.addEventListener('input', updateExamWords);",
  "  if (pinyinInput) pinyinInput.addEventListener('change', updatePinyin);",
  "  document.querySelectorAll('.mode-switch button').forEach(function (button) {",
  "    button.addEventListener('click', function () { setMode(button.getAttribute('data-mode')); });",
  '  });',
  "  window.addEventListener('resize', function () { syncControlsHeight(); fitAll(); });",
  "  window.addEventListener('beforeprint', fitAll);",
  '  updateScale();',
  '  updateExamWords();',
  '  updatePinyin();',
  "  setMode('normal');",
  "  if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitAll);",
  '}());',
].join('\n')

/** 生成可直接打印的整页 HTML */
export function buildFlashcardsHtml(cards: FlashCard[], options: FlashcardOptions = {}): string {
  const cols    = clamp(options.cols ?? 2, 1, 6)
  const rows    = clamp(options.rows ?? 3, 1, 8)
  const perPage = cols * rows
  const title   = options.title || '单词卡'

  const pages: FlashCard[][] = []
  for (let i = 0; i < cards.length; i += perPage) pages.push(cards.slice(i, i + perPage))
  if (pages.length === 0) pages.push([])

  const grid = ' style="grid-template-columns: repeat(' + cols +
    ', 1fr); grid-template-rows: repeat(' + rows + ', 1fr)"'
  // 每组正反面紧邻：第 1/3/5... 页是单词，第 2/4/6... 页是对应音标与翻译。
  const normalSheets: string[] = []
  const examSheets: string[] = []

  pages.forEach((group, gi) => {
    const padded: (FlashCard | null)[] = group.slice()
    while (padded.length < perPage) padded.push(null)

    const frontPage = gi * 2 + 1
    const backPage = frontPage + 1
    normalSheets.push('<div class="sheet-preview"><div class="sheet-label">第 ' + frontPage +
      ' 页 · Group ' + (gi + 1) + ' FRONT</div>')
    normalSheets.push('<div class="a4-sheet"' + grid + '>')
    padded.forEach((card, idx) => {
      if (!card) { normalSheets.push('<div class="card front empty"></div>'); return }
      const cardText = card.type === 'sentence' && card.displayText?.trim()
        ? card.displayText.trim()
        : card.word
      const labels = card.type !== 'sentence' && card.libraryLabels?.[0]
        ? '<span class="library-labels"><span class="library-label">' +
          escHtml(card.libraryLabels[0]) + '</span></span>'
        : ''
      const kind = card.type === 'sentence' ? 'sentence' : 'word'
      normalSheets.push('<div class="card front"><span class="card-num">' + (gi * perPage + idx + 1) +
        '</span>' + labels + '<div class="word" data-kind="' + kind + '">' +
        escHtml(cardText) + '</div></div>')
    })
    normalSheets.push('</div></div>')

    normalSheets.push('<div class="sheet-preview"><div class="sheet-label">第 ' + backPage +
      ' 页 · Group ' + (gi + 1) + ' BACK</div>')
    normalSheets.push('<div class="a4-sheet"' + grid + '>')
    // 偶数页逐行左右镜像，不改变行的上下顺序。
    mirrorRows(padded, cols, rows).forEach(card => {
      if (!card) { normalSheets.push('<div class="card back empty"></div>'); return }
      const phonetic = card.phonetic
        ? '<div class="phonetic">' + escHtml(card.phonetic) + '</div>'
        : ''
      // 反面只印音标 + 中文那一行，英文释义不上卡片
      normalSheets.push('<div class="card back">' + phonetic + '<div class="translation">' +
        escHtml(card.translation || '—') + '</div></div>')
    })
    normalSheets.push('</div></div>')

    examSheets.push('<div class="sheet-preview"><div class="sheet-label">第 ' + (gi + 1) +
      ' 页 · Group ' + (gi + 1) + ' EXAM</div>')
    examSheets.push('<div class="a4-sheet"' + grid + '>')
    padded.forEach((card, idx) => {
      if (!card) { examSheets.push('<div class="card front exam empty"></div>'); return }
      const cardText = card.type === 'sentence' && card.displayText?.trim()
        ? card.displayText.trim()
        : card.word
      const labels = card.type !== 'sentence' && card.libraryLabels?.[0]
        ? '<span class="library-labels"><span class="library-label">' +
          escHtml(card.libraryLabels[0]) + '</span></span>'
        : ''
      examSheets.push('<div class="card front exam"><span class="card-num">' +
        (gi * perPage + idx + 1) + '</span>' + labels + '<div class="exam-translation">' +
        rubyTranslation(card.translation || '—') + '</div><div class="writing-guide">' +
        '<span class="exam-word" data-word="' + escHtml(cardText) + '">' +
        escHtml(cardText) + '</span></div></div>')
    })
    examSheets.push('</div></div>')
  })

  return [
    '<!DOCTYPE html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="UTF-8">',
    '<title>' + escHtml(title) + '</title>',
    '<style>',
    PRINT_CSS,
    '</style>',
    '</head>',
    '<body>',
    '<div id="controls">',
    '<h2>单词卡</h2>',
    '<button id="btn-print" onclick="window.print()">打 印</button>',
    '<span class="flip-hint">短边翻转</span>',
    '<span class="mode-switch"><button type="button" class="active" data-mode="normal">普通模式</button>' +
      '<button type="button" data-mode="exam">考试模式</button></span>',
    '<label class="font-control"><span>单词字号</span>' +
      '<input id="word-font-size" type="number" min="10" max="180" step="2" value="96"></label>',
    '<label class="font-control"><span>语句字号</span>' +
      '<input id="sentence-font-size" type="number" min="12" max="96" step="2" value="52"></label>',
    '<label class="font-control"><span>翻译字号</span>' +
      '<input id="translation-font-size" type="number" min="10" max="220" step="2" value="54"></label>',
    '<label class="font-control preview-scale"><span>预览缩放</span>' +
      '<input id="preview-scale" type="number" min="20" max="100" step="5" value="35">%</label>',
    '<span class="exam-controls" id="exam-controls" hidden>' +
      '<label class="font-control"><span>隐藏字母数</span>' +
      '<input id="hidden-letter-count" type="number" min="0" step="1" value="0"></label>' +
      '<label class="exam-toggle"><input id="show-pinyin" type="checkbox" checked>' +
      '<span>显示拼音</span></label></span>',
    '</div>',
    '<div id="print-area">',
    '<div class="sheet-set" id="normal-sheets">' + normalSheets.join('\n') + '</div>',
    '<div class="sheet-set" id="exam-sheets" hidden>' + examSheets.join('\n') + '</div>',
    '</div>',
    '<script>',
    FIT_TEXT_SCRIPT,
    '</script>',
    '</body>',
    '</html>',
  ].join('\n')
}

// ── 先开页、后填内容 ─────────────────────────────────────────────────────

/** 加载页上进度那行字的 id，后面要按 id 改文案 */
const BOOT_PROGRESS_ID = 'boot-progress'

/** 加载页 / 失败页的样式，配色跟卡片页顶部那条控制栏一致 */
const BOOT_CSS = [
  '* { margin: 0; padding: 0; box-sizing: border-box; }',
  'body {',
  '  min-height: 100vh; padding: 24px; background: #2c3e50; color: #ecf0f1;',
  '  font-family: sans-serif; display: flex; align-items: center; justify-content: center;',
  '}',
  '.boot { max-width: 420px; text-align: center; }',
  '.boot__spin {',
  '  width: 34px; height: 34px; margin: 0 auto 18px; border-radius: 50%;',
  '  border: 3px solid rgba(255,255,255,.22); border-top-color: #f39c12;',
  '  animation: boot-spin .8s linear infinite;',
  '}',
  '@keyframes boot-spin { to { transform: rotate(360deg); } }',
  '.boot__title { font-size: 17px; font-weight: bold; color: #f39c12; }',
  '.boot__name { margin-top: 6px; font-size: 13px; color: #bdc3c7; }',
  '.boot__progress { margin-top: 14px; font-size: 13px; }',
  '.boot__hint { margin-top: 12px; font-size: 12px; line-height: 1.6; color: #95a5a6; }',
  '.boot--error .boot__title { color: #e74c3c; }',
].join('\n')

function bootShell(title: string, inner: string[]): string {
  return [
    '<!DOCTYPE html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="UTF-8">',
    '<title>' + escHtml(title) + '</title>',
    '<style>',
    BOOT_CSS,
    '</style>',
    '</head>',
    '<body>',
    ...inner,
    '</body>',
    '</html>',
  ].join('\n')
}

function bootHtml(title: string): string {
  return bootShell(title, [
    '<div class="boot">',
    '<div class="boot__spin"></div>',
    '<p class="boot__title">正在生成单词卡</p>',
    '<p class="boot__name">' + escHtml(title) + '</p>',
    '<p class="boot__progress" id="' + BOOT_PROGRESS_ID + '">正在读取本地词典缓存...</p>',
    '<p class="boot__hint">没查过的词要现抓音标和释义，词多时会慢一点。抓完这一页会自动变成卡片，不用刷新。</p>',
    '</div>',
  ])
}

function bootErrorHtml(title: string, message: string): string {
  return bootShell(title, [
    '<div class="boot boot--error">',
    '<p class="boot__title">卡片生成失败</p>',
    '<p class="boot__hint">' + escHtml(message) + '</p>',
    '</div>',
  ])
}

/** 已经开出来的卡片标签页：内容先是进度，等释义查完再换成卡片 */
export interface CardWindow {
  /** 用户是不是已经把这个标签页关掉了 */
  readonly closed: boolean
  /** 刷新加载页上的进度文案 */
  progress(done: number, total: number): void
  /** 换成正式卡片内容 */
  render(html: string): void
  /** 换成一句失败提示 */
  fail(message: string): void
}

function writeDoc(win: Window, html: string): void {
  win.document.open()
  win.document.write(html)
  win.document.close()
}

/**
 * 立刻开一个标签页显示进度，等释义查完再把内容替换成卡片。
 * 必须在点击事件里同步调用：先 await 再 open 会被浏览器当成弹窗拦掉。
 * 被拦时返回 null。
 */
export function openCardWindow(title: string): CardWindow | null {
  const win = window.open('', '_blank')
  if (!win) return null
  writeDoc(win, bootHtml(title))
  return {
    get closed() { return win.closed },
    progress(done: number, total: number) {
      if (win.closed) return
      const el = win.document.getElementById(BOOT_PROGRESS_ID)
      if (!el) return
      el.textContent = total > 0
        ? '正在补音标和释义 ' + done + ' / ' + total + '...'
        : '正在读取本地词典缓存...'
    },
    render(html: string) { if (!win.closed) writeDoc(win, html) },
    fail(message: string) { if (!win.closed) writeDoc(win, bootErrorHtml(title, message)) },
  }
}
