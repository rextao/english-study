/**
 * 像素魔法飞弹：合并两个球后从合并点飞到小怪兽胸前炸开。
 *
 * 视觉与运动参考 pixelfx 的 projectiles/magic-missile（MIT，https://github.com/patch-gg/pixelfx）。
 * 项目约定不新增运行时依赖，所以这里用一块低分辨率画布重写了同一套「蓄力光点 → 扭动拖尾 →
 * 命中星芒 / 冲击环」效果，不引入 pixelfx 包。画布按 CSS 像素的 1/3 渲染，再用 image-rendering:
 * pixelated 放大，保持像素颗粒感。
 */

type Color = number

interface Frame {
  w: number
  h: number
  color: Uint32Array
  light: Uint32Array
}

const TAU = Math.PI * 2
const CHARGE = 0.18
const FLY = 0.55
const BURST = 0.5
const TOTAL = CHARGE + FLY + BURST
const TRAIL_LIFE = 0.32

/** 4×4 有序抖动阈值：半透明像素按格子决定画不画，得到像素画特有的颗粒淡出 */
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map(v => (v + 0.5) / 16)
const CROSS = [[1, 0], [-1, 0], [0, 1], [0, -1]]
const DIAG = [[1, 1], [1, -1], [-1, 1], [-1, -1]]

/** 与 pixelfx 的 arcane 色板一致：从暗紫到纯白 */
const PALETTE = ['#140a26', '#2b1252', '#481c88', '#6b2cc0', '#9a48ec', '#c684ff', '#ecc8ff', '#ffffff']

const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value))
const easeInOutSine = (t: number) => -(Math.cos(Math.PI * t) - 1) / 2
const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3)
const easeOutBack = (t: number) => {
  if (t <= 0) return 0
  if (t >= 1) return 1
  const s = 1.70158
  return 1 + (s + 1) * Math.pow(t - 1, 3) + s * Math.pow(t - 1, 2)
}

function rgb(r: number, g: number, b: number): Color {
  return ((255 << 24) | ((b & 255) << 16) | ((g & 255) << 8) | (r & 255)) >>> 0
}

function hex(value: string): Color {
  let text = value.replace('#', '')
  if (text.length === 3) text = text[0] + text[0] + text[1] + text[1] + text[2] + text[2]
  const valueNumber = parseInt(text.slice(0, 6), 16)
  return rgb((valueNumber >> 16) & 255, (valueNumber >> 8) & 255, valueNumber & 255)
}

function red(color: Color) {
  return color & 255
}

function green(color: Color) {
  return (color >>> 8) & 255
}

function blue(color: Color) {
  return (color >>> 16) & 255
}

function scaleColor(color: Color, k: number): Color {
  return rgb(Math.min(255, red(color) * k), Math.min(255, green(color) * k), Math.min(255, blue(color) * k))
}

const C = PALETTE.map(hex)
const WHITE = C[7]
const SPARK_COLORS = [WHITE, C[6], C[5], C[4]]

class Rng {
  private state: number

  constructor(seed: number) {
    this.state = seed >>> 0 || 1
  }

  next() {
    let t = (this.state = (this.state + 0x6d2b79f5) >>> 0)
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  range(min: number, max: number) {
    return min + (max - min) * this.next()
  }

  chance(probability: number) {
    return this.next() < probability
  }

  pick<T>(list: T[]): T {
    return list[Math.floor(this.next() * list.length)]
  }
}

class Painter {
  private frame: Frame

  constructor(frame: Frame) {
    this.frame = frame
  }

  /** 画一个不透明像素 */
  px(x: number, y: number, color: Color) {
    this.dot(x, y, color, 1)
  }

  /** 画一个像素，alpha 用有序抖动表现 */
  dot(x: number, y: number, color: Color, alpha = 1) {
    if (!color || alpha <= 0) return
    const px = Math.floor(x)
    const py = Math.floor(y)
    if (alpha < 1 && alpha <= BAYER[((py & 3) << 2) | (px & 3)]) return
    if (px < 0 || py < 0 || px >= this.frame.w || py >= this.frame.h) return
    this.frame.color[py * this.frame.w + px] = color
  }

  /** 加一点光：最终在 composite 里叠到颜色上 */
  add(x: number, y: number, color: Color, k: number) {
    if (k <= 0.004) return
    const px = Math.floor(x)
    const py = Math.floor(y)
    if (px < 0 || py < 0 || px >= this.frame.w || py >= this.frame.h) return
    const index = py * this.frame.w + px
    const old = this.frame.light[index]
    const r = Math.min(255, (old & 255) + red(color) * k) | 0
    const g = Math.min(255, ((old >>> 8) & 255) + green(color) * k) | 0
    const b = Math.min(255, ((old >>> 16) & 255) + blue(color) * k) | 0
    this.frame.light[index] = ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0
  }

  /** 径向光晕，中心最亮，到 r 处消失 */
  glow(x: number, y: number, radius: number, color: Color, k = 0.5) {
    if (radius < 1 || k <= 0.004) return
    const x0 = Math.floor(x - radius)
    const x1 = Math.ceil(x + radius)
    const y0 = Math.floor(y - radius)
    const y1 = Math.ceil(y + radius)
    for (let py = y0; py <= y1; py += 1) {
      const dy = (py + 0.5 - y) / radius
      for (let px = x0; px <= x1; px += 1) {
        const dx = (px + 0.5 - x) / radius
        const distance = dx * dx + dy * dy
        if (distance >= 1) continue
        const falloff = 1 - Math.sqrt(distance)
        this.add(px, py, color, falloff * falloff * k)
      }
    }
  }

  /** 1 像素宽的线（Bresenham） */
  line(x0: number, y0: number, x1: number, y1: number, color: Color, alpha = 1) {
    let px = Math.floor(x0)
    let py = Math.floor(y0)
    const ex = Math.floor(x1)
    const ey = Math.floor(y1)
    const dx = Math.abs(ex - px)
    const dy = -Math.abs(ey - py)
    const stepX = px < ex ? 1 : -1
    const stepY = py < ey ? 1 : -1
    let error = dx + dy
    for (;;) {
      this.dot(px, py, color, alpha)
      if (px === ex && py === ey) break
      const e2 = 2 * error
      if (e2 >= dy) {
        error += dy
        px += stepX
      }
      if (e2 <= dx) {
        error += dx
        py += stepY
      }
    }
  }

  /** 实心圆 */
  circle(cx: number, cy: number, radius: number, color: Color, alpha = 1) {
    if (radius < 0.6) {
      this.dot(cx, cy, color, alpha)
      return
    }
    const x0 = Math.floor(cx - radius)
    const x1 = Math.ceil(cx + radius)
    const y0 = Math.floor(cy - radius)
    const y1 = Math.ceil(cy + radius)
    for (let py = y0; py <= y1; py += 1) {
      for (let px = x0; px <= x1; px += 1) {
        const dx = px + 0.5 - cx
        const dy = py + 0.5 - cy
        if (dx * dx + dy * dy <= radius * radius) this.dot(px, py, color, alpha)
      }
    }
  }

  /** 圆环，宽度向内 */
  ring(cx: number, cy: number, radius: number, width: number, color: Color, alpha = 1) {
    const inner = Math.max(0, radius - width)
    const x0 = Math.floor(cx - radius)
    const x1 = Math.ceil(cx + radius)
    const y0 = Math.floor(cy - radius)
    const y1 = Math.ceil(cy + radius)
    for (let py = y0; py <= y1; py += 1) {
      for (let px = x0; px <= x1; px += 1) {
        const dx = px + 0.5 - cx
        const dy = py + 0.5 - cy
        const distance = dx * dx + dy * dy
        if (distance <= radius * radius && distance >= inner * inner) this.dot(px, py, color, alpha)
      }
    }
  }
}

const SPARK = 0
const MOTE = 1
const STAR = 2

interface Particle {
  kind: number
  x: number
  y: number
  vx: number
  vy: number
  life: number
  max: number
  color: Color
  size: number
  seed: number
  delay: number
}

interface Light {
  x: number
  y: number
  radius: number
  color: Color
  k: number
  life: number
  max: number
}

interface TrailPoint {
  x: number
  y: number
  t: number
}

interface Missile {
  x0: number
  y0: number
  x1: number
  y1: number
  cssX1: number
  cssY1: number
  ux: number
  uy: number
  nx: number
  ny: number
  length: number
  damage: number
  t: number
  seed: number
  impacted: boolean
  rng: Rng
  trail: TrailPoint[]
  particles: Particle[]
  lights: Light[]
}

export interface MissileLaunch {
  /** 合并点（CSS 像素） */
  x0: number
  y0: number
  /** 小怪兽胸前（CSS 像素） */
  x1: number
  y1: number
  damage: number
}

export interface MissileImpact {
  /** 命中点（CSS 像素） */
  x: number
  y: number
  damage: number
}

/** 一个飞弹实例，存活时间结束后自动移除 */
export class MagicMissileFx {
  private scale: number
  private canvas: HTMLCanvasElement | null = null
  private ctx: CanvasRenderingContext2D | null = null
  private frame: Frame | null = null
  private imageData: ImageData | null = null
  private cssW = 0
  private cssH = 0
  private missiles: Missile[] = []
  private dirty = false

  constructor(scale = 3) {
    this.scale = scale
  }

  attach(canvas: HTMLCanvasElement) {
    if (this.canvas === canvas && this.ctx) return
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')
    if (this.ctx) this.ctx.imageSmoothingEnabled = false
    this.rebuild()
  }

  detach() {
    this.canvas = null
    this.ctx = null
  }

  /** 场地尺寸变化：按低分辨率重建画布与缓冲 */
  resize(cssW: number, cssH: number) {
    if (!cssW || !cssH) return
    if (Math.abs(cssW - this.cssW) < 0.5 && Math.abs(cssH - this.cssH) < 0.5) return
    this.cssW = cssW
    this.cssH = cssH
    this.missiles = []
    this.rebuild()
  }

  private rebuild() {
    if (this.cssW <= 0 || this.cssH <= 0) return
    const w = Math.max(1, Math.ceil(this.cssW / this.scale))
    const h = Math.max(1, Math.ceil(this.cssH / this.scale))
    if (this.canvas) {
      this.canvas.width = w
      this.canvas.height = h
    }
    this.frame = {
      w,
      h,
      color: new Uint32Array(w * h),
      light: new Uint32Array(w * h),
    }
    this.imageData = this.ctx ? this.ctx.createImageData(w, h) : null
    this.dirty = true
  }

  /** 从合并点发射一颗飞弹；画布还没准备好时返回 false，调用方可直接结算伤害 */
  fire(launch: MissileLaunch): boolean {
    if (!this.frame || !this.cssW || !this.cssH) return false
    const x0 = launch.x0 / this.scale
    const y0 = launch.y0 / this.scale
    const x1 = launch.x1 / this.scale
    const y1 = launch.y1 / this.scale
    const dx = x1 - x0
    const dy = y1 - y0
    const length = Math.hypot(dx, dy) || 1
    const ux = dx / length
    const uy = dy / length
    this.missiles.push({
      x0,
      y0,
      x1,
      y1,
      cssX1: launch.x1,
      cssY1: launch.y1,
      ux,
      uy,
      nx: -uy,
      ny: ux,
      length,
      damage: launch.damage,
      t: 0,
      seed: Math.floor(Math.random() * 1e9),
      impacted: false,
      rng: new Rng(Math.floor(Math.random() * 1e9) + 1),
      trail: [],
      particles: [],
      lights: [],
    })
    this.dirty = true
    return true
  }

  /** 推进所有飞弹，返回这一帧命中的目标（命中伤害由游戏结算） */
  update(dt: number): MissileImpact[] {
    if (dt <= 0) return []
    const impacts: MissileImpact[] = []
    const height = this.frame?.h ?? 0
    for (const missile of this.missiles) {
      updateMissile(missile, dt, height, impacts)
    }
    this.missiles = this.missiles.filter(missile => missile.t < TOTAL)
    if (this.missiles.length > 0) this.dirty = true
    return impacts
  }

  /** 把当前飞弹画到画布上；没有飞弹时只清一次 */
  render() {
    if (!this.ctx || !this.frame || !this.imageData) return
    if (this.missiles.length === 0 && !this.dirty) return
    this.frame.color.fill(0)
    this.frame.light.fill(0)
    const painter = new Painter(this.frame)
    for (const missile of this.missiles) drawMissile(painter, missile)
    composite(this.frame, this.imageData.data)
    this.ctx.putImageData(this.imageData, 0, 0)
    this.dirty = this.missiles.length > 0
  }

  /** 重开一局：丢掉所有飞弹并立刻擦干净画布 */
  reset() {
    this.missiles = []
    if (this.ctx && this.imageData) {
      this.imageData.data.fill(0)
      this.ctx.putImageData(this.imageData, 0, 0)
    }
    this.dirty = true
  }
}

function flightPoint(missile: Missile, u: number) {
  const eased = easeInOutSine(u)
  const forward = missile.length * eased + Math.sin(u * Math.PI) * 6
  const sideways = Math.sin(u * Math.PI * 3) * 9 * Math.sin(u * Math.PI)
  return {
    x: missile.x0 + missile.ux * forward + missile.nx * sideways,
    y: missile.y0 + missile.uy * forward + missile.ny * sideways,
  }
}

function spawnParticle(
  missile: Missile,
  kind: number,
  x: number,
  y: number,
  vx: number,
  vy: number,
  life: number,
  color: Color,
  size: number,
  delay = 0,
) {
  missile.particles.push({
    kind,
    x,
    y,
    vx,
    vy,
    life,
    max: life,
    color,
    size,
    seed: missile.rng.next() * 100,
    delay,
  })
}

function updateMissile(missile: Missile, dt: number, height: number, impacts: MissileImpact[]) {
  const rng = missile.rng
  missile.t += dt

  if (missile.t < CHARGE) {
    // 蓄力：光点从四周螺旋收进手心的光球
    if (rng.chance(Math.min(1, 0.8 * dt * 120))) {
      const angle = rng.range(0, TAU)
      const distance = rng.range(12, 26)
      const speed = distance / 0.14
      spawnParticle(
        missile,
        MOTE,
        missile.x0 + Math.cos(angle) * distance,
        missile.y0 + Math.sin(angle) * distance,
        -Math.cos(angle) * speed - Math.sin(angle) * speed * 0.5,
        -Math.sin(angle) * speed + Math.cos(angle) * speed * 0.5,
        0.14,
        rng.pick([C[5], C[6], WHITE]),
        0.8,
      )
    }
  } else if (missile.t < CHARGE + FLY) {
    // 飞行：沿着路径留下扭动的光带，并不断掉出小光点
    const u = (missile.t - CHARGE) / FLY
    const point = flightPoint(missile, u)
    missile.trail.push({ x: point.x, y: point.y, t: missile.t })
    if (rng.chance(Math.min(1, 0.6 * dt * 120))) {
      spawnParticle(
        missile,
        MOTE,
        point.x,
        point.y,
        rng.range(-50, 50),
        rng.range(-50, 50),
        rng.range(0.2, 0.4),
        rng.pick([C[4], C[5], C[6]]),
        0.7,
      )
    }
    if (rng.chance(Math.min(1, 0.25 * dt * 120))) {
      spawnParticle(
        missile,
        STAR,
        point.x + rng.range(-3, 3),
        point.y + rng.range(-3, 3),
        rng.range(-10, 10),
        rng.range(-10, 10),
        rng.range(0.25, 0.5),
        C[6],
        rng.range(0.6, 1.6),
      )
    }
  } else if (!missile.impacted) {
    // 命中：星芒 + 冲击环 + 四散的光点 / 火星
    missile.impacted = true
    missile.lights.push({ x: missile.x1, y: missile.y1, radius: 52, color: C[4], k: 0.95, life: 0.55, max: 0.55 })
    missile.lights.push({ x: missile.x1, y: missile.y1, radius: 22, color: WHITE, k: 0.8, life: 0.12, max: 0.12 })
    for (let i = 0; i < 26; i += 1) {
      const angle = rng.range(0, TAU)
      const speed = rng.range(60, 150) * (1 - 0.65 * Math.max(0, Math.sin(angle)))
      spawnParticle(
        missile,
        i % 3 ? MOTE : STAR,
        missile.x1,
        missile.y1,
        Math.cos(angle) * speed,
        Math.sin(angle) * speed,
        rng.range(0.25, 0.45),
        rng.pick([C[5], C[6], WHITE]),
        rng.range(0.8, 1.8),
      )
    }
    for (let i = 0; i < 18; i += 1) {
      const angle = rng.range(0, TAU)
      const speed = rng.range(110, 240) * (1 - 0.5 * Math.max(0, Math.sin(angle)))
      spawnParticle(
        missile,
        SPARK,
        missile.x1,
        missile.y1,
        Math.cos(angle) * speed,
        Math.sin(angle) * speed - 30,
        rng.range(0.12, 0.3),
        WHITE,
        1,
      )
    }
    for (let i = 0; i < 14; i += 1) {
      const angle = rng.range(0, TAU)
      const distance = rng.range(4, 22)
      spawnParticle(
        missile,
        STAR,
        missile.x1 + Math.cos(angle) * distance,
        missile.y1 + Math.sin(angle) * distance * 0.8,
        0,
        -rng.range(2, 8),
        rng.range(0.5, 1.1),
        rng.pick([C[6], WHITE, C[5]]),
        rng.range(0.8, 2.6),
        rng.range(0.05, 0.45),
      )
    }
    impacts.push({ x: missile.cssX1, y: missile.cssY1, damage: missile.damage })
  }

  // 拖尾只保留最近 0.32 秒，避免数组无限长
  if (missile.trail.length > 0) {
    missile.trail = missile.trail.filter(point => missile.t - point.t < TRAIL_LIFE)
  }
  updateParticles(missile.particles, dt, height)
  updateLights(missile.lights, dt)
}

function updateParticles(particles: Particle[], dt: number, ground: number) {
  for (let i = particles.length - 1; i >= 0; i -= 1) {
    const particle = particles[i]
    if (particle.delay > 0) {
      particle.delay -= dt
      continue
    }
    particle.life -= dt
    if (particle.life <= 0) {
      particles.splice(i, 1)
      continue
    }
    if (particle.kind === SPARK) {
      particle.vy += 950 * 0.45 * dt
      particle.vx -= particle.vx * 2.2 * dt
      particle.vy -= particle.vy * 2.2 * dt
      particle.x += particle.vx * dt
      const nextY = particle.y + particle.vy * dt
      if (particle.vy > 0 && particle.y <= ground && nextY >= ground) {
        particle.y = ground - 0.25
        particle.vy = -particle.vy * 0.45
        particle.vx *= 0.7
      } else {
        particle.y = nextY
      }
      continue
    }
    if (particle.kind === MOTE) {
      particle.vx -= particle.vx * 0.6 * dt
      particle.vy -= particle.vy * 0.6 * dt
    } else {
      particle.vx -= particle.vx * 1.6 * dt
      particle.vy -= particle.vy * 1.6 * dt + 5 * dt
    }
    particle.x += particle.vx * dt
    particle.y += particle.vy * dt
  }
}

function updateLights(lights: Light[], dt: number) {
  for (let i = lights.length - 1; i >= 0; i -= 1) {
    lights[i].life -= dt
    if (lights[i].life <= 0) lights.splice(i, 1)
  }
}

function drawMissile(painter: Painter, missile: Missile) {
  const now = missile.t
  if (now < CHARGE + FLY) {
    drawTrail(painter, missile, now)
  }
  drawParticles(painter, missile.particles, now)
  if (now < CHARGE + FLY) {
    drawOrb(painter, missile)
  }
  drawBurst(painter, missile)
  drawLights(painter, missile.lights)
}

function drawTrail(painter: Painter, missile: Missile, now: number) {
  const keep = missile.trail.filter(point => now - point.t < TRAIL_LIFE)
  for (let i = 1; i < keep.length; i += 1) {
    const a = keep[i - 1]
    const b = keep[i]
    const dx = b.x - a.x
    const dy = b.y - a.y
    const length = Math.hypot(dx, dy) || 1
    const nx = -dy / length
    const ny = dx / length
    for (let f = 0; f < 1; f += 0.5 / length) {
      const time = a.t + (b.t - a.t) * f
      const k = 1 - (now - time) / TRAIL_LIFE
      const twist = Math.sin(time * 26)
      const width = 3.2 * k * Math.abs(twist) + 0.4
      const face = twist > 0
      const x = a.x + dx * f
      const y = a.y + dy * f
      for (let s = -width; s <= width; s += 0.5) {
        const edge = Math.abs(s) > width - 0.8
        const color = face
          ? edge ? C[6] : k > 0.6 ? C[5] : C[4]
          : edge ? C[4] : C[2]
        painter.dot(x + nx * s, y + ny * s, color, k > 0.35 ? 1 : k / 0.35)
      }
    }
    if (i % 3 === 0) {
      painter.glow(b.x, b.y, 6, C[4], 0.25 * (1 - (now - b.t) / TRAIL_LIFE))
    }
  }
}

function drawOrb(painter: Painter, missile: Missile) {
  const charging = missile.t < CHARGE
  const k = charging ? missile.t / CHARGE : 1
  const point = charging
    ? { x: missile.x0, y: missile.y0 }
    : flightPoint(missile, clamp((missile.t - CHARGE) / FLY))
  const radius = 1 + 3 * easeOutBack(k)
  painter.circle(point.x, point.y, radius + 1.4, C[3])
  painter.circle(point.x, point.y, radius + 0.4, C[5])
  painter.circle(point.x - 0.4, point.y - 0.4, radius * 0.55, WHITE)
  for (let i = 0; i < 3; i += 1) {
    const angle = missile.t * 14 + (i * TAU) / 3
    painter.px(
      point.x + Math.cos(angle) * (radius + 3),
      point.y + Math.sin(angle) * (radius + 3) * 0.6,
      i ? C[6] : WHITE,
    )
  }
  painter.glow(point.x, point.y, 20, C[4], 0.65 * k)
  painter.glow(point.x, point.y, 7, C[6], 0.5 * k)
}

function drawBurst(painter: Painter, missile: Missile) {
  const q = missile.t - CHARGE - FLY
  if (q < 0 || q >= BURST) return
  const e = q / BURST
  if (e < 0.5) {
    flare(painter, missile.x1, missile.y1, 26 * Math.pow(1 - e * 2, 1.2) + 2, 1 - e * 2)
  }
  if (e < 0.12) {
    painter.circle(missile.x1, missile.y1, 6 * (1 - e / 0.12) + 1, WHITE)
  }
  painter.ring(
    missile.x1,
    missile.y1,
    4 + 20 * easeOutCubic(e),
    Math.max(1, 2.5 * (1 - e)),
    e < 0.3 ? C[6] : C[5],
    Math.min(1, (1 - e) * 1.5),
  )
  if (e < 0.4) {
    sparkle(painter, missile.x1, missile.y1, 7 * (1 - e / 0.4), C[6], C[4], 0.6 * (1 - e / 0.4))
  }
}

function drawParticles(painter: Painter, particles: Particle[], time: number) {
  for (const particle of particles) {
    if (particle.delay > 0) continue
    const k = particle.life / particle.max
    const speed = Math.hypot(particle.vx, particle.vy) || 1
    const ux = particle.vx / speed
    const uy = particle.vy / speed
    if (particle.kind === SPARK) {
      const head = k > 0.6 ? SPARK_COLORS[0] : k > 0.3 ? SPARK_COLORS[1] : SPARK_COLORS[2]
      const length = Math.min(9, 1 + speed * 0.022)
      painter.line(
        particle.x - ux * length,
        particle.y - uy * length,
        particle.x - ux * length * 0.4,
        particle.y - uy * length * 0.4,
        k > 0.5 ? head : SPARK_COLORS[SPARK_COLORS.length - 1],
      )
      painter.line(
        particle.x - ux * length * 0.45,
        particle.y - uy * length * 0.45,
        particle.x,
        particle.y,
        head,
      )
      painter.glow(particle.x, particle.y, 3, head, 0.45 * k)
      continue
    }
    if (particle.kind === MOTE) {
      const length = Math.min(16, 0.5 + speed * 0.026) * particle.size
      const alpha = k < 0.35 ? k / 0.35 : 1
      painter.line(
        particle.x - ux * length,
        particle.y - uy * length,
        particle.x - ux * length * 0.35,
        particle.y - uy * length * 0.35,
        scaleColor(particle.color, 0.55),
        alpha,
      )
      painter.line(
        particle.x - ux * length * 0.4,
        particle.y - uy * length * 0.4,
        particle.x,
        particle.y,
        particle.color,
        alpha,
      )
      painter.glow(particle.x, particle.y, 2.5 + particle.size, particle.color, 0.4 * k)
      continue
    }
    const twinkle = 0.6 + 0.4 * Math.sin(time * (8 + (particle.seed % 5)) + particle.seed)
    if (particle.size < 1) {
      if (twinkle * k > 0.25) {
        painter.px(particle.x, particle.y, twinkle > 0.8 ? WHITE : particle.color)
      }
      painter.glow(particle.x, particle.y, 3, particle.color, 0.4 * k * twinkle)
      continue
    }
    sparkle(
      painter,
      particle.x,
      particle.y,
      particle.size * twinkle * Math.min(1, k * 3),
      particle.color,
      scaleColor(particle.color, 0.75),
      0.5 * k * twinkle,
    )
  }
}

function drawLights(painter: Painter, lights: Light[]) {
  for (const light of lights) {
    const k = light.life / light.max
    painter.glow(light.x, light.y, light.radius * (0.55 + 0.45 * k), light.color, light.k * k * k)
  }
}

/** 星芒：四向长臂 + 斜向短臂，中心白点 */
function sparkle(painter: Painter, x: number, y: number, arm: number, color: Color, tip = color, k = 0.6) {
  const length = Math.round(arm)
  if (length < 1) return
  const px = Math.floor(x)
  const py = Math.floor(y)
  for (let d = 1; d <= length; d += 1) {
    const c = d > length * 0.6 ? tip : color
    for (const [dx, dy] of CROSS) painter.px(px + dx * d, py + dy * d, c)
  }
  if (length >= 3) {
    for (const [dx, dy] of DIAG) painter.px(px + dx, py + dy, color)
  }
  if (length >= 6) {
    for (const [dx, dy] of DIAG) painter.px(px + dx * 2, py + dy * 2, tip)
  }
  painter.px(px, py, WHITE)
  painter.glow(x, y, 4 + length * 2, color, k)
}

/** 8 向星芒，轴线长、斜线短，沿长度渐隐 */
function flare(painter: Painter, x: number, y: number, length: number, k: number) {
  if (length < 1) return
  for (let i = 0; i < 8; i += 1) {
    const angle = (i * Math.PI) / 4
    const rayLength = i % 4 === 0 ? length : i % 2 === 0 ? length * 0.6 : length * 0.3
    const cos = Math.cos(angle)
    const sin = Math.sin(angle)
    for (let d = 0; d <= rayLength; d += 0.5) {
      const u = d / rayLength
      const color = u < 0.35 ? WHITE : u < 0.7 ? C[6] : C[5]
      painter.dot(x + cos * d, y + sin * d, color, u < 0.6 ? 1 : k * 1.5 * (1 - u) + 0.2)
    }
  }
}

/** 颜色 + 光叠加成 RGBA 字节；transparent 背景只保留颜色自己的 alpha，光按加色补上 */
function composite(frame: Frame, out: Uint8ClampedArray) {
  const length = frame.w * frame.h
  for (let i = 0; i < length; i += 1) {
    const color = frame.color[i]
    const light = frame.light[i] & 0xffffff
    const alpha = color >>> 24
    let r: number
    let g: number
    let b: number
    let a: number
    if (alpha === 255) {
      r = color & 255
      g = (color >>> 8) & 255
      b = (color >>> 16) & 255
      a = 255
    } else {
      r = color & 255
      g = (color >>> 8) & 255
      b = (color >>> 16) & 255
      a = alpha
    }
    if (light) {
      const lr = (light & 255) * 1
      const lg = ((light >>> 8) & 255) * 1
      const lb = ((light >>> 16) & 255) * 1
      if (a < 255) {
        const pa = a / 255
        const pr = r * pa + lr
        const pg = g * pa + lg
        const pb = b * pa + lb
        const na = Math.min(1, Math.max(pa, Math.max(lr, lg, lb) / 255))
        if (na > 0) {
          r = Math.min(255, pr / na)
          g = Math.min(255, pg / na)
          b = Math.min(255, pb / na)
          a = na * 255
        }
      } else {
        r = Math.min(255, r + lr)
        g = Math.min(255, g + lg)
        b = Math.min(255, b + lb)
      }
    }
    const index = i * 4
    out[index] = r
    out[index + 1] = g
    out[index + 2] = b
    out[index + 3] = a
  }
}
