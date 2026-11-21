import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { saveReciteDraft } from '../hooks/useRecite'
import { readRecordPref, useReciteRecording, writeRecordPref } from '../hooks/useReciteRecording'
import { useRecitePreload } from '../hooks/useRecitePreload'
import type { ReciteCard, ReciteSessionPayload, ReciteTask } from '../hooks/useRecite'
import { ReciteDebugPanel } from '../components/ReciteDebugPanel'
import { SENTENCE_SPEAKING_RATE, speak, speechErrorMessage, stopSpeech } from '../utils/speech'
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
  /** 完成页「继续学习」：直接开本周的下一次任务 */
  onContinue: () => void
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

/**
 * 发音语速档位：rate = 相对正常速的倍数（Worker 乘上 0.9，交 Google 原生念慢，音色不变）；
 * speakingRate = 直接指定 Google 的语速（句子整句用 0.7，比 0.5 倍速快一点、长句又听得清）。
 * 卡片右上角的按钮点一下换一档；卡片上手动切过就按切的那档，换卡时按卡片类型重置。
 */
interface SpeedPreset {
  label: string
  rate?: number
  speakingRate?: number
}
const NORMAL_SPEED: SpeedPreset = { label: '正常速', rate: 1 }
/** 单词卡：正常速 / 0.5 倍速（走相对倍速；正常速与背词首页预取的音频共用缓存） */
const WORD_SPEED_PRESETS: SpeedPreset[] = [NORMAL_SPEED, { label: '0.5 倍速', rate: 0.5 }]
/** 句子卡：整句默认让 Google 用 speakingRate 0.7 念（正常速对小朋友太快） */
const SENTENCE_SPEED_PRESETS: SpeedPreset[] = [NORMAL_SPEED, { label: '0.7 倍速', speakingRate: SENTENCE_SPEAKING_RATE }]
/** 句子默认第二档（0.7 倍速），单词默认正常速 */
const SENTENCE_SPEED_INDEX = 1

/**
 * 句子卡：以服务端给的词条类型（type）为准——单词卡的 displayText 也是单词本身，不能拿它猜。
 * 老接口没有 type 时退回比对 displayText 与 word：句子卡是首字母大写过的原句，两者不同。
 */
function isSentenceCard(card: ReciteCard | null) {
  if (!card) return false
  if (card.type) return card.type === 'sentence'
  return Boolean(card.displayText && card.displayText.trim() !== card.word.trim())
}

/**
 * 句子拆成一个个可点的单词：点哪个只读哪个（固定正常速，不受句子卡 0.5 倍速影响），
 * 标点和空格原样留在按钮外面。独立单词卡不走这里，它们只靠下面的喇叭按钮整词播放。
 */
function SentenceWords({ text, onSpeak }: { text: string; onSpeak: (word: string) => void }) {
  return (
    <>
      {text.split(/(\s+)/).map((part, i) => {
        const match = /^([^A-Za-z']*)([A-Za-z][A-Za-z'’-]*)(.*)$/.exec(part)
        if (!match) return <span key={i}>{part}</span>
        const [, leading, word, trailing] = match
        return (
          <span key={i}>
            {leading}
            <button
              type="button"
              className="recite-card__word-btn"
              onClick={event => {
                // 回看时点卡片会翻面，点单词只播放发音
                event.stopPropagation()
                onSpeak(word)
              }}
              aria-label={'朗读单词 ' + word}
              title={'朗读「' + word + '」'}
            >{word}</button>
            {trailing}
          </span>
        )
      })}
    </>
  )
}

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

/** 本周下一条还没建过会话的次数（1-based）；每一次都建过会话时返回 null */
function nextSessionIndex(task: ReciteTask | null): number | null {
  if (!task) return null
  const used = new Set((task.sessions ?? []).map(item => item.index))
  for (let index = 1; index <= task.sessionCount; index += 1) {
    if (!used.has(index)) return index
  }
  return null
}

/**
 * 这一次有没有选好单词：任务词表按每次单词数切开，这一格是空的就说明还没配。
 * 后面的次数共用同一份词表、按顺序切分，所以最后一格没词时再往后也不会有。
 */
function sessionHasWords(task: ReciteTask | null, index: number | null): boolean {
  if (!task || index == null) return false
  const order = task.wordOrder
  if (order && order.length > 0) return (order[index - 1]?.length ?? 0) > 0
  return task.words.length > (index - 1) * Math.max(1, task.perSessionCount)
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
  onContinue,
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
  // 发音倍速（卡片右上角）：0 = 正常速，1 = 0.5 倍速；默认值按卡的类型给
  const [speedIndex, setSpeedIndex] = useState(0)
  // 点「会」之后的确认：先说中文（ask）→ 不管会 / 不会都亮出中文（reveal），再决定下一张
  const [askStep, setAskStep] = useState<'ask' | 'reveal' | null>(null)
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
  // 完成页「继续学习」：本周计划里还有没建过会话、并且已经选好单词的次数才能接着学；
  // 学完但家长还没保存的那一次已经有会话了，不占「还能学」的名额
  const taskInfo = payload?.task ?? null
  const nextLearnable = nextSessionIndex(taskInfo)
  const remainingSessions = taskInfo && sessionHasWords(taskInfo, nextLearnable)
    ? Math.max(0, taskInfo.sessionCount - (taskInfo.sessions?.length ?? 0))
    : 0
  // 后面的次数还没选词时不给「继续学习」：点进去只会是空的一场，直接停在最后一页
  const hasNextSession = remainingSessions > 0 && !payload?.complete && !payload?.empty

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
   * 点「继续学习」直接开本周的下一次：服务端会跳过「学完待保存」的那一次（判定留在草稿里，
   * 等家长保存），再建下一次的会话。不点这个按钮就仍然停在完成页，只放庆祝特效。
   */
  function handleContinueLesson() {
    if (!hasNextSession) return
    // 先回到卡片态：新会话回来时不会在完成页闪一下；点按钮本身是手势，正好用来要麦克风
    setStage('cards')
    recording.prime()
    onContinue()
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
    setAskStep(null)
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
    setAskStep(null)
    stopSpeech()
  }, [index])

  // 每张卡进来先给它默认语速：句子 0.7 倍速、单词正常速；这张卡上手动切过的档位换卡前保留
  const cardId = cards[index]?.id ?? ''
  useEffect(() => {
    setSpeedIndex(isSentenceCard(cards[index] ?? null) ? SENTENCE_SPEED_INDEX : 0)
  }, [cardId]) // eslint-disable-line react-hooks/exhaustive-deps

  const card = cards[index] ?? null
  const isSpelling = card?.cardType === 'spelling'
  /** 句子卡：卡上的每个单词可以单独点来听，单词卡没有这个功能（只用喇叭听整词） */
  const isSentence = isSentenceCard(card)
  /** 当前这张卡可用的语速档位（句子 / 单词两套）与当前档位 */
  const speedPresets = isSentence ? SENTENCE_SPEED_PRESETS : WORD_SPEED_PRESETS
  const speed = speedPresets[speedIndex] ?? NORMAL_SPEED
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
    // 点「会 / 不会」先把这张卡念一遍：先出声音，再判定 / 翻面（手势里调用，Safari 才给播）
    playWord()
    if (result === 'known') {
      // 说得出中文才算真会：先让小朋友说，卡片上确认了再判会 / 不会
      setAskStep('ask')
      return
    }
    persistDraft({ cardId: card.id, result, attempts: 0 })
    setFlipped(true)
  }

  /** 确认卡片上点「会 / 不会」：先落草稿，再统一亮出中文（不会也照样看答案） */
  function judgeMeaning(correct: boolean) {
    if (!card || card.cardType !== 'meaning') return
    persistDraft({ cardId: card.id, result: correct ? 'known' : 'unknown', attempts: 0 })
    setAskStep('reveal')
  }

  /** 亮出中文后点「下一个」：关掉确认卡片，照常播离场动画进下一张 */
  function nextFromAsk() {
    setAskStep(null)
    leaveToNext()
  }

  /** 亮出中文后点「上一个」：退回上一张 */
  function previousFromAsk() {
    setAskStep(null)
    previousCard()
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

  /**
   * 播一段文本（整句 / 句子里的某个单词）：连点只认最后一次，失败原因写在页面上。
   * 不传 speed 就用卡片右上角选中的档位；点句子里单个单词时固定正常速。
   */
  function playText(text: string, preset?: SpeedPreset) {
    const value = text.trim()
    if (!value) return
    const token = playToken.current + 1
    playToken.current = token
    setSpeechError('')
    setSpeaking(true)
    void speak(value, preset ?? speed)
      .catch(error => {
        if (playToken.current === token) setSpeechError(speechErrorMessage(error))
      })
      .finally(() => {
        if (playToken.current === token) setSpeaking(false)
      })
  }

  /** 喇叭按钮：句子卡读整句、单词卡读整个单词 */
  function playWord() {
    if (!card || spellingLocked) return
    playText(answer)
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
    // 下一条次数还没选单词：点了也只会空转（进来没有卡片），直接在首页说明情况
    const nextUnstarted = nextSessionIndex(homeTask)
    const missingWords = homeTask.activeSessionIndex == null
      && nextUnstarted != null
      && !sessionHasWords(homeTask, nextUnstarted)
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
          {!finished && (missingWords ? (
            <p className="recite__state-sub">这一次还没选单词，请家长在背词任务页补上。</p>
          ) : (
            <button
              type="button"
              className="recite__state-btn"
              // 先在手势里要麦克风再开会话：等会话回来再要，Safari 常常不给
              onClick={() => { recording.prime(); onStart() }}
            >
              {homeTask.activeSessionIndex == null ? '开始学习' : '继续学习'}
            </button>
          ))}
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

  // 下一次没有单词（没选词 / 单词已经不在学习列表里）：停在最后一页，不再单独给一个回不去的空页面
  if (payload.empty || payload.complete || stage === 'celebrate') {
    return (
      <div className="recite recite--celebrate">
        <div className="recite__celebrate-card">
          <div className="recite__trophy" aria-hidden="true">🏆</div>
          <h1 className="recite__celebrate-title">太棒啦，全部完成！</h1>
          {localError && <p className="recite__error">{localError}</p>}
          {/* 本周还有没学过的次数：可以接着学下一次；不点就停在完成页，和以前一样 */}
          {hasNextSession && (
            <>
              <p className="recite__celebrate-sub">本周还有 {remainingSessions} 次学习</p>
              <button type="button" className="recite__confirm" onClick={handleContinueLesson}>继续学习</button>
            </>
          )}
          <button
            type="button"
            className={'recite__confirm' + (hasNextSession ? ' recite__confirm--ghost' : '')}
            onClick={handleFinish}
          >完成</button>
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

  // 喇叭：圆形纯图标按钮，挂在单词 / 句子下面，整词或整句播放；拼写卡判定前锁定不出声，原因靠 title 说明
  const speakButton = (
    <button
      type="button"
      className={'recite-card__speak' + (speaking ? ' is-playing' : '')}
      onClick={event => {
        // 回看已学过的卡片时点卡片会翻面，点喇叭只播放发音，别把卡片翻过去
        event.stopPropagation()
        playWord()
      }}
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
          {/* 右上角语速：点一下在「正常速 / 0.5 倍速」（句子卡是 0.7 倍速）之间循环 */}
          <button
            type="button"
            className="recite-card__speed"
            onClick={event => {
              // 回看时点卡片会翻面，别让倍速按钮把卡片翻过去
              event.stopPropagation()
              setSpeedIndex(value => (value + 1) % speedPresets.length)
            }}
            aria-label={'发音速度：' + speed.label + '，点击切换'}
            title={'发音速度：' + speed.label + '，点一下切换'}
          >{speed.label}</button>
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
                  {/* 翻面后：句子卡每个单词仍可单独点，单词卡就是整词文本 */}
                  <span className="recite-card__back-word">
                    {isSentence
                      ? <SentenceWords text={card.displayText || card.word} onSpeak={word => playText(word, NORMAL_SPEED)} />
                      : card.word}
                  </span>
                  <strong className="recite-card__back-translation">{card.translation || '暂无中文含义'}</strong>
                  {speakButton}
                </div>
              ) : (
                <>
                  {/* 句子卡：每个单词单独可点；单词卡只是文本，靠下面的喇叭听整词 */}
                  <div className="recite-card__prompt" style={promptStyle}>
                    {isSentence ? <SentenceWords text={display} onSpeak={word => playText(word, NORMAL_SPEED)} /> : display}
                  </div>
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
      {/* 点「会」之后的确认：先说中文 → 不论会 / 不会都亮出中文 → 上一个 / 下一个 */}
      {askStep && card && card.cardType === 'meaning' && (
        <div className="recite-ask" role="dialog" aria-modal="true" aria-labelledby="recite-ask-title">
          <div className="recite-ask__card">
            <p className="recite-ask__word">{card.word}</p>
            {askStep === 'ask' ? (
              <>
                <h2 className="recite-ask__title" id="recite-ask-title">说一说中文</h2>
                <div className="recite-ask__actions recite-ask__actions--judge">
                  <button
                    type="button"
                    className="recite-ask__judge recite-ask__judge--no"
                    aria-label="不会，看答案"
                    title="不会（看答案）"
                    onClick={() => judgeMeaning(false)}
                  >不会</button>
                  <button
                    type="button"
                    className="recite-ask__judge recite-ask__judge--yes"
                    aria-label="会，看答案"
                    title="会（看答案）"
                    onClick={() => judgeMeaning(true)}
                  >会</button>
                </div>
              </>
            ) : (
              <>
                <p className="recite-ask__translation" id="recite-ask-title">{card.translation || '暂无中文含义'}</p>
                <div className="recite-ask__actions">
                  <button
                    type="button"
                    className="recite-ask__cancel"
                    disabled={index === 0}
                    onClick={previousFromAsk}
                  >上一个</button>
                  <button type="button" className="recite-ask__confirm" onClick={nextFromAsk}>下一个</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
      {debugPanel}
    </div>
  )
}
