import { useEffect, useMemo, useRef, useState } from 'react'
import { createWorker } from 'tesseract.js'
import { useVocabMatch } from '../hooks/useSearch'
import { useDictPrefetch } from '../hooks/useDictPrefetch'
import type { StudyListApi, ImportItem } from '../hooks/useStudyList'
import type { DictionaryEntry, VocabLibrary } from '../types/vocab'
import {
  formatTranslationWithCustom, selectedTranslationOptions,
  translationOptions, translationPosLabel,
} from '../utils/translations'
import { PageHeader } from '../components/PageHeader'
import { Button, Checkbox, Input, Modal, Select, Tag, TextArea } from '../ui'
import type { SelectOption } from '../ui'
import './ImportPage.css'

/** 词库筛选的特殊取值 */
const NO_FILTER = ''
const ANY_LIB   = '__any__'

/** 预览最多渲染多少行，避免粘贴几千行时卡住 */
const PREVIEW_LIMIT = 200
/** 与服务端单次批量查询上限一致；超过时自动分批，用户仍只操作一次。 */
const SEARCH_BATCH_SIZE = 200
/** 单批查询最长等待时间，避免外部词典一直 pending 时按钮永久转圈。 */
const SEARCH_REQUEST_TIMEOUT_MS = 90_000
/** 网络错误、超时和服务端临时错误自动重试一次；客户端错误不重试。 */
const SEARCH_REQUEST_MAX_RETRIES = 1
const SEARCH_REQUEST_RETRY_DELAY_MS = 600
const MAX_PICKED_TRANSLATIONS = 12
/** 与服务端 MAX_CUSTOM_TRANSLATIONS 一致：一个词最多 6 条自定义词义 */
const MAX_CUSTOM_TRANSLATIONS = 6
const RANDOM_COUNT_OPTIONS: SelectOption[] = [5, 10, 20, 50, 100].map(count => ({
  value: String(count), label: count + ' 个',
}))

/**
 * 过滤英文模型在中文/混合图片上的“英文幻觉”。
 * 仅检查字母会把中文笔画误判成大量拉丁字符，因此还要结合行置信度、字符比例和重复度。
 */
function englishOcrText(lines: Array<{ text: string; confidence: number }>): string {
  return lines
    .filter(line => {
      const text = line.text.trim()
      const letters = text.match(/[A-Za-z]/g) ?? []
      const compact = text.replace(/\s/g, '')
      const punctuation = compact.match(/[^A-Za-z0-9'’.,!?;:%()\-]/g) ?? []
      const uniqueLetters = new Set(letters.map(letter => letter.toLowerCase())).size
      const oneLetterWords = text.split(/\s+/).filter(word => /^[A-Za-z]$/.test(word)).length
      return line.confidence >= 55
        && letters.length >= 2
        && letters.length / Math.max(compact.length, 1) >= .45
        && punctuation.length / Math.max(compact.length, 1) <= .25
        && uniqueLetters / letters.length >= .2
        && oneLetterWords <= 3
        && !/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(text)
    })
    .map(line => line.text.trim())
    .join('\n')
    .trim()
}

import { apiFetch } from '../utils/apiBase'
import { primaryVocabId } from '../utils/vocabOrder'

type RowState = 'keep' | 'filtered' | 'dup-text' | 'dup-list'

interface Row {
  /** 在原始输入中的行号，用于导入后只移除真正成功的那一次输入 */
  inputIndex: number
  raw: string
  key: string
  type: 'word' | 'sentence'
  sourceIds: string[]
  /** 命中的词库：整行本身收录它的词库，句子则是「句中出现过其词条」的词库 */
  hitIds: string[]
  existingBatchKey?: string
  state: RowState
}

/** 词库筛选标签行里的一档 */
interface FilterTag {
  value: string
  label: string
  title: string
  count?: number
}

interface BatchSearchResult {
  word: string
  ok: boolean
  entry?: DictionaryEntry
  error?: { message?: string }
}

interface ImportUndoItem {
  text: string
  translationIds?: string[]
  customTranslations?: string[]
}

export interface ImportUndoSnapshot {
  listId: string
  items: ImportUndoItem[]
}

interface QueryProgress {
  phase: 'preparing' | 'querying' | 'retrying'
  batch: number
  batches: number
  done: number
  total: number
  retry?: number
}

/** 与服务端保持一致的归一化规则：去首尾空白 + 压缩空白 + 小写 */
function normalize(input: string): string {
  return input.trim().replace(/\s+/g, ' ').toLowerCase()
}

function capitalizeSentence(input: string): string {
  return input.trim().replace(/\s+/g, ' ').replace(/[A-Za-z]/, letter => letter.toUpperCase())
}

/** 从自定义分组键 b:时间戳-随机 里取出时间戳，用于把分组按新建时间倒序排 */
const batchKeyTs = (key: string): number => {
  const m = /^b:(\d+)-/.exec(key)
  return m ? Number(m[1]) : 0
}

/** 词条加入时间 → 自然日分组键，形如 2026-10-12（本地时区），与学习列表分组键一致 */
const dayBatchKey = (ts: number): string => {
  const d = new Date(ts)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return d.getFullYear() + '-' + mm + '-' + dd
}

/** 分组键是不是自然日（否则就是自定义分组 b:...） */
const isDateKey = (key: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(key)

/** 自然日分组键 → 当天 0 点时间戳，用于按时间排序 */
const dateKeyTs = (key: string): number => {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, m - 1, d).getTime()
}

/** 分组下拉里一个键显示成什么：自定义名 > 自然日（今天/昨天标注）> 自定义分组 */
function batchKeyLabel(key: string, names: Record<string, string>): string {
  if (names[key]) return names[key]
  if (!isDateKey(key)) return '自定义分组'
  const [y, m, d] = key.split('-').map(Number)
  const now = new Date()
  now.setHours(0, 0, 0, 0)
  const that = new Date(y, m - 1, d).getTime()
  const diff = Math.round((now.getTime() - that) / 86400000)
  const sameYear = y === now.getFullYear()
  const base = sameYear ? (m + ' 月 ' + d + ' 日') : (y + ' 年 ' + m + ' 月 ' + d + ' 日')
  if (diff === 0) return base + '（今天）'
  if (diff === 1) return base + '（昨天）'
  return base
}

/** 把句子拆成单词，用来判断句子里有没有某个词库的词 */
function tokenize(key: string): string[] {
  return key
    .split(/[^a-z'-]+/)
    .map(token => token.replace(/^[-']+/, '').replace(/[-']+$/, ''))
    .filter(Boolean)
}

/** 句中取词时的宽松回退：连字符两侧的词 + 最常见的复数/时态形式，免得 apples 匹配不到 apple */
function wordForms(token: string): string[] {
  const forms = [token]
  if (token.includes('-')) forms.push(...token.split('-').filter(Boolean))
  for (const base of [...forms]) {
    if (base.length < 4) continue
    if (base.endsWith('ies')) forms.push(base.slice(0, -3) + 'y')
    else if (base.endsWith('es')) forms.push(base.slice(0, -2), base.slice(0, -1))
    else if (base.endsWith('s')) forms.push(base.slice(0, -1))
    if (base.endsWith('ed')) forms.push(base.slice(0, -2), base.slice(0, -1))
    if (base.endsWith('ing')) forms.push(base.slice(0, -3), base.slice(0, -3) + 'e')
  }
  return forms
}

const STATE_LABEL: Record<RowState, string> = {
  'keep':     '将导入',
  'filtered': '不在所选词库',
  'dup-text': '本次重复',
  'dup-list': '列表已有',
}

/**
 * 过滤开关开启时，删除数字和中文，但保留英文句子及常用标点。
 * 例如「1. but conj. 但是，不过。」会变成「but conj.」。
 */
function filterEnglishText(input: string): string {
  return input
    .split(/\r?\n/)
    .map(line => line
      .replace(/[0-9０-９\u3400-\u9fff]/g, '')
      .replace(/[^A-Za-z'’.,!?;:()\-\s]/g, ' ')
      .replace(/^\s*[.,!?;:]+(?=\s)/, '')
      .replace(/[ \t]+/g, ' '),
    )
    // 不删除空行：受控 TextArea 在行尾按 Enter 时会先产生一个空行，
    // 这里删掉它会立刻把光标所在的换行改回去，导致用户无法继续输入下一行。
    .join('\n')
}

interface ImportPageProps {
  libraries: VocabLibrary[]
  getLabelById: (id: string) => string
  study: StudyListApi
  /** 点「+ 新建列表」跳到设置页的学习列表分区统一管理 */
  onManageLists: () => void
  /** 嵌入查词页时不画自己的 .page 容器和标题，由查词页提供版式 */
  embedded?: boolean
  /**
   * 撤销快照放在 App 状态中枢：切到学习列表再回到查词页仍可撤销，
   * 直到新的导入 / 新的词输入把它覆盖或清掉。
   */
  undoSnapshot: ImportUndoSnapshot | null
  onUndoSnapshotChange: (snapshot: ImportUndoSnapshot | null) => void
}

export function ImportPage({
  libraries, getLabelById, study, onManageLists, embedded,
  undoSnapshot, onUndoSnapshotChange: setUndoSnapshot,
}: ImportPageProps) {
  const { lists, importItems, fetchListWords, fetchBatches, moveItemBatch, removeItems } = study
  const { getSourceIds } = useVocabMatch(libraries)

  const [text, setText]                 = useState('')
  const [filterLibId, setFilterLibId]   = useState<string>(NO_FILTER)
  const [filterNonWords, setFilterNonWords] = useState(true)
  const [keepSentences, setKeepSentences] = useState(false)
  const [randomLibraryId, setRandomLibraryId] = useState('')
  const [randomCount, setRandomCount] = useState('10')
  const [replaceText, setReplaceText] = useState('')
  const [targetList, setTargetList]     = useState('default')
  const [importing, setImporting]       = useState(false)
  const [queryProgress, setQueryProgress] = useState<QueryProgress | null>(null)
  const [result, setResult]             = useState<{ added: number; skipped: number; queued: number; suspect: number; moved?: number } | null>(null)
  const [undoMessage, setUndoMessage] = useState('')
  const [error, setError]               = useState('')
  const [existing, setExisting]         = useState<Map<string, string>>(new Map())
  const [moveExisting, setMoveExisting] = useState<Set<string>>(new Set())
  const [reloadToken, setReloadToken]   = useState(0)
  const [pickerRows, setPickerRows]     = useState<Row[]>([])
  const [pickerEntries, setPickerEntries] = useState<Map<string, DictionaryEntry>>(new Map())
  const [pickerErrors, setPickerErrors]   = useState<Map<string, string>>(new Map())
  const [pickerSelected, setPickerSelected] = useState<Map<string, string[]>>(new Map())
  const [restorePickerSelections, setRestorePickerSelections] = useState<Map<string, Pick<ImportUndoItem, 'translationIds' | 'customTranslations'>>>(new Map())
  // 分组选择：默认今天的自然日分组键；也可选任意已有分组（自然日或自定义 b:...）
  const [batchChoice, setBatchChoice] = useState(() => dayBatchKey(Date.now()))
  const [batchNames, setBatchNames] = useState<Record<string, string>>({})
  const [listBatchKeys, setListBatchKeys] = useState<Set<string>>(new Set())
  const [addingBatch, setAddingBatch] = useState(false)
  const [newBatchName, setNewBatchName] = useState('')
  const [pendingBatch, setPendingBatch] = useState<{ key: string; name: string } | null>(null)
  const [pickerOpen, setPickerOpen]     = useState(false)
  const [pickerSaving, setPickerSaving] = useState(false)
  const [pickerCustoms, setPickerCustoms] = useState<Map<string, string[]>>(new Map())
  const [pickerCustomDraft, setPickerCustomDraft] = useState<Map<string, string>>(new Map())
  const [ocrBusy, setOcrBusy] = useState(false)
  const [ocrStatus, setOcrStatus] = useState('')
  const [ocrError, setOcrError] = useState('')
  const cameraInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (libraries.length > 0 && !libraries.some(library => library.id === randomLibraryId)) {
      setRandomLibraryId(libraries[0].id)
    }
  }, [libraries, randomLibraryId])

  // 导入接口立即返回；中文已在查询阶段确定，这里只盯后台补音标的进度。
  const prefetch = useDictPrefetch()

  /** 手机端拍照后用 Tesseract.js 识别文字，并追加回填到批量导入框。 */
  async function handleOcrPhoto(file: File | undefined) {
    if (!file) return
    setOcrBusy(true)
    setOcrStatus('正在准备识别…')
    setOcrError('')
    try {
      const worker = await createWorker('eng', 1, {
        logger: message => {
          if (message.status === 'recognizing text') {
            setOcrStatus('正在识别文字 ' + Math.round(message.progress * 100) + '%')
          }
        },
      })
      try {
        const { data } = await worker.recognize(file)
        const ocrData = data as unknown as { text: string; lines?: Array<{ text: string; confidence: number }> }
        const lines = ocrData.lines ?? ocrData.text.split(/\r?\n/).map(text => ({ text, confidence: 100 }))
        const recognized = englishOcrText(lines)
        if (!recognized) {
          setOcrError('没有识别到英文文字，非英文内容已忽略')
          return
        }
        setText(previous => {
          const next = previous.trim() ? previous.trimEnd() + '\n' + recognized : recognized
          return filterNonWords ? filterEnglishText(next) : next
        })
        setResult(null)
        setUndoSnapshot(null)
        setUndoMessage('')
        setOcrStatus('识别完成')
      } finally {
        await worker.terminate()
      }
    } catch {
      setOcrError('拍照识别失败，请检查网络后重试')
      setOcrStatus('')
    } finally {
      setOcrBusy(false)
      if (cameraInputRef.current) cameraInputRef.current.value = ''
    }
  }

  /** 从选定词库随机抽词，并追加到输入框；已存在于输入框或目标列表的词不会重复添加。 */
  function addRandomWords() {
    const library = libraries.find(item => item.id === randomLibraryId)
    if (!library) return
    const count = Number(randomCount)
    const existingKeys = new Set(text.split(/\r?\n/).map(normalize).filter(Boolean))
    const listKeys = new Set([...existing.keys()].map(normalize))
    const candidates = library.words.filter(word => {
      const key = normalize(word.word)
      return !existingKeys.has(key) && !listKeys.has(key)
    })
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      const item = candidates[i]
      candidates[i] = candidates[j]
      candidates[j] = item
    }
    const selected = candidates.slice(0, count).map(item => item.word)
    if (selected.length === 0) return
    setText(previous => {
      const next = previous.trim() ? previous.trimEnd() + '\n' + selected.join('\n') : selected.join('\n')
      return filterNonWords ? filterEnglishText(next) : next
    })
    setResult(null)
    setUndoSnapshot(null)
    setUndoMessage('')
  }

  /** 将输入框中所有匹配文本替换为空；按普通文本匹配，不执行正则。 */
  function removeTextFromInput() {
    const target = replaceText
    if (!target || !text) return
    setText(previous => previous.split(target).join(''))
    setResult(null)
    setUndoSnapshot(null)
    setUndoMessage('')
  }

  /** 预览行右侧的 ×：把这一行从输入框里删掉（inputIndex 就是原始文本里的行号） */
  function removePreviewRow(inputIndex: number) {
    const row = rows.find(item => item.inputIndex === inputIndex)
    if (!row) return
    setText(previous => previous.split('\n').filter(line => normalize(line) !== row.key).join('\n'))
    setResult(null)
    setUndoSnapshot(null)
    setUndoMessage('')
  }

  /** 词义弹窗里每行右侧的 ×：这一条不导入；输入框内容保留，之后仍可重新查询 */
  function removePickerRow(key: string) {
    setPickerRows(previous => previous.filter(row => row.key !== key))
    setPickerSelected(previous => {
      const next = new Map(previous)
      next.delete(key)
      return next
    })
    setPickerCustoms(previous => {
      const next = new Map(previous)
      next.delete(key)
      return next
    })
  }

  // 目标列表已有的词条，用于预览时标出「列表已有」
  useEffect(() => {
    let alive = true
    fetchListWords(targetList).then(items => {
      if (!alive) return
       setExisting(new Map(items.map(i => [normalize(i.word), i.batchKey || dayBatchKey(i.addedAt)])))
      const keys = new Set<string>()
      for (const it of items) keys.add(it.batchKey || dayBatchKey(it.addedAt))
      setListBatchKeys(keys)
    })
    fetchBatches(targetList).then(names => { if (alive) setBatchNames(names) })
    return () => { alive = false }
  }, [targetList, fetchListWords, fetchBatches, reloadToken])

  // 目标列表被删掉时回退到默认列表
  useEffect(() => {
    if (lists.length > 0 && !lists.some(l => l.id === targetList)) {
      setTargetList('default')
      setUndoSnapshot(null)
    }
  }, [lists, targetList])

  // 切换目标列表时把分组选择重置回今天；只在列表真的变化时清撤销快照。
  // 不能用「首次挂载」标记：StrictMode 下挂载副作用会跑两遍，会误判成切换并把跨页
  // 保留的撤销快照清掉（切到学习列表再回来就看不到撤销按钮了）。
  const prevListRef = useRef(targetList)
  useEffect(() => {
    if (prevListRef.current === targetList) return
    prevListRef.current = targetList
    setUndoSnapshot(null)
    setBatchChoice(dayBatchKey(Date.now()))
    setPendingBatch(null)
    setAddingBatch(false)
    setNewBatchName('')
  }, [targetList, setUndoSnapshot])

  /** 句子里出现过的词库 id（去重）：句子的筛选按「含该词库的词」判断 */
  function tokenSourceIds(key: string): string[] {
    const ids = new Set<string>()
    for (const token of tokenize(key)) {
      for (const form of wordForms(token)) {
        for (const id of getSourceIds(form)) ids.add(id)
      }
    }
    return Array.from(ids)
  }

  const rows = useMemo<Row[]>(() => {
    const seen = new Set<string>()
    const out: Row[] = []
    for (const [inputIndex, line] of text.split('\n').entries()) {
      const key = normalize(line)
      if (!key) continue
      const sourceIds = getSourceIds(key)
      // 与服务端一致：命中词库的条目算 word（含 "a few" 这类固定短语），否则含空白即句子
      const type: Row['type'] = sourceIds.length > 0 || !/\s/.test(key) ? 'word' : 'sentence'
      // 单词看自己属不属于词库，句子看里面有没有该词库的词
      const hitIds = type === 'sentence' ? tokenSourceIds(key) : sourceIds

      let state: RowState = 'keep'
      const skipFilter = filterLibId === NO_FILTER || (keepSentences && type === 'sentence')
      if (!skipFilter) {
        const hit = filterLibId === ANY_LIB
          ? hitIds.length > 0
          : hitIds.includes(filterLibId)
        if (!hit) state = 'filtered'
      }
      if (state === 'keep' && seen.has(key)) state = 'dup-text'
       if (state === 'keep' && existing.has(key)) state = 'dup-list'

      seen.add(key)
      const raw = type === 'sentence' ? capitalizeSentence(line) : line.trim()
       out.push({ inputIndex, raw, key, type, sourceIds, hitIds, state, existingBatchKey: existing.get(key) })
    }
    return out
  }, [text, filterLibId, keepSentences, existing, getSourceIds])

  const stats = useMemo(() => {
    let keep = 0, filtered = 0, dup = 0, sentences = 0
    for (const r of rows) {
      if (r.state === 'keep') keep++
      else if (r.state === 'filtered') filtered++
      else dup++
      if (r.type === 'sentence') sentences++
    }
    return { total: rows.length, keep, filtered, dup, sentences }
  }, [rows])

  /** 批量执行与首页一致的完整查词链路；单项失败不会阻塞其他项目。 */
  async function loadTranslationEntries(
    targetRows: Row[],
    onProgress?: (progress: QueryProgress) => void,
  ) {
    const words = targetRows.map(row => row.type === 'sentence' ? row.raw : row.key)
    const next = new Map<string, DictionaryEntry>()
    const errors = new Map<string, string>()
    const batches = Math.max(1, Math.ceil(words.length / SEARCH_BATCH_SIZE))
    for (let start = 0; start < words.length; start += SEARCH_BATCH_SIZE) {
      const requestWords = words.slice(start, start + SEARCH_BATCH_SIZE)
      const batchIndex = Math.floor(start / SEARCH_BATCH_SIZE) + 1
      let response: Response | null = null
      let finalFailure = ''

      for (let attempt = 0; attempt <= SEARCH_REQUEST_MAX_RETRIES; attempt++) {
        onProgress?.({
          phase: attempt === 0 ? 'querying' : 'retrying',
          batch: batchIndex,
          batches,
          done: start,
          total: words.length,
          retry: attempt,
        })
        const controller = new AbortController()
        const timeout = window.setTimeout(() => controller.abort(), SEARCH_REQUEST_TIMEOUT_MS)
        try {
          response = await apiFetch('/api/dict/search-batch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ words: requestWords }),
            signal: controller.signal,
          })
          if (response.ok) break
          // 408 / 429 / 5xx 属于可能恢复的临时错误；400、401 等直接报错，避免无意义重试。
          if (attempt < SEARCH_REQUEST_MAX_RETRIES
            && (response.status === 408 || response.status === 429 || response.status >= 500)) {
            await new Promise(resolve => window.setTimeout(resolve, SEARCH_REQUEST_RETRY_DELAY_MS))
            continue
          }
          break
        } catch {
          const timedOut = controller.signal.aborted
          finalFailure = timedOut
            ? '第 ' + batchIndex + ' 批查询超过 90 秒'
            : '第 ' + batchIndex + ' 批查询连接失败，请检查网络或 Worker 状态'
          if (attempt >= SEARCH_REQUEST_MAX_RETRIES) throw new Error(finalFailure)
          await new Promise(resolve => window.setTimeout(resolve, SEARCH_REQUEST_RETRY_DELAY_MS))
        } finally {
          window.clearTimeout(timeout)
        }
      }

      if (!response || !response.ok) {
        let detail = ''
        const status = response?.status
        try {
          const body = await response?.json() as { error?: string; message?: string } | undefined
          detail = body?.error || body?.message || ''
        } catch { /* 非 JSON 错误响应 */ }
        throw new Error(finalFailure || ('第 ' + batchIndex + ' 批查询失败（HTTP ' + status + '）') + (detail ? '：' + detail : ''))
      }
      const batchResult = await response.json() as { results?: BatchSearchResult[] }
      for (const result of batchResult.results ?? []) {
        const key = normalize(result.word)
        if (result.entry) next.set(key, result.entry)
        if (!result.ok) errors.set(key, result.error?.message || '未获取到中文翻译')
      }
      onProgress?.({
        phase: 'querying',
        batch: batchIndex,
        batches,
        done: Math.min(start + requestWords.length, words.length),
        total: words.length,
      })
    }
    return { entries: next, errors }
  }

  function openTranslationPicker(
    targetRows: Row[], entries: Map<string, DictionaryEntry>, errors: Map<string, string>,
  ) {
    const selected = new Map<string, string[]>()
    const customs = new Map<string, string[]>()
    for (const row of targetRows) {
      const choices = translationOptions(entries.get(row.key)?.translations ?? [])
      const restored = restorePickerSelections.get(row.key)
      selected.set(row.key, restored?.translationIds ?? (row.type === 'sentence' && choices.length === 1 ? [choices[0].id] : []))
      if (restored?.customTranslations?.length) customs.set(row.key, restored.customTranslations)
    }
    setPickerRows(targetRows)
    setPickerEntries(entries)
    setPickerErrors(errors)
    setPickerSelected(selected)
    setPickerCustoms(customs)
    setPickerCustomDraft(new Map())
    setPickerOpen(true)
    setRestorePickerSelections(new Map())
  }

  function toggleTranslation(word: string, id: string) {
    setPickerSelected(prev => {
      const next = new Map(prev)
      const current = next.get(word) ?? []
      if (current.includes(id)) next.set(word, current.filter(item => item !== id))
      else if (current.length < MAX_PICKED_TRANSLATIONS) next.set(word, current.concat(id))
      return next
    })
  }

  function toggleAllTranslations(word: string, entry?: DictionaryEntry) {
    const available = translationOptions(entry?.translations ?? []).slice(0, MAX_PICKED_TRANSLATIONS)
    setPickerSelected(prev => {
      const next = new Map(prev)
      const current = next.get(word) ?? []
      const allSelected = available.length > 0 && available.every(item => current.includes(item.id))
      next.set(word, allSelected ? [] : available.map(item => item.id))
      return next
    })
  }

  function customDraftOf(word: string): string {
    return pickerCustomDraft.get(word) ?? ''
  }

  function setCustomDraft(word: string, value: string) {
    setPickerCustomDraft(prev => {
      const next = new Map(prev)
      next.set(word, value)
      return next
    })
  }

  function addCustomTranslation(word: string) {
    const text = (pickerCustomDraft.get(word) ?? '').trim()
    if (!text) return
    setPickerCustoms(prev => {
      const current = prev.get(word) ?? []
      if (current.includes(text) || current.length >= MAX_CUSTOM_TRANSLATIONS) return prev
      const next = new Map(prev)
      next.set(word, current.concat(text))
      return next
    })
    setPickerCustomDraft(prev => {
      const next = new Map(prev)
      next.set(word, '')
      return next
    })
  }

  function removeCustomTranslation(word: string, index: number) {
    setPickerCustoms(prev => {
      const current = prev.get(word) ?? []
      const next = new Map(prev)
      next.set(word, current.filter((_, i) => i !== index))
      return next
    })
  }

  function isSpellingSuspect(row: Row, entry?: DictionaryEntry): boolean {
    return !/\s/.test(row.key)
      && row.sourceIds.length === 0
      && entry?.spellingStatus === 'suspect'
  }

  async function moveSelectedExistingRows() {
    const batchName = pendingBatch && pendingBatch.key === batchChoice ? pendingBatch.name : batchNames[batchChoice]
    const moveRows = rows.filter(row => row.state === 'dup-list' && moveExisting.has(row.key))
    const latestItems = await fetchListWords(targetList)
    const latestByWord = new Map(latestItems.map(item => [normalize(item.word), item]))
    const movedInputIndexes = new Set<number>()
    const undoItems: ImportUndoItem[] = []
    let moved = 0
    for (const row of moveRows) {
      if (await moveItemBatch(targetList, row.key, batchChoice, batchName)) {
        moved++
        movedInputIndexes.add(row.inputIndex)
        const item = latestByWord.get(row.key)
        undoItems.push({
          text: row.raw,
          translationIds: item?.translationIds,
          customTranslations: item?.customTranslations,
        })
      }
    }
    if (moved > 0) {
      setText(rows.filter(row => !movedInputIndexes.has(row.inputIndex)).map(row => row.raw).join('\n'))
      setResult({ added: 0, skipped: 0, queued: 0, suspect: 0, moved })
      setMoveExisting(new Set())
      setUndoSnapshot({ listId: targetList, items: undoItems })
      setUndoMessage('')
      setReloadToken(t => t + 1)
      if (batchChoice) setPendingBatch(null)
    }
    return moved
  }

  async function undoLastImport() {
    // 撤销永远针对当初导入的那份快照；跨页回来后当前选中的列表可能已经变了
    if (!undoSnapshot) return
    const listId = undoSnapshot.listId
    setImporting(true)
    setError('')
    try {
      const result = await removeItems(listId, undoSnapshot.items.map(item => item.text))
      if (!result) {
        setError('撤销失败，请确认云端服务可用')
        return
      }
      setText(undoSnapshot.items.map(item => item.text).join('\n'))
      setRestorePickerSelections(new Map(undoSnapshot.items.map(item => [
        normalize(item.text), {
          translationIds: item.translationIds,
          customTranslations: item.customTranslations,
        },
      ])))
      setUndoMessage('已撤销本次导入，并将 ' + result.removed + ' 条内容放回输入框')
      setUndoSnapshot(null)
      setResult(null)
      setReloadToken(t => t + 1)
    } finally {
      setImporting(false)
    }
  }

  async function handleImport() {
    if (stats.keep === 0) {
      if (moveExisting.size === 0) return
      setImporting(true)
      setError('')
      try {
        await moveSelectedExistingRows()
      } finally {
        setImporting(false)
      }
      return
    }
    setImporting(true)
    setQueryProgress({ phase: 'preparing', batch: 0, batches: 1, done: 0, total: stats.keep })
    setResult(null)
    setUndoSnapshot(null)
    setUndoMessage('')
    setError('')
    try {
      const targetRows = rows.filter(r => r.state === 'keep')
      const { entries, errors } = await loadTranslationEntries(targetRows, setQueryProgress)
      openTranslationPicker(targetRows, entries, errors)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '词义查询失败，请确认云端服务可用')
    } finally {
      setImporting(false)
      setQueryProgress(null)
    }
  }

  function queryProgressText(progress: QueryProgress): string {
    if (progress.phase === 'preparing') return '正在整理 ' + progress.total + ' 条输入...'
    if (progress.phase === 'retrying') {
      return '第 ' + progress.batch + ' / ' + progress.batches + ' 批响应较慢，正在自动重试（' + (progress.retry ?? 1) + '/1）'
    }
    return '正在查询第 ' + progress.batch + ' / ' + progress.batches + ' 批，已完成 ' + progress.done + ' / ' + progress.total + ' 条'
  }

  async function confirmImport() {
    if (pickerRows.length === 0) return
    setPickerSaving(true)
    const candidates: { row: Row; item: ImportItem }[] = pickerRows.flatMap(row => {
      const entry = pickerEntries.get(row.key)
      if (!entry || pickerErrors.has(row.key) || isSpellingSuspect(row, entry)) return []
      const customs = pickerCustoms.get(row.key) ?? []
      // 词典没有中文但用户自己填了词义，也允许导入；否则保持「缺中文不导入」
      if (!entry.translation && customs.length === 0) return []
      const translationIds = pickerSelected.get(row.key) ?? []
      const translation = formatTranslationWithCustom(
        selectedTranslationOptions(entry.translations ?? [], translationIds),
        customs,
      ) || entry.translation
      return [{
        row,
        item: {
          text: row.raw,
          sourceIds: row.sourceIds,
          phonetic: entry.phonetic,
          translationIds,
          translation,
          customTranslations: customs.length > 0 ? customs : undefined,
        },
      }]
    })
    if (candidates.length === 0 && moveExisting.size === 0) {
      setError('没有成功获取中文词义的项目，暂时无法导入')
      setPickerSaving(false)
      return
    }

    // 弹窗打开后列表可能已在别处发生变化；提交前再确认一次，已有项不提交并继续留在输入框。
    const latestItems = await fetchListWords(targetList)
    const latestKeys = new Set(latestItems.map(item => normalize(item.word)))
    const pendingCandidates = candidates.filter(({ row }) => !latestKeys.has(row.key))
    const alreadyExistingCount = candidates.length - pendingCandidates.length
    const res = pendingCandidates.length > 0
      ? await importItems(targetList, pendingCandidates.map(({ item }) => item), batchChoice || undefined, pendingBatch && pendingBatch.key === batchChoice ? pendingBatch.name : undefined)
      : { added: 0, skipped: 0, queued: 0 }
    if (res) {
      const movedBefore = new Set<number>()
      const undoItems: ImportUndoItem[] = pendingCandidates.slice(0, res.added).map(({ row, item }) => ({
        text: row.raw,
        translationIds: item.translationIds,
        customTranslations: item.customTranslations,
      }))
      const batchName = pendingBatch && pendingBatch.key === batchChoice ? pendingBatch.name : batchNames[batchChoice]
      const moveRows = rows.filter(row => row.state === 'dup-list' && moveExisting.has(row.key))
      const latestByWord = new Map(latestItems.map(item => [normalize(item.word), item]))
      let moved = 0
      for (const row of moveRows) {
        if (await moveItemBatch(targetList, row.key, batchChoice, batchName)) {
          moved++
          movedBefore.add(row.inputIndex)
          const item = latestByWord.get(row.key)
          undoItems.push({
            text: row.raw,
            translationIds: item?.translationIds,
            customTranslations: item?.customTranslations,
          })
        }
      }
      const suspect = pickerRows.filter(row => isSpellingSuspect(row, pickerEntries.get(row.key))).length
      setResult({ ...res, skipped: res.skipped + alreadyExistingCount, suspect, moved })
      if (undoItems.length > 0) {
        setUndoSnapshot({ listId: targetList, items: undoItems })
        setUndoMessage('')
      }

      // 服务端按提交顺序处理；正常情况下 pendingCandidates 都会成功。若并发产生跳过，
      // 只按返回的 added 数量移除前面的成功项，其余输入（含重复、筛选项和查询失败项）全部保留。
      const addedInputIndexes = new Set(
        pendingCandidates.slice(0, res.added).map(({ row }) => row.inputIndex),
      )
      setText(rows
        .filter(row => !addedInputIndexes.has(row.inputIndex) && !movedBefore.has(row.inputIndex))
        .map(row => row.raw)
        .join('\n'))
      setMoveExisting(new Set())
      setReloadToken(t => t + 1)
      // 分组名已随这次导入落盘；清掉未保存标记（reloadToken 变化会重新拉分组列表）
      if (batchChoice) setPendingBatch(null)
      if (res.queued > 0) prefetch.watch()
      setPickerOpen(false)
    } else {
      setError('导入失败，请确认云端服务可用')
    }
    setPickerSaving(false)
  }

  const filterActive = filterLibId !== NO_FILTER
  const shown = useMemo(() => {
    const unique = new Map<string, Row>()
    for (const row of rows) {
      if (!unique.has(row.key)) unique.set(row.key, row)
    }
    return Array.from(unique.values()).slice(0, PREVIEW_LIMIT)
  }, [rows])
  const pickerImportableCount = pickerRows.filter(row => (
    !pickerErrors.has(row.key)
    && !isSpellingSuspect(row, pickerEntries.get(row.key))
    && (Boolean(pickerEntries.get(row.key)?.translation)
      || (pickerCustoms.get(row.key) ?? []).length > 0)
  )).length
  const pickerSuspectCount = pickerRows.filter(row => (
    isSpellingSuspect(row, pickerEntries.get(row.key))
  )).length
  const pickerFailedCount = pickerRows.length - pickerImportableCount - pickerSuspectCount

  const filterTags: FilterTag[] = [
    { value: NO_FILTER, label: '全部', title: '不筛选，粘贴的内容全部导入' },
    { value: ANY_LIB, label: '任一词库', title: '只保留任一词库收录的词，以及含这些词的句子' },
    ...libraries.map(lib => ({
      value: lib.id,
      label: getLabelById(lib.id),
      count: lib.words.length,
      title: '只保留「' + getLabelById(lib.id) + '」收录的词，以及含这些词的句子',
    })),
  ]

  const listOptions: SelectOption[] = lists.length > 0
    ? lists.map(l => ({ value: l.id, label: l.name, extra: l.wordCount + ' 条' }))
    : [{ value: 'default', label: '默认列表' }]

  // 下拉可选分组 = 当前列表下的全部分组：分组名表 ∪ 词条上出现过的键 ∪ 今天，按时间倒序；
  // 未保存的新分组置顶，其余（含自然日分组）都能选来导入
  const batchOptions: SelectOption[] = (() => {
    const keys = new Set<string>()
    for (const k of Object.keys(batchNames)) keys.add(k)
    listBatchKeys.forEach(k => keys.add(k))
    keys.add(dayBatchKey(Date.now()))
    if (pendingBatch) keys.delete(pendingBatch.key)
    const sortTs = (k: string) => k.startsWith('b:') ? batchKeyTs(k) : isDateKey(k) ? dateKeyTs(k) : 0
    const sorted = Array.from(keys).sort((a, b) => sortTs(b) - sortTs(a))
    return [
      ...(pendingBatch ? [{ value: pendingBatch.key, label: pendingBatch.name + '（未保存）' }] : []),
      ...sorted.map(k => ({ value: k, label: batchKeyLabel(k, batchNames) })),
    ]
  })()

  /** 确认新建分组：先在本地生成键，等第一次导入时把名字落盘 */
  function confirmNewBatch() {
    const name = newBatchName.trim()
    if (!name) return
    const key = 'b:' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)
    setPendingBatch({ key, name })
    setBatchChoice(key)
    setAddingBatch(false)
    setNewBatchName('')
  }
  function closeNewBatch() {
    setAddingBatch(false)
    setNewBatchName('')
  }

const targetControls = (
  <>
    <div className="import-target">
              <label className="field-label" htmlFor="import-target">导入到</label>
              <Select
                id="import-target"
                aria-label="导入到"
                size="small"
                block={false}
                className="import-target__select"
                value={targetList}
                options={listOptions}
                onChange={value => { setTargetList(value); setResult(null) }}
              />
            </div>
            <Button size="small" onClick={onManageLists}>+ 新建列表</Button>

            <div className="import-target">
              <span className="field-label">分组</span>
              <Select
                aria-label="选择分组"
                size="small"
                block={false}
                className="import-target__select"
                value={batchChoice}
                options={batchOptions}
                onChange={setBatchChoice}
              />
            </div>
            {addingBatch ? (
              <div className="import-new">
                <Input
                  className="import-new__input"
                  size="small"
                  placeholder="分组名称..."
                  value={newBatchName}
                  autoFocus
                  aria-label="新建分组名称"
                  onChange={e => setNewBatchName(e.target.value)}
                  onPressEnter={confirmNewBatch}
                  onKeyDown={e => { if (e.key === 'Escape') closeNewBatch() }}
                />
                <Button type="primary" size="small" disabled={!newBatchName.trim()} onClick={confirmNewBatch}>确定</Button>
                <Button type="text" size="small" onClick={closeNewBatch}>取消</Button>
              </div>
            ) : (
              <Button size="small" onClick={() => setAddingBatch(true)}>+ 新建分组</Button>
            )}

          </>
  )

  // 嵌入搜索页时没有 PageHeader，导入到 / 新建列表单独占一行
  const body = (
    <>
      <div className="import-page__body">
        <div className="import-col">
          <div className="import-section">
            <div className="import-filter">
              <span className="field-label" id="import-filter-label">词库筛选</span>
              <div className="import-filter__tags" role="group" aria-labelledby="import-filter-label">
                {filterTags.map(tag => {
                  const active = tag.value === filterLibId
                  return (
                    <Tag
                      key={tag.value || 'all'}
                      className={'import-filter__tag' + (active ? ' import-filter__tag--active' : '')}
                      title={tag.title}
                      pressed={active}
                      onClick={() => { setFilterLibId(tag.value); setResult(null) }}
                    >
                      {tag.label}
                      {tag.count != null && <span className="import-filter__count">{tag.count}</span>}
                    </Tag>
                  )
                })}
              </div>
            </div>
            <div className="import-filter__options">
              <Checkbox
                className="import-check"
                checked={filterNonWords}
                onChange={e => {
                  const checked = e.target.checked
                  setFilterNonWords(checked)
                  if (checked) setText(previous => filterEnglishText(previous))
                  setResult(null)
                }}
              >
                过滤非单词（数字、中文）
              </Checkbox>
              {filterActive && (
                <Checkbox
                  className="import-check"
                  checked={keepSentences}
                  onChange={e => setKeepSentences(e.target.checked)}
                >
                  句子不参与筛选，始终保留
                </Checkbox>
              )}
            </div>
          </div>

          <div className="import-section">
            <div className="import-label-row">
              <label className="field-label" htmlFor="import-textarea">粘贴内容</label>
              <div className="import-text-actions">
                <div className="import-random-controls">
                  <Select
                    aria-label="随机单词词库"
                    size="small"
                    block={false}
                    className="import-random-controls__library"
                    value={randomLibraryId}
                    options={libraries.map(library => ({ value: library.id, label: getLabelById(library.id) }))}
                    onChange={setRandomLibraryId}
                  />
                  <Select
                    aria-label="随机单词数量"
                    size="small"
                    block={false}
                    className="import-random-controls__count"
                    value={randomCount}
                    options={RANDOM_COUNT_OPTIONS}
                    onChange={setRandomCount}
                  />
                  <Button size="small" disabled={!randomLibraryId} onClick={addRandomWords}>随机单词</Button>
                </div>
                <div className="import-replace-controls">
                  <Input
                    size="small"
                    className="import-replace-controls__input"
                    aria-label="要删除的文本"
                    placeholder="输入要删除的文本"
                    value={replaceText}
                    onChange={event => setReplaceText(event.target.value)}
                    onPressEnter={removeTextFromInput}
                  />
                  <Button size="small" disabled={!replaceText || !text} onClick={removeTextFromInput}>替换为空</Button>
                </div>
                <input ref={cameraInputRef} className="import-camera__input" type="file" accept="image/*" capture="environment"
                  onChange={e => { void handleOcrPhoto(e.target.files?.[0]) }} aria-label="拍照提取文字" />
                <Button className="import-camera__button" size="small" loading={ocrBusy}
                  onClick={() => cameraInputRef.current?.click()}>拍照提取文字</Button>
                {text && <Button type="link" size="small" onClick={() => { setText(''); setResult(null); setUndoSnapshot(null); setUndoMessage('') }}>清空</Button>}
              </div>
            </div>
            {ocrStatus && <p className="import-camera__status" role="status">{ocrStatus}</p>}
            {ocrError && <p className="import-camera__error" role="alert">{ocrError}</p>}
            <TextArea
              id="import-textarea"
              placeholder={'apple\nbanana\nHow are you doing today?\n...'}
              value={text}
              onChange={e => {
                setText(filterNonWords ? filterEnglishText(e.target.value) : e.target.value)
                setResult(null)
                setUndoSnapshot(null)
                setUndoMessage('')
              }}
              rows={14}
              spellCheck={false}
            />
            <p className="hint">
              共 {stats.total} 行（其中句子 {stats.sentences} 条）
              {stats.total > 0 && <> · 将导入 <strong>{stats.keep}</strong> 条 · 重复 {stats.dup} 条 · 筛掉 {stats.filtered} 条</>}
            </p>
          </div>

          <div className="import-actions">
            <Button
              type="primary"
              size="large"
                disabled={stats.keep === 0 && moveExisting.size === 0}
              loading={importing}
              onClick={handleImport}
            >
              {importing
                ? '查询中 ' + (queryProgress ? queryProgress.done + '/' + queryProgress.total : '...')
                : '查询 ' + stats.keep + ' 条'}
            </Button>
            {importing && queryProgress && (
              <div className="import-query-status" role="status" aria-live="polite">
                <span className="ui-spin" aria-hidden="true" />
                <span className="import-query-status__text">{queryProgressText(queryProgress)}</span>
                <span className="import-query-status__hint">单批最长等待 90 秒，网络或服务端临时失败会自动重试 1 次</span>
              </div>
            )}
            {/* 音标还在后台补齐时不展示导入结果和撤销入口，等补齐完成再一起出现 */}
            {result && !prefetch.busy && (
              <div className="callout callout--success import-actions__msg">
                ✓ 成功导入 <strong>{result.added}</strong> 条，跳过重复 <strong>{result.skipped}</strong> 条
                {result.suspect > 0 && <> · 疑似错误 <strong>{result.suspect}</strong> 条未导入</>}
                {result.moved && result.moved > 0 && <> · 已移动 <strong>{result.moved}</strong> 条</>}
                {result.queued > 0 && <> · 缺失音标正在后台补齐</>}
              </div>
            )}
            {undoSnapshot && !prefetch.busy && (
              <div className="import-undo">
                <Button
                  size="small"
                  danger
                  disabled={importing}
                  title="点击后会从导入的学习列表删除这些词，并放回输入框"
                  onClick={() => { void undoLastImport() }}
                >
                  撤销本次导入
                </Button>
              </div>
            )}
            {undoMessage && <div className="callout callout--success import-actions__msg">{undoMessage}</div>}
            {prefetch.busy && (
              <div className="callout callout--warn import-actions__msg">
                {prefetch.state.total > 0
                  ? '正在补齐音标 ' + prefetch.state.done + '/' + prefetch.state.total
                  : '正在补齐音标...'}
                {prefetch.state.failed > 0 && <> · 失败 {prefetch.state.failed} 条</>}
              </div>
            )}
            {prefetch.error && (
              <div className="callout callout--error import-actions__msg">{prefetch.error}</div>
            )}
            {error && <div className="callout callout--error import-actions__msg">{error}</div>}
          </div>

          {rows.length > 0 && (
            <div className="import-section">
              <span className="field-label">预览</span>
              <ul className="import-preview">
                {shown.map((row, i) => (
                  <li key={i} className={'import-row import-row--' + row.state}>
                    <span className="import-row__text">{row.raw}</span>
                    {row.type === 'sentence' && <Tag color="default">句子</Tag>}
                    {primaryVocabId(row.hitIds) && (
                      <Tag color="blue">
                        {row.type === 'sentence' ? '含 ' + getLabelById(primaryVocabId(row.hitIds)!) : getLabelById(primaryVocabId(row.hitIds)!)}
                      </Tag>
                    )}
                    {row.state === 'dup-list' && row.existingBatchKey && (
                      row.existingBatchKey === batchChoice ? (
                        <Tag color="green">当前分组</Tag>
                      ) : (
                        <Checkbox
                          className="import-row__move"
                          checked={moveExisting.has(row.key)}
                          onChange={event => setMoveExisting(previous => {
                            const next = new Set(previous)
                            if (event.target.checked) next.add(row.key)
                            else next.delete(row.key)
                            return next
                          })}
                        >
                          <span className="import-row__move-label">
                            <Tag color="gold">{batchKeyLabel(row.existingBatchKey, batchNames)}</Tag>
                            <span>→ 当前</span>
                          </span>
                        </Checkbox>
                      )
                    )}
                    <span className={'import-state import-state--' + row.state}>{STATE_LABEL[row.state]}</span>
                    <Button
                      type="text"
                      size="small"
                      className="import-row__remove"
                      aria-label={'删除此行：' + row.raw}
                      title="从输入中删除此行"
                      onClick={() => removePreviewRow(row.inputIndex)}
                    >
                      ×
                    </Button>
                  </li>
                ))}
              </ul>
              {new Set(rows.map(row => row.key)).size > PREVIEW_LIMIT && (
                <p className="hint">仅显示前 {PREVIEW_LIMIT} 条，剩余 {new Set(rows.map(row => row.key)).size - PREVIEW_LIMIT} 条仍会按同样规则导入</p>
              )}
            </div>
          )}
        </div>
      </div>

      {pickerOpen && (
        <Modal
          open
          width="wide"
          title="选择要背的中文词义"
          description={'查询成功 ' + pickerImportableCount + ' 条'
            + (pickerSuspectCount > 0 ? '，疑似错误 ' + pickerSuspectCount + ' 条默认不导入' : '')
            + (pickerFailedCount > 0 ? '，查询失败 ' + pickerFailedCount + ' 条将保留以便重试' : '')}
          onClose={() => setPickerOpen(false)}
          footer={
            <div className="import-translation-picker__footer">
              <span className="hint">每个词最多选择 {MAX_PICKED_TRANSLATIONS} 条</span>
              <div className="import-translation-picker__buttons">
                <Button size="small" onClick={() => setPickerOpen(false)}>取消</Button>
                 <Button type="primary" size="small" loading={pickerSaving} disabled={pickerImportableCount === 0 && moveExisting.size === 0} onClick={() => { void confirmImport() }}>
                   {moveExisting.size > 0 ? '确认处理' : '确认导入 ' + pickerImportableCount + ' 条'}
                 </Button>
              </div>
            </div>
          }
        >
          <div className="import-picker-target">{targetControls}</div>
          <div className="import-translation-picker">
            {pickerRows.map(row => {
              const entry = pickerEntries.get(row.key)
              const translations = entry?.translations ?? []
              const selected = pickerSelected.get(row.key) ?? []
              const failed = pickerErrors.get(row.key)
              const spellingSuspect = isSpellingSuspect(row, entry)
              const available = translationOptions(translations).slice(0, MAX_PICKED_TRANSLATIONS)
              const allSelected = available.length > 0 && available.every(item => selected.includes(item.id))
              return (
                <div className="import-translation-row" key={row.key}>
                  <div className="import-translation-row__word">
                    <span>{row.raw}</span>
                    {row.type === 'sentence' && <Tag color="default">句子</Tag>}
                    {spellingSuspect && <Tag color="gold">疑似错误</Tag>}
                    {row.type === 'word' && entry?.phonetic && <span className="import-translation-row__phonetic">{entry.phonetic}</span>}
                    {!failed && !spellingSuspect && available.length > 0 && (
                      <Button type="link" size="small" className="import-translation-row__select-all" onClick={() => toggleAllTranslations(row.key, entry)}>
                        {allSelected ? '取消全选' : '全选'}
                      </Button>
                    )}
                    <Button
                      type="text"
                      size="small"
                      className="import-translation-row__remove"
                      aria-label={'本条不导入：' + row.raw}
                      title="这一条不导入，内容保留在输入框"
                      onClick={() => removePickerRow(row.key)}
                    >
                      ×
                    </Button>
                  </div>
                  {spellingSuspect ? (
                    <span className="import-translation-row__suspect">可能拼写错误：本地词典、免费词典和词库均未命中，本条默认不导入</span>
                  ) : failed ? (
                    <span className="import-translation-row__error">查询失败：{failed}，本条不会导入</span>
                  ) : translations.length > 0 ? (
                    <div className="import-translation-row__groups">
                      {(() => {
                        const groups = new Map<string, ReturnType<typeof translationOptions>>()
                        for (const item of translationOptions(translations)) {
                          const key = item.pos ?? ''
                          const group = groups.get(key) ?? []
                          group.push(item)
                          groups.set(key, group)
                        }
                        return Array.from(groups.entries()).map(([pos, items]) => (
                          <div className="import-translation-row__group" key={pos || 'other'}>
                            {pos && <span className="import-translation-row__pos">{translationPosLabel(pos)}</span>}
                            <div className="import-translation-row__choices">
                              {items.map(item => (
                                <Checkbox
                                  key={item.id}
                                  checked={selected.includes(item.id)}
                                  disabled={!selected.includes(item.id) && selected.length >= MAX_PICKED_TRANSLATIONS}
                                  onChange={() => toggleTranslation(row.key, item.id)}
                                >
                                  {item.text}
                                </Checkbox>
                              ))}
                            </div>
                          </div>
                        ))
                      })()}
                    </div>
                  ) : (
                    <span className="import-translation-row__error">未获取到中文词义；可在下面自定义，否则本条不会导入</span>
                  )}

                  {!spellingSuspect && !failed && (
                    <div className="import-translation-row__custom">
                      {(pickerCustoms.get(row.key) ?? []).map((text, index) => (
                        <Tag
                          key={index}
                          color="green"
                          title="点击移除这条自定义词义"
                          onClick={() => removeCustomTranslation(row.key, index)}
                        >
                          {text}
                        </Tag>
                      ))}
                      <span className="import-translation-row__custom-input">
                        <Input
                          size="small"
                          value={customDraftOf(row.key)}
                          placeholder="自定义词义：词典里没有的也能自己加"
                          maxLength={60}
                          onChange={e => setCustomDraft(row.key, e.target.value)}
                          onPressEnter={() => addCustomTranslation(row.key)}
                        />
                        <Button
                          size="small"
                          disabled={
                            !customDraftOf(row.key).trim()
                            || (pickerCustoms.get(row.key) ?? []).length >= MAX_CUSTOM_TRANSLATIONS
                          }
                          onClick={() => addCustomTranslation(row.key)}
                        >
                          添加
                        </Button>
                      </span>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
       </Modal>
     )}
    </>
  )

  if (embedded) {
    return body
  }

  return (
    <div className="page import-page">
      <PageHeader
        title="批量导入"
        subtitle="每行一个单词或句子，导入前会标出所属词库、重复项和被筛掉的行"
      />
      {body}
    </div>
  )
 }
