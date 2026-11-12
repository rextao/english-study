import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { dealWordRounds, shuffleWords } from '../data'
import type { GameProps, GameWord } from '../types'
import './xiaoxiaole.css'

/** 一关放几对：6 对 = 12 张牌，4 列 3 行正好铺满一屏 */
const PAIRS_PER_ROUND = 6
/** 列数：一关最多 6 对，4 列 3 行最稳，短一关也不会空出半行 */
const COLUMNS = 4

interface Tile {
  /** 同一对（英文 / 中文）的 group 相同，判定只看它 */
  group: string
  id: string
  text: string
  kind: 'word' | 'meaning'
}

interface LinkLine {
  x1: number
  y1: number
  x2: number
  y2: number
  len: number
}

/** 一关的牌：每对拆成英文牌 + 中文牌，再整体打乱 */
function buildTiles(pairs: GameWord[], round: number): Tile[] {
  const tiles: Tile[] = []
  pairs.forEach((pair, index) => {
    const group = round + ':' + index
    tiles.push({ id: group + ':word', group, text: pair.word, kind: 'word' })
    tiles.push({ id: group + ':meaning', group, text: pair.translation, kind: 'meaning' })
  })
  return shuffleWords(tiles)
}

function fmtTime(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000))
  const mm = Math.floor(total / 60)
  const ss = total % 60
  return (mm > 0 ? mm + ' 分 ' : '') + ss + ' 秒'
}

/**
 * 单词消消乐。单词统一从游戏数据层来（与背词页当期单词一致，已去重），
 * 每关从牌堆里发一批词，词用完就结束；游戏自己只管关卡、计时、连线判定，不碰任何接口。
 */
export function XiaoxiaoleGame({ words }: GameProps) {
  // 换一次 seed 就重新洗牌并回到第一关
  const [seed, setSeed] = useState(0)
  // 每一关的词都由数据层的牌堆发出：一个词整局只出现一次，最后一关打完 = 单词全部用完
  const rounds = useMemo(() => dealWordRounds(words, PAIRS_PER_ROUND), [words, seed])
  const [round, setRound] = useState(0)
  const pairs = rounds[round] ?? []
  const tiles = useMemo(() => buildTiles(pairs, round), [pairs, round])

  // 已消掉的牌：留在格子里但透明，牌桌不会因为消牌而重新排版
  const [cleared, setCleared] = useState<Set<string>>(() => new Set())
  // 当前选中的那张（等第二张来配对）
  const [selected, setSelected] = useState<string | null>(null)
  // 连错的两张（抖一下）
  const [wrong, setWrong] = useState<string[]>([])
  // 连对时先画线，260ms 后再消牌
  const [linking, setLinking] = useState<string[]>([])
  const [link, setLink] = useState<LinkLine | null>(null)
  const [mistakes, setMistakes] = useState(0)
  const [startedAt, setStartedAt] = useState(() => Date.now())
  const [elapsed, setElapsed] = useState(0)

  const boardRef = useRef<HTMLDivElement | null>(null)
  const tileRefs = useRef(new Map<string, HTMLButtonElement>())
  // 判定动画的定时器：离开页面时一起清掉
  const timers = useRef<number[]>([])

  useEffect(() => () => {
    for (const id of timers.current) window.clearTimeout(id)
    timers.current = []
  }, [])

  // 换关：这一关的选中 / 消牌 / 连线全部归零
  useEffect(() => {
    setCleared(new Set())
    setSelected(null)
    setWrong([])
    setLinking([])
    setLink(null)
  }, [tiles])

  // 看这一关每张牌是不是都消掉了：不能只比数量，换关那一帧旧数量还在，会闪一下过关面板
  const roundDone = tiles.length > 0 && tiles.every(tile => cleared.has(tile.id))
  const finished = roundDone && round >= rounds.length - 1

  // 计时：全部消完就停
  useEffect(() => {
    if (finished) return
    const id = window.setInterval(() => setElapsed(Date.now() - startedAt), 500)
    return () => window.clearInterval(id)
  }, [finished, startedAt])

  function later(fn: () => void, ms: number) {
    const id = window.setTimeout(fn, ms)
    timers.current.push(id)
  }

  /** 点一张牌：没选中就当第一张，选中了就判定这一对连不连得上 */
  function pick(tile: Tile) {
    if (cleared.has(tile.id) || linking.length > 0) return
    if (!selected) {
      setSelected(tile.id)
      return
    }
    if (selected === tile.id) {
      setSelected(null)
      return
    }
    const first = tiles.find(item => item.id === selected)
    if (!first) {
      setSelected(tile.id)
      return
    }

    if (first.group !== tile.group) {
      // 连错：两张一起抖，记一次失误，不消牌
      setWrong([first.id, tile.id])
      setSelected(null)
      setMistakes(count => count + 1)
      later(() => setWrong([]), 420)
      return
    }

    // 连对：先按两张牌的中心画一条线，线画完再把牌消掉
    const board = boardRef.current
    const from = tileRefs.current.get(first.id)
    const to = tileRefs.current.get(tile.id)
    if (board && from && to) {
      const boardBox = board.getBoundingClientRect()
      const fromBox = from.getBoundingClientRect()
      const toBox = to.getBoundingClientRect()
      const x1 = fromBox.left - boardBox.left + fromBox.width / 2
      const y1 = fromBox.top - boardBox.top + fromBox.height / 2
      const x2 = toBox.left - boardBox.left + toBox.width / 2
      const y2 = toBox.top - boardBox.top + toBox.height / 2
      setLink({ x1, y1, x2, y2, len: Math.hypot(x2 - x1, y2 - y1) })
    }
    setSelected(null)
    setLinking([first.id, tile.id])
    later(() => {
      setCleared(prev => {
        const next = new Set(prev)
        next.add(first.id)
        next.add(tile.id)
        return next
      })
      setLinking([])
      setLink(null)
    }, 260)
  }

  function restart() {
    setSeed(value => value + 1)
    setRound(0)
    setMistakes(0)
    setStartedAt(Date.now())
    setElapsed(0)
  }

  const boardStyle = { '--cols': String(COLUMNS) } as CSSProperties

  return (
    <div className="xxl">
      <div className="xxl__stats">
        <span className="xxl__chip">第 {round + 1} / {rounds.length} 关</span>
        <span className="xxl__chip">⏱ {fmtTime(elapsed)}</span>
        <span className="xxl__chip">失误 {mistakes}</span>
      </div>
      <p className="xxl__hint">点一张英文，再点它的中文；连对了就一起消掉</p>

      <div className="xxl__board" ref={boardRef} style={boardStyle}>
        {tiles.map(tile => {
          const className = [
            'xxl__tile',
            'xxl__tile--' + tile.kind,
            selected === tile.id ? 'is-selected' : '',
            linking.includes(tile.id) ? 'is-linking' : '',
            wrong.includes(tile.id) ? 'is-wrong' : '',
            cleared.has(tile.id) ? 'is-cleared' : '',
          ].filter(Boolean).join(' ')
          return (
            <button
              key={tile.id}
              type="button"
              className={className}
              ref={element => {
                if (element) tileRefs.current.set(tile.id, element)
                else tileRefs.current.delete(tile.id)
              }}
              onClick={() => pick(tile)}
              disabled={cleared.has(tile.id)}
            >
              {tile.text}
            </button>
          )
        })}
        {link && (
          <svg className="xxl__link" aria-hidden="true">
            <line
              x1={link.x1}
              y1={link.y1}
              x2={link.x2}
              y2={link.y2}
              style={{ '--len': link.len + 'px' } as CSSProperties}
            />
          </svg>
        )}
      </div>

      {roundDone && !finished && (
        <div className="xxl__panel">
          <div className="xxl__panel-card">
            <p className="xxl__panel-title">第 {round + 1} 关通过！</p>
            <p className="xxl__panel-sub">已消掉 {pairs.length} 对</p>
            <button type="button" className="xxl__btn" onClick={() => setRound(value => value + 1)}>
              下一关
            </button>
          </div>
        </div>
      )}

      {finished && (
        <div className="xxl__panel">
          <div className="xxl__panel-card">
            <p className="xxl__panel-title">全部消完啦 🎉</p>
            <p className="xxl__panel-sub">用时 {fmtTime(elapsed)} · 失误 {mistakes} 次</p>
            <button type="button" className="xxl__btn" onClick={restart}>
              再玩一次
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
