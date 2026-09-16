import { useEffect, useMemo, useState } from 'react'
import { PageHeader } from '../components/PageHeader'
import { StudyGoal } from '../components/StudyGoal'
import { Button, Checkbox, Input, Modal, Popconfirm, Select } from '../ui'
import type { SelectOption } from '../ui'
import type { StudyListApi } from '../hooks/useStudyList'
import type { StudyPlanApi, TallyKind } from '../hooks/useStudyPlan'
import { useDictBatch } from '../hooks/useDictBatch'
import { usePrintBatches } from '../hooks/usePrintBatches'
import type {
  PrintBatch, StudyMarkScope, StudyPlanItem, StudyWordItem, VocabLibraryInfo,
} from '../types/vocab'
import { fetchCards, openCardWindow, renderCardsInto } from '../utils/flashcards'
import type { CardRequest, CardWindow } from '../utils/flashcards'
import { formatTranslationOptions, selectedTranslationOptions } from '../utils/translations'
import './StudyPage.css'

const DAY = 86400000
const DEFAULT_LIST_ID = 'default'
/** 月历第一列是周一 */
const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日']

/** 复习计划的粒度：按天一天一批，按周一周一批（导出卡片和打卡都跟着走） */
const MODE_OPTIONS: SelectOption[] = [
  { value: 'day', label: '按天', extra: '每天一批' },
  { value: 'week', label: '按周', extra: '一周一批' },
]

interface Layout {
  value: string
  cols: number
  rows: number
}

const LAYOUTS: Layout[] = [
  { value: '2x3', cols: 2, rows: 3 },
  { value: '3x4', cols: 3, rows: 4 },
  { value: '4x5', cols: 4, rows: 5 },
]

const LAYOUT_OPTIONS: SelectOption[] = LAYOUTS.map(item => ({
  value: item.value,
  label: item.cols + ' 列 × ' + item.rows + ' 行',
  extra: '每页 ' + item.cols * item.rows + ' 张',
}))

function startOfDay(ts: number): number {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** 所在周的周一 0 点，与服务端 startOfWeek 保持一致 */
function startOfWeek(ts: number): number {
  const day = startOfDay(ts)
  const weekday = (new Date(day).getDay() + 6) % 7
  return day - weekday * DAY
}

function fmtDate(ts: number): string {
  const d = new Date(ts)
  return (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日'
}

function fmtShort(ts: number): string {
  const d = new Date(ts)
  return (d.getMonth() + 1) + '/' + d.getDate()
}

/** 一周的日期区间，如 9/8 - 9/14 */
function fmtWeek(week: number): string {
  return fmtShort(week) + ' - ' + fmtShort(week + 6 * DAY)
}

/** 打印记录标题：日批次显示当天，周批次显示周一到周日。 */
function printBatchTitle(batch: PrintBatch): string {
  if (batch.scope !== 'week') return fmtDate(batch.printedAt)
  const week = startOfWeek(batch.printedAt)
  return fmtDate(week) + ' - ' + fmtDate(week + 6 * DAY)
}

function fmtMonth(ts: number): string {
  const d = new Date(ts)
  return d.getFullYear() + ' 年 ' + (d.getMonth() + 1) + ' 月'
}

/** 分组标题：同一年只显示月日，跨年补年份；今天/昨天额外标注 */
function groupDayLabel(day: number, today: number): string {
  const diff = dayDiff(today, day)
  const sameYear = new Date(day).getFullYear() === new Date(today).getFullYear()
  const base = sameYear ? fmtDate(day) : new Date(day).getFullYear() + ' 年 ' + fmtDate(day)
  if (diff === 0) return base + ' · 今天'
  if (diff === 1) return base + ' · 昨天'
  return base
}

/** 词条加入时间 → 自然日串，形如 2026-09-15（本地时区），与学习列表的批次键一致 */
const batchKeyOf = (ts: number) => {
  const d = new Date(ts)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return d.getFullYear() + '-' + mm + '-' + dd
}

/** 批次键反回当天 0 点时间戳，供今天/昨天标注对照 */
const batchKeyTsOf = (key: string) => {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, m - 1, d).getTime()
}

/** 相对 base 偏移 offset 个月的 1 号零点；先归到 1 号，避免 31 号跳月 */
function monthStart(base: number, offset: number): number {
  const d = new Date(base)
  d.setDate(1)
  d.setHours(0, 0, 0, 0)
  d.setMonth(d.getMonth() + offset)
  return d.getTime()
}

const dayDiff = (from: number, to: number) => Math.round((startOfDay(to) - startOfDay(from)) / DAY)
const keyOf = (word: string) => word.trim().replace(/\s+/g, ' ').toLowerCase()

function displayTextOf(item: StudyWordItem): string {
  return item.type === 'sentence' && item.displayText?.trim()
    ? item.displayText.trim()
    : item.word
}

/** 某天相对今天的口语说法 */
function relLabel(day: number, today: number): string {
  const diff = dayDiff(today, day)
  if (diff === 0) return '今天'
  if (diff === 1) return '明天'
  if (diff === -1) return '昨天'
  return diff > 0 ? diff + ' 天后' : -diff + ' 天前'
}

/** 某一周相对本周的口语说法 */
function weekRelLabel(week: number, thisWeek: number): string {
  const diff = Math.round((week - thisWeek) / (7 * DAY))
  if (diff === 0) return '本周'
  if (diff === 1) return '下周'
  if (diff === -1) return '上周'
  return diff > 0 ? diff + ' 周后' : -diff + ' 周前'
}

/** 按列表分组：打卡和留档接口都是按列表调的，而计划里的词可能来自多个列表 */
function groupByList(items: StudyPlanItem[]): Map<string, string[]> {
  const groups = new Map<string, string[]>()
  for (const item of items) {
    const bucket = groups.get(item.listId)
    if (bucket) bucket.push(item.word)
    else groups.set(item.listId, [item.word])
  }
  return groups
}

/** 月历格子：day 为 null 表示月初月末的补位空格 */
interface DayCell {
  key: string
  day: number | null
  count: number
}

type BusyKind = '' | 'print' | 'start' | 'day' | 'custom'
/** spelling / reading / meaning = 熟悉度计数；next = 进入下一轮；again = 没记住 */
type WordAction = 'spelling' | 'reading' | 'meaning'
  | 'spelling-undo' | 'reading-undo' | 'meaning-undo'
  | 'next' | 'again'

/** 会拼 / 会读 / 知意的按钮文案，与 tally 的 successKind 一一对应 */
const TALLY_LABEL: Record<TallyKind, string> = {
  spelling: '会拼',
  reading: '会读',
  meaning: '知意',
}

/** 「−」按钮撤销的维度：本周期内最近一次该维度的计数 */
const UNDO_KIND: Partial<Record<WordAction, TallyKind>> = {
  'spelling-undo': 'spelling',
  'reading-undo': 'reading',
  'meaning-undo': 'meaning',
}
type PrintResult = 'ok' | 'blocked' | 'failed'
type StudyCardRequest = CardRequest & { sourceIds?: string[] }

interface StudyPageProps {
  libraries: VocabLibraryInfo[]
  study: StudyListApi
  plan: StudyPlanApi
  getLabelById: (id: string) => string
  getPrintLabelById: (id: string) => string
}

export function StudyPage({ libraries, study, plan, getLabelById, getPrintLabelById }: StudyPageProps) {
  const { lists, fetchListWords, fetchBatches } = study
  const planData = plan.plan
  const prints   = usePrintBatches()

  const [listId, setListId]             = useState(DEFAULT_LIST_ID)
  const [words, setWords]               = useState<StudyWordItem[]>([])
  const [wordsLoading, setWordsLoading] = useState(false)
  const [picked, setPicked]             = useState<string[]>([])
  const [layout, setLayout]             = useState(LAYOUTS[0].value)
  const [busy, setBusy]                 = useState<BusyKind>('')
  const [progress, setProgress]         = useState<{ done: number; total: number } | null>(null)
  const [notice, setNotice]             = useState('')
  const [error, setError]               = useState('')
  const [reloadToken, setReloadToken]   = useState(0)
  /** 批次显示名：与学习列表共用同一份（按 addedAt 自然日分组），学习列表改名这里同步 */
  const [batchNames, setBatchNames]     = useState<Record<string, string>>({})
  /** 挑词弹窗：draft 是草稿，点取消就丢掉 */
  const [pickOpen, setPickOpen]         = useState(false)
  const [draft, setDraft]               = useState<string[]>([])
  /** 自由打印弹窗：可选择列表里的任意词，只打印、不改变学习进度。 */
  const [cardPickOpen, setCardPickOpen] = useState(false)
  const [cardDraft, setCardDraft]       = useState<string[]>([])
  const [cardSearch, setCardSearch]     = useState('')
  const [quickBatchId, setQuickBatchId] = useState('')
  /** 日历：相对今天所在月的偏移，selectedDay 为 null 表示跟着今天走 */
  const [monthOffset, setMonthOffset]   = useState(0)
  const [selectedDay, setSelectedDay]   = useState<number | null>(null)
  /** 复习粒度：按天一天一批，按周一周一批 */
  const [mode, setMode]                 = useState<StudyMarkScope>('week')
  /** 每个词独立记录操作状态，不阻塞其他词的打卡 */
  const [wordBusy, setWordBusy]         = useState<Record<string, WordAction | undefined>>({})

  // 选中的列表被删掉后回退到默认列表
  useEffect(() => {
    if (lists.length > 0 && !lists.some(l => l.id === listId)) setListId(DEFAULT_LIST_ID)
  }, [lists, listId])

  // 切换列表或打卡后重新拉这个列表的词条
  useEffect(() => {
    let alive = true
    setWordsLoading(true)
    setPicked([])
    setCardDraft([])
    setCardSearch('')
    setQuickBatchId('')
    setCardPickOpen(false)
    fetchListWords(listId).then(items => {
      if (!alive) return
      setWords(items)
      setWordsLoading(false)
    })
    // 批次显示名与学习列表共用，学习列表改名后这里同步
    fetchBatches(listId).then(names => {
      if (!alive) return
      setBatchNames(names)
    })
    return () => { alive = false }
  }, [listId, reloadToken, fetchListWords, fetchBatches])

  const draftSet = useMemo(() => new Set(draft), [draft])
  const cardDraftSet = useMemo(() => new Set(cardDraft), [cardDraft])

  /** 词 -> 这一阶段要背的释义，跟着打印请求一起带上（反面目前只印音标 + 中文） */
  const senseMap = useMemo(
    () => new Map(words.map(w => [w.word, w.senseIds])),
    [words]
  )
  const translationMap = useMemo(
    () => new Map(words.map(w => [w.word, w.translation])),
    [words]
  )
  const phoneticMap = useMemo(
    () => new Map(words.map(w => [w.word, w.phonetic])),
    [words]
  )
  const wordMap = useMemo(
    () => new Map(words.map(word => [word.word, word])),
    [words]
  )
  const availableWordByKey = useMemo(
    () => new Map(words.map(word => [keyOf(word.word), word.word])),
    [words]
  )

  /** 还没开始学的词才能选进新批次 */
  const newWords = useMemo(
    () => words.filter(w => !w.startedAt).sort((a, b) => a.word.localeCompare(b.word)),
    [words]
  )
  /** 挑新词弹窗按加入日期分成批次：与学习列表同键（2026-09-15），显示名直接读同一份 batchNames */
  const newWordGroups = useMemo(() => {
    const groups = new Map<string, StudyWordItem[]>()
    for (const item of newWords) {
      const key = batchKeyOf(item.addedAt)
      const bucket = groups.get(key)
      if (bucket) bucket.push(item)
      else groups.set(key, [item])
    }
    // 自然日串按字典序就是时间序，新日期在上
    return Array.from(groups.entries()).sort((a, b) => b[0].localeCompare(a[0]))
  }, [newWords])
  const printableWords = useMemo(
    () => words.slice().sort((a, b) => displayTextOf(a).localeCompare(displayTextOf(b))),
    [words]
  )
  const filteredPrintableWords = useMemo(() => {
    const query = keyOf(cardSearch)
    if (!query) return printableWords
    return printableWords.filter(item => keyOf(displayTextOf(item)).includes(query))
  }, [printableWords, cardSearch])

  const learningCount = words.length - newWords.length
  const layoutInfo    = LAYOUTS.find(l => l.value === layout) ?? LAYOUTS[0]
  const perPage       = layoutInfo.cols * layoutInfo.rows
  const listName      = lists.find(l => l.id === listId)?.name ?? '学习列表'
  const listOptions: SelectOption[] = lists.map(l => ({
    value: l.id,
    label: l.name,
    extra: l.wordCount + ' 词',
  }))
  const printBatchOptions = useMemo<SelectOption[]>(() => (
    prints.batches.flatMap(batch => {
      const count = batch.items.filter(item => (
        item.listId === listId && availableWordByKey.has(keyOf(item.word))
      )).length
      if (count === 0) return []
      const kind = batch.kind === 'start' ? '新词' : batch.kind === 'review' ? '复习' : '自选'
      return [{
        value: batch.id,
        label: printBatchTitle(batch) + ' · ' + kind,
        extra: count + ' 词',
      }]
    })
  ), [prints.batches, listId, availableWordByKey])

  /** 每天要复习哪些词：已毕业的不进日历，逾期的都折叠到今天 */
  const dueByDay = useMemo(() => {
    const buckets = new Map<number, StudyPlanItem[]>()
    for (const item of planData.items) {
      if (item.nextDueAt == null) continue
      const raw = startOfDay(item.nextDueAt)
      const day = raw < planData.today ? planData.today : raw
      const bucket = buckets.get(day)
      if (bucket) bucket.push(item)
      else buckets.set(day, [item])
    }
    for (const bucket of Array.from(buckets.values())) {
      bucket.sort((a, b) => {
        const da = a.nextDueAt ?? 0
        const db = b.nextDueAt ?? 0
        return da === db ? a.word.localeCompare(b.word) : da - db
      })
    }
    return buckets
  }, [planData])

  const thisWeek = useMemo(() => startOfWeek(planData.today), [planData.today])

  /** 每周要复习哪些词：同一个词一周内可能排到多轮，但计划里只有一条，按周打卡时一次过完 */
  const dueByWeek = useMemo(() => {
    const buckets = new Map<number, StudyPlanItem[]>()
    for (const item of planData.items) {
      if (item.nextDueAt == null) continue
      const raw  = startOfWeek(item.nextDueAt)
      const week = raw < thisWeek ? thisWeek : raw
      const bucket = buckets.get(week)
      if (bucket) bucket.push(item)
      else buckets.set(week, [item])
    }
    for (const bucket of Array.from(buckets.values())) {
      bucket.sort((a, b) => {
        const da = a.nextDueAt ?? 0
        const db = b.nextDueAt ?? 0
        return da === db ? a.word.localeCompare(b.word) : da - db
      })
    }
    return buckets
  }, [planData, thisWeek])

  const monthFirst = useMemo(() => monthStart(planData.today, monthOffset), [planData.today, monthOffset])

  /** 当月格子，前后补空位对齐到整周 */
  const cells = useMemo<DayCell[]>(() => {
    const first = new Date(monthFirst)
    const year  = first.getFullYear()
    const month = first.getMonth()
    const total = new Date(year, month + 1, 0).getDate()
    const lead  = (first.getDay() + 6) % 7
    const list: DayCell[] = []
    for (let i = 0; i < lead; i++) list.push({ key: 'head-' + i, day: null, count: 0 })
    for (let i = 1; i <= total; i++) {
      const day = startOfDay(new Date(year, month, i).getTime())
      list.push({ key: String(day), day, count: dueByDay.get(day)?.length ?? 0 })
    }
    while (list.length % 7 !== 0) list.push({ key: 'tail-' + list.length, day: null, count: 0 })
    return list
  }, [monthFirst, dueByDay])

  const isWeek      = mode === 'week'
  const activeDay   = selectedDay ?? planData.today
  const activeWeek  = startOfWeek(activeDay)
  const isToday     = activeDay === planData.today
  const isThisWeek  = activeWeek === thisWeek
  /** 面板里列出的词：按天取那一天，按周取那一整周 */
  const activeItems = (isWeek ? dueByWeek.get(activeWeek) : dueByDay.get(activeDay)) ?? []
  const dict = useDictBatch(activeItems.map(item => item.word))
  /** 只有当前这一天 / 当前这一周能打卡，未来的批次只能看 */
  const canReview   = isWeek ? isThisWeek : isToday
  const panelTitle  = isWeek
    ? (isThisWeek ? '本周' : fmtWeek(activeWeek))
    : (isToday ? '今天' : fmtDate(activeDay))
  const panelRel    = isWeek
    ? (isThisWeek ? '' : weekRelLabel(activeWeek, thisWeek))
    : (isToday ? '' : relLabel(activeDay, planData.today))
  /** 打卡时带上粒度，只进打标日志，不影响排期 */
  const reviewOptions = { scope: (isWeek ? 'week' : 'day') as StudyMarkScope }

  function openPick() {
    setDraft(picked)
    setPickOpen(true)
    // 每次打开都刷新一次批次显示名，保证学习列表刚改过的名称立即生效
    fetchBatches(listId).then(names => setBatchNames(names))
  }

  function toggleDraft(word: string) {
    setDraft(prev => prev.includes(word) ? prev.filter(w => w !== word) : prev.concat(word))
  }

  /** 分组全选：整组都勾了就整组取消，否则把组内没勾上的词都加进来 */
  function toggleGroupWords(items: StudyWordItem[]) {
    const words = items.map(item => item.word)
    setDraft(prev => words.every(word => prev.includes(word))
      ? prev.filter(word => !words.includes(word))
      : prev.concat(words.filter(word => !prev.includes(word))))
  }

  function draftFirst(count: number) {
    setDraft(newWords.slice(0, count).map(w => w.word))
  }

  function openCardPick() {
    const available = new Set(words.map(item => item.word))
    setCardDraft(current => current.filter(word => available.has(word)))
    setCardSearch('')
    setQuickBatchId('')
    setCardPickOpen(true)
  }

  function toggleCardDraft(word: string) {
    setCardDraft(prev => prev.includes(word) ? prev.filter(item => item !== word) : prev.concat(word))
  }

  function selectFilteredCards() {
    setCardDraft(prev => Array.from(new Set(prev.concat(filteredPrintableWords.map(item => item.word)))))
  }

  function selectPrintBatch(batchId: string) {
    setQuickBatchId(batchId)
    const batch = prints.batches.find(item => item.id === batchId)
    if (!batch) return
    const selected = batch.items.flatMap(item => {
      if (item.listId !== listId) return []
      const word = availableWordByKey.get(keyOf(item.word))
      return word ? [word] : []
    })
    setCardDraft(Array.from(new Set(selected)))
  }

  /** 来源 id 与可展示标签都带进打印链路；句子不显示词库标识。 */
  function toCardRequest(item: StudyWordItem): StudyCardRequest {
    const sourceIds = item.type === 'sentence' ? [] : item.sourceIds
    return {
      word: item.word,
      displayText: item.type === 'sentence' ? item.displayText : undefined,
      type: item.type,
      senseIds: item.senseIds,
      phonetic: item.phonetic,
      translation: item.translation,
      sourceIds,
      libraryLabels: sourceIds.map(getPrintLabelById),
      fromLibrary: sourceIds.length > 0,
    }
  }

  async function renderCards(
    win: CardWindow,
    requests: StudyCardRequest[],
    title: string,
    startedAt?: number,
  ): Promise<boolean> {
    setProgress({ done: 0, total: 0 })
    try {
      const cards = await fetchCards(requests, (done, total) => {
        setProgress({ done, total })
        win.progress(done, total)
      })
      renderCardsInto(win, cards, {
        cols: layoutInfo.cols,
        rows: layoutInfo.rows,
        title,
        startedAt,
      })
      return true
    } catch {
      win.fail('卡片生成失败，请确认本地服务已启动（npm run dev:all）')
      return false
    } finally {
      setProgress(null)
    }
  }

  /**
   * 标签页先开出来显示进度，再去查释义、回填卡片；被拦截返回 false。
   * 开页必须在点击事件里同步做，不能等 fetchCards 回来再开。
   */
  async function printCards(
    requests: StudyCardRequest[],
    title: string,
    startedAt?: number,
  ): Promise<PrintResult> {
    const win = openCardWindow(title)
    if (!win) return 'blocked'
    return await renderCards(win, requests, title, startedAt) ? 'ok' : 'failed'
  }

  async function handleStart(withPrint: boolean) {
    if (picked.length === 0) return
    setError('')
    setNotice('')
    setBusy(withPrint ? 'print' : 'start')
    const startedAt = Date.now()
    const batchTitle = listName + ' · '
      + (isWeek ? fmtWeek(thisWeek) + ' 周批次' : fmtDate(startedAt) + ' 批次')

    if (withPrint) {
      const requests = picked.map(word => {
        const item = wordMap.get(word)
        return item ? toCardRequest(item) : {
          word,
          type: 'word' as const,
          senseIds: senseMap.get(word),
          phonetic: phoneticMap.get(word),
          translation: translationMap.get(word),
          sourceIds: [],
          libraryLabels: [],
        }
      })
      const printed = await printCards(requests, batchTitle, startedAt)
      // 卡片没打开就不写学习状态，避免开始时间对不上手里的卡片
      if (printed !== 'ok') {
        setBusy('')
        setError(printed === 'blocked'
          ? '浏览器拦截了新标签页，请允许本站弹窗后重试，或用「仅标记开始学习」。'
          : '卡片生成失败，尚未标记开始学习。')
        return
      }
    }

    const res = await plan.startWords(listId, picked, startedAt, mode)
    // 卡片导出成功后再留一条打印记录。
    let recordError = ''
    if (withPrint && res.ok) {
      const saved = await prints.record({
        title: batchTitle,
        kind: 'start',
        scope: mode,
        printedAt: startedAt,
        groups: [{ listId, words: picked }],
      })
      if (!saved.ok) recordError = '卡片已导出，但打印记录没保存：' + saved.error
    }
    setBusy('')
    if (!res.ok) { setError(res.error); return }
    setNotice(res.started + ' 个词已放入今天，完成记忆标记后才会进入下一轮复习。')
    if (recordError) setError(recordError)
    setPicked([])
    setReloadToken(t => t + 1)
  }

  /** 打印当前面板里要复习的词：按天是选中那一天，按周是选中那一整周 */
  async function handlePrintBatch() {
    if (activeItems.length === 0) return
    setError('')
    setNotice('')
    setBusy('day')
    const requests = activeItems.map(toCardRequest)
    const title = isWeek
      ? (isThisWeek ? '本周复习 · ' : '复习 · ') + fmtWeek(activeWeek)
      : (isToday ? '今日复习 · ' : '复习 · ') + fmtDate(activeDay)
    const printed = await printCards(requests, title)
    let recordError = ''
    if (printed === 'ok') {
      // 卡片确实导出了才留档；计划里的词可能跨列表，按列表分组
      const groups = Array.from(groupByList(activeItems).entries())
        .map(([id, wordList]) => ({ listId: id, words: wordList }))
      const saved = await prints.record({ title, kind: 'review', scope: mode, groups })
      if (!saved.ok) recordError = '卡片已导出，但打印记录没保存：' + saved.error
    }
    setBusy('')
    if (printed !== 'ok') {
      setError(printed === 'blocked'
        ? '浏览器拦截了新标签页，请允许本站弹窗后重试。'
        : '卡片生成失败，请确认本地服务已启动。')
      return
    }
    if (recordError) setError(recordError)
  }

  /** 自由挑选只负责打印和留档，不开始学习，也不推进任何复习轮次。 */
  async function handleCustomPrint() {
    if (cardDraft.length === 0) return
    setError('')
    setNotice('')
    setBusy('custom')
    const selected = cardDraft
      .map(word => wordMap.get(word))
      .filter((item): item is StudyWordItem => item != null)
    const printedAt = Date.now()
    const title = listName + ' · 自选卡片 · ' + fmtDate(printedAt)
    const printed = await printCards(selected.map(toCardRequest), title)
    if (printed !== 'ok') {
      setBusy('')
      setError(printed === 'blocked'
        ? '浏览器拦截了新标签页，请允许本站弹窗后重试。'
        : '卡片生成失败，请确认本地服务已启动。')
      return
    }
    const saved = await prints.record({
      title,
      kind: 'custom',
      printedAt,
      groups: [{ listId, words: selected.map(item => item.word) }],
    })
    setBusy('')
    setCardPickOpen(false)
    if (!saved.ok) setError('卡片已导出，但打印记录没保存：' + saved.error)
  }

  /** 每次点击生成独立幂等键：同一调用重试会去重，重新点击则各算一次 */
  function newRequestId(item: StudyPlanItem, action: string): string {
    return [
      item.listId,
      item.word,
      action,
      mode,
      Date.now().toString(36),
      Math.random().toString(36).slice(2, 8),
    ].join('|')
  }

  async function handleWordAction(item: StudyPlanItem, action: WordAction) {
    const key = item.listId + '/' + item.word
    const displayText = displayTextOf(item)
    setError('')
    setNotice('')
    setWordBusy(prev => ({ ...prev, [key]: action }))
    try {
      // 「−」按钮：撤销本周期内最近一次会拼 / 会读 / 知意，计数下限 0
      const undoKind = UNDO_KIND[action]
      if (undoKind) {
        const result = await plan.undoTally(item.listId, [item.word], undoKind, reviewOptions.scope)
        if (!result.ok) {
          setError(displayText + ' 撤销失败：' + result.error)
          return
        }
        setNotice(result.undone > 0
          ? displayText + ' 已撤销一次' + TALLY_LABEL[undoKind] + '（本周期内）。'
          : displayText + ' 本周期内没有可撤销的' + TALLY_LABEL[undoKind] + '记录。')
        if (item.listId === listId) setReloadToken(t => t + 1)
        return
      }
      const tallyKind = action === 'spelling' || action === 'reading' || action === 'meaning'
        ? action as 'spelling' | 'reading' | 'meaning'
        : undefined
      const reviewAction: 'tally' | 'done' | 'again' = tallyKind
        ? 'tally'
        : (action === 'next' ? 'done' : 'again')
      const result = await plan.reviewWords(item.listId, [item.word], reviewAction, {
        ...reviewOptions,
        successKind: tallyKind,
        requestId: newRequestId(item, action),
      })
      if (!result.ok) {
        setError(displayText + ' 操作失败：' + result.error)
        return
      }
      if (action === 'spelling') setNotice(displayText + ' 已记一次会拼（不影响复习轮次）。')
      else if (action === 'reading') setNotice(displayText + ' 已记一次会读（不影响复习轮次）。')
      else if (action === 'meaning') setNotice(displayText + ' 已记一次知意（不影响复习轮次）。')
      else if (action === 'next') setNotice(displayText + ' 已进入下一轮复习。')
      else setNotice(displayText + ' 已标记为没记住，明天重新复习。')
      if (item.listId === listId) setReloadToken(t => t + 1)
    } finally {
      setWordBusy(prev => {
        const next = { ...prev }
        delete next[key]
        return next
      })
    }
  }

  async function handleAllDone() {
    if (!canReview || activeItems.length === 0) return
    setError('')
    setNotice('')
    const groups = groupByList(activeItems)
    const requestIdsByList = new Map<string, Record<string, string>>()
    for (const item of activeItems) {
      const ids = requestIdsByList.get(item.listId) ?? {}
      ids[item.word] = newRequestId(item, 'next')
      requestIdsByList.set(item.listId, ids)
    }
    const count = activeItems.length
    let failed = 0
    for (const [id, wordList] of Array.from(groups.entries())) {
      const result = await plan.reviewWords(id, wordList, 'done', {
        ...reviewOptions,
        requestIds: requestIdsByList.get(id),
      })
      if (!result.ok) failed++
    }
    if (failed > 0) setError('部分词打卡失败，请确认本地服务已启动')
    else setNotice(count + ' 个词已进入下一轮复习。')
    setReloadToken(t => t + 1)
  }

  return (
    <div className="page page--wide study-page">
      <PageHeader title="英语学习" />

      {error && <div className="callout callout--error study-alert">{error}</div>}
      {notice && <div className="callout callout--success study-alert">{notice}</div>}

      <StudyGoal
        libraries={libraries}
        items={planData.items}
        getLabelById={getLabelById}
      />

      <section className="card card--pad study-start">
        <div className="study-start__head">
          <h2 className="study-start__title">学习与打印卡片</h2>
          <div className="study-start__fields">
            <div className="study-start__field">
              <label className="field-label" htmlFor="study-list">学习列表</label>
              <Select
                id="study-list"
                aria-label="学习列表"
                value={listId}
                options={listOptions}
                onChange={setListId}
              />
            </div>
            <div className="study-start__field">
              <label className="field-label" htmlFor="study-layout">卡片版式</label>
              <Select
                id="study-layout"
                aria-label="卡片版式"
                value={layout}
                options={LAYOUT_OPTIONS}
                onChange={setLayout}
              />
            </div>
          </div>
        </div>

        <div className="study-start__toolbar">
          <Button disabled={wordsLoading || newWords.length === 0} onClick={openPick}>
            {picked.length > 0 ? '重新挑选新词' : '挑选新词'}
          </Button>
          <span className="study-start__picked">
            {wordsLoading ? '加载词条中...' : '已选 ' + picked.length + ' 个 · 可选 ' + newWords.length + ' 个'}
          </span>
          <Button
            type="primary"
            loading={busy === 'print'}
            disabled={picked.length === 0 || busy !== ''}
            onClick={() => handleStart(true)}
          >
            打印卡片并开始学习
          </Button>
          <Button
            type="text"
            loading={busy === 'start'}
            disabled={picked.length === 0 || busy !== ''}
            onClick={() => handleStart(false)}
          >
            仅标记开始学习
          </Button>
        </div>

        <div className="study-start__secondary">
          <Button
            disabled={wordsLoading || words.length === 0 || busy !== ''}
            onClick={openCardPick}
          >
            挑选单词打印
          </Button>
          <span className="hint">
            {wordsLoading ? '加载词条中...' : listName + ' · 共 ' + words.length + ' 个词'}
          </span>
        </div>

        {progress && (
          <p className="hint study-start__progress">
            {progress.total > 0
              ? '正在补音标和释义 ' + progress.done + ' / ' + progress.total + '...'
              : '卡片页已打开，正在读取本地词典缓存...'}
          </p>
        )}

        {!wordsLoading && newWords.length === 0 && (
          <p className="empty empty--inline study-start__foot">
            {words.length === 0
              ? '这个列表还没有词条，先去查词或批量导入。'
              : '这个列表里的词都已经在学习中了。'}
          </p>
        )}

        {!wordsLoading && newWords.length > 0 && learningCount > 0 && (
          <p className="hint study-start__foot">该列表已有 {learningCount} 个词在学习中</p>
        )}

        <Modal
          open={pickOpen}
          width="wide"
          title={'挑选要开始学的词 · ' + listName}
          description={'共 ' + newWords.length + ' 个还没开始学的词，当前版式每页 ' + perPage + ' 张卡片'}
          onClose={() => setPickOpen(false)}
          footer={
            <>
              <span className="pick-modal__count">已选 {draft.length} 个</span>
              <Button type="text" onClick={() => setPickOpen(false)}>取消</Button>
              <Button type="primary" onClick={() => { setPicked(draft); setPickOpen(false) }}>确定</Button>
            </>
          }
        >
          <div className="pick-modal__quick">
            <Button type="link" size="small" onClick={() => draftFirst(perPage)}>选 1 页</Button>
            <Button type="link" size="small" onClick={() => draftFirst(perPage * 2)}>选 2 页</Button>
            <Button type="link" size="small" onClick={() => setDraft(newWords.map(w => w.word))}>全选</Button>
            <Button type="link" size="small" disabled={draft.length === 0} onClick={() => setDraft([])}>清空</Button>
          </div>
          {newWordGroups.map(([key, items]) => {
            const dayTs = batchKeyTsOf(key)
            const customLabel = batchNames[key]
            return (
              <div key={key} className="pick-modal__group">
                <div className="pick-modal__group-title">
                  <span>{customLabel || groupDayLabel(dayTs, planData.today)}</span>
                  {customLabel && (
                    <span className="pick-modal__group-day">{groupDayLabel(dayTs, planData.today)}</span>
                  )}
                  <span className="pick-modal__group-count">加入 · {items.length} 个词</span>
                  <Checkbox
                    className="pick-modal__group-all"
                    checked={items.length > 0 && items.every(item => draftSet.has(item.word))}
                    onChange={() => toggleGroupWords(items)}
                  >
                    全选
                  </Checkbox>
                </div>
                <div className="pick-grid">
                  {items.map(item => (
                    <Checkbox
                      key={item.word}
                      className="pick-grid__item"
                      checked={draftSet.has(item.word)}
                      onChange={() => toggleDraft(item.word)}
                    >
                      {displayTextOf(item)}
                    </Checkbox>
                  ))}
                </div>
              </div>
            )
          })}
        </Modal>

        <Modal
          open={cardPickOpen}
          width="wide"
          title={'挑选要打印的单词 · ' + listName}
          description={'可选择未开始、学习中或已完成的词；当前版式每页 ' + perPage + ' 张卡片'}
          onClose={() => { if (busy !== 'custom') setCardPickOpen(false) }}
          footer={
            <>
              <span className="pick-modal__count">已选 {cardDraft.length} 个</span>
              <Button type="text" disabled={busy === 'custom'} onClick={() => setCardPickOpen(false)}>取消</Button>
              <Button
                type="primary"
                loading={busy === 'custom'}
                disabled={cardDraft.length === 0 || busy !== ''}
                onClick={handleCustomPrint}
              >
                打印所选卡片（{cardDraft.length}）
              </Button>
            </>
          }
        >
          <div className="pick-modal__history">
            <label className="field-label" htmlFor="print-history-quick-pick">从打印记录快速选择</label>
            <Select
              id="print-history-quick-pick"
              aria-label="从打印记录快速选择单词"
              value={quickBatchId}
              options={printBatchOptions}
              placeholder={printBatchOptions.length > 0 ? '选择某天的打印记录' : '暂无可用的打印记录'}
              disabled={printBatchOptions.length === 0}
              onChange={selectPrintBatch}
            />
          </div>
          <Input
            block
            allowClear
            value={cardSearch}
            placeholder="搜索单词或句子"
            aria-label="搜索要打印的单词或句子"
            onChange={event => setCardSearch(event.target.value)}
            onClear={() => setCardSearch('')}
          />
          <div className="pick-modal__quick pick-modal__quick--search">
            <Button type="link" size="small" disabled={filteredPrintableWords.length === 0} onClick={selectFilteredCards}>
              全选当前结果
            </Button>
            <Button type="link" size="small" disabled={cardDraft.length === 0} onClick={() => setCardDraft([])}>清空</Button>
            <span className="pick-modal__result">找到 {filteredPrintableWords.length} 个</span>
          </div>
          {filteredPrintableWords.length === 0 ? (
            <p className="empty empty--inline">没有匹配的单词或句子。</p>
          ) : (
            <div className="pick-grid">
              {filteredPrintableWords.map(item => (
                <Checkbox
                  key={item.word}
                  className="pick-grid__item"
                  checked={cardDraftSet.has(item.word)}
                  onChange={() => toggleCardDraft(item.word)}
                >
                  {displayTextOf(item)}
                </Checkbox>
              ))}
            </div>
          )}
        </Modal>
      </section>

      <section className="card card--pad study-plan">
        <div className="study-plan__head">
          <h2 className="study-plan__title">复习计划</h2>
          <div className="study-plan__nav">
            <div className="study-plan__mode">
              <Select
                size="small"
                aria-label="复习粒度"
                value={mode}
                options={MODE_OPTIONS}
                onChange={value => setMode(value === 'week' ? 'week' : 'day')}
              />
            </div>
            <Button type="text" size="small" aria-label="上个月" onClick={() => setMonthOffset(v => v - 1)}>‹</Button>
            <span className="study-plan__month">{fmtMonth(monthFirst)}</span>
            <Button type="text" size="small" aria-label="下个月" onClick={() => setMonthOffset(v => v + 1)}>›</Button>
            <Button size="small" onClick={() => { setMonthOffset(0); setSelectedDay(null) }}>今天</Button>
          </div>
        </div>

        <div className="study-cal">
          <div className="study-cal__week" aria-hidden="true">
            {WEEKDAYS.map(w => <span key={w} className="study-cal__wd">{w}</span>)}
          </div>
          <div className="study-cal__grid">
            {cells.map(cell => {
              const day = cell.day
              if (day == null) return <span key={cell.key} className="study-cal__pad" aria-hidden="true" />
              // 按周模式下点任意一天都是选中整周，高亮跟着整行走
              const on = isWeek ? startOfWeek(day) === activeWeek : day === activeDay
              return (
                <button
                  key={cell.key}
                  type="button"
                  className={'study-cal__day'
                    + (day === planData.today ? ' study-cal__day--today' : '')
                    + (on ? ' study-cal__day--on' : '')
                    + (cell.count > 0 ? ' study-cal__day--has' : '')}
                  aria-pressed={on}
                  aria-label={fmtDate(day) + '，' + cell.count + ' 个词要复习' + (isWeek ? '，选中所在周' : '')}
                  onClick={() => setSelectedDay(day)}
                >
                  <span className="study-cal__date">{new Date(day).getDate()}</span>
                  {cell.count > 0 && <span className="study-cal__count">{cell.count}</span>}
                </button>
              )
            })}
          </div>
        </div>

        <div className="study-day">
          <div className="study-day__head">
            <h3 className="study-day__title">{panelTitle}</h3>
            <span className="study-day__count">{activeItems.length} 词</span>
            {panelRel && <span className="study-day__rel">{panelRel}</span>}
            {activeItems.length > 0 && (
              <div className="study-day__ops">
                <Button size="small" loading={busy === 'day'} disabled={busy !== ''} onClick={handlePrintBatch}>
                  {isWeek ? '打印整周卡片' : '打印当天卡片'}
                </Button>
                {canReview && (
                  <Popconfirm
                    title={isWeek ? '本周到期的词全部进入下一轮？' : '今天到期的词全部进入下一轮？'}
                    description={'共 ' + activeItems.length + ' 个词，各推进一轮，下次复习按记忆曲线顺延'}
                    okText="全部下一轮"
                    onConfirm={handleAllDone}
                  >
                    <Button type="primary" size="small">全部下一轮</Button>
                  </Popconfirm>
                )}
              </div>
            )}
          </div>

          {activeItems.length === 0 ? (
            <p className="empty empty--inline">
              {planData.items.length === 0
                ? '还没有正在学习的词，先在上面挑一批开始学。'
                : isWeek
                  ? (isThisWeek ? '本周没有要复习的词。' : '这周没有要复习的词。')
                  : (isToday ? '今天没有要复习的词。' : '这天没有要复习的词。')}
            </p>
          ) : (
              <ul className="review-rows">
              {activeItems.map(item => {
                const action = wordBusy[item.listId + '/' + item.word]
                const entry = dict.getEntry(item.word)
                const selected = item.translationIds && entry?.translations
                  ? formatTranslationOptions(selectedTranslationOptions(entry.translations, item.translationIds))
                  : ''
                const translation = item.translation || selected || entry?.translation || '暂无中文词义'
                return (
                  <li key={item.listId + '/' + item.word} className="review-row">
                    <div className="review-row__content">
                      <span className="review-row__word">{displayTextOf(item)}</span>
                      <span className="review-row__phonetic">{item.phonetic || entry?.phonetic || '—'}</span>
                      <span className="review-row__translation">{translation}</span>
                    </div>
                    {canReview && (
                      <span className="review-row__ops">
                        {(['spelling', 'reading', 'meaning'] as const).map(kind => {
                          const undo = (kind + '-undo') as WordAction
                          const counts = item.tallyCounts?.[isWeek ? 'week' : 'day']
                          const count = counts?.[kind] ?? 0
                          return (
                            <span key={kind} className="review-row__tally">
                              <Button
                                size="small"
                                title={'记一次' + TALLY_LABEL[kind] + '（本周期内可重复）'}
                                loading={action === kind}
                                disabled={action != null}
                                onClick={() => handleWordAction(item, kind)}
                              >
                                {TALLY_LABEL[kind]} {count}
                              </Button>
                              <Button
                                size="small"
                                className="review-row__tally-minus"
                                title={'减少一次' + TALLY_LABEL[kind] + '（本周期内，最少 0）'}
                                aria-label={'减少一次' + TALLY_LABEL[kind]}
                                loading={action === undo}
                                disabled={action != null || count <= 0}
                                onClick={() => handleWordAction(item, undo)}
                              >
                                −
                              </Button>
                            </span>
                          )
                        })}
                       <Button
                         type="primary"
                         size="small"
                         className="review-row__done"
                         title="进入下一轮"
                         aria-label="进入下一轮"
                         loading={action === 'next'}
                         disabled={action != null}
                         onClick={() => handleWordAction(item, 'next')}
                       >
                         <svg
                           className="review-row__done-icon"
                           viewBox="0 0 24 24"
                           fill="none"
                           aria-hidden="true"
                           >
                             <path
                               d="M20 6 9 17l-5-5"
                               stroke="currentColor"
                               strokeWidth="2.6"
                               strokeLinecap="round"
                               strokeLinejoin="round"
                             />
                           </svg>
                       </Button>
                        <Button
                          size="small"
                          loading={action === 'again'}
                          disabled={action != null}
                          onClick={() => handleWordAction(item, 'again')}
                        >
                          没记住
                        </Button>
                      </span>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </section>

    </div>
  )
}
