// 打印卡片：A4 横向正反镜像排版，
// 先打印所有正面页 → 纸张翻面放回纸盒 → 再打印所有反面页，裁切后正反自动对齐。

const SERVER = 'http://127.0.0.1:3456'

export interface FlashCard {
  word: string
  phonetic?: string
  translation?: string
  /** 这一阶段挑中的英文释义。反面现在只印音标 + 中文，字段留着方便以后改回去印释义 */
  senses: string[]
}

/** 要印的一张卡：词 + 这一阶段要背的释义 id */
export interface CardRequest {
  word: string
  senseIds?: string[]
}

export interface FlashcardOptions {
  /** 每页列数，1-6，默认 3 */
  cols?: number
  /** 每页行数，1-8，默认 4 */
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

/** 每行内部左右翻转：纸张翻面后，反面的格子才会落在正面同一张卡上 */
export function mirrorRows<T>(arr: T[], cols: number, rows: number): T[] {
  const out: T[] = []
  for (let r = 0; r < rows; r++) {
    const row = arr.slice(r * cols, r * cols + cols)
    row.reverse()
    for (const cell of row) out.push(cell)
  }
  return out
}

const pad2 = (n: number) => (n < 10 ? '0' + n : String(n))

function formatStamp(ts: number): string {
  const d = new Date(ts)
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
    ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes())
}

/** 与服务端 normalizeText 一致的归一化，用来对齐缓存 key */
const keyOf = (word: string) => word.trim().replace(/\s+/g, ' ').toLowerCase()

function clamp(value: number, min: number, max: number): number {
  const n = Math.round(value)
  if (!Number.isFinite(n)) return min
  return Math.max(min, Math.min(max, n))
}

/** 打印提示里的页码区间，单页时不写成「第 1-1 页」 */
const pageRange = (from: number, to: number) =>
  from === to ? '第 ' + from + ' 页' : '第 ' + from + '-' + to + ' 页'

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
  const words = items.map((item) => item.word)
  const found = new Map<string, CachedEntry>()
  let missing: string[] = []

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
      phonetic: entry?.phonetic,
      translation: entry?.translation,
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
  '#controls .meta { font-size: 12px; color: #dfe6e9; }',
  '#controls button {',
  '  padding: 7px 18px; border-radius: 5px; border: none;',
  '  cursor: pointer; font-size: 13px; font-weight: bold;',
  '}',
  '#btn-print { background: #27ae60; color: #fff; }',
  '.tip { font-size: 11px; color: #95a5a6; margin-left: auto; line-height: 1.5; text-align: right; }',
  '#print-area { margin-top: 62px; padding: 16px 0; }',
  '.sheet-label {',
  '  width: 297mm; margin: 0 auto 3px; font-size: 11px; color: #888;',
  '  text-align: right; padding-right: 4mm; font-family: sans-serif;',
  '}',
  '.a4-sheet {',
  '  width: 297mm; height: 210mm; margin: 0 auto 12px; background: #fff;',
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
  '  font-size: clamp(14px, 2.2vw, 28px); font-weight: bold; color: #1a1a2e;',
  '  letter-spacing: .5px; line-height: 1.35; word-break: break-word;',
  '}',
  '.card.front .card-num {',
  '  position: absolute; top: 4px; right: 6px;',
  '  font-size: 9px; color: #ccc; font-family: sans-serif;',
  '}',
  '.card.back .phonetic {',
  '  font-size: clamp(10px, 1.2vw, 14px); color: #666;',
  '  margin-bottom: 5px; font-style: italic;',
  '}',
  // 反面只剩中文这一行，字号给足一点
  '.card.back .translation {',
  '  font-size: clamp(14px, 2vw, 22px); font-weight: bold;',
  '  color: #1a1a1a; line-height: 1.45; word-break: break-word;',
  '}',
  '@media print {',
  '  @page { size: A4 landscape; margin: 0; }',
  '  body { background: #fff; }',
  '  #controls { display: none !important; }',
  '  #print-area { margin-top: 0; padding: 0; }',
  '  .sheet-label { display: none; }',
  '  .a4-sheet {',
  '    margin: 0; border: none; box-shadow: none;',
  '    width: 297mm; height: 210mm; padding: 0;',
  '    page-break-after: always; break-after: page;',
  '  }',
  '  .card { border-color: #aaa; }',
  '}',
].join('\n')

/** 生成可直接打印的整页 HTML */
export function buildFlashcardsHtml(cards: FlashCard[], options: FlashcardOptions = {}): string {
  const cols    = clamp(options.cols ?? 3, 1, 6)
  const rows    = clamp(options.rows ?? 4, 1, 8)
  const perPage = cols * rows
  const title   = options.title || '单词卡'

  const pages: FlashCard[][] = []
  for (let i = 0; i < cards.length; i += perPage) pages.push(cards.slice(i, i + perPage))
  if (pages.length === 0) pages.push([])

  const grid = ' style="grid-template-columns: repeat(' + cols +
    ', 1fr); grid-template-rows: repeat(' + rows + ', 1fr)"'
  // 正面页全排在前、反面页全排在后，打印时前半段是正面，翻面后再打后半段
  const fronts: string[] = []
  const backs: string[] = []

  pages.forEach((group, gi) => {
    const padded: (FlashCard | null)[] = group.slice()
    while (padded.length < perPage) padded.push(null)

    fronts.push('<div class="sheet-label">第 ' + (gi + 1) + ' 页 · Group ' + (gi + 1) + ' FRONT</div>')
    fronts.push('<div class="a4-sheet"' + grid + '>')
    padded.forEach((card, idx) => {
      if (!card) { fronts.push('<div class="card front empty"></div>'); return }
      fronts.push('<div class="card front"><span class="card-num">' + (gi * perPage + idx + 1) +
        '</span><div class="word">' + escHtml(card.word) + '</div></div>')
    })
    fronts.push('</div>')

    backs.push('<div class="sheet-label">第 ' + (pages.length + gi + 1) + ' 页 · Group ' + (gi + 1) + ' BACK</div>')
    backs.push('<div class="a4-sheet"' + grid + '>')
    mirrorRows(padded, cols, rows).forEach(card => {
      if (!card) { backs.push('<div class="card back empty"></div>'); return }
      const phonetic = card.phonetic
        ? '<div class="phonetic">' + escHtml(card.phonetic) + '</div>'
        : ''
      // 反面只印音标 + 中文那一行，英文释义不上卡片
      backs.push('<div class="card back">' + phonetic + '<div class="translation">' +
        escHtml(card.translation || '—') + '</div></div>')
    })
    backs.push('</div>')
  })

  const body = fronts.concat(backs)

  const meta = [
    escHtml(title),
    cards.length + ' 词',
    pages.length + ' 组 / ' + pages.length * 2 + ' 页',
    cols + ' × ' + rows + ' 张',
  ]
  if (options.startedAt) meta.push('开始学习 ' + formatStamp(options.startedAt))

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
    '<div class="meta">' + meta.join(' · ') + '</div>',
    '<button id="btn-print" onclick="window.print()">打 印</button>',
    '<div class="tip">① 先打印' + pageRange(1, pages.length) + '（正面）→ ② 整叠纸翻面放回纸盒 → ③ 再打印' +
      pageRange(pages.length + 1, pages.length * 2) + '（反面）<br>' +
      '每行列顺序已自动镜像，裁切后正反面自动对齐</div>',
    '</div>',
    '<div id="print-area">',
    body.join('\n'),
    '</div>',
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
