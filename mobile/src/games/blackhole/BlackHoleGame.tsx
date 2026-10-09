/**
 * BlackHoleGame.tsx — 「黑洞吞噬」的全屏表现层
 *
 * 负责三件事：驱动 requestAnimationFrame 主循环（更新 + 渲染引擎）、把触摸手势翻译成
 * 浮动摇杆方向喂给引擎、用 React 画 HUD（得分 / 剩余时间 / 体型 / 排名）与结算面板。
 * 游戏逻辑全在 engine.ts，这里不含任何玩法规则。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { BlackHoleEngine, emptyStatus, type GameStatus } from './engine'
import type { GameProps } from '../types'
import './blackhole.css'

const JOY_MAX = 70

interface Joy {
  baseX: number
  baseY: number
  knobX: number
  knobY: number
}

/** 两个状态在 HUD 上长得一样就不触发重渲染，省得每帧 setState */
function sameDisplay(a: GameStatus, b: GameStatus): boolean {
  return (
    a.score === b.score &&
    Math.ceil(a.timeLeft) === Math.ceil(b.timeLeft) &&
    Math.round(a.radius) === Math.round(b.radius) &&
    a.rank === b.rank &&
    a.over === b.over
  )
}

export default function BlackHoleGame({ onExit }: GameProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const engineRef = useRef<BlackHoleEngine | null>(null)
  const pointerRef = useRef<number | null>(null)
  const [status, setStatus] = useState<GameStatus>(emptyStatus)
  const [joy, setJoy] = useState<Joy | null>(null)
  // 加一就重开：effect 以它为依赖，会丢掉旧引擎、建一个新的
  const [round, setRound] = useState(0)

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

  const handleDown = useCallback((e: React.PointerEvent) => {
    if (pointerRef.current !== null) return
    pointerRef.current = e.pointerId
    e.currentTarget.setPointerCapture(e.pointerId)
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    setJoy({ baseX: x, baseY: y, knobX: x, knobY: y })
  }, [])

  const handleMove = useCallback((e: React.PointerEvent) => {
    if (pointerRef.current !== e.pointerId) return
    setJoy(prev => {
      if (!prev) return prev
      const rect = e.currentTarget.getBoundingClientRect()
      const dx = e.clientX - rect.left - prev.baseX
      const dy = e.clientY - rect.top - prev.baseY
      const len = Math.hypot(dx, dy)
      const clamped = Math.min(len, JOY_MAX)
      const nx = len > 0 ? dx / len : 0
      const ny = len > 0 ? dy / len : 0
      engineRef.current?.setInput((nx * clamped) / JOY_MAX, (ny * clamped) / JOY_MAX)
      return { ...prev, knobX: prev.baseX + nx * clamped, knobY: prev.baseY + ny * clamped }
    })
  }, [])

  const handleUp = useCallback((e: React.PointerEvent) => {
    if (pointerRef.current !== e.pointerId) return
    pointerRef.current = null
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
        <div className="bh__stats">
          <div className="bh__stat">
            <span className="bh__stat-val">{status.score}</span>
            <span className="bh__stat-key">得分</span>
          </div>
          <div className="bh__stat">
            <span className="bh__stat-val">{sizeX}×</span>
            <span className="bh__stat-key">体型</span>
          </div>
          <div className={'bh__stat' + (timeLeft <= 15 ? ' bh__stat--warn' : '')}>
            <span className="bh__stat-val">{timeLeft}</span>
            <span className="bh__stat-key">秒</span>
          </div>
        </div>
      </div>

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
              吞噬 {status.eaten} 个目标 · 体型 {sizeX}× · 超过 {status.rank}/{status.rivals} 个黑洞
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
