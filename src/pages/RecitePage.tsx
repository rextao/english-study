import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { saveReciteDraft } from '../hooks/useRecite'
import { readRecordPref, useReciteRecording, writeRecordPref } from '../hooks/useReciteRecording'
import { useRecitePreload } from '../hooks/useRecitePreload'
import type { ReciteSessionPayload, ReciteTask } from '../hooks/useRecite'
import { ReciteDebugPanel } from '../components/ReciteDebugPanel'
import { speak, speechErrorMessage, stopSpeech } from '../utils/speech'
import { flushQueuedRecordings } from '../utils/reciteRecordingUpload'
import './RecitePage.css'

interface RecitePageProps {
  payload: ReciteSessionPayload | null
  loading: boolean
  error: string | null
  onReload: () => void
  /** 首页只读本周任务概况，点了「开始学习」之后才创建 / 恢复会话 */
  started: boolean
  homeTask: ReciteTask | null
  homeLoading: boolean
  homeError: string | null
  onStart: () => void
}

type MeaningResult = 'known' | 'unknown'

interface DraftAnswer {
  cardId: string
  result: MeaningResult | 'correct' | 'skipped'
  answer?: string
  attempts: number
}

/** 键盘只有两行小写字母：第一行 q、w，第二行按 a–z 顺序排列（小朋友按字母表找键更容易，输入统一小写）；
    第二行到 q、w 的位置只留半透明空位，字母表顺序不乱，也不会和第一行重复 */
const KEYBOARD_ROWS = ['qw', 'abcdefghijklmnopqrstuvwxyz']
const FIRST_ROW_KEYS = 'qw'

function normalize(value: string) {
  return value.trim().replace(/\s+/g, ' ').toLowerCase()
}

/**
 * 完成按钮的庆祝特效：一次只放一种，每次打开 / 刷新完成页随机挑一种。
 * 四种都是「从页面底部出发」，互不叠加。
 */
type FxKind = 'smoke' | 'firework' | 'bubble' | 'heart'
const FX_KINDS: FxKind[] = ['smoke', 'firework', 'bubble', 'heart']
type FxParticle = { key: string; className: string; style: CSSProperties }
/** 各特效的总时长：最长的一条粒子走完就清掉，避免拖尾的空等 */
const FX_DURATION: Record<FxKind, number> = { smoke: 4300, firework: 2600, bubble: 4600, heart: 3700 }
/** 同时最多叠几次特效：满了就等最早那次播完再响应点击 */
const MAX_FX_ROUNDS = 3
/** 一轮特效：id 用作重新挂载的 key，播完只移除自己那一轮，不影响后来叠上的 */
type FxRound = { id: number; particles: FxParticle[] }

function pickFxKind(): FxKind {
  return FX_KINDS[Math.floor(Math.random() * FX_KINDS.length)]
}

function generateFx(kind: FxKind): FxParticle[] {
  const particles: FxParticle[] = []
  const rand = (min: number, max: number) => min + Math.random() * (max - min)
  const pick = <T,>(arr: T[]) => arr[Math.floor(Math.random() * arr.length)]
  // 五彩缤纷：烟雾每团换一种颜色，烟花每朵换一种颜色
  const palette = ['#FF6B6B', '#FFD93D', '#4ECDC4', '#95E1D3', '#AA96DA', '#FCBAD3', '#F9A26C', '#6FBF9B', '#5AA9E6', '#F38181']

  if (kind === 'smoke') {
    // 五彩烟雾：从页面底部各处升起，一路摇晃长大，飘到顶部后淡出
    for (let i = 0; i < 20; i += 1) {
      particles.push({
        key: 'smoke-' + i,
        className: 'fx-particle fx-smoke',
        style: {
          '--x': rand(2, 98) + '%',
          '--size': rand(26, 74) + 'px',
          '--color': pick(palette),
          // 往上飘一整屏多一点，保证能飘到顶部
          '--rise': rand(92, 118) + 'vh',
          '--drift': rand(-70, 70) + 'px',
          '--delay': rand(0, 1) + 's',
          '--dur': rand(2.4, 3.2) + 's',
        } as CSSProperties,
      })
    }
    return particles
  }

  if (kind === 'firework') {
    // 烟花：底部发射一枚火箭升到空中炸开，每朵 12 粒火花
    for (let b = 0; b < 5; b += 1) {
      const x = rand(12, 88)
      const cy = rand(48, 82)
      const color = pick(palette)
      const launch = rand(0, 0.7)
      particles.push({
        key: 'rocket-' + b,
        className: 'fx-particle fx-rocket',
        style: {
          '--x': x + '%',
          '--cy': cy + 'vh',
          '--drift': rand(-3, 3) + 'vw',
          '--color': color,
          '--delay': launch + 's',
        } as CSSProperties,
      })
      for (let i = 0; i < 12; i += 1) {
        const angle = (i / 12) * Math.PI * 2
        const dist = rand(46, 104)
        particles.push({
          key: 'burst-' + b + '-' + i,
          className: 'fx-particle fx-firework',
          style: {
            '--x': x + '%',
            '--cy': cy + 'vh',
            '--dx': Math.cos(angle) * dist + 'px',
            '--dy': Math.sin(angle) * dist + 'px',
            '--color': color,
            // 等火箭升到位再炸开（火花前 30% 是跟着上升，看不见）
            '--delay': launch + 0.45 + 's',
          } as CSSProperties,
        })
      }
    }
    return particles
  }

  if (kind === 'bubble') {
    // 泡泡：数量少一些，从底部摇晃上飘到页面顶部，到顶后放大炸开消失
    for (let i = 0; i < 9; i += 1) {
      particles.push({
        key: 'bubble-' + i,
        className: 'fx-particle fx-bubble',
        style: {
          '--x': rand(6, 94) + '%',
          '--size': rand(18, 56) + 'px',
          // 飘到接近屏幕顶部才炸：比一屏略矮，爆破点留在可视区
          '--rise': rand(80, 92) + 'vh',
          '--drift': rand(-70, 70) + 'px',
          '--delay': rand(0, 1.2) + 's',
          '--dur': rand(2.6, 3.4) + 's',
        } as CSSProperties,
      })
    }
    return particles
  }

  // 爱心飘升：发光爱心从底部向上飘浮 + 摇摆 + 放大淡出
  for (let i = 0; i < 16; i += 1) {
    particles.push({
      key: 'heart-' + i,
      className: 'fx-particle fx-heart',
      style: {
        '--x': rand(4, 96) + '%',
        '--size': rand(20, 52) + 'px',
        '--rise': rand(80, 105) + 'vh',
        '--drift': rand(-110, 110) + 'px',
        '--delay': rand(0, 0.8) + 's',
        '--dur': rand(2.2, 2.8) + 's',
      } as CSSProperties,
    })
  }
  return particles
}

export function RecitePage({
  payload,
  loading,
  error,
  onReload,
  started,
  homeTask,
  homeLoading,
  homeError,
  onStart,
}: RecitePageProps) {
  const cards = payload?.cards ?? []
  const session = payload?.session ?? null
  const [index, setIndex] = useState(0)
  // 判定先写服务端草稿：不推进轮次，家长换设备也能读到同一份结果
  const [answers, setAnswers] = useState<Record<string, DraftAnswer>>({})
  const [stage, setStage] = useState<'cards' | 'celebrate'>('cards')
  const [flipped, setFlipped] = useState(false)
  const [input, setInput] = useState('')
  const [attempts, setAttempts] = useState(0)
  const [feedback, setFeedback] = useState<'correct' | 'wrong' | 'skipped' | null>(null)
  const [localError, setLocalError] = useState('')
  // 喇叭：任何情况都显示，点了才去请求 /api/tts，失败把原因直接写在页面上
  const [speaking, setSpeaking] = useState(false)
  const [speechError, setSpeechError] = useState('')
  // 连点喇叭时只认最后一次：旧的那次被掐掉后不会再改回「播放中」
  const playToken = useRef(0)
  // 点「下一张」先把卡片滑出去（180ms）再换下一张，换卡不是硬切
  const [leaving, setLeaving] = useState(false)
  // 回看已学卡片时点卡片正反面切换的翻面动画
  const [flipAnim, setFlipAnim] = useState(false)
  // 完成页正在播的庆祝特效：每点一次「完成」叠一轮新的，旧的继续播完，最多同时 3 轮
  const [fxRounds, setFxRounds] = useState<FxRound[]>([])
  // 这次打开页面固定用哪一种特效（刷新才重新随机），点「完成」只重播这一种
  const [fxKind] = useState<FxKind>(pickFxKind)
  const fxId = useRef(0)
  // 还在播的轮数：用 ref 数而不是读 state，连点两下也不会超叠到第 4 轮
  const fxActive = useRef(0)
  // 每轮特效自己的清理定时器：播完的那轮自己下线，剩下的继续播
  const fxTimers = useRef(new Map<number, number>())
  const leaveTimer = useRef(0)
  // 还有没判过的卡片才算在学：完成页刷新进来时所有卡片都有服务端草稿，不能再自动开录
  const draftCardIds = new Set((payload?.drafts ?? []).map(draft => draft.cardId))
  const hasCardToLearn = cards.some(item => item.status === 'pending' && !draftCardIds.has(item.id))
  const recordingActive = started
    && stage === 'cards'
    && !payload?.complete
    && payload?.session?.status === 'active'
    && hasCardToLearn
  // 课堂录音：首页左下角的开关默认开启；进背词流开始录，学完 / 离开页面自动停并上传
  const [recordEnabled, setRecordEnabled] = useState(readRecordPref)
  const recording = useReciteRecording({
    enabled: recordEnabled,
    active: recordingActive,
    sessionId: payload?.session?.sessionId ?? null,
  })

  // 上次没传完的录音片段：一进背词页就补传，网络恢复时再试（传完才删本地副本）
  useEffect(() => {
    void flushQueuedRecordings()
    const onOnline = () => { void flushQueuedRecordings() }
    window.addEventListener('online', onOnline)
    return () => window.removeEventListener('online', onOnline)
  }, [])

  // 打开页面、还没点「开始学习」时，把本周的单词发音预取到本地（优先下一次要学的那一次）
  const preload = useRecitePreload(homeTask, !started)
  // 右下角齿轮：输入口令 123 后打开调试面板（录音状态 + 本地缓存情况）
  const [debugOpen, setDebugOpen] = useState(false)
  const week = homeTask ?? payload?.task ?? null

  /** 录音开关的偏好：开关本身和调试面板里的按钮都走这里 */
  const applyRecordPref = (next: boolean) => {
    setRecordEnabled(next)
    writeRecordPref(next)
  }

  useEffect(() => stopSpeech, [])

  // 离开页面时把未走完的换卡 / 特效定时器清掉
  useEffect(() => () => {
    if (leaveTimer.current) window.clearTimeout(leaveTimer.current)
    for (const timer of fxTimers.current.values()) window.clearTimeout(timer)
    fxTimers.current.clear()
  }, [])

  /** 把所有正在播的特效一起收掉（换会话时用） */
  function clearFx() {
    for (const timer of fxTimers.current.values()) window.clearTimeout(timer)
    fxTimers.current.clear()
    fxActive.current = 0
    setFxRounds([])
  }

  /**
   * 点「完成」只放庆祝特效：不关窗口、也不跳回任务首页（跳转会重新拉数据，容易弹出令牌门）。
   * 新的一轮叠在旧的上，不清掉之前那几次；已经叠满 3 轮时先不响应，等最早那轮播完就能再点。
   */
  function handleFinish() {
    if (fxActive.current >= MAX_FX_ROUNDS) return
    fxActive.current += 1
    fxId.current += 1
    const id = fxId.current
    setFxRounds(rounds => [...rounds, { id, particles: generateFx(fxKind) }])
    const timer = window.setTimeout(() => {
      fxTimers.current.delete(id)
      fxActive.current -= 1
      setFxRounds(rounds => rounds.filter(round => round.id !== id))
    }, FX_DURATION[fxKind])
    fxTimers.current.set(id, timer)
  }

  // 换会话：草稿来自 Server，已经判完的会话直接进完成动画
  useEffect(() => {
    if (!payload?.session) return
    clearFx()
    const list = payload.cards ?? []
    const seeded: Record<string, DraftAnswer> = {}
    for (const draft of payload.drafts ?? []) {
      seeded[draft.cardId] = {
        cardId: draft.cardId,
        result: draft.result,
        answer: draft.answer,
        attempts: draft.attempts,
      }
    }
    const pending = list.filter(card => card.status === 'pending')
    const nextCard = pending.find(card => !seeded[card.id])
    const nextIndex = nextCard ? list.findIndex(card => card.id === nextCard.id) : list.length
    setIndex(nextIndex < 0 ? list.length : nextIndex)
    setAnswers(seeded)
    setFlipped(false)
    setInput('')
    setAttempts(0)
    setFeedback(null)
    setLocalError('')
    setStage(pending.length > 0 && nextCard ? 'cards' : 'celebrate')
  }, [payload?.session?.sessionId, payload?.session?.cursor])

  // 换卡片时清掉上一张的输入和反馈
  useEffect(() => {
    // 回看已答过的卡片时直接展示当时的判定：meaning 翻面看中文，spelling 看对错
    const target = cards[index]
    const draft = target ? answers[target.id] : undefined
    setFlipped(false)
    setInput(draft && target.cardType === 'spelling' ? draft.answer ?? '' : '')
    setAttempts(draft?.attempts ?? 0)
    setFeedback(
      draft && target.cardType === 'spelling'
        ? (draft.result === 'correct' ? 'correct' : 'skipped')
        : null,
    )
    setSpeechError('')
    setSpeaking(false)
    stopSpeech()
  }, [index])

  const card = cards[index] ?? null
  const isSpelling = card?.cardType === 'spelling'
  const display = card?.displayText || card?.word || ''
  const answer = card?.word || ''
  const total = session?.cardCount || cards.length || 0
  const lastCard = index + 1 >= cards.length

  // 是否是已答过的回看卡片（进度轨道点进来的）
  const isReview = card ? Boolean(answers[card.id]) : false

  // 回看时点卡片正反面切换（带 3D 翻转动画）
  function flipCard() {
    if (!isReview || isSpelling) return
    setFlipAnim(true)
    setTimeout(() => {
      setFlipped(v => !v)
      setFlipAnim(false)
    }, 150)
  }

  function advance() {
    if (index + 1 >= cards.length) {
      setStage('celebrate')
      return
    }
    setIndex(index + 1)
  }

  /** 翻面后回看上一张：已答过的卡片会按草稿恢复翻面 / 已输入的拼写 */
  function previousCard() {
    if (index === 0) return
    setIndex(index - 1)
  }

  /** 先更新本地界面，再把草稿写到 Server；写失败时保留本地判定，家长保存时会重新提交 */
  function persistDraft(draft: DraftAnswer) {
    setAnswers(previous => ({ ...previous, [draft.cardId]: draft }))
    if (!session) return
    setLocalError('')
    void saveReciteDraft(session.sessionId, {
      cardId: draft.cardId,
      result: draft.result,
      answer: draft.answer,
      attempts: draft.attempts,
    }).catch(() => {
      setLocalError('草稿同步失败，家长保存记录时会重新提交')
    })
  }

  function markMeaning(result: MeaningResult) {
    if (!card || card.cardType !== 'meaning') return
    persistDraft({ cardId: card.id, result, attempts: 0 })
    setFlipped(true)
  }

  /** 播离场动画，180ms 后切到下一张（最后一张则进完成页） */
  function leaveToNext() {
    if (leaving) return
    setLeaving(true)
    leaveTimer.current = window.setTimeout(() => {
      leaveTimer.current = 0
      setLeaving(false)
      advance()
    }, 180)
  }

  function nextCard() {
    if (!card || !answers[card.id]) return
    leaveToNext()
  }

  /** 拼写卡完全不不会：记为跳过，然后直接跳下一张（不停在答案上） */
  function skipSpellingDirect() {
    if (!card || card.cardType !== 'spelling' || feedback) return
    persistDraft({ cardId: card.id, result: 'skipped', answer: input, attempts })
    leaveToNext()
  }

  function addKey(key: string) {
    if (feedback) return
    setInput(value => value + key)
  }

  function submitSpelling() {
    if (!card || card.cardType !== 'spelling' || feedback) return
    if (normalize(input) !== normalize(answer)) {
      setAttempts(value => value + 1)
      setFeedback('wrong')
      return
    }
    persistDraft({ cardId: card.id, result: 'correct', answer: input, attempts })
    setFeedback('correct')
  }

  function skipSpelling() {
    if (!card || card.cardType !== 'spelling' || feedback === 'correct') return
    persistDraft({ cardId: card.id, result: 'skipped', answer: input, attempts })
    setFeedback('skipped')
  }

  /** 拼写卡在「拼对 / 跳过看答案」之前不出声，否则等于把答案念出来（拼错一次也还算没判定） */
  const spellingLocked = isSpelling && feedback !== 'correct' && feedback !== 'skipped'

  function playWord() {
    if (!card || spellingLocked) return
    const token = playToken.current + 1
    playToken.current = token
    setSpeechError('')
    setSpeaking(true)
    void speak(answer)
      .catch(error => {
        if (playToken.current === token) setSpeechError(speechErrorMessage(error))
      })
      .finally(() => {
        if (playToken.current === token) setSpeaking(false)
      })
  }

  // 左下角的录音标识：绿 = 录音中，灰 = 没开，红 = 不可用 / 开录失败，黄 = 正在开启
  const recordUnavailable = !recording.supported
  const recordFailed = !recordUnavailable && recordEnabled && recording.startFailed
  // 录音状态合并进设置按钮颜色：绿色 = 可用，红色 = 不可用 / 失败
  const recordOk = !recordUnavailable && !recordFailed && !recording.error

  // 左下角的调试入口：绿色 = 录音可用，红色 = 录音不可用 / 失败；输口令 123 进调试面板
  const debugButton = (
    <button
      type="button"
      className={'recite__debug-btn' + (recordOk ? ' is-ok' : ' is-bad')}
      aria-label="打开调试面板"
      title={recordOk ? '调试面板' : '录音有问题，点开看看'}
      onClick={() => setDebugOpen(true)}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <circle cx="12" cy="12" r="3.1" />
        <path d="M19.1 14.6a1.5 1.5 0 0 0 .3 1.65l.05.05a1.8 1.8 0 1 1-2.55 2.55l-.05-.05a1.5 1.5 0 0 0-1.65-.3 1.5 1.5 0 0 0-.9 1.37V20a1.8 1.8 0 1 1-3.6 0v-.08a1.5 1.5 0 0 0-.98-1.37 1.5 1.5 0 0 0-1.65.3l-.05.05a1.8 1.8 0 1 1-2.55-2.55l.05-.05a1.5 1.5 0 0 0 .3-1.65 1.5 1.5 0 0 0-1.37-.9H4a1.8 1.8 0 1 1 0-3.6h.08a1.5 1.5 0 0 0 1.37-.98 1.5 1.5 0 0 0-.3-1.65l-.05-.05A1.8 1.8 0 1 1 7.65 4.9l.05.05a1.5 1.5 0 0 0 1.65.3h.07a1.5 1.5 0 0 0 .9-1.37V3.8a1.8 1.8 0 1 1 3.6 0v.08a1.5 1.5 0 0 0 .9 1.37 1.5 1.5 0 0 0 1.65-.3l.05-.05a1.8 1.8 0 1 1 2.55 2.55l-.05.05a1.5 1.5 0 0 0-.3 1.65v.07a1.5 1.5 0 0 0 1.37.9H20a1.8 1.8 0 1 1 0 3.6h-.08a1.5 1.5 0 0 0-1.37.9z" />
      </svg>
    </button>
  )

  // 调试面板放在 .recite 根节点里：卡片上带 transform 动画，弹窗挂在卡片里会被当成固定定位的参照
  const debugPanel = (
    <ReciteDebugPanel
      open={debugOpen}
      onClose={() => setDebugOpen(false)}
      recording={recording}
      recordEnabled={recordEnabled}
      onRecordToggle={applyRecordPref}
      preload={preload}
      onReloadCache={preload.reload}
      weekStart={week?.weekStart ?? null}
      weekEnd={week?.weekEnd ?? null}
    />
  )

  // 首页：本周任务概况 + 开始学习。不创建会话，点开始才进入背词流
  if (!started) {
    if (homeLoading) {
      return (
        <div className="recite recite--state">
          <div className="recite__panel recite__panel--lite">
            <span className="recite__spinner" aria-hidden="true" />
            <b>正在准备今天的学习…</b>
          </div>
                    {debugButton}
          {debugPanel}
        </div>
      )
    }
    if (homeError) {
      return (
        <div className="recite recite--state">
          <div className="recite__panel recite__panel--lite">
            <b>学习任务读取失败</b>
            <p>{homeError}</p>
            <button type="button" className="recite__state-btn" onClick={onReload}>重试读取</button>
          </div>
                    {debugButton}
          {debugPanel}
        </div>
      )
    }
    if (!homeTask) {
      return (
        <div className="recite recite--state">
          <div className="recite__panel recite__panel--lite">
            <span className="recite__emoji">🌤️</span>
            <b>当前没有待学习内容</b>
            <p>请先在英语学习页准备本周任务。</p>
          </div>
                    {debugButton}
          {debugPanel}
        </div>
      )
    }
    const finished = homeTask.completedSessions >= homeTask.sessionCount
    const nextIndex = homeTask.activeSessionIndex ?? homeTask.completedSessions + 1
    return (
      <div className="recite recite--state">
        <div className="recite__panel recite__panel--lite">
          <span className="recite__emoji">{finished ? '🏆' : '📚'}</span>
          <b className="recite__state-title">{finished ? '本周学习已完成' : '今天背单词'}</b>
          <p className="recite__state-sub">
            {finished
              ? '本周 ' + homeTask.sessionCount + ' 次学习全部完成，真棒！'
              : '本周第 ' + nextIndex + ' / ' + homeTask.sessionCount + ' 次，每次 ' + homeTask.perSessionCount + ' 个单词'}
          </p>
          {!finished && (
            <button
              type="button"
              className="recite__state-btn"
              // 先在手势里要麦克风再开会话：等会话回来再要，Safari 常常不给
              onClick={() => { recording.prime(); onStart() }}
            >
              {homeTask.activeSessionIndex == null ? '开始学习' : '继续学习'}
            </button>
          )}
        </div>
                {debugButton}
        {debugPanel}
      </div>
    )
  }

  if (loading) {
    return (
      <div className="recite recite--state">
        <div className="recite__panel recite__panel--lite">
          <span className="recite__spinner" aria-hidden="true" />
          <b>正在准备今天的学习…</b>
        </div>
                {debugButton}
        {debugPanel}
      </div>
    )
  }

  if (error) {
    return (
      <div className="recite recite--state">
        <div className="recite__panel recite__panel--lite">
          <b>学习任务读取失败</b>
          <p>{error}</p>
          <button type="button" className="recite__state-btn" onClick={onReload}>重试读取</button>
        </div>
                {debugButton}
        {debugPanel}
      </div>
    )
  }

  if (!payload?.task) {
    return (
      <div className="recite recite--state">
        <div className="recite__panel recite__panel--lite">
          <span className="recite__emoji">🌤️</span>
          <b>当前没有待学习内容</b>
          <p>请先在英语学习页准备本周任务。</p>
        </div>
                {debugButton}
        {debugPanel}
      </div>
    )
  }

  if (payload.complete || stage === 'celebrate') {
    return (
      <div className="recite recite--celebrate">
        <div className="recite__celebrate-card">
          <div className="recite__trophy" aria-hidden="true">🏆</div>
          <h1 className="recite__celebrate-title">太棒啦，全部完成！</h1>
          {localError && <p className="recite__error">{localError}</p>}
          <button type="button" className="recite__confirm" onClick={handleFinish}>完成</button>
        </div>
        {fxRounds.map(round => (
          <div className="fx-overlay" key={round.id} aria-hidden="true">
            {round.particles.map(p => <span key={p.key} className={p.className} style={p.style} />)}
          </div>
        ))}
        {debugButton}
        {debugPanel}
      </div>
    )
  }

  // 单词长度写进 CSS 变量，字号按它自适应：单词越长字号越小，整词总能放进卡片
  const promptStyle = { '--len': String(Math.max(1, display.length)) } as CSSProperties

  // 喇叭：圆形纯图标按钮，挂在单词下面；拼写卡判定前锁定不出声，原因靠 title 说明
  const speakButton = (
    <button
      type="button"
      className={'recite-card__speak' + (speaking ? ' is-playing' : '')}
      onClick={playWord}
      disabled={spellingLocked}
      aria-label={spellingLocked ? '拼完或跳过后再听发音' : '播放单词发音'}
      title={spellingLocked ? '拼完或跳过后再听' : '播放单词发音'}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M4 9.5h3.2L12 5.6v12.8L7.2 14.5H4z" />
        <path d="M15.4 8.6a4.6 4.6 0 0 1 0 6.8" />
        <path d="M17.9 6.1a8.2 8.2 0 0 1 0 11.8" />
      </svg>
    </button>
  )

  return (
    <div className="recite">
      <div className="recite__track" role="list" aria-label={'共 ' + total + ' 张卡片的学习进度'}>
        {cards.map((item, i) => {
          const position = i + 1
          // 进度轨道上只有最后一张是礼物节点，其余都是序号
          const isPrize = position === total
          const answered = Boolean(answers[item.id])
          const isCurrent = i === index
          const nodeClass = [
            'recite__node',
            isPrize ? 'recite__node--prize' : '',
            answered ? 'recite__node--done' : '',
            isCurrent ? 'recite__node--current' : '',
          ].filter(Boolean).join(' ')
          if (answered) {
            return (
              <button
                key={item.id}
                type="button"
                role="listitem"
                className={nodeClass + ' recite__node--back'}
                aria-label={'第 ' + position + ' 张' + (isPrize ? '，宝箱节点' : '') + '，已学过，点击回看'}
                title={'回看第 ' + position + ' 张'}
                onClick={() => setIndex(i)}
              >
                {isPrize ? '🎁' : position}
              </button>
            )
          }
          return (
            <span
              key={item.id}
              role="listitem"
              className={nodeClass}
              aria-label={'第 ' + position + ' 张' + (isPrize ? '，宝箱节点' : '') + '，' + (answered ? '已学过' : '未学')}
            >
              {isPrize ? '🎁' : position}
            </span>
          )
        })}
      </div>

      <main className="recite__stage">
        <section
          key={card?.id ?? 'empty'}
          className={
            'recite-card'
            + (flipped ? ' recite-card--flipped' : '')
            + (leaving ? ' recite-card--leaving' : '')
            + (isReview && !isSpelling ? ' recite-card--review' : '')
          }
          onClick={isReview && !isSpelling ? flipCard : undefined}
        >
          {isSpelling ? (
            <>
              <p className="recite-card__hint">看中文，拼出英文</p>
              <div className="recite-card__prompt recite-card__prompt--cn">{display || '暂无中文提示'}</div>
              {speakButton}
              <div className={'recite-card__input' + (input ? '' : ' recite-card__input--empty')}>
                {input || '点击下方键盘输入'}
              </div>
              {feedback === 'wrong' && (
                <div className="recite-card__feedback recite-card__feedback--wrong">还差一点，可以重新尝试或跳过</div>
              )}
              {feedback === 'correct' && <div className="recite-card__feedback">拼写正确：{answer}</div>}
              {feedback === 'skipped' && (
                <div className="recite-card__feedback recite-card__feedback--wrong">答案：{answer}</div>
              )}
            </>
          ) : (
            <div className={'recite-card__face' + (flipAnim ? ' recite-card__face--flip' : '')}>
              {flipped ? (
                <div className="recite-card__back">
                  <span className="recite-card__back-word">{card.word}</span>
                  <strong className="recite-card__back-translation">{card.translation || '暂无中文含义'}</strong>
                  {speakButton}
                </div>
              ) : (
                <>
                  <div className="recite-card__prompt" style={promptStyle}>{display}</div>
                  {speakButton}
                </>
              )}
            </div>
          )}
          {debugButton}
        </section>

        {isSpelling ? (
          <div className="recite-keyboard">
            {KEYBOARD_ROWS.map((row, rowIndex) => (
              <div
                key={row}
                className={'recite-keyboard__row ' + (rowIndex === 0 ? 'recite-keyboard__row--two' : 'recite-keyboard__row--alpha')}
              >
                {[...row].map((key, keyIndex) => {
                  // 第二行的 q、w 已经在第一行：留半透明空位，占住字母表里的位置
                  if (rowIndex > 0 && FIRST_ROW_KEYS.includes(key)) {
                    return (
                      <span
                        key={key + keyIndex}
                        className="recite-keyboard__key recite-keyboard__key--ghost"
                        aria-hidden="true"
                      />
                    )
                  }
                  return (
                    <button
                      type="button"
                      key={key}
                      className="recite-keyboard__key"
                      disabled={Boolean(feedback)}
                      onClick={() => addKey(key)}
                    >{key}</button>
                  )
                })}
                {/* 第一行只有 Q、W，空位很多：删除键放在这里，小朋友不用低头找下面的小按钮 */}
                {rowIndex === 0 && (
                  <button
                    type="button"
                    className="recite-keyboard__key recite-keyboard__key--action"
                    aria-label="删除上一个字母"
                    title="删掉最后一个字母"
                    disabled={Boolean(feedback) || !input}
                    onClick={() => setInput(value => value.slice(0, -1))}
                  >⌫</button>
                )}
              </div>
            ))}
            <div className="recite-keyboard__actions">
              <div className="recite-keyboard__group recite-keyboard__group--left">
                <button
                  type="button"
                  className="recite__kbd-ghost"
                  onClick={() => setInput('')}
                  disabled={Boolean(feedback)}
                >清空</button>
                {/* 完全不会：不用先乱拼一遍，直接记跳过并跳下一张；和普通卡的「不会」一样贴在左下角 */}
                {!feedback && (
                  <button
                    type="button"
                    className="recite__kbd-ghost recite__kbd-skip"
                    onClick={skipSpellingDirect}
                    title="完全不会就点这里，记为跳过并直接跳下一张"
                  >不会</button>
                )}
              </div>
              <div className="recite-keyboard__group recite-keyboard__group--right">
                {feedback === 'wrong' ? (
                  <>
                    <button type="button" className="recite__kbd-ghost" onClick={() => setFeedback(null)}>重新尝试</button>
                    <button type="button" className="recite__kbd-primary" onClick={skipSpelling}>跳过看答案</button>
                  </>
                ) : feedback ? (
                  <button type="button" className="recite__kbd-primary" onClick={nextCard}>
                    {lastCard ? '完成' : '下一个'}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="recite__kbd-primary"
                    onClick={submitSpelling}
                    disabled={!input}
                  >提交</button>
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className={'recite__bar' + (flipped ? ' recite__bar--single' : '')}>
            {!flipped ? (
              <>
                <button
                  type="button"
                  className="recite__mark recite__mark--no"
                  onClick={() => markMeaning('unknown')}
                >不会</button>
                <button
                  type="button"
                  className="recite__mark recite__mark--yes"
                  onClick={() => markMeaning('known')}
                >会</button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="recite__prev"
                  onClick={previousCard}
                  disabled={index === 0}
                  title="回看上一张"
                >上一个</button>
                <button type="button" className="recite__next" onClick={nextCard}>
                  {lastCard ? '完成' : '下一个'}
                </button>
              </>
            )}
          </div>
        )}
        {localError && <div className="recite__error">{localError}</div>}
        {speechError && <div className="recite__error" role="alert">{speechError}</div>}
        {recording.error && <div className="recite__error" role="alert">{recording.error}</div>}
      </main>
      {debugPanel}
    </div>
  )
}
