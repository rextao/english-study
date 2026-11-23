import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, Drawer, Input, Modal, Select, Tag } from '../ui'
import { PageHeader } from '../components/PageHeader'
import { ReciteTaskPanel } from '../components/ReciteTaskPanel'
import { RecitePushPanel } from '../components/RecitePushPanel'
import { ReciteRecordingButton } from '../components/ReciteRecordingButton'
import { ReciteRecordingPlayer } from '../components/ReciteRecordingPlayer'
import { TallyCounter } from '../components/TallyCounter'
import type { TallyKind } from '../components/TallyCounter'
import {
  commitReciteSession,
  copyReciteSession,
  deleteReciteSession,
  deleteReciteTask,
  fetchReciteActiveSession,
  fetchReciteHistory,
  fetchReciteRecordings,
  fetchReciteTasks,
  planReciteTask,
} from '../hooks/useRecite'
import type {
  ReciteCard,
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
import { groupReciteRecordings } from '../utils/reciteRecordings'
import type { RecordingGroup } from '../utils/reciteRecordings'
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
/** 「配置周任务」的默认框架：每次 15 词、每周 3 次 */
const DEFAULT_PER_SESSION = 15
const DEFAULT_SESSION_COUNT = 3
/** 每次学习单词数的上限，与输入框的 max 一致 */
const MAX_PER_SESSION = 200
/** 每周学习次数下拉的范围 */
const SESSION_OPTIONS = Array.from({ length: 7 }, (_, index) => ({
  value: String(index + 1), label: String(index + 1),
}))

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

/** 任务是否已经开始（建过任何一次会话，含学完待保存的），开始了配置就锁定 */
function isStarted(task: ReciteTask): boolean {
  return task.completedSessions > 0 || task.activeSessionIndex != null || (task.sessions?.length ?? 0) > 0
}

interface SessionWord {
  key: string
  label: string
  meaning?: string
  spelling?: string
}

/**
 * 家长端看到的一次「学习中 / 学完待保存」的会话。
 * 孩子没等保存就继续学下一次时，一次学习可能同时有好几条，每一条都能单独保存。
 */
interface ActiveRowView {
  sessionId: string
  weekStart: number
  sessionIndex: number
  /** 这一次的逐词判定（草稿优先，其次已落库的结果） */
  marks: Map<string, SessionWord>
  /** 还有几张卡片没判定；大于 0 时不能保存 */
  missing: number
  /** 全部判完了（孩子已经停在完成动画），按已完成展示但保存按钮仍在 */
  judged: boolean
  /** 这次还没落库、按卡片顺序排好的卡片 */
  pendingCards: ReciteCard[]
  /** 卡片 id → 草稿 */
  drafts: Map<string, ReciteDraft>
  payload: ReciteSessionPayload
}

/** 一次接口结果里的全部待确认会话：新接口给 actives，老接口只有单条 */
function activePayloadList(payload: ReciteSessionPayload | null): ReciteSessionPayload[] {
  if (!payload) return []
  const list = payload.actives?.length ? payload.actives : (payload.session ? [payload] : [])
  return list.filter(item => Boolean(item.session))
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
function WeekRows({ task, isThisWeek, onEdit, onDelete, onPush, pushDisabled, pushReason, sessionMarks, activeRows, savingSessionId, onSave, onCopy, copyingKey, onDeleteSession, recordings, onPlaybackError }: {
  task: ReciteTask
  isThisWeek: boolean
  /** 点行传 session（1-based）只改这一行；点「修改配置」不传，改整周 */
  onEdit: (weekStart: number, session?: number) => void
  /** 打开删除确认弹窗（表格外层有横向滚动，不能用贴行的气泡，会被裁掉） */
  onDelete: (weekStart: number) => void
  /** 本周日期格子下面的「推送」：没有进行中的学习时才能用 */
  onPush?: () => void
  pushDisabled?: boolean
  pushReason?: string
  /** 这一周每一次（1-based）已保存记录的逐词判定 */
  sessionMarks: Map<number, Map<string, SessionWord>>
  /** 这一周「学习中 / 学完待保存」的会话，key = 第几次（1-based）；可能同时有好几次 */
  activeRows?: Map<number, ActiveRowView>
  /** 正在提交保存的那次会话 id，按钮显示「保存中…」 */
  savingSessionId?: string | null
  onSave: (view: ActiveRowView) => void
  /** 把某一次学习的单词复制到新增的最后一次；copyingKey = 正在复制的「周 + 第几次」 */
  onCopy: (weekStart: number, session: number) => void
  copyingKey?: string
  /** 删除还没开始的一次学习（含复制出来的次数） */
  onDeleteSession: (weekStart: number, session: number) => void
  /** 课堂录音：key = 周 + 第几次；同一次学习的几段已经归好组 */
  recordings?: Map<string, RecordingGroup>
  onPlaybackError: (message: string) => void
}) {
  const per = Math.max(1, task.perSessionCount)
  const started = isStarted(task)

  return (
    <>
      {Array.from({ length: task.sessionCount }, (_, index) => {
        const state = sessionState(task, index)
        const session = task.sessions?.find(item => item.index === index + 1)
        /** 这一次是「学习中 / 学完待保存」：判定和保存按钮落在这一行，跟别的那几次互不影响 */
        const activeRow = state === 'active' ? activeRows?.get(index + 1) : undefined
        const isActiveRow = Boolean(activeRow)
        const marks = state === 'done'
          ? sessionMarks.get(index + 1)
          : activeRow?.marks
        /** 主动推送的那一次不占本周计划的词表，也不能点行改词 */
        const pushed = Boolean(session?.pushed)
        /** 整周任务开始后不能再改整周配置；没开始 / 正在学习中的这一次仍然可以点行改它自己的单词 */
        const clickable = state !== 'done' && !pushed && !(isActiveRow && activeRow?.judged)
        /** 删除这一次：还没开始，且它后面的次数也都还没开始（否则已有记录会错位） */
        const deletable = state === 'todo' && task.sessionCount > 1
          && !(task.sessions ?? []).some(item => item.index >= index + 1)
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
                  <>
                    <Button
                      size="small"
                      onClick={event => { event.stopPropagation(); onEdit(task.weekStart) }}
                    >
                      修改配置
                    </Button>
                    {/* 整行可点击（点行改词），删除按钮的点击不能再冒泡到行上，否则会同时打开配置窗 */}
                    <Button
                      size="small"
                      type="text"
                      danger
                      onClick={event => { event.stopPropagation(); onDelete(task.weekStart) }}
                    >
                      删除
                    </Button>
                  </>
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
              onCopy={onCopy}
              copying={copyingKey === task.weekStart + ':' + (index + 1)}
              copyDisabled={Boolean(copyingKey)}
              onDeleteSession={onDeleteSession}
              deletable={deletable}
              activeJudged={activeRow?.judged}
              saveSlot={activeRow ? (
                <Button
                  type="primary"
                  size="small"
                  className="recite-tasks__row-save"
                  disabled={activeRow.missing > 0 || savingSessionId === activeRow.sessionId}
                  title={activeRow.missing > 0 ? '还有 ' + activeRow.missing + ' 张卡片没有判定，等孩子背完再保存' : '保存这一次的判定'}
                  onClick={event => { event.stopPropagation(); onSave(activeRow) }}
                >
                  {savingSessionId === activeRow.sessionId ? '保存中…' : '保存'}
                </Button>
              ) : undefined}
            />
          </tr>
        )
      })}
    </>
  )
}

function SessionCells({ task, index, per, marks, session, order, saveSlot, recording, onPlaybackError, onCopy, copying, copyDisabled, onDeleteSession, deletable, activeJudged }: {
  task: ReciteTask
  index: number
  per: number
  marks?: Map<string, SessionWord>
  /** 这一次学习的会话记录：主动推送的那一次单词要按卡片取，不来自计划词表 */
  session?: ReciteTaskSession
  /** 这一次学习的单词出现顺序，两侧单词都用它标序号 */
  order?: string[]
  saveSlot?: ReactNode
  /** 这一次学习留下的课堂录音（可能因为关页面 / 切后台分成好几段，已经归好组） */
  recording?: RecordingGroup
  onPlaybackError: (message: string) => void
  /** 复制这一次的单词到新增的最后一次 */
  onCopy: (weekStart: number, session: number) => void
  /** 正在复制这一次 */
  copying?: boolean
  /** 有别的次数正在复制，按钮先禁用 */
  copyDisabled?: boolean
  /** 删除这一次（只对还没开始、且后面都没开始的次数显示） */
  onDeleteSession: (weekStart: number, session: number) => void
  deletable?: boolean
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
  // 读的列列出这一次的全部单词：要背的词也照样先读一遍（背的列只列勾了拼写的）
  const read = pushedWords.length > 0 ? pushedItems : slice
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
        <div className="recite-tasks__times-tools">
          {recording && <ReciteRecordingButton group={recording} onError={onPlaybackError} />}
          <Button
            size="small"
            type="text"
            className="recite-tasks__copy-btn"
            disabled={copyDisabled}
            title="把这一次的单词复制到新增的最后一次"
            onClick={event => { event.stopPropagation(); onCopy(task.weekStart, index + 1) }}
          >
            {copying ? '复制中…' : '复制'}
          </Button>
          {deletable && (
            <Button
              size="small"
              type="text"
              danger
              className="recite-tasks__copy-btn"
              title="删除这一次（还没开始学习）"
              onClick={event => { event.stopPropagation(); onDeleteSession(task.weekStart, index + 1) }}
            >
              删除
            </Button>
          )}
        </div>
      </td>
      {/* data-label：手机端表格转卡片后靠它给两列各标一行小标签 */}
      <td className="recite-tasks__words-cell" data-label="读的单词">
        <WordChips items={read} marks={marks} order={order} />
      </td>
      <td className="recite-tasks__words-cell" data-label="背的单词">
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
  /**
   * 本周全部「学习中 / 学完待保存」的会话（只会属于本周任务）。
   * 孩子没等家长保存就点了继续学习时会有好几条，每条都能单独保存。
   */
  const [activeSessions, setActiveSessions] = useState<ReciteSessionPayload[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  /** 正在复制的那一次（「周 + 第几次」），同时只允许一个复制请求 */
  const [copyingKey, setCopyingKey] = useState('')
  const [copyError, setCopyError] = useState('')
  /** 操作结果 toast：复制 / 删除成功后浮在页底，2.6 秒自动消失（文案相同也靠自增 id 重新出现） */
  const [toast, setToast] = useState<{ text: string; id: number } | null>(null)
  const toastSeq = useRef(0)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  function showToast(text: string) {
    if (!text) return
    const id = ++toastSeq.current
    setToast({ text, id })
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => {
      setToast(current => (current && current.id === id ? null : current))
    }, 2600)
  }

  // 卸载时取消定时器，避免对已卸载组件 setState
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current) }, [])
  /** 删除某一次学习的确认弹窗：存「周 + 第几次」，null 表示关闭 */
  const [deleteSessionTarget, setDeleteSessionTarget] = useState<{ week: number; session: number } | null>(null)
  const [deletingSession, setDeletingSession] = useState(false)
  const [deleteSessionError, setDeleteSessionError] = useState('')
  /** 删除确认弹窗：存目标周（周一 0 点），null 表示关闭 */
  const [deleteWeek, setDeleteWeek] = useState<number | null>(null)
  const [deleting, setDeleting] = useState(false)
  /** 删除失败的原因，显示在确认弹窗里（表格被弹窗盖住，页面上看不见） */
  const [deleteError, setDeleteError] = useState('')
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
  /** 保存抽屉：存要保存的那次会话 id，null 表示抽屉关着 */
  const [saveSessionId, setSaveSessionId] = useState<string | null>(null)
  /** 抽屉里播放课堂录音失败的提示，只显示在抽屉里 */
  const [drawerPlayError, setDrawerPlayError] = useState('')
  /** 抽屉里每张卡各维度要加的次数，key = 卡片 id */
  const [cardTimes, setCardTimes] = useState<Record<string, ReciteCardTimes>>({})
  /** 主动推送：要推送到哪一周（周一 0 点），null 表示弹窗关闭 */
  const [pushWeek, setPushWeek] = useState<number | null>(null)
  /** 「配置周任务」弹窗：只配每次词数 / 每周次数，给下一周建框架，不选单词 */
  const [planOpen, setPlanOpen] = useState(false)
  const [planPer, setPlanPer] = useState(DEFAULT_PER_SESSION)
  /** 输入框里的原始文本：允许先清空再输入，不在每次按键时就夹成 1 */
  const [planPerText, setPlanPerText] = useState(String(DEFAULT_PER_SESSION))
  const [planSessions, setPlanSessions] = useState(DEFAULT_SESSION_COUNT)
  const [planBusy, setPlanBusy] = useState(false)
  const [planError, setPlanError] = useState('')

  useEffect(() => {
    let alive = true
    setLoading(true)
    Promise.all([
      // 只取这一页要显示的周：本周到 12 周后，历史周不再跟着一起读
      fetchReciteTasks({ from: thisWeek, to: thisWeek + MAX_WEEK_OFFSET * 7 * DAY }),
      fetchReciteHistory(HISTORY_LIMIT),
      fetchReciteActiveSession(),
      // 录音只是锦上添花：拉不到不影响任务配置
      fetchReciteRecordings(RECORDING_LIMIT).catch(() => [] as ReciteRecordingSummary[]),
    ])
      .then(([list, history, activePayload, recordingList]) => {
        if (!alive) return
        setTasks(list)
        setHistoryRecords(history.records || [])
        setActiveSessions(activePayloadList(activePayload))
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
  }, [reload, thisWeek])

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

  /**
   * 「配置周任务」建的是「第一个还没配置的周」：本周没配置就先建本周（否则本周永远学不了），
   * 本周配好了再往后排到还没配置的周。
   */
  const planWeek = useMemo(
    () => weeks.find(week => !taskByWeek.has(week)) ?? thisWeek + 7 * DAY,
    [weeks, taskByWeek, thisWeek],
  )

  /** 打开配置周任务弹窗：这一周已有任务（框架）时回填它现在的词数与次数 */
  function openPlan() {
    const existing = taskByWeek.get(planWeek)
    const per = existing?.perSessionCount ?? DEFAULT_PER_SESSION
    setPlanPer(per)
    setPlanPerText(String(per))
    setPlanSessions(existing?.sessionCount ?? DEFAULT_SESSION_COUNT)
    setPlanError('')
    setPlanOpen(true)
  }

  /** 输入框文本 → 实际生效的每次词数：空 / 非法回退到当前值，超出范围夹到 1–200 */
  function resolvedPlanPer(): number {
    const parsed = Number(planPerText)
    if (!Number.isFinite(parsed) || parsed < 1) return planPer
    return Math.min(MAX_PER_SESSION, Math.floor(parsed))
  }

  /** 输入途中只接受合法值；清空 / 输入 0 时先留着文本，失焦再回填，这样才输得出 20、30 */
  function changePlanPer(raw: string) {
    setPlanPerText(raw)
    const parsed = Number(raw)
    if (Number.isFinite(parsed) && parsed >= 1) setPlanPer(Math.min(MAX_PER_SESSION, Math.floor(parsed)))
  }

  /** 失焦时把文本归一化：空串、0、小数都回填成实际生效的整数 */
  function commitPlanPer() {
    const next = resolvedPlanPer()
    setPlanPer(next)
    setPlanPerText(String(next))
  }

  /** 保存框架：服务端只写词数与次数，不选单词；单词随后在每一行里配置 */
  async function savePlan() {
    if (planBusy) return
    setPlanBusy(true)
    setPlanError('')
    try {
      await planReciteTask({ weekStart: planWeek, perSessionCount: resolvedPlanPer(), sessionCount: planSessions })
      setPlanOpen(false)
      setReload(value => value + 1)
    } catch (error) {
      setPlanError(error instanceof Error ? error.message : '周任务创建失败，请重试')
    } finally {
      setPlanBusy(false)
    }
  }

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

  /**
   * 课堂录音按「周 + 第几次」归组：一次学习可能录成好几段（关页面 / 切后台），
   * 顺序可信就在行内当一条播，不可信就分段各给一个按钮。
   */
  const recordingBySession = useMemo(() => {
    const map = new Map<string, RecordingGroup>()
    for (const [key, group] of groupReciteRecordings(recordings)) {
      if (key.startsWith('recording:')) continue
      map.set(key, group)
    }
    return map
  }, [recordings])

  /**
   * 每个待确认会话一份视图数据：逐词判定（草稿优先）、还差几张没判、待保存的卡片。
   * 同时有好几次「学习中 / 学完待保存」时各算各的，保存按钮和抽屉都按会话走。
   */
  const activeViews = useMemo<ActiveRowView[]>(() => {
    const views: ActiveRowView[] = []
    for (const payload of activeSessions) {
      const session = payload.session
      if (!session) continue
      const drafts = new Map((payload.drafts ?? []).map(draft => [draft.cardId, draft]))
      const cards = payload.cards ?? []
      const pendingCards = cards
        .filter(card => card.status === 'pending')
        .slice()
        .sort((a, b) => a.position - b.position)
      const missing = pendingCards.filter(card => !drafts.has(card.id)).length
      views.push({
        sessionId: session.sessionId,
        weekStart: payload.task?.weekStart ?? 0,
        sessionIndex: session.sessionIndex,
        marks: wordsToMarks(cards.map(card => ({
          word: card.word,
          displayText: card.displayText,
          cardType: card.cardType,
          result: drafts.get(card.id)?.result ?? card.result,
        }))),
        missing,
        judged: missing === 0,
        pendingCards,
        drafts,
        payload,
      })
    }
    return views
  }, [activeSessions])

  /** 按「周 → 第几次」索引，表格每一行去找自己那一次的视图 */
  const activeRowsByWeek = useMemo(() => {
    const map = new Map<number, Map<number, ActiveRowView>>()
    for (const view of activeViews) {
      const rows = map.get(view.weekStart) ?? new Map<number, ActiveRowView>()
      rows.set(view.sessionIndex, view)
      map.set(view.weekStart, rows)
    }
    return map
  }, [activeViews])

  /** 抽屉正在保存的那一次；会话被保存 / 关掉抽屉后清空 */
  const saveView = saveSessionId
    ? activeViews.find(view => view.sessionId === saveSessionId) ?? null
    : null
  const pendingCards = saveView?.pendingCards ?? []
  const activeMissing = saveView?.missing ?? 0

  /** 点行右侧「保存」：先弹抽屉，按这次会话的卡片判定给好默认次数 */
  function openSaveDrawer(view: ActiveRowView) {
    const initial: Record<string, ReciteCardTimes> = {}
    for (const card of view.pendingCards) {
      initial[card.id] = defaultCardTimes(view.drafts.get(card.id)?.result)
    }
    setCardTimes(initial)
    setSaveError('')
    setSaveSessionId(view.sessionId)
  }

  /** 关抽屉：清掉抽屉里的播放失败提示（按钮卸载时会自动停掉正在播的录音） */
  function closeSaveDrawer() {
    setDrawerPlayError('')
    setSaveSessionId(null)
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

  /** 把这一次会话的草稿统一提交保存（带上抽屉里填的次数），保存后刷新整个页面 */
  async function saveActiveSession() {
    const view = saveView
    const session = view?.payload.session
    if (!view || !session || saving) return
    setSaving(true)
    setSaveError('')
    try {
      const answers = view.pendingCards.map(card => {
        const draft = view.drafts.get(card.id)
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
      setSaveSessionId(null)
      setReload(value => value + 1)
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : '保存失败，请重试')
    } finally {
      setSaving(false)
    }
  }

  /** 删除一周还没开始的任务：删完重拉列表，这一周回到「配置这一周任务」 */
  async function removeTask() {
    if (deleteWeek === null || deleting) return
    setDeleting(true)
    setDeleteError('')
    try {
      await deleteReciteTask(deleteWeek)
      setDeleteWeek(null)
      setReload(value => value + 1)
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : '删除任务失败，请重试')
    } finally {
      setDeleting(false)
    }
  }

  /** 复制某一次的单词到新增的最后一次：服务端本周次数 +1，重新拉任务列表 */
  async function copySessionWords(weekStart: number, session: number) {
    if (copyingKey) return
    setCopyingKey(weekStart + ':' + session)
    setCopyError('')
    try {
      const result = await copyReciteSession(weekStart, session)
      showToast('已把第 ' + session + ' 次的 ' + result.count + ' 个单词复制到新增的第 ' + result.sessionIndex + ' 次。')
      setReload(value => value + 1)
    } catch (error) {
      setCopyError(error instanceof Error ? error.message : '复制失败，请重试')
    } finally {
      setCopyingKey('')
    }
  }

  /** 删除还没开始的一次学习：删完重拉任务列表，这一周次数减 1 */
  async function removeSession() {
    if (!deleteSessionTarget || deletingSession) return
    setDeletingSession(true)
    setDeleteSessionError('')
    try {
      const result = await deleteReciteSession(deleteSessionTarget.week, deleteSessionTarget.session)
      showToast('已删除第 ' + deleteSessionTarget.session + ' 次学习，本周剩 ' + result.sessionCount + ' 次。')
      setDeleteSessionTarget(null)
      setReload(value => value + 1)
    } catch (error) {
      setDeleteSessionError(error instanceof Error ? error.message : '删除失败，请重试')
    } finally {
      setDeletingSession(false)
    }
  }

  /** 只有还没学完的那一次才挡着推送；已经学完只是没点保存的，推送时服务端会先按默认次数保存 */
  const pushBlocked = Boolean(taskByWeek.get(thisWeek)?.sessions?.some(
    session => session.status === 'active' && !session.judged,
  ))
  /** 抽屉里那次学习的课堂录音（抽屉顶部试听，没有录音就显示「暂无音频」） */
  const activeRecording = saveView
    ? recordingBySession.get(saveView.weekStart + ':' + saveView.sessionIndex)
    : undefined

  return (
    <div className="page page--wide">
      <PageHeader
        title="配置背词任务"
        actions={<Button onClick={onBack}>返回英语学习</Button>}
      />

      <section className="card card--pad recite-tasks">
        <div className="recite-tasks__head">
          <h2 className="recite-tasks__title">各周任务</h2>
          <span className="recite-tasks__hint">
            {loading ? '正在读取…' : '本周至 12 周后，已配置 ' + configuredCount + ' 周'}
          </span>
          <Button size="small" className="recite-tasks__plan-btn" onClick={openPlan}>
            配置周任务
          </Button>
        </div>

        {loadError && <p className="callout callout--error">{loadError}</p>}
        {saveError && <p className="callout callout--error">{saveError}</p>}
        {playError && <p className="callout callout--error">{playError}</p>}
        {copyError && <p className="callout callout--error">{copyError}</p>}

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
                          <span className="recite-tasks__empty-text">
                            这一周还没有背词任务，点右上角「配置周任务」新建
                          </span>
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
                      onDelete={weekStart => { setDeleteError(''); setDeleteWeek(weekStart) }}
                      onPush={() => setPushWeek(task.weekStart)}
                      pushDisabled={pushBlocked}
                      pushReason="有进行中的一次学习，学完再推送"
                      sessionMarks={marksByWeek.get(week) ?? new Map()}
                      activeRows={activeRowsByWeek.get(task.weekStart)}
                      savingSessionId={saving ? saveView?.sessionId ?? null : null}
                      onSave={openSaveDrawer}
                      onCopy={copySessionWords}
                      copyingKey={copyingKey}
                      onDeleteSession={(week, session) => { setDeleteSessionError(''); setDeleteSessionTarget({ week, session }) }}
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
        open={saveSessionId !== null}
        width="wide"
        title={saveView ? '确认这次学习的次数 · 第 ' + saveView.sessionIndex + ' 次' : '确认这次学习的次数'}
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
        <ReciteRecordingPlayer group={activeRecording} onError={setDrawerPlayError} />
        {activeMissing > 0 && (
          <p className="callout callout--warn">还有 {activeMissing} 张卡片没有判定，等孩子背完再保存。</p>
        )}
        {saveError && <p className="callout callout--error">{saveError}</p>}
        {drawerPlayError && <p className="callout callout--error">{drawerPlayError}</p>}
        <ul className="recite-tasks__counts">
          {pendingCards.map(card => {
            const times = cardTimes[card.id] ?? { spelling: 0, reading: 0, meaning: 0 }
            const no = card.position + 1
            const result = saveView?.drafts.get(card.id)?.result
            return (
              <li key={card.id} className="recite-tasks__count-row">
                <span className="recite-tasks__count-no">{no}</span>
                <span
                  className="recite-tasks__count-word"
                  title={card.cardType === 'spelling' ? '拼写卡：' + card.word + ' = ' + (card.translation || '') : undefined}
                >
                  {/* 一律显示英文单词：拼写卡的 displayText 是中文释义，不能拿来当标题 */}
                  {card.word}
                  {card.cardType === 'spelling' && (
                    <i className="recite-tasks__count-kind">拼写</i>
                  )}
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
                      confirm={false}
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

      <Modal
        open={deleteWeek !== null}
        title="删除这一周的背词任务？"
        onClose={() => { if (!deleting) setDeleteWeek(null) }}
        footer={
          <>
            <Button disabled={deleting} onClick={() => setDeleteWeek(null)}>取消</Button>
            <Button type="primary" danger loading={deleting} onClick={() => { void removeTask() }}>
              删除
            </Button>
          </>
        }
      >
        <p className="hint">
          只删除还没开始的任务配置，删掉后这一周可以重新选词配置；已经开始过的周不能删除。
        </p>
        {deleteError && <p className="callout callout--error">{deleteError}</p>}
      </Modal>

      <Modal
        open={deleteSessionTarget !== null}
        title={'删除第 ' + (deleteSessionTarget?.session ?? '') + ' 次学习？'}
        onClose={() => { if (!deletingSession) setDeleteSessionTarget(null) }}
        footer={
          <>
            <Button disabled={deletingSession} onClick={() => setDeleteSessionTarget(null)}>取消</Button>
            <Button type="primary" danger loading={deletingSession} onClick={() => { void removeSession() }}>
              删除
            </Button>
          </>
        }
      >
        <p className="hint">
          只删除还没开始的这一次，单词会一起移除，本周学习次数减 1；已学过的次数不受影响。
        </p>
        {deleteSessionError && <p className="callout callout--error">{deleteSessionError}</p>}
      </Modal>

      <Modal
        open={planOpen}
        title={'配置周任务 · ' + fmtWeek(planWeek)}
        onClose={() => { if (!planBusy) setPlanOpen(false) }}
        footer={
          <>
            <Button disabled={planBusy} onClick={() => setPlanOpen(false)}>取消</Button>
            <Button type="primary" loading={planBusy} onClick={() => { void savePlan() }}>
              保存
            </Button>
          </>
        }
      >
        <p className="hint">
          只配置每次学习单词数与每周学习次数，会为 {fmtWeek(planWeek)} 这一周建好任务但不选单词；
          保存后点每一行「第 N 次」配置那一次要学的单词。
        </p>
        <div className="recite-tasks__plan-form">
          <div className="recite-tasks__plan-field">
            <label className="field-label" htmlFor="recite-plan-per">每次学习单词数</label>
            <Input
              id="recite-plan-per"
              type="number"
              min={1}
              max={MAX_PER_SESSION}
              value={planPerText}
              onChange={event => changePlanPer(event.target.value)}
              onBlur={commitPlanPer}
            />
          </div>
          <div className="recite-tasks__plan-field">
            <label className="field-label" htmlFor="recite-plan-sessions">每周学习次数</label>
            <Select
              id="recite-plan-sessions"
              block={false}
              value={String(planSessions)}
              options={SESSION_OPTIONS}
              aria-label="每周学习次数"
              onChange={value => setPlanSessions(Number(value) || 1)}
            />
          </div>
        </div>
        {planError && <p className="callout callout--error">{planError}</p>}
      </Modal>

      {toast && (
        <div key={toast.id} className="recite-tasks__toast" role="status" aria-live="polite">
          <span className="recite-tasks__toast-mark" aria-hidden="true">✓</span>
          <span>{toast.text}</span>
        </div>
      )}

      <RecitePushPanel
        open={pushWeek !== null}
        study={study}
        weekStart={pushWeek ?? thisWeek}
        blockedReason={pushBlocked ? '有进行中的一次学习，学完再推送' : undefined}
        onClose={() => setPushWeek(null)}
        onPushed={() => {
          setPushWeek(null)
          setReload(value => value + 1)
        }}
      />
    </div>
  )
}
