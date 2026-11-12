import { useEffect, useState } from 'react'
import { fetchReciteActiveSession, fetchReciteTask } from '../hooks/useRecite'
import type { ReciteCard, ReciteTaskWord } from '../hooks/useRecite'
import { stripTranslationPos } from '../utils/translations'
import type { GameWord } from './types'

/**
 * 游戏统一数据层：所有游戏的单词只从这里来。
 *
 * - 词表和背词页同源：优先取「进行中」那一次学习的卡片（孩子正背着的那批，释义实时），
 *   没有进行中的会话就退回本周任务词表，所以单词总数就是背词页这批词，两边永远一致。
 * - 一个词只出现一次（按小写去重），句子卡和没有中文释义的词不进游戏。
 * - 游戏从牌堆（WordDeck）里取词：取过的词不会再出现，牌堆空了 = 单词全部用完，这一局结束。
 */

/** 当期单词的读取状态，游戏外壳按它显示加载 / 错误 / 词太少 */
export interface GameWordsState {
  words: GameWord[]
  loading: boolean
  error: string
}

/** 一局游戏的牌堆：整份词表洗一次，每个词只会被取到一次 */
export interface WordDeck {
  /** 这份牌堆的全部单词（已去重，每个词只出现一次，顺序与 draw 无关） */
  readonly words: GameWord[]
  readonly total: number
  /** 已经取走的数量 */
  readonly taken: number
  readonly remaining: number
  /** 牌堆空了 = 这一局的单词全部用完，游戏该结束了 */
  readonly finished: boolean
  /** 取下一个词；取完返回 null */
  draw(): GameWord | null
  /** 一次最多取 count 个；牌堆不够就只给剩下的 */
  drawMany(count: number): GameWord[]
  /** 重新洗牌，把所有词放回牌堆（「再玩一次」用） */
  restart(): void
}

/** 洗牌：Fisher–Yates，返回新数组，不改入参 */
export function shuffleWords<T>(list: readonly T[]): T[] {
  const next = [...list]
  for (let i = next.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    const temp = next[i]
    next[i] = next[j]
    next[j] = temp
  }
  return next
}

/** 去重 + 清理：同一个词只留第一次出现的释义，空词 / 没释义的丢掉 */
function uniqueGameWords(words: readonly GameWord[]): GameWord[] {
  const seen = new Set<string>()
  const out: GameWord[] = []
  for (const item of words) {
    const word = item.word.trim()
    const translation = item.translation.trim()
    const key = word.toLowerCase()
    if (!word || !translation || seen.has(key)) continue
    seen.add(key)
    out.push({ word, translation })
  }
  return out
}

/**
 * 建一副牌：把词表洗一次，draw / drawMany 依次取，取过的词不会再回到牌堆。
 * 游戏只管取词，不重复和「什么时候算用完」都由牌堆负责。
 */
export function createWordDeck(words: readonly GameWord[]): WordDeck {
  const source = uniqueGameWords(words)
  let order: number[] = []
  let cursor = 0

  function restart() {
    order = shuffleWords(source.map((_, index) => index))
    cursor = 0
  }

  function draw(): GameWord | null {
    if (cursor >= order.length) return null
    const word = source[order[cursor]]
    cursor += 1
    return word
  }

  function drawMany(count: number): GameWord[] {
    const out: GameWord[] = []
    for (let i = 0; i < count; i += 1) {
      const word = draw()
      if (!word) break
      out.push(word)
    }
    return out
  }

  restart()

  return {
    words: source,
    get total() {
      return source.length
    },
    get taken() {
      return cursor
    },
    get remaining() {
      return source.length - cursor
    },
    get finished() {
      return cursor >= source.length
    },
    draw,
    drawMany,
    restart,
  }
}

/**
 * 把词表按「每关最多 perRound 对」平均分成几关：7 个词给 4 + 3，不留只有一对的尾巴。
 * 走的是 createWordDeck，一个词整局只出现一次，最后一关打完 = 全部单词用完。
 */
export function dealWordRounds(words: readonly GameWord[], perRound: number): GameWord[][] {
  const deck = createWordDeck(words)
  if (deck.finished) return []
  const roundCount = Math.max(1, Math.ceil(deck.total / perRound))
  const size = Math.ceil(deck.total / roundCount)
  const rounds: GameWord[][] = []
  while (!deck.finished) {
    const hand = deck.drawMany(size)
    if (hand.length === 0) break
    rounds.push(hand)
  }
  return rounds
}

/** 任务词表的小写索引：会话卡片不带类型，靠它判断某张卡是单词还是句子 */
function wordTypeIndexOf(words: ReciteTaskWord[]) {
  const map = new Map<string, 'word' | 'sentence'>()
  for (const item of words) map.set(item.word.trim().toLowerCase(), item.type)
  return map
}

/** 卡片里的词不在任务词表里（主动推过来的）时，按文本身份粗筛句子 */
function looksLikeSentence(text: string) {
  const value = text.trim()
  if (/[.!?。！？]$/.test(value)) return true
  return value.split(/\s+/).length > 3
}

/** 整周任务词表里取单词：只收单词卡，句子卡和没有释义的不进游戏 */
export function gameWordsFromTask(words: ReciteTaskWord[]): GameWord[] {
  const seen = new Set<string>()
  const out: GameWord[] = []
  for (const item of words) {
    if (item.type !== 'word') continue
    const word = item.word.trim()
    // 游戏里只给孩子看中文，去掉 n. / v. 这类词性前缀
    const translation = stripTranslationPos(item.translation ?? '')
    const key = word.toLowerCase()
    if (!word || !translation || seen.has(key)) continue
    seen.add(key)
    out.push({ word, translation })
  }
  return out
}

/** 进行中那一次学习的卡片里取单词：释义是实时的，孩子正背着哪批就玩哪批 */
export function gameWordsFromCards(cards: ReciteCard[], taskWords: ReciteTaskWord[]): GameWord[] {
  const types = wordTypeIndexOf(taskWords)
  const seen = new Set<string>()
  const out: GameWord[] = []
  for (const card of cards) {
    const word = card.word.trim()
    const key = word.toLowerCase()
    if (!word || seen.has(key)) continue
    const translation = stripTranslationPos(card.translation ?? '')
    if (!translation) continue
    const type = types.get(key) ?? (looksLikeSentence(word) ? 'sentence' : 'word')
    if (type === 'sentence') continue
    seen.add(key)
    out.push({ word, translation })
  }
  return out
}

/**
 * 拉一次当期单词，和背词页同一套接口、同一套筛选。
 * 卡片筛干净了（比如这一次全是句子）就退回整周词表，保底能玩。
 */
export async function loadGameWords(): Promise<GameWord[]> {
  const [task, active] = await Promise.all([fetchReciteTask(), fetchReciteActiveSession()])
  if (!task) throw new Error('本周还没有配置背词任务，先去配置一周的任务吧。')
  const fromCards = active?.cards?.length ? gameWordsFromCards(active.cards, task.words) : []
  return fromCards.length > 0 ? fromCards : gameWordsFromTask(task.words)
}

/** 游戏外壳用的取词 hook：只对外给词表，不重复与结束判定交给每个游戏的牌堆 */
export function useGameWords(enabled: boolean): GameWordsState {
  const [state, setState] = useState<GameWordsState>({ words: [], loading: enabled, error: '' })
  useEffect(() => {
    if (!enabled) return
    let alive = true
    setState({ words: [], loading: true, error: '' })
    loadGameWords()
      .then(words => {
        if (!alive) return
        setState({ words, loading: false, error: '' })
      })
      .catch(error => {
        if (!alive) return
        const message = error instanceof Error ? error.message : '单词读取失败'
        setState({ words: [], loading: false, error: message })
      })
    return () => {
      alive = false
    }
  }, [enabled])
  return state
}
