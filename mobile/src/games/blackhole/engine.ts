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

import { pickWord } from './words'

/** 排行榜一行：玩家与对手共用，分数取整后给 HUD 展示 */
export interface LeaderRow {
  name: string
  score: number
  isPlayer: boolean
}

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
  /** 累计被对手咬掉体型的次数（界面可做「被咬」轻提示，不判负） */
  drains: number
  /** 最近一次吞下的道具附带的单词（数据管线保留，当前界面不展示；后续结合背单词） */
  lastWord: string | null
  /** 分数排行榜（玩家 + 对手，按分数降序取前 5） */
  leaderboard: LeaderRow[]
}

/** 道具类型：决定用哪种 2.5D 画法 */
type PropKind = 'bush' | 'person' | 'tree' | 'car' | 'house' | 'tower'

interface PropKindDef {
  kind: PropKind
  radius: number
  value: number
  weight: number
}

interface Thing {
  id: number
  kind: PropKind
  x: number
  y: number
  radius: number
  value: number
  /** 已被吸入、正在播放吞噬动画 */
  eaten: boolean
  /** 吞噬动画进度 0..1 */
  suck: number
  /** 随机外观种子（0..1）：决定配色 / 窗户亮灯 / 朝向，让城市不千篇一律 */
  variant: number
  /** 被吞时的旋转角（弧度）：边转边被拧进洞里 */
  tilt: number
  /** 这个道具附带的单词（吞下后进数据管线，以后结合背单词） */
  word: string
}

/** 黑洞坠落粒子：极坐标表示，dist 以「黑洞半径的倍数」为单位，向中心坠落 */
interface Particle {
  /** 当前角度（弧度） */
  angle: number
  /** 距中心的半径倍数：>1 在视界外，坠到 ~0 后重生到外圈 */
  dist: number
  /** 每秒向心坠落速度（dist 的减少量） */
  speed: number
  /** 每秒角速度（统一同向，形成漩涡） */
  spin: number
  /** 点的相对大小 */
  size: number
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
  /** 体型增长上限（世界像素半径）：对手只会缓慢长到这里就封顶 */
  maxRadius: number
  /** 每秒增长的半径（像素）：控制对手成长速度，别太快盖过玩家 */
  growRate: number
  /** 被咬扣体型后的冷却（秒，仅玩家用）：期间不再被扣，避免被连咬 */
  drainCd: number
  /** 分数：玩家=吞噬得分（排行榜里直接读引擎 score），对手=按 scoreRate 累加 */
  score: number
  /** 对手每秒自然涨分速率（玩家为 0）：让排行榜动态洗牌、玩家处于中上游竞争 */
  scoreRate: number
  /** 坠落粒子：绕黑洞向心旋入的小点，纯观感 */
  particles: Particle[]
}

const WORLD = 2600
const MARGIN = 60
const BASE_RADIUS = 26
const PLAYER_SPEED = 250
const AI_SPEED = 150
const MASS_PER_VALUE = 70
const SUCK_TIME = 0.5
const DURATION = 150
const PROP_TARGET = 440
const AI_COUNT = 10
const SWALLOW_RATIO = 0.9
const BOUNCE_IMPULSE = 320
const PLAYER_ACCENT = '#38bdf8'
// 对手成长：每秒缓慢长大、各自封顶，避免成长过快盖过玩家
const AI_GROW_PER_SEC = 0.12
const AI_MAX_RADIUS_LO = BASE_RADIUS * 1.15
const AI_MAX_RADIUS_HI = BASE_RADIUS * 2.1
// 对手更大撞上玩家时：只按面积比例扣一点体型，带冷却，绝不判负、不扣分
const DRAIN_RATIO = 0.12
const DRAIN_COOLDOWN = 1.4
// 坠落粒子数量：调低做成淡淡的环境漩涡，别抢了「实物被吞」的主戏
const PLAYER_PARTICLES = 16
const AI_PARTICLES = 4

const PROP_KINDS: PropKindDef[] = [
  { kind: 'bush', radius: 11, value: 1, weight: 26 },
  { kind: 'person', radius: 15, value: 2, weight: 30 },
  { kind: 'tree', radius: 22, value: 4, weight: 18 },
  { kind: 'car', radius: 28, value: 9, weight: 14 },
  { kind: 'house', radius: 44, value: 22, weight: 8 },
  { kind: 'tower', radius: 64, value: 52, weight: 4 },
]

const TOTAL_WEIGHT = PROP_KINDS.reduce((sum, k) => sum + k.weight, 0)

// 对手名字池：中英文昵称混搭，随机拼后缀（数字 / 符号 / 语气字），每局不同，看着像一堆真人在玩
const NAME_BASES = [
  '小宇', '阿强', '团子', '大黑', '波波', '西瓜', '阿飞', '九九', '饺子', '豆豆',
  '阿凯', '糖糖', '老王', '果果', '七七', '皮皮', '嘟嘟', '毛毛', '大圣', '可乐',
  'Luna', 'Momo', 'Neo', 'Zoe', 'Rin', 'Kai', 'Yuki', 'Toby', 'Nova', 'Leo',
  'Mia', 'Coco', 'Sora', 'Echo', 'Volt', 'Jade', 'Finn', 'Ace', 'Pixel', 'Ghost',
]
const NAME_SUFFIXES = ['', '', '', '', '66', '77', '233', '007', '99', '_', 'xo', '酱', '呀', 'TT', '2k', '888']

/** 随机生成 count 个不重复的对手名字，带点人味儿 */
function makeNames(count: number): string[] {
  const used = new Set<string>()
  const names: string[] = []
  let guard = 0
  while (names.length < count && guard < count * 60) {
    guard++
    const base = NAME_BASES[Math.floor(Math.random() * NAME_BASES.length)]
    const suffix = NAME_SUFFIXES[Math.floor(Math.random() * NAME_SUFFIXES.length)]
    const name = base + suffix
    if (used.has(name)) continue
    used.add(name)
    names.push(name)
  }
  return names
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

function rand(lo: number, hi: number): number {
  return lo + Math.random() * (hi - lo)
}

/** 生成一个坠落粒子：角度随机、从视界外（dist>1）起步，向心旋入 */
function spawnParticle(): Particle {
  return {
    angle: rand(0, Math.PI * 2),
    dist: rand(1.5, 2.8),
    speed: rand(0.6, 1.4),
    spin: rand(1.6, 3.2),
    size: rand(0.6, 1.6),
  }
}

/** 批量生成坠落粒子 */
function makeParticles(count: number): Particle[] {
  const list: Particle[] = []
  for (let i = 0; i < count; i++) list.push(spawnParticle())
  return list
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
  return { score: 0, radius: BASE_RADIUS, timeLeft: DURATION, over: false, eaten: 0, rank: 0, rivals: AI_COUNT, drains: 0, lastWord: null, leaderboard: [] }
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
  private drains = 0
  private lastWord: string | null = null

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
    this.drains = 0
    this.lastWord = null

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
      maxRadius: BASE_RADIUS,
      growRate: 0,
      drainCd: 0,
      score: 0,
      scoreRate: 0,
      particles: makeParticles(PLAYER_PARTICLES),
    }
    this.holes.push(this.player)

    const aiNames = makeNames(AI_COUNT)
    for (let i = 0; i < AI_COUNT; i++) {
      const radius = BASE_RADIUS * rand(0.6, 1.3)
      const maxRadius = Math.max(radius, rand(AI_MAX_RADIUS_LO, AI_MAX_RADIUS_HI))
      this.holes.push({
        isPlayer: false,
        name: aiNames[i],
        hue: Math.floor(rand(0, 360)),
        x: rand(MARGIN, WORLD - MARGIN),
        y: rand(MARGIN, WORLD - MARGIN),
        radius,
        area: Math.PI * radius * radius,
        spin: rand(0, Math.PI * 2),
        bvx: 0,
        bvy: 0,
        wander: rand(0, Math.PI * 2),
        maxRadius,
        growRate: AI_GROW_PER_SEC * rand(0.6, 1.4),
        drainCd: 0,
        score: rand(0, 30),
        scoreRate: rand(0.6, 2.2),
        particles: makeParticles(AI_PARTICLES),
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
    // 排行榜：玩家读引擎实时得分，对手读自然累加的 score；按分数降序取前 5
    const rows: LeaderRow[] = this.holes.map(h => ({
      name: h.isPlayer ? '你' : h.name,
      score: Math.round(h.isPlayer ? this.score : h.score),
      isPlayer: h.isPlayer,
    }))
    rows.sort((a, b) => b.score - a.score || (a.isPlayer ? -1 : b.isPlayer ? 1 : 0))
    return {
      score: this.score,
      radius: this.player.radius,
      timeLeft: Math.max(0, DURATION - this.elapsed),
      over: this.over,
      eaten: this.eaten,
      rank,
      rivals: AI_COUNT,
      drains: this.drains,
      lastWord: this.lastWord,
      leaderboard: rows.slice(0, 5),
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
    return { id: this.nextId++, kind: k.kind, x, y, radius: k.radius, value: k.value, eaten: false, suck: 0, variant: Math.random(), tilt: 0, word: pickWord().word }
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
    // 玩家被咬后的扣体型冷却递减
    if (this.player.drainCd > 0) {
      this.player.drainCd = Math.max(0, this.player.drainCd - dt)
    }

    // 对手黑洞：随机游走 + 体型缓慢长大到各自上限（成长速度受控，不会突然盖过玩家）
    for (let i = 1; i < this.holes.length; i++) {
      const ai = this.holes[i]
      // 对手自然涨分：让排行榜动态洗牌（纯观感，不影响玩法）
      ai.score += ai.scoreRate * dt
      if (ai.radius < ai.maxRadius) {
        ai.radius = Math.min(ai.maxRadius, ai.radius + ai.growRate * dt)
        ai.area = Math.PI * ai.radius * ai.radius
      }
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
      this.stepParticles(h, dt)
    }

    this.clampHoles()
    this.resolveCollisions()
    this.clampHoles()
    this.consume(dt)
  }

  /** 推进一个黑洞的坠落粒子：向心靠近、同向自转，坠到中心就从外圈重生 */
  private stepParticles(h: Hole, dt: number): void {
    for (const p of h.particles) {
      const accel = 1 + Math.max(0, 1.8 - p.dist) * 0.9
      p.dist -= p.speed * accel * dt
      p.angle += p.spin * dt
      if (p.dist <= 0.08) {
        const np = spawnParticle()
        p.angle = np.angle; p.dist = np.dist; p.speed = np.speed; p.size = np.size
      }
    }
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
        // 轻松版：被更大的对手撞上只扣一点体型（带冷却、有下限），绝不判负、也不扣分
        if (player.drainCd <= 0) {
          const minArea = Math.PI * BASE_RADIUS * BASE_RADIUS
          player.area = Math.max(minArea, player.area * (1 - DRAIN_RATIO))
          player.radius = radiusOf(player.area)
          player.drainCd = DRAIN_COOLDOWN
          this.drains++
        }
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
        thing.tilt += dt * 9
        // 螺旋坠入：绕着黑洞中心一边转圈一边向心靠近，像被吸进漩涡而非直线飞过去
        const dx = thing.x - player.x
        const dy = thing.y - player.y
        const ang = Math.atan2(dy, dx) + dt * 7
        const d = Math.hypot(dx, dy) * (1 - pull)
        thing.x = player.x + Math.cos(ang) * d
        thing.y = player.y + Math.sin(ang) * d
        if (thing.suck >= 1) {
          this.score += thing.value
          this.eaten++
          this.lastWord = thing.word
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

    // 道具：改成手绘 2.5D 矢量图形（楼 / 房 / 车 / 树 / 行人 / 灌木），不再用 emoji。
    // 每个道具按世界坐标「站」在地面上向上立起（有顶面 / 侧面 / 投影），像一座被黑洞逼近的城市；
    // 被吞时整体缩小 / 旋转 / 变淡并拖一条朝向洞心的暗影，像真被扯进洞里，而不只是一圈粒子。
    const pcx = toX(player.x)
    const pcy = toY(player.y)
    for (const thing of this.things) {
      const sx = toX(thing.x)
      const sy = toY(thing.y)
      const r = thing.radius * scale
      if (sx + r * 2 < 0 || sx - r * 2 > cssW || sy + r < 0 || sy - r * 3.4 > cssH) continue
      if (r < 1.2) continue
      const suck = thing.eaten ? Math.min(1, thing.suck) : 0
      if (suck > 0.08 && suck < 0.95) {
        ctx.save()
        ctx.globalAlpha = 0.16 * (1 - suck)
        ctx.strokeStyle = '#01030a'
        ctx.lineWidth = Math.max(1, r * 0.8 * (1 - suck))
        ctx.beginPath()
        ctx.moveTo(sx, sy - r * 0.6)
        ctx.lineTo(pcx, pcy)
        ctx.stroke()
        ctx.restore()
      }
      drawProp(ctx, thing.kind, sx, sy, r, thing.variant, suck, thing.tilt)
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

    // 坠落粒子：绕黑洞向心旋入的小点，营造「被吸进去」的漩涡感（够大才画，省性能）
    if (r > 6) {
      ctx.fillStyle = color
      for (const p of h.particles) {
        const pr = r * p.dist
        const px = sx + Math.cos(p.angle) * pr
        const py = sy + Math.sin(p.angle) * pr
        const t = clamp(p.dist / 1.8, 0, 1)
        ctx.globalAlpha = clamp(t * 0.5, 0.04, 0.5) * (h.isPlayer ? 1 : 0.7)
        const dotR = Math.max(0.5, p.size * r * 0.025 * (0.5 + t * 0.5))
        ctx.beginPath(); ctx.arc(px, py, dotR, 0, Math.PI * 2); ctx.fill()
      }
      ctx.globalAlpha = 1
    }

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

// ── 2.5D 道具绘制：全部手绘矢量（顶面亮 / 侧面暗 / 地面投影，光从左上来），不依赖任何外部素材 ──

const TOWER_PALETTE = [
  { front: '#3b4a63', side: '#2b394f', top: '#4b5c79' },
  { front: '#4a5568', side: '#38424f', top: '#5a6a80' },
  { front: '#2f6b7a', side: '#234f5c', top: '#3c8294' },
  { front: '#6b5a4a', side: '#51473a', top: '#7e6c58' },
]
const HOUSE_PALETTE = [
  { front: '#c9b79c', side: '#a89779', roof: '#b4553f', roofSide: '#8d3e2d' },
  { front: '#d8cbb4', side: '#b4a68c', roof: '#5b7fa6', roofSide: '#466285' },
  { front: '#bfc7cf', side: '#99a3ae', roof: '#7a8a52', roofSide: '#5e6c3f' },
]
const CAR_COLORS = [
  { body: '#d0574b', cabin: '#a7443b' },
  { body: '#4e86c6', cabin: '#3c699b' },
  { body: '#e3b23c', cabin: '#b78c2c' },
  { body: '#cfd6de', cabin: '#a3abb5' },
  { body: '#5aa469', cabin: '#468053' },
]
const TREE_GREENS = [
  { dark: '#2f6b3f', light: '#4f9960' },
  { dark: '#356b2f', light: '#5aa04f' },
  { dark: '#2b7a5e', light: '#46a683' },
]
const PERSON_SKINS = ['#e8b98f', '#d79a6a', '#c08457', '#f0c9a0']
const PERSON_SHIRTS = ['#d0576e', '#4e86c6', '#e3b23c', '#5aa469', '#9b6bd0', '#e07b3c']

/** 按种子从数组里稳定取一项（种子可超出 0..1，取模兜底） */
function pickFrom<T>(arr: T[], variant: number): T {
  const i = Math.floor(Math.abs(variant) * arr.length) % arr.length
  return arr[i]
}

/** 伪随机 0..1：按种子 + 下标出一个稳定值，用于楼里哪些窗户亮灯 */
function pseudo(seed: number, i: number): number {
  const x = Math.sin(seed * 97.17 + i * 12.9898) * 43758.5453
  return x - Math.floor(x)
}

/** 实心圆点 / 圆团 */
function blob(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number): void {
  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, Math.PI * 2)
  ctx.fill()
}

/** 圆角矩形路径（不依赖 ctx.roundRect，兼容性更好）；只建路径，填充交给调用方 */
function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + rr, y)
  ctx.arcTo(x + w, y, x + w, y + h, rr)
  ctx.arcTo(x + w, y + h, x, y + h, rr)
  ctx.arcTo(x, y + h, x, y, rr)
  ctx.arcTo(x, y, x + w, y, rr)
  ctx.closePath()
}

/** 地面压扁投影，给道具一个「踩在地上」的参照 */
function drawShadow(ctx: CanvasRenderingContext2D, gx: number, gy: number, rr: number): void {
  ctx.save()
  ctx.globalAlpha *= 0.26
  ctx.fillStyle = '#02040c'
  ctx.beginPath()
  ctx.ellipse(gx, gy, rr * 1.05, rr * 0.42, 0, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
}

/** 立方体盒子：右侧面 + （可选）顶面 + 正面，oblique 斜投影出高度 */
function drawBox(
  ctx: CanvasRenderingContext2D,
  gx: number, gy: number, halfW: number, height: number, depth: number,
  front: string, side: string, top: string, withTop: boolean,
): void {
  const bx0 = gx - halfW
  const bx1 = gx + halfW
  const topY = gy - height
  const ddx = depth * 0.8
  const ddy = -depth * 0.55
  ctx.fillStyle = side
  ctx.beginPath()
  ctx.moveTo(bx1, gy)
  ctx.lineTo(bx1, topY)
  ctx.lineTo(bx1 + ddx, topY + ddy)
  ctx.lineTo(bx1 + ddx, gy + ddy)
  ctx.closePath()
  ctx.fill()
  if (withTop) {
    ctx.fillStyle = top
    ctx.beginPath()
    ctx.moveTo(bx0, topY)
    ctx.lineTo(bx1, topY)
    ctx.lineTo(bx1 + ddx, topY + ddy)
    ctx.lineTo(bx0 + ddx, topY + ddy)
    ctx.closePath()
    ctx.fill()
  }
  ctx.fillStyle = front
  ctx.fillRect(bx0, topY, halfW * 2, height)
}

function drawTower(ctx: CanvasRenderingContext2D, gx: number, gy: number, rr: number, variant: number): void {
  const halfW = rr * 0.82
  const height = rr * 2.7
  const depth = rr * 0.5
  const pal = pickFrom(TOWER_PALETTE, variant)
  drawBox(ctx, gx, gy, halfW, height, depth, pal.front, pal.side, pal.top, true)
  const topY = gy - height
  const cols = 3
  const rows = Math.max(4, Math.round(height / (rr * 0.42)))
  const marginX = halfW * 0.3
  const marginY = rr * 0.2
  const cellW = (halfW * 2 - marginX * 2) / cols
  const cellH = (height - marginY * 2) / rows
  const winW = cellW * 0.58
  const winH = cellH * 0.56
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const lit = pseudo(variant, row * cols + col) > 0.5
      ctx.fillStyle = lit ? 'rgba(255,224,130,0.92)' : 'rgba(12,20,38,0.75)'
      const wx = gx - halfW + marginX + col * cellW + (cellW - winW) / 2
      const wy = topY + marginY + row * cellH + (cellH - winH) / 2
      ctx.fillRect(wx, wy, winW, winH)
    }
  }
}

function drawHouse(ctx: CanvasRenderingContext2D, gx: number, gy: number, rr: number, variant: number): void {
  const halfW = rr * 0.92
  const height = rr * 1.05
  const depth = rr * 0.5
  const pal = pickFrom(HOUSE_PALETTE, variant)
  drawBox(ctx, gx, gy, halfW, height, depth, pal.front, pal.side, pal.front, false)
  const topY = gy - height
  const ddx = depth * 0.8
  const ddy = -depth * 0.55
  const peakX = gx
  const peakY = topY - rr * 0.72
  ctx.fillStyle = pal.roofSide
  ctx.beginPath()
  ctx.moveTo(gx + halfW, topY)
  ctx.lineTo(peakX, peakY)
  ctx.lineTo(peakX + ddx, peakY + ddy)
  ctx.lineTo(gx + halfW + ddx, topY + ddy)
  ctx.closePath()
  ctx.fill()
  ctx.fillStyle = pal.roof
  ctx.beginPath()
  ctx.moveTo(gx - halfW, topY)
  ctx.lineTo(gx + halfW, topY)
  ctx.lineTo(peakX, peakY)
  ctx.closePath()
  ctx.fill()
  const doorW = halfW * 0.4
  const doorH = height * 0.6
  ctx.fillStyle = '#4a3728'
  ctx.fillRect(gx - doorW / 2, gy - doorH, doorW, doorH)
  const winW = halfW * 0.42
  ctx.fillStyle = 'rgba(255,224,130,0.9)'
  ctx.fillRect(gx + halfW * 0.16, topY + height * 0.2, winW, winW * 0.78)
}

function drawCar(ctx: CanvasRenderingContext2D, gx: number, gy: number, rr: number, variant: number): void {
  const w = rr * 1.4
  const h = rr * 0.64
  const col = pickFrom(CAR_COLORS, variant)
  const topY = gy - h
  ctx.fillStyle = '#1b2130'
  blob(ctx, gx - w * 0.28, gy - h * 0.05, h * 0.3)
  blob(ctx, gx + w * 0.28, gy - h * 0.05, h * 0.3)
  ctx.fillStyle = col.body
  roundRectPath(ctx, gx - w / 2, topY, w, h, h * 0.32)
  ctx.fill()
  ctx.fillStyle = col.cabin
  roundRectPath(ctx, gx - w * 0.24, topY - h * 0.55, w * 0.5, h * 0.62, h * 0.22)
  ctx.fill()
  ctx.fillStyle = 'rgba(190,225,255,0.9)'
  roundRectPath(ctx, gx - w * 0.19, topY - h * 0.44, w * 0.42, h * 0.42, h * 0.14)
  ctx.fill()
  ctx.fillStyle = 'rgba(255,241,170,0.95)'
  blob(ctx, gx + w * 0.46, topY + h * 0.42, h * 0.11)
}

function drawTree(ctx: CanvasRenderingContext2D, gx: number, gy: number, rr: number, variant: number): void {
  const g = pickFrom(TREE_GREENS, variant)
  const trunkW = rr * 0.26
  const trunkH = rr * 0.95
  ctx.fillStyle = '#6b4423'
  ctx.fillRect(gx - trunkW / 2, gy - trunkH, trunkW, trunkH)
  const cx = gx
  const cy = gy - trunkH - rr * 0.5
  ctx.fillStyle = g.dark
  blob(ctx, cx - rr * 0.42, cy + rr * 0.22, rr * 0.6)
  blob(ctx, cx + rr * 0.42, cy + rr * 0.16, rr * 0.58)
  blob(ctx, cx, cy, rr * 0.82)
  ctx.fillStyle = g.light
  blob(ctx, cx - rr * 0.2, cy - rr * 0.22, rr * 0.44)
}

function drawBush(ctx: CanvasRenderingContext2D, gx: number, gy: number, rr: number, variant: number): void {
  const g = pickFrom(TREE_GREENS, variant)
  ctx.fillStyle = g.dark
  blob(ctx, gx - rr * 0.5, gy - rr * 0.32, rr * 0.56)
  blob(ctx, gx + rr * 0.5, gy - rr * 0.26, rr * 0.5)
  blob(ctx, gx, gy - rr * 0.58, rr * 0.62)
  ctx.fillStyle = g.light
  blob(ctx, gx - rr * 0.14, gy - rr * 0.62, rr * 0.34)
}

function drawPerson(ctx: CanvasRenderingContext2D, gx: number, gy: number, rr: number, variant: number): void {
  const skin = pickFrom(PERSON_SKINS, variant)
  const shirt = pickFrom(PERSON_SHIRTS, variant * 1.7 + 0.3)
  ctx.fillStyle = '#2b3240'
  ctx.fillRect(gx - rr * 0.3, gy - rr * 0.55, rr * 0.22, rr * 0.55)
  ctx.fillRect(gx + rr * 0.08, gy - rr * 0.55, rr * 0.22, rr * 0.55)
  ctx.fillStyle = shirt
  roundRectPath(ctx, gx - rr * 0.4, gy - rr * 1.18, rr * 0.8, rr * 0.74, rr * 0.26)
  ctx.fill()
  ctx.fillStyle = skin
  blob(ctx, gx, gy - rr * 1.42, rr * 0.4)
}

/** 按类型分派 2.5D 画法；被吞时整体缩小 / 旋转 / 变淡，像被扯进洞里 */
function drawProp(
  ctx: CanvasRenderingContext2D,
  kind: PropKind, gx: number, gy: number, r: number,
  variant: number, suck: number, tilt: number,
): void {
  const shrink = 1 - suck * 0.5
  const rr = r * shrink
  if (rr < 1) return
  ctx.save()
  ctx.globalAlpha = clamp(1 - suck * 0.8, 0, 1)
  if (suck > 0) {
    const pivotY = gy - rr * 0.6
    ctx.translate(gx, pivotY)
    ctx.rotate(tilt)
    ctx.translate(-gx, -pivotY)
  }
  drawShadow(ctx, gx, gy, rr)
  switch (kind) {
    case 'bush': drawBush(ctx, gx, gy, rr, variant); break
    case 'person': drawPerson(ctx, gx, gy, rr, variant); break
    case 'tree': drawTree(ctx, gx, gy, rr, variant); break
    case 'car': drawCar(ctx, gx, gy, rr, variant); break
    case 'house': drawHouse(ctx, gx, gy, rr, variant); break
    case 'tower': drawTower(ctx, gx, gy, rr, variant); break
  }
  ctx.restore()
}
