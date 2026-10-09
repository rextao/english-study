/**
 * engine.ts — 「黑洞吞噬」小游戏的纯逻辑引擎（不碰 React / DOM）
 *
 * 世界是一块方形场景，上面散落着行人、树、汽车、房屋等道具。玩家操纵一个黑洞，
 * 用手势给出移动方向；碰到比自己小的道具就把它吸进来，体型随吃的东西越变越大。
 * 场景里还有若干「别的用户」黑洞：它们不会吃掉玩家，体型会随机维持在玩家附近；
 * 一旦某个黑洞比玩家大并撞上，就把玩家弹开。
 *
 * 对外只暴露 setInput / update / render / status / restart：渲染直接画在传入的 2D
 * context 上（以 CSS 像素为单位，缩放交给调用方的 transform），这样 React 组件只管
 * 生命周期、手势和 HUD，核心玩法全在这一份文件里，方便单独调试或替换表现层。
 */

/** 对外暴露给 HUD 的只读状态 */
export interface GameStatus {
  /** 累计吞噬得分 */
  score: number
  /** 玩家黑洞当前半径（世界像素） */
  radius: number
  /** 剩余秒数 */
  timeLeft: number
  /** 本局是否结束 */
  over: boolean
  /** 已吞噬道具数 */
  eaten: number
  /** 比玩家小的对手黑洞数量 */
  rank: number
  /** 对手黑洞总数 */
  rivals: number
}

interface PropKindDef {
  emoji: string
  radius: number
  value: number
  weight: number
}

interface Thing {
  id: number
  emoji: string
  x: number
  y: number
  radius: number
  value: number
  /** 已被吸入、正在播放吞噬动画 */
  eaten: boolean
  /** 吞噬动画进度 0..1 */
  suck: number
}

interface Hole {
  isPlayer: boolean
  name: string
  hue: number
  x: number
  y: number
  radius: number
  /** 面积（吞噬按面积累加，再反算半径，长大更自然） */
  area: number
  /** 漩涡自转相位 */
  spin: number
  /** 被弹开后的速度（会衰减） */
  bvx: number
  bvy: number
  // 以下仅对手黑洞使用
  wander: number
  targetRadius: number
  retarget: number
}

const WORLD = 2600
const MARGIN = 60
const BASE_RADIUS = 26
const PLAYER_SPEED = 250
const AI_SPEED = 150
const MASS_PER_VALUE = 70
const SUCK_TIME = 0.26
const DURATION = 150
const PROP_TARGET = 440
const AI_COUNT = 10
const SWALLOW_RATIO = 0.9
const BOUNCE_IMPULSE = 320
const PLAYER_ACCENT = '#38bdf8'

const PROP_KINDS: PropKindDef[] = [
  { emoji: '🌿', radius: 11, value: 1, weight: 26 },
  { emoji: '🧍', radius: 15, value: 2, weight: 30 },
  { emoji: '🌳', radius: 22, value: 4, weight: 18 },
  { emoji: '🚗', radius: 28, value: 9, weight: 14 },
  { emoji: '🏠', radius: 44, value: 22, weight: 8 },
  { emoji: '🏢', radius: 64, value: 52, weight: 4 },
]

const TOTAL_WEIGHT = PROP_KINDS.reduce((sum, k) => sum + k.weight, 0)

const AI_NAMES = [
  '小宇', 'Luna', '阿强', 'Momo', 'Neo', '团子', 'Zoe', '大黑',
  'Rin', '波波', 'Kai', '西瓜', 'Yuki', '阿飞', '九九', 'Toby',
]

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

function rand(lo: number, hi: number): number {
  return lo + Math.random() * (hi - lo)
}

function pickKind(): PropKindDef {
  let r = Math.random() * TOTAL_WEIGHT
  for (const k of PROP_KINDS) {
    r -= k.weight
    if (r <= 0) return k
  }
  return PROP_KINDS[0]
}

/** 面积换半径 */
function radiusOf(area: number): number {
  return Math.sqrt(area / Math.PI)
}

/** 体型越大移动越慢，但有下限，别慢到不能玩 */
function speedFactor(radius: number): number {
  return clamp(Math.pow(BASE_RADIUS / radius, 0.4), 0.45, 1)
}

export function emptyStatus(): GameStatus {
  return { score: 0, radius: BASE_RADIUS, timeLeft: DURATION, over: false, eaten: 0, rank: 0, rivals: AI_COUNT }
}

export class BlackHoleEngine {
  private things: Thing[] = []
  private holes: Hole[] = []
  private player!: Hole
  private inputX = 0
  private inputY = 0
  private elapsed = 0
  private over = false
  private score = 0
  private eaten = 0
  private nextId = 1
  private viewScale = 1

  constructor() {
    this.reset()
  }

  /** 重开一局：清空世界、重新铺道具和对手 */
  reset(): void {
    this.things = []
    this.holes = []
    this.inputX = 0
    this.inputY = 0
    this.elapsed = 0
    this.over = false
    this.score = 0
    this.eaten = 0
    this.nextId = 1
    this.viewScale = 1

    const area = Math.PI * BASE_RADIUS * BASE_RADIUS
    this.player = {
      isPlayer: true,
      name: '你',
      hue: 199,
      x: WORLD / 2,
      y: WORLD / 2,
      radius: BASE_RADIUS,
      area,
      spin: 0,
      bvx: 0,
      bvy: 0,
      wander: 0,
      targetRadius: BASE_RADIUS,
      retarget: 0,
    }
    this.holes.push(this.player)

    for (let i = 0; i < AI_COUNT; i++) {
      const radius = BASE_RADIUS * rand(0.6, 1.3)
      this.holes.push({
        isPlayer: false,
        name: AI_NAMES[i % AI_NAMES.length],
        hue: Math.floor(rand(0, 360)),
        x: rand(MARGIN, WORLD - MARGIN),
        y: rand(MARGIN, WORLD - MARGIN),
        radius,
        area: Math.PI * radius * radius,
        spin: rand(0, Math.PI * 2),
        bvx: 0,
        bvy: 0,
        wander: rand(0, Math.PI * 2),
        targetRadius: radius,
        retarget: rand(0, 3),
      })
    }

    for (let i = 0; i < PROP_TARGET; i++) this.things.push(this.spawnThing(true))
  }

  /** 设置移动方向，分量范围约 -1..1（手势摇杆归一化后传进来） */
  setInput(x: number, y: number): void {
    this.inputX = clamp(x, -1, 1)
    this.inputY = clamp(y, -1, 1)
  }

  status(): GameStatus {
    let rank = 0
    for (let i = 1; i < this.holes.length; i++) {
      if (this.holes[i].radius < this.player.radius) rank++
    }
    return {
      score: this.score,
      radius: this.player.radius,
      timeLeft: Math.max(0, DURATION - this.elapsed),
      over: this.over,
      eaten: this.eaten,
      rank,
      rivals: AI_COUNT,
    }
  }

  private spawnThing(awayFromPlayer: boolean): Thing {
    const k = pickKind()
    let x = rand(MARGIN, WORLD - MARGIN)
    let y = rand(MARGIN, WORLD - MARGIN)
    if (awayFromPlayer) {
      for (let i = 0; i < 8; i++) {
        if (Math.hypot(x - WORLD / 2, y - WORLD / 2) > BASE_RADIUS + 150) break
        x = rand(MARGIN, WORLD - MARGIN)
        y = rand(MARGIN, WORLD - MARGIN)
      }
    }
    return { id: this.nextId++, emoji: k.emoji, x, y, radius: k.radius, value: k.value, eaten: false, suck: 0 }
  }

  update(dt: number): void {
    if (this.over) return
    this.elapsed += dt
    if (this.elapsed >= DURATION) {
      this.elapsed = DURATION
      this.over = true
    }

    // 玩家：按手势方向移动
    const inLen = Math.hypot(this.inputX, this.inputY)
    if (inLen > 0.001) {
      const sp = PLAYER_SPEED * speedFactor(this.player.radius)
      const mag = Math.min(1, inLen)
      this.player.x += (this.inputX / inLen) * sp * mag * dt
      this.player.y += (this.inputY / inLen) * sp * mag * dt
    }

    // 对手黑洞：随机游走 + 体型朝「玩家附近的随机目标」缓慢靠拢
    for (let i = 1; i < this.holes.length; i++) {
      const ai = this.holes[i]
      ai.retarget -= dt
      if (ai.retarget <= 0) {
        ai.targetRadius = clamp(this.player.radius * rand(0.55, 1.4), 14, this.player.radius + 120)
        ai.retarget = rand(2, 5)
      }
      ai.radius += (ai.targetRadius - ai.radius) * Math.min(1, dt * 0.9)
      ai.wander += rand(-1, 1) * dt * 4
      const sp = AI_SPEED * speedFactor(ai.radius)
      ai.x += Math.cos(ai.wander) * sp * dt
      ai.y += Math.sin(ai.wander) * sp * dt
    }

    // 弹开速度：施加位移并衰减
    for (const h of this.holes) {
      h.x += h.bvx * dt
      h.y += h.bvy * dt
      const decay = Math.max(0, 1 - dt * 5)
      h.bvx *= decay
      h.bvy *= decay
      h.spin += dt * (h.isPlayer ? 2 : 1.4)
    }

    this.clampHoles()
    this.resolveCollisions()
    this.clampHoles()
    this.consume(dt)
  }

  private clampHoles(): void {
    for (let i = 0; i < this.holes.length; i++) {
      const h = this.holes[i]
      const before = { x: h.x, y: h.y }
      h.x = clamp(h.x, h.radius, WORLD - h.radius)
      h.y = clamp(h.y, h.radius, WORLD - h.radius)
      // 对手撞墙就把游走方向掰回场内，别卡在边上抖
      if (!h.isPlayer && (before.x !== h.x || before.y !== h.y)) {
        h.wander = Math.atan2(WORLD / 2 - h.y, WORLD / 2 - h.x) + rand(-0.6, 0.6)
      }
    }
  }

  private resolveCollisions(): void {
    const player = this.player
    for (let i = 1; i < this.holes.length; i++) {
      const ai = this.holes[i]
      const dx = player.x - ai.x
      const dy = player.y - ai.y
      const dist = Math.hypot(dx, dy)
      const minDist = player.radius + ai.radius
      if (dist >= minDist || dist === 0) continue
      const nx = dx / dist
      const ny = dy / dist
      const overlap = minDist - dist
      if (ai.radius > player.radius * 1.04) {
        // 对手更大：把玩家整体推出去并给一记弹飞
        player.x += nx * overlap
        player.y += ny * overlap
        player.bvx += nx * BOUNCE_IMPULSE
        player.bvy += ny * BOUNCE_IMPULSE
      } else if (player.radius > ai.radius * 1.04) {
        // 玩家更大：反过来把对手弹开
        ai.x -= nx * overlap
        ai.y -= ny * overlap
        ai.bvx -= nx * BOUNCE_IMPULSE
        ai.bvy -= ny * BOUNCE_IMPULSE
      } else {
        // 体型相近：各退一半，谁也吃不动谁
        player.x += nx * overlap * 0.5
        player.y += ny * overlap * 0.5
        ai.x -= nx * overlap * 0.5
        ai.y -= ny * overlap * 0.5
      }
    }
  }

  /** 玩家吞噬：吸比自己小、且已进嘴的道具；只有玩家吃东西，对手只是移动障碍 */
  private consume(dt: number): void {
    const player = this.player
    let removed = 0
    const pull = Math.min(1, dt * 9)
    for (const thing of this.things) {
      if (!thing.eaten) {
        const dist = Math.hypot(thing.x - player.x, thing.y - player.y)
        if (player.radius >= thing.radius * SWALLOW_RATIO && dist < player.radius) {
          thing.eaten = true
        }
      }
      if (thing.eaten) {
        thing.suck += dt / SUCK_TIME
        thing.x += (player.x - thing.x) * pull
        thing.y += (player.y - thing.y) * pull
        if (thing.suck >= 1) {
          this.score += thing.value
          this.eaten++
          player.area += thing.value * MASS_PER_VALUE
          player.radius = radiusOf(player.area)
          removed++
        }
      }
    }
    if (removed > 0) {
      this.things = this.things.filter(t => !(t.eaten && t.suck >= 1))
      for (let i = 0; i < removed; i++) this.things.push(this.spawnThing(false))
    }
  }

  /**
   * 把当前世界画到 2D context 上。调用方负责按设备像素比设好 transform，
   * 这里一律按 CSS 像素计算，相机始终跟着玩家、体型越大视野越远。
   */
  render(ctx: CanvasRenderingContext2D, cssW: number, cssH: number): void {
    const player = this.player
    const targetScale = clamp((Math.min(cssW, cssH) * 0.13) / player.radius, 0.42, 1.7)
    this.viewScale += (targetScale - this.viewScale) * 0.08
    const scale = this.viewScale
    const ox = cssW / 2 - player.x * scale
    const oy = cssH / 2 - player.y * scale
    const toX = (x: number) => x * scale + ox
    const toY = (y: number) => y * scale + oy

    // 地面
    ctx.fillStyle = '#0b1222'
    ctx.fillRect(0, 0, cssW, cssH)

    // 网格：只画可视范围内的线
    const GRID = 140
    const left = (0 - ox) / scale
    const right = (cssW - ox) / scale
    const top = (0 - oy) / scale
    const bottom = (cssH - oy) / scale
    ctx.strokeStyle = 'rgba(148,163,184,0.07)'
    ctx.lineWidth = 1
    ctx.beginPath()
    for (let gx = Math.floor(left / GRID) * GRID; gx <= right; gx += GRID) {
      ctx.moveTo(toX(gx), 0)
      ctx.lineTo(toX(gx), cssH)
    }
    for (let gy = Math.floor(top / GRID) * GRID; gy <= bottom; gy += GRID) {
      ctx.moveTo(0, toY(gy))
      ctx.lineTo(cssW, toY(gy))
    }
    ctx.stroke()

    // 世界边界
    ctx.strokeStyle = 'rgba(56,189,248,0.22)'
    ctx.lineWidth = 2
    ctx.strokeRect(toX(0), toY(0), WORLD * scale, WORLD * scale)

    // 道具（先画，黑洞叠在上面，吞噬时像是沉进洞里）
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    for (const thing of this.things) {
      const sx = toX(thing.x)
      const sy = toY(thing.y)
      const r = thing.radius * scale
      if (sx + r < 0 || sx - r > cssW || sy + r < 0 || sy - r > cssH) continue
      const shrink = thing.eaten ? 1 - Math.min(1, thing.suck) * 0.7 : 1
      const size = thing.radius * 2.1 * scale * shrink
      if (size < 3) continue
      ctx.globalAlpha = thing.eaten ? 1 - Math.min(1, thing.suck) * 0.6 : 1
      ctx.font = size + 'px -apple-system,"Segoe UI Emoji","Apple Color Emoji",sans-serif'
      ctx.fillText(thing.emoji, sx, sy)
    }
    ctx.globalAlpha = 1

    // 黑洞：对手在前，玩家最后画，保证玩家永远在最上层
    for (let i = this.holes.length - 1; i >= 0; i--) {
      this.drawHole(ctx, this.holes[i], toX(this.holes[i].x), toY(this.holes[i].y), this.holes[i].radius * scale)
    }
  }

  private drawHole(ctx: CanvasRenderingContext2D, h: Hole, sx: number, sy: number, r: number): void {
    if (sx + r < -40 || sx - r > ctx.canvas.width || sy + r < -40 || sy - r > ctx.canvas.height) return
    const color = h.isPlayer ? PLAYER_ACCENT : 'hsl(' + h.hue + ',80%,62%)'

    // 洞体：中心纯黑，边缘略带底色
    const grad = ctx.createRadialGradient(sx, sy, r * 0.15, sx, sy, r)
    grad.addColorStop(0, '#000000')
    grad.addColorStop(0.72, '#05060c')
    grad.addColorStop(1, '#0c1222')
    ctx.beginPath()
    ctx.arc(sx, sy, r, 0, Math.PI * 2)
    ctx.fillStyle = grad
    ctx.fill()

    // 漩涡
    ctx.save()
    ctx.translate(sx, sy)
    ctx.rotate(h.spin)
    ctx.globalAlpha = 0.33
    ctx.strokeStyle = color
    ctx.lineWidth = Math.max(1.5, r * 0.13)
    ctx.beginPath()
    ctx.arc(0, 0, r * 0.6, 0.2, Math.PI * 1.15)
    ctx.stroke()
    ctx.beginPath()
    ctx.arc(0, 0, r * 0.38, Math.PI, Math.PI * 1.95)
    ctx.stroke()
    ctx.restore()
    ctx.globalAlpha = 1

    // 事件视界：发光描边
    ctx.save()
    ctx.shadowColor = color
    ctx.shadowBlur = Math.min(26, r * 0.5)
    ctx.strokeStyle = color
    ctx.lineWidth = Math.max(2, r * 0.06)
    ctx.beginPath()
    ctx.arc(sx, sy, r, 0, Math.PI * 2)
    ctx.stroke()
    ctx.restore()

    // 对手名牌
    if (!h.isPlayer && r > 10) {
      ctx.font = '12px -apple-system,"PingFang SC",sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'alphabetic'
      ctx.lineWidth = 3
      ctx.strokeStyle = 'rgba(0,0,0,0.6)'
      ctx.strokeText(h.name, sx, sy - r - 6)
      ctx.fillStyle = 'rgba(241,245,249,0.92)'
      ctx.fillText(h.name, sx, sy - r - 6)
    }
  }
}
