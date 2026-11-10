import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, Drawer, Tag } from '../ui'
import { PageHeader } from '../components/PageHeader'
import { ReciteTaskPanel } from '../components/ReciteTaskPanel'
import { RecitePushPanel } from '../components/RecitePushPanel'
import { ReciteRecordingButton } from '../components/ReciteRecordingButton'
import { ReciteRecordingPlayer } from '../components/ReciteRecordingPlayer'
import { TallyCounter } from '../components/TallyCounter'
import type { TallyKind } from '../components/TallyCounter'
import {
  commitReciteSession,
  fetchReciteActiveSession,
  fetchReciteHistory,
  fetchReciteRecordings,
  fetchReciteTasks,
} from '../hooks/useRecite'
import type {
  ReciteCardTimes,
  ReciteDraft,
  ReciteHistoryRecord,
  ReciteRecordingSummary,
  ReciteSessionPayload,
  ReciteTask,
  ReciteTaskSession,
  ReciteTaskWord,
} from '../hooks/useRecite'
import type { StudyListApi } from '../hooks/useStudyList'
import './ReciteTasksPage.css'

const DAY = 86400000
/** 与服务端 resolveWeekStart 一致：最多预排 12 周后的任务 */
const MAX_WEEK_OFFSET = 12
/** 拉取的已保存记录条数，够覆盖最近几周的每次记录 */
const HISTORY_LIMIT = 60
/** 课堂录音只保留 15 天，一次拉回来按「周 + 第几次」挂到对应行 */
const RECORDING_LIMIT = 60
/** 一次保存按 30 张一批提交，服务端单请求最多 60 张 */
const COMMIT_CHUNK = 30
/** 保存抽屉里单张卡片最多加多少次，与服务端 MAX_CARD_TIMES 一致 */
const MAX_CARD_TIMES = 10

const RESULT_LABEL: Record<string, string> = {
  known: '会',
  unknown: '不会',
  correct: '拼写正确',
  skipped: '拼写跳过',
}

interface ReciteTasksPageProps {
  study: StudyListApi
  /** 服务端今天 0 点，用来定位「本周」 */
  today: number
  onBack: () => void
}

/** 所在周的周一 0 点，与服务端 startOfWeek 保持一致 */
function startOfWeek(ts: number): number {
  const day = new Date(ts)
  day.setHours(0, 0, 0, 0)
  const weekday = (day.getDay() + 6) % 7
  return day.getTime() - weekday * DAY
}

/** 一行的日期区间，周一开始，如 11.4—11.10 */
function fmtWeek(week: number): string {
  const a = new Date(week)
  const b = new Date(week + 6 * DAY)
  return (a.getMonth() + 1) + '.' + a.getDate() + '—' + (b.getMonth() + 1) + '.' + b.getDate()
}

function taskWordLabel(item: ReciteTaskWord) {
  return item.type === 'sentence' && item.displayText ? item.displayText : item.word
}

type SessionState = 'done' | 'active' | 'todo'

/** 这一次学习进行到哪一步：已完成 / 进行中 / 还没开始 */
function sessionState(task: ReciteTask, index: number): SessionState {
  const sessionIndex = index + 1
  // 有真实会话记录时以它为准：推送的那一次不按顺序完成，只看条数会标错行
  const actual = task.sessions?.find(session => session.index === sessionIndex)
  if (actual) return actual.status === 'completed' ? 'done' : 'active'
  if (sessionIndex <= task.completedSessions) return 'done'
  if (task.activeSessionIndex != null && sessionIndex === task.activeSessionIndex) return 'active'
  return 'todo'
}

/** 任务是否已经开始（有完成的会话或正在进行中的会话），开始了配置就锁定 */
function isStarted(task: ReciteTask): boolean {
  return task.completedSessions > 0 || task.activeSessionIndex != null
}

interface SessionWord {
  key: string
  label: string
  meaning?: string
  spelling?: string
}

/**
 * 保存抽屉里一张卡的默认次数：判「会」的普通卡加会读、知意各 1 次，
 * 「拼写正确」的拼写卡加会拼 1 次，「不会」的词一律不加。
 */
function defaultCardTimes(result?: ReciteDraft['result']): ReciteCardTimes {
  if (result === 'known') return { spelling: 0, reading: 1, meaning: 1 }
  if (result === 'correct') return { spelling: 1, reading: 0, meaning: 0 }
  return { spelling: 0, reading: 0, meaning: 0 }
}

/** 一次记录按词合并：普通卡的判定归知意，拼写卡的判定归拼写 */
function wordsToMarks(cards: Array<{ word: string; displayText?: string; cardType: string; result?: string }>): Map<string, SessionWord> {
  const words = new Map<string, SessionWord>()
  for (const card of cards) {
    const word = words.get(card.word) ?? { key: card.word, label: card.displayText || card.word }
    if (card.cardType === 'spelling') word.spelling = card.result
    else word.meaning = card.result
    words.set(card.word, word)
  }
  return words
}

/** 单词的知意 / 拼写判定；还没判定（进行中的会话）不显示任何标记 */
function WordMarks({ meaning, spelling }: { meaning?: string; spelling?: string }) {
  if (!meaning && !spelling) {
    return null
  }
  return (
    <>
      {meaning && (
        <i className={'recite-tasks__mark recite-tasks__mark--' + meaning}>
          {RESULT_LABEL[meaning] || meaning}
        </i>
      )}
      {spelling && (
        <i className={'recite-tasks__mark recite-tasks__mark--' + spelling}>
          {RESULT_LABEL[spelling] || spelling}
        </i>
      )}
    </>
  )
}

/**
 * 单词小圆片：有判定记录时在单词后直接显示标记，不用再点开看。
 * showSpelling=false 只显示知意判定（读的列），=true 同时显示拼写判定（背的列）。
 */
function WordChips({ items, marks, showSpelling, order }: {
  items: ReciteTaskWord[]
  marks?: Map<string, SessionWord>
  showSpelling?: boolean
  /** 这一次学习的单词出现顺序（与背词页卡片顺序一致），给每个词标序号 */
  order?: string[]
}) {
  // 序号按整个这一次学习算：读的词和背的词用同一套编号，对得上背词页第几张卡
  const positions = new Map<string, number>()
  for (const [index, word] of (order ?? []).entries()) {
    if (!positions.has(word)) positions.set(word, index + 1)
  }
  // 组内按序号升序排；拿不到序号的词留在最后，保持原来的相对顺序
  const sorted = [...items].sort((a, b) => (
    (positions.get(a.word) ?? Number.MAX_SAFE_INTEGER) - (positions.get(b.word) ?? Number.MAX_SAFE_INTEGER)
  ))
  return (
    <div className="recite-tasks__words">
      {sorted.map(item => {
        const mark = marks?.get(item.word)
        const position = positions.get(item.word)
        return (
          <span key={item.listId + '|' + item.word} className="recite-tasks__chip">
            {position != null && <i className="recite-tasks__chip-no">{position}</i>}
            {taskWordLabel(item)}
            {mark && (
              <span className="recite-tasks__marks">
                <WordMarks meaning={mark.meaning} spelling={showSpelling ? mark.spelling : undefined} />
              </span>
            )}
          </span>
        )
      })}
      {items.length === 0 && <span className="recite-tasks__none">—</span>}
    </div>
  )
}

/**
 * 一周的明细行：第 1 列日期（rowSpan 跨整周），后面每次学习一行。
 * 已完成的次数在单词后直接带判定；进行中的那一次在行右侧保存；没开始的次数点行改这一周的词。
 */
function WeekRows({ task, isThisWeek, onEdit, onPush, pushDisabled, pushReason, sessionMarks, activeMarks, activeSave, activeJudged, recordings, onPlaybackError }: {
  task: ReciteTask
  isThisWeek: boolean
  /** 点行传 session（1-based）只改这一行；点「修改配置」不传，改整周 */
  onEdit: (weekStart: number, session?: number) => void
  /** 本周日期格子下面的「推送」：没有进行中的学习时才能用 */
  onPush?: () => void
  pushDisabled?: boolean
  pushReason?: string
  /** 这一周每一次（1-based）已保存记录的逐词判定 */
  sessionMarks: Map<number, Map<string, SessionWord>>
  /** 正在进行那一次的逐词判定（来自当前会话的卡片与草稿） */
  activeMarks?: Map<string, SessionWord>
  /** 进行中那一次的保存按钮状态；没有进行中的会话时不传 */
  activeSave?: { saving: boolean; missing: number; onSave: () => void }
  /** 进行中的那一次已全部判完（背词页停在完成动画），这次按已完成展示，保存按钮仍在 */
  activeJudged?: boolean
  /** 课堂录音：key = 周 + 第几次 */
  recordings?: Map<string, ReciteRecordingSummary>
  onPlaybackError: (message: string) => void
}) {
  const per = Math.max(1, task.perSessionCount)
  const started = isStarted(task)

  return (
    <>
      {Array.from({ length: task.sessionCount }, (_, index) => {
        const state = sessionState(task, index)
        const session = task.sessions?.find(item => item.index === index + 1)
        const marks = state === 'done'
          ? sessionMarks.get(index + 1)
          : state === 'active' ? activeMarks : undefined
        /** 主动推送的那一次不占本周计划的词表，也不能点行改词 */
        const pushed = Boolean(session?.pushed)
        /** 整周任务开始后不能再改整周配置；没开始 / 正在学习中的这一次仍然可以点行改它自己的单词 */
        const clickable = state !== 'done' && !pushed
        return (
          <tr
            key={index}
            className={'recite-tasks__row' + (clickable ? ' recite-tasks__row--clickable' : '')}
            title={clickable
              ? (state === 'active' ? '点击修改这一次的单词，改完需要重新学习' : '点击修改这一次的单词')
              : undefined}
            onClick={clickable ? () => onEdit(task.weekStart, index + 1) : undefined}
          >
            {index === 0 && (
              <th scope="rowgroup" rowSpan={task.sessionCount} className="recite-tasks__week-cell">
                <span className="recite-tasks__week-date">
                  {fmtWeek(task.weekStart)}
                  {isThisWeek && <Tag color="blue">本周</Tag>}
                </span>
                {!started && (
                  <Button
                    size="small"
                    onClick={event => { event.stopPropagation(); onEdit(task.weekStart) }}
                  >
                    修改配置
                  </Button>
                )}
                {isThisWeek && onPush && (
                  <Button
                    size="small"
                    disabled={pushDisabled}
                    title={pushDisabled ? pushReason : '推送一批单词，本周次数 +1'}
                    onClick={event => { event.stopPropagation(); onPush() }}
                  >
                    推送
                  </Button>
                )}
              </th>
            )}
            <SessionCells
              task={task}
              index={index}
              per={per}
              marks={marks}
              session={session}
              order={task.wordOrder?.[index]}
              recording={recordings?.get(task.weekStart + ':' + (index + 1))}
              onPlaybackError={onPlaybackError}
             activeJudged={activeJudged}
              saveSlot={state === 'active' && activeSave ? (
                <Button
                  type="primary"
                  size="small"
                  className="recite-tasks__row-save"
                  disabled={activeSave.missing > 0 || activeSave.saving}
                  onClick={event => { event.stopPropagation(); void activeSave.onSave() }}
                >
                  {activeSave.saving ? '保存中…' : '保存'}
                </Button>
              ) : undefined}
            />
          </tr>
        )
      })}
    </>
  )
}

function SessionCells({ task, index, per, marks, session, order, saveSlot, recording, onPlaybackError, activeJudged }: {
  task: ReciteTask
  index: number
  per: number
  marks?: Map<string, SessionWord>
  /** 这一次学习的会话记录：主动推送的那一次单词要按卡片取，不来自计划词表 */
  session?: ReciteTaskSession
  /** 这一次学习的单词出现顺序，两侧单词都用它标序号 */
  order?: string[]
  saveSlot?: ReactNode
  /** 这一次学习留下的课堂录音（没有就不显示喇叭） */
  recording?: ReciteRecordingSummary
  onPlaybackError: (message: string) => void
  /** 进行中的那一次已全部判完（背词页停在完成动画），这次按已完成展示，保存按钮仍在 */
  activeJudged?: boolean
}) {
  const slice = task.words.slice(index * per, (index + 1) * per)
  /** 推送的那一次：词表来自会话卡片，不按计划的每次词数切分；有拼写卡的词进「背的词」那一列 */
  const pushedWords = session?.pushed ? session.words ?? [] : []
  const pushedSpelling = new Set(session?.pushed ? session.spellingWords ?? [] : [])
  const pushedItems: ReciteTaskWord[] = pushedWords.map(word => ({
    word, listId: '', position: 0, type: 'word',
    sourceType: 'selected', spellingEnabled: pushedSpelling.has(word),
  }))
  const read = pushedWords.length > 0
    ? pushedItems.filter(item => !item.spellingEnabled)
    : slice.filter(item => !item.spellingEnabled)
  const spell = pushedWords.length > 0
    ? pushedItems.filter(item => item.spellingEnabled)
    : slice.filter(item => item.spellingEnabled)
  const state = sessionState(task, index)
  return (
    <>
      <td className="recite-tasks__times-cell">
        <div className="recite-tasks__times-line">
          <span className="recite-tasks__times">第 {index + 1} 次</span>
          {session?.pushed && <Tag color="purple">主动推送</Tag>}
          {state === 'done' && <Tag color="green">已完成</Tag>}
          {state === 'active' && (
            <Tag color={activeJudged ? 'green' : 'gold'}>{activeJudged ? '已完成' : '学习中'}</Tag>
          )}
        </div>
        {recording && <ReciteRecordingButton recording={recording} onError={onPlaybackError} />}
      </td>
      <td className="recite-tasks__words-cell">
        <WordChips items={read} marks={marks} order={order} />
      </td>
      <td className="recite-tasks__words-cell">
        <div className="recite-tasks__cell-flow">
          <WordChips items={spell} marks={marks} showSpelling order={order} />
          {saveSlot}
        </div>
      </td>
    </>
  )
}

export function ReciteTasksPage({ study, today, onBack }: ReciteTasksPageProps) {
  const thisWeek = useMemo(() => startOfWeek(today), [today])
  const [tasks, setTasks] = useState<ReciteTask[]>([])
  /** 当前进行中的会话（只会属于本周任务），用来在行内显示判定和保存按钮 */
  const [active, setActive] = useState<ReciteSessionPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [reload, setReload] = useState(0)
  /** 选词弹窗：存目标周（周一 0 点），null 表示关闭 */
  const [modalWeek, setModalWeek] = useState<number | null>(null)
  /** 只改某一行时存 1-based 第几次，null = 改整周 */
  const [modalSession, setModalSession] = useState<number | null>(null)
  /** 已保存的背诵记录，用来在已完成的那一行显示逐词判定 */
  const [historyRecords, setHistoryRecords] = useState<ReciteHistoryRecord[]>([])
  /** 最近 15 天的课堂录音，按「周 + 第几次」挂到对应行的「次数」下面 */
  const [recordings, setRecordings] = useState<ReciteRecordingSummary[]>([])
  const [playError, setPlayError] = useState('')
  /** 保存抽屉：点行右侧「保存」先弹出来，按序号给每个单词填要加的次数 */
  const [saveOpen, setSaveOpen] = useState(false)
  /** 抽屉里播放课堂录音失败的提示，只显示在抽屉里 */
  const [drawerPlayError, setDrawerPlayError] = useState('')
  /** 抽屉里每张卡各维度要加的次数，key = 卡片 id */
  const [cardTimes, setCardTimes] = useState<Record<string, ReciteCardTimes>>({})
  /** 主动推送：要推送到哪一周（周一 0 点），null 表示弹窗关闭 */
  const [pushWeek, setPushWeek] = useState<number | null>(null)

  useEffect(() => {
    let alive = true
    setLoading(true)
    Promise.all([
      fetchReciteTasks(),
      fetchReciteHistory(HISTORY_LIMIT),
      fetchReciteActiveSession(),
      // 录音只是锦上添花：拉不到不影响任务配置
      fetchReciteRecordings(RECORDING_LIMIT).catch(() => [] as ReciteRecordingSummary[]),
    ])
      .then(([list, history, activeSession, recordingList]) => {
        if (!alive) return
        setTasks(list)
        setHistoryRecords(history.records || [])
        setActive(activeSession)
        setRecordings(recordingList)
        setLoadError('')
        setSaveError('')
      })
      .catch(error => {
        if (!alive) return
        setLoadError(error instanceof Error ? error.message : '背词任务读取失败')
      })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [reload])

  /** 表格只列本周到 12 周后，服务端返回的全量任务按周找出对应的配置 */
  const weeks = useMemo(() => (
    Array.from({ length: MAX_WEEK_OFFSET + 1 }, (_, offset) => thisWeek + offset * 7 * DAY)
  ), [thisWeek])

  const taskByWeek = useMemo(() => {
    const map = new Map<number, ReciteTask>()
    for (const task of tasks) map.set(task.weekStart, task)
    return map
  }, [tasks])

  const configuredCount = useMemo(
    () => weeks.filter(week => taskByWeek.has(week)).length,
    [weeks, taskByWeek],
  )

  /** 已保存的记录按周 / 第几次归组，已完成的行直接在单词后显示判定 */
  const marksByWeek = useMemo(() => {
    const map = new Map<number, Map<number, Map<string, SessionWord>>>()
    for (const record of historyRecords) {
      if (record.weekStart == null) continue
      const bySession = map.get(record.weekStart) ?? new Map<number, Map<string, SessionWord>>()
      bySession.set(record.sessionIndex, wordsToMarks(record.cards))
      map.set(record.weekStart, bySession)
    }
    return map
  }, [historyRecords])

  /** 课堂录音按「周 + 第几次」索引，行内直接取 */
  const recordingBySession = useMemo(() => {
    const map = new Map<string, ReciteRecordingSummary>()
    for (const item of recordings) {
      if (item.weekStart == null || item.sessionIndex == null) continue
      map.set(item.weekStart + ':' + item.sessionIndex, item)
    }
    return map
  }, [recordings])

  /** 进行中那一次的逐词判定：草稿优先（孩子刚判定还没保存的结果），其次卡片结果 */
  const activeMarks = useMemo(() => {
    if (!active?.cards) return undefined
    const drafts = new Map((active.drafts ?? []).map(draft => [draft.cardId, draft]))
    return wordsToMarks(active.cards.map(card => ({
      word: card.word,
      displayText: card.displayText,
      cardType: card.cardType,
      result: drafts.get(card.id)?.result ?? card.result,
    })))
  }, [active])

  /** 进行中那一次每张卡的判定草稿，抽屉里给单词标判定、按判定给默认次数 */
  const draftByCard = useMemo(() => {
    const map = new Map<string, ReciteDraft>()
    for (const draft of active?.drafts ?? []) map.set(draft.cardId, draft)
    return map
  }, [active])

  /** 进行中那一次还有几张卡片没判定，没判定完不能保存 */
  const activeMissing = useMemo(() => {
    const cards = active?.cards ?? []
    return cards.filter(card => card.status === 'pending' && !draftByCard.has(card.id)).length
  }, [active, draftByCard])

  /** 进行中那一次还没判定的卡片，按背词页的卡片顺序排（也就是表里的序号） */
  const pendingCards = useMemo(() => (
    (active?.cards ?? [])
      .filter(card => card.status === 'pending')
      .slice()
      .sort((a, b) => a.position - b.position)
  ), [active])

  /** 点行右侧「保存」：先弹抽屉，按卡片判定给好默认次数 */
  function openSaveDrawer() {
    if (!active?.session) return
    const initial: Record<string, ReciteCardTimes> = {}
    for (const card of pendingCards) {
      initial[card.id] = defaultCardTimes(draftByCard.get(card.id)?.result)
    }
    setCardTimes(initial)
    setSaveError('')
    setSaveOpen(true)
  }

  /** 关抽屉：清掉抽屉里的播放失败提示（按钮卸载时会自动停掉正在播的录音） */
  function closeSaveDrawer() {
    setDrawerPlayError('')
    setSaveOpen(false)
  }

  /** 抽屉里调节某一维度的次数：0 到 MAX_CARD_TIMES 之间 */
  function bumpCardTimes(cardId: string, kind: TallyKind, delta: number) {
    setCardTimes(current => {
      const times = current[cardId] ?? { spelling: 0, reading: 0, meaning: 0 }
      return {
        ...current,
        [cardId]: { ...times, [kind]: Math.min(MAX_CARD_TIMES, Math.max(0, times[kind] + delta)) },
      }
    })
  }

  /** 把进行中那一次的草稿统一提交保存（带上抽屉里填的次数），保存后刷新整个页面 */
  async function saveActiveSession() {
    const session = active?.session
    if (!session || saving) return
    const drafts = new Map((active?.drafts ?? []).map(draft => [draft.cardId, draft]))
    setSaving(true)
    setSaveError('')
    try {
      const answers = pendingCards.map(card => {
        const draft = drafts.get(card.id)
        if (!draft) throw new Error('还有卡片没有判定，等孩子背完再保存。')
        return {
          cardId: card.id,
          result: draft.result,
          answer: draft.answer,
          attempts: draft.attempts,
          // 幂等键固定为会话 + 卡片，重复保存不会重复推进轮次
          requestId: 'recite|' + session.sessionId + '|' + card.id,
          // 抽屉里填的各维度次数：会拼 / 会读 / 知意按填的值累加
          times: cardTimes[card.id] ?? { spelling: 0, reading: 0, meaning: 0 },
        }
      })
      for (let start = 0; start < answers.length; start += COMMIT_CHUNK) {
        await commitReciteSession(session.sessionId, answers.slice(start, start + COMMIT_CHUNK))
      }
      setSaveOpen(false)
      setReload(value => value + 1)
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : '保存失败，请重试')
    } finally {
      setSaving(false)
    }
  }

  const activeSave = active?.session
    ? { saving, missing: activeMissing, onSave: openSaveDrawer }
    : undefined
  /** 进行中的那一次已全部判完（背词页会停在完成动画）：按已完成展示，但还没保存，保存按钮仍在 */
  const activeJudged = Boolean(active?.session) && activeMissing === 0
  /** 进行中那一次的课堂录音（抽屉标题旁试听，没有录音就不显示） */
  const activeRecording = active?.session && active.task
    ? recordingBySession.get(active.task.weekStart + ':' + active.session.sessionIndex)
    : undefined

  return (
    <div className="page page--wide">
      <PageHeader
        title="配置背词任务"
        subtitle="一周一行；已完成的次数在单词后直接看判定，进行中的那一次在行右侧保存。没开始或正在学习的次数点行可以改这一次的单词，学习中改词需要重新学。"
        actions={<Button onClick={onBack}>返回英语学习</Button>}
      />

      <section className="card card--pad recite-tasks">
        <div className="recite-tasks__head">
          <h2 className="recite-tasks__title">各周任务</h2>
          <span className="recite-tasks__hint">
            {loading ? '正在读取…' : '本周至 12 周后，已配置 ' + configuredCount + ' 周'}
          </span>
        </div>

        {loadError && <p className="callout callout--error">{loadError}</p>}
        {saveError && <p className="callout callout--error">{saveError}</p>}
        {playError && <p className="callout callout--error">{playError}</p>}

        {!loading && !loadError && (
          <div className="recite-tasks__scroll">
            <table className="recite-tasks__table">
              <colgroup>
                <col className="recite-tasks__col-week" />
                <col className="recite-tasks__col-times" />
                <col className="recite-tasks__col-read" />
                <col className="recite-tasks__col-spell" />
              </colgroup>
              <thead>
                <tr>
                  <th scope="col">周</th>
                  <th scope="col">次数</th>
                  <th scope="col">读的单词</th>
                  <th scope="col">背的单词</th>
                </tr>
              </thead>
              {weeks.map(week => {
                const task = taskByWeek.get(week)
                const isThisWeek = week === thisWeek
                if (!task) {
                  return (
                    <tbody key={week}>
                      <tr className="recite-tasks__row recite-tasks__row--empty">
                        <th scope="rowgroup" className="recite-tasks__week-cell">
                          <span className="recite-tasks__week-date">
                            {fmtWeek(week)}
                            {isThisWeek && <Tag color="blue">本周</Tag>}
                          </span>
                        </th>
                        <td colSpan={3} className="recite-tasks__empty-cell">
                          <span className="recite-tasks__empty-text">这一周还没有背词任务</span>
                          <Button
                            size="small"
                            onClick={() => { setModalWeek(week); setModalSession(null) }}
                          >
                            {isThisWeek ? '配置本周任务' : '配置这一周任务'}
                          </Button>
                        </td>
                      </tr>
                    </tbody>
                  )
                }
                return (
                  <tbody key={week}>
                    <WeekRows
                      task={task}
                      isThisWeek={isThisWeek}
                      onEdit={(next, session) => { setModalWeek(next); setModalSession(session ?? null) }}
                      onPush={() => setPushWeek(task.weekStart)}
                      pushDisabled={Boolean(active?.session)}
                      pushReason="有进行中的一次学习，学完再推送"
                      sessionMarks={marksByWeek.get(week) ?? new Map()}
                      activeMarks={activeMarks}
                      activeSave={activeSave}
                      activeJudged={activeJudged}
                      recordings={recordingBySession}
                      onPlaybackError={setPlayError}
                    />
                  </tbody>
                )
              })}
            </table>
          </div>
        )}
      </section>

      <ReciteTaskPanel
        open={modalWeek !== null}
        study={study}
        weekStart={modalWeek ?? thisWeek}
        focusSession={modalSession}
        onClose={() => { setModalWeek(null); setModalSession(null) }}
        onSaved={() => {
          setModalWeek(null)
          setModalSession(null)
          setReload(value => value + 1)
        }}
      />

      <Drawer
        open={saveOpen}
        width="wide"
        title="确认这次学习的次数"
        onClose={closeSaveDrawer}
        footer={
          <>
            <Button onClick={closeSaveDrawer}>取消</Button>
            <Button
              type="primary"
              loading={saving}
              disabled={pendingCards.length === 0 || activeMissing > 0}
              onClick={() => { void saveActiveSession() }}
            >
              保存
            </Button>
          </>
        }
      >
        <ReciteRecordingPlayer recording={activeRecording} onError={setDrawerPlayError} />
        {activeMissing > 0 && (
          <p className="callout callout--warn">还有 {activeMissing} 张卡片没有判定，等孩子背完再保存。</p>
        )}
        {drawerPlayError && <p className="callout callout--error">{drawerPlayError}</p>}
        <ul className="recite-tasks__counts">
          {pendingCards.map(card => {
            const times = cardTimes[card.id] ?? { spelling: 0, reading: 0, meaning: 0 }
            const no = card.position + 1
            const result = draftByCard.get(card.id)?.result
            return (
              <li key={card.id} className="recite-tasks__count-row">
                <span className="recite-tasks__count-no">{no}</span>
                <span className="recite-tasks__count-word">
                  {card.displayText || card.word}
                  {result && (
                    <Tag color={result === 'known' || result === 'correct' ? 'green' : 'default'}>
                      {RESULT_LABEL[result] || result}
                    </Tag>
                  )}
                </span>
                <span className="recite-tasks__count-tallies">
                  {(['spelling', 'reading', 'meaning'] as const).map(kind => (
                    <TallyCounter
                      key={kind}
                      kind={kind}
                      value={times[kind]}
                      max={MAX_CARD_TIMES}
                      disabled={saving}
                      addDescription="保存这次学习后，会计入该单词的永久学习成果。"
                      reduceDescription="只减少这次保存要加的次数，不影响已经保存的记录。"
                      onAdjust={(_, delta) => bumpCardTimes(card.id, kind, delta)}
                    />
                  ))}
                </span>
              </li>
            )
          })}
        </ul>
        {pendingCards.length === 0 && <p className="empty empty--inline">这次学习没有待保存的卡片。</p>}
      </Drawer>

      <RecitePushPanel
        open={pushWeek !== null}
        study={study}
        weekStart={pushWeek ?? thisWeek}
        blockedReason={active?.session ? '有进行中的一次学习，学完再推送' : undefined}
        onClose={() => setPushWeek(null)}
        onPushed={() => {
          setPushWeek(null)
          setReload(value => value + 1)
        }}
      />
    </div>
  )
}
