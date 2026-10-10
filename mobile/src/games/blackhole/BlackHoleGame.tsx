/**
 * BlackHoleGame.tsx — 「黑洞吞噬」的全屏表现层
 *
 * 负责三件事：驱动 requestAnimationFrame 主循环（更新 + 渲染引擎）、把触摸手势翻译成
 * 浮动摇杆方向喂给引擎、用 React 画 HUD（得分 / 剩余时间 / 体型 / 排名）与结算面板。
 * 游戏逻辑全在 engine.ts，这里不含任何玩法规则。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { BlackHoleEngine, emptyStatus, type GameStatus, type LeaderRow } from './engine'
import type { GameProps } from '../types'
import './blackhole.css'

const JOY_MAX = 70

/** 秒数格式化成 M:SS，HUD 顶部倒计时用 */
function formatTime(sec: number): string {
  const total = Math.max(0, Math.ceil(sec))
  const m = Math.floor(total / 60)
  const s = total % 60
  return m + ':' + String(s).padStart(2, '0')
}

interface Joy {
  baseX: number
  baseY: number
  knobX: number
  knobY: number
}

/** 排行榜逐行比较：名次 / 人名 / 分数 / 是否玩家都相同才算没变 */
function sameBoard(a: LeaderRow[], b: LeaderRow[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i].name !== b[i].name || a[i].score !== b[i].score || a[i].isPlayer !== b[i].isPlayer) return false
  }
  return true
}

/** 两个状态在 HUD 上长得一样就不触发重渲染，省得每帧 setState */
function sameDisplay(a: GameStatus, b: GameStatus): boolean {
  return (
    a.score === b.score &&
    Math.ceil(a.timeLeft) === Math.ceil(b.timeLeft) &&
    Math.round(a.radius) === Math.round(b.radius) &&
    a.rank === b.rank &&
    a.drains === b.drains &&
    a.over === b.over &&
    sameBoard(a.leaderboard, b.leaderboard)
  )
}

export default function BlackHoleGame({ onExit }: GameProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const engineRef = useRef<BlackHoleEngine | null>(null)
  const pointerRef = useRef<number | null>(null)
  // 摇杆基点（按下处坐标）单独存 ref：pointermove 必须同步读坐标，
  // 不能把 e.currentTarget 放进 setState 更新函数里异步读（那时 React 已把它置空）
  const joyBaseRef = useRef<{ x: number; y: number } | null>(null)
  const [status, setStatus] = useState<GameStatus>(emptyStatus)
  const [joy, setJoy] = useState<Joy | null>(null)
  // 加一就重开：effect 以它为依赖，会丢掉旧引擎、建一个新的
  const [round, setRound] = useState(0)
  // 被咬反馈：记住上一帧 drains，变大就闪一下红色提示
  const prevDrainsRef = useRef(0)
  const biteTimerRef = useRef<number | null>(null)
  const [biteFlash, setBiteFlash] = useState(false)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const engine = new BlackHoleEngine()
    engineRef.current = engine
    setStatus(engine.status())

    let raf = 0
    let last = performance.now()
    let viewW = 0
    let viewH = 0

    const loop = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now

      const cssW = canvas.clientWidth
      const cssH = canvas.clientHeight
      const dpr = window.devicePixelRatio || 1
      if (cssW !== viewW || cssH !== viewH) {
        viewW = cssW
        viewH = cssH
        canvas.width = Math.round(cssW * dpr)
        canvas.height = Math.round(cssH * dpr)
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

      engine.update(dt)
      engine.render(ctx, cssW, cssH)

      const next = engine.status()
      setStatus(prev => (sameDisplay(prev, next) ? prev : next))

      if (next.over) {
        setStatus(next)
        return
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)

    return () => cancelAnimationFrame(raf)
  }, [round])

  // 被咬闪动：drains 比上一帧大就触发约 0.9s 红色提示；变小说明重开，顺手清掉残留
  useEffect(() => {
    if (status.drains > prevDrainsRef.current) {
      setBiteFlash(true)
      if (biteTimerRef.current !== null) clearTimeout(biteTimerRef.current)
      biteTimerRef.current = window.setTimeout(() => {
        setBiteFlash(false)
        biteTimerRef.current = null
      }, 900)
    } else if (status.drains < prevDrainsRef.current) {
      if (biteTimerRef.current !== null) {
        clearTimeout(biteTimerRef.current)
        biteTimerRef.current = null
      }
      setBiteFlash(false)
    }
    prevDrainsRef.current = status.drains
  }, [status.drains])

  // 卸载时清掉被咬反馈定时器
  useEffect(() => () => {
    if (biteTimerRef.current !== null) clearTimeout(biteTimerRef.current)
  }, [])

  const handleDown = useCallback((e: React.PointerEvent) => {
    if (pointerRef.current !== null) return
    pointerRef.current = e.pointerId
    e.currentTarget.setPointerCapture(e.pointerId)
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    joyBaseRef.current = { x, y }
    setJoy({ baseX: x, baseY: y, knobX: x, knobY: y })
  }, [])

  const handleMove = useCallback((e: React.PointerEvent) => {
    if (pointerRef.current !== e.pointerId) return
    // 关键修复：在事件回调里同步读取 currentTarget / 坐标。React 会在回调返回后把
    // e.currentTarget 置为 null，之前把它放进 setState 更新函数（异步执行）里读，会读到
    // null 再 .getBoundingClientRect() 直接抛错 → 整个组件渲染崩溃，表现为「一碰屏幕就全没了」。
    const base = joyBaseRef.current
    if (!base) return
    const rect = e.currentTarget.getBoundingClientRect()
    const dx = e.clientX - rect.left - base.x
    const dy = e.clientY - rect.top - base.y
    const len = Math.hypot(dx, dy)
    const clamped = Math.min(len, JOY_MAX)
    const nx = len > 0 ? dx / len : 0
    const ny = len > 0 ? dy / len : 0
    engineRef.current?.setInput((nx * clamped) / JOY_MAX, (ny * clamped) / JOY_MAX)
    setJoy(prev => (prev ? { ...prev, knobX: base.x + nx * clamped, knobY: base.y + ny * clamped } : prev))
  }, [])

  const handleUp = useCallback((e: React.PointerEvent) => {
    if (pointerRef.current !== e.pointerId) return
    pointerRef.current = null
    joyBaseRef.current = null
    engineRef.current?.setInput(0, 0)
    setJoy(null)
  }, [])

  const timeLeft = Math.ceil(status.timeLeft)
  const sizeX = (status.radius / 26).toFixed(1)

  return (
    <div className="bh">
      <canvas
        ref={canvasRef}
        className="bh__canvas"
        onPointerDown={handleDown}
        onPointerMove={handleMove}
        onPointerUp={handleUp}
        onPointerCancel={handleUp}
      />

      <div className="bh__hud">
        <button className="bh__back" type="button" onClick={onExit}>‹ 退出</button>

        {/* 顶部居中：倒计时，最后 15 秒变红 */}
        <div className={'bh__timer' + (timeLeft <= 15 ? ' bh__timer--warn' : '')}>
          {formatTime(status.timeLeft)}
        </div>

        {/* 右侧：实时排行榜前 5（人名 + 分数），玩家所在行高亮 */}
        <div className="bh__board">
          {status.leaderboard.map((row, i) => (
            <div
              key={row.name + i}
              className={'bh__board-row' + (row.isPlayer ? ' bh__board-row--me' : '')}
            >
              <span className="bh__board-rank">{i + 1}</span>
              <span className="bh__board-name">{row.name}</span>
              <span className="bh__board-score">{row.score}</span>
            </div>
          ))}
        </div>
      </div>

      {biteFlash ? <div className="bh__bite">被吞了一口！</div> : null}

      {joy ? (
        <div className="bh__joy" style={{ left: joy.baseX, top: joy.baseY }}>
          <span className="bh__joy-knob" style={{ left: joy.knobX - joy.baseX, top: joy.knobY - joy.baseY }} />
        </div>
      ) : null}

      {status.over ? (
        <div className="bh__over">
          <div className="bh__over-card">
            <div className="bh__over-title">时间到！</div>
            <div className="bh__over-score">{status.score}</div>
            <div className="bh__over-sub">
              吞噬 {status.eaten} 个目标 · 体型 {sizeX}× · 超过 {status.rank}/{status.rivals} 个黑洞 · 被吞 {status.drains} 次
            </div>
            <div className="bh__over-actions">
              <button className="bh__btn bh__btn--primary" type="button" onClick={() => { setStatus(emptyStatus()); setRound(r => r + 1) }}>
                再来一局
              </button>
              <button className="bh__btn" type="button" onClick={onExit}>返回列表</button>
            </div>
          </div>
        </div>
      ) : null}

      {!joy && !status.over ? <div className="bh__tip">按住屏幕任意位置拖动，操控黑洞移动</div> : null}
    </div>
  )
}
