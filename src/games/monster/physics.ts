/**
 * 单词打怪兽的球体物理：只做「重力下落 + 圆与圆碰撞 + 落地 / 撞墙」，
 * 不碰 React、不碰接口，方便单独跑模拟检查抖动。
 *
 * 关键约定：落定的球会睡觉（resting），睡着以后完全不动，直到支撑它的球
 * 被消掉 / 被拖走，由 wakeUnsupported 从下往上唤醒。这样球堆稳定后
 * 不会每帧都被重力、碰撞反复推来推去。
 */

export type BallKind = 'word' | 'meaning'

export interface BallBody {
  id: string
  /** 同一个单词的英文球与中文球 group 相同，判定只看它 */
  group: number
  kind: BallKind
  text: string
  x: number
  y: number
  vx: number
  vy: number
  r: number
  /** 按文字长度反推出的字号，保证球里放得下完整单词 */
  fontSize: number
  /** 已经稳稳落定（睡着）：不受重力，也不会被别的球推动 */
  resting: boolean
  dragging: boolean
  /** 配错后到什么时候为止一直闪红 */
  wrongUntil: number
  /** 连续几帧「速度够低 + 支撑够稳」；内部状态，不参与渲染 */
  sleepFrames: number
  /** 上一帧结束时的位置：用来发现「被三颗球卡住、位置不动但速度不为 0」的死锁 */
  lastX: number
  lastY: number
}

export interface FieldSize {
  w: number
  h: number
}

/** 空中球每秒捡到的下落加速度；封顶在 fallSpeed */
const GRAVITY = 900
/** 每秒衰减掉多少水平速度：只做很轻的空气阻力，滚下斜坡主要靠重力 */
const AIR_DRAG = 0.8
/** 落地后的滚动摩擦：让球在地面上滚一小段就停，不会一直滑 */
const GROUND_DRAG = 4
/** 速度低于这个值、且支撑稳定，就开始累积睡眠帧 */
const SLEEP_SPEED = 26
/** 连续 8 帧满足条件才睡觉（约 0.13 秒），避免刚接触时误睡 */
const SLEEP_FRAMES = 8
/** 每帧解几遍球与球的穿插：多遍才能同时压住两个支撑之间的缝隙 */
const CONTACT_PASSES = 3
/**
 * 一帧位移小于这个值就算「没动」。卡在墙边 / 两颗球夹缝里的球常常还剩零点几像素的抖动，
 * 阈值定得太紧（曾经是 0.05）它会一直醒着，游戏就再也发不出新球了。
 * 1.2px/帧 约等于 72px/秒：真正下落的球一帧就是好几像素，不会误判。
 */
export const STILL_EPSILON = 1.2
/** 离地面多近算「已经落地」 */
const GROUND_SLOP = 1.5
/** 球与球之间留的接触容差 */
const TOUCH_SLOP = 2
/**
 * 骑在一颗球顶上时的侧向推力（px/s²）。这是重力在球面切向的分量：
 * 球心正好在支撑球正上方时切向分量为 0，那是理想平衡点，真实的小球会被任何微小扰动带下去，
 * 所以这里给一个和重力同量级的推力，让它顺着球面滚开，而不是叠成一根柱子。
 */
const ROLL_PUSH = 900

/** 球落地的速度：大约 2 秒穿过整块场地（原来 2.6 秒，落得更快一些） */
export function fallSpeed(height: number) {
  return Math.max(160, height / 2)
}

export interface SupportInfo {
  /** 支撑够稳，可以睡觉 */
  stable: boolean
  /** 有几颗睡着的球托着它 */
  count: number
  onGround: boolean
  /** 脚下最近的那颗球：单支撑时要顺着它的球面往外滚 */
  anchor: BallBody | null
  /** 贴着几颗睡着的球（不分上下）：骑在球顶又被旁边一颗卡住时，它其实滚不动了 */
  touchCount: number
}

/**
 * 这颗球现在被谁托着：
 * - 落地 = 稳；
 * - 两颗球夹成的凹槽 = 稳（真实的小球会停在这种坑里）；
 * - 只踩在一颗球的顶部不算稳：它会顺着圆面滚下去，不会叠成一根柱子。
 */
export function supportInfo(ball: BallBody, balls: BallBody[], height: number): SupportInfo {
  if (ball.y >= height - ball.r - GROUND_SLOP) {
    return { stable: true, count: 1, onGround: true, anchor: null, touchCount: 1 }
  }
  let count = 0
  let touchCount = 0
  let anchor: BallBody | null = null
  let nearest = Infinity
  for (const other of balls) {
    if (other === ball || other.dragging || !other.resting) continue
    const dx = ball.x - other.x
    const dy = ball.y - other.y
    const minD = ball.r + other.r
    const dist = Math.hypot(dx, dy)
    if (dist === 0 || dist > minD + TOUCH_SLOP) continue
    touchCount += 1
    const ny = dy / dist
    // ny >= 0：支撑在它头顶或侧面，托不住；只认在下面的
    if (ny > -0.2) continue
    count += 1
    if (dist < nearest) {
      nearest = dist
      anchor = other
    }
  }
  // 只有一颗球托着时不算稳：真实的小球会从球顶滚下去，不会叠成一根柱子。
  // 两颗球夹成的凹槽才让它睡觉（落地已经在上面单独处理）。
  return { stable: count >= 2, count, onGround: false, anchor, touchCount }
}

/**
 * 球堆里少了球（配对消掉 / 被拖走）以后，从下往上检查：
 * 失去稳定支撑的球重新醒来往下落，还踩得稳的球继续睡，不会整堆一起抖。
 */
export function wakeUnsupported(balls: BallBody[], height: number) {
  const sleeping = balls.filter(ball => ball.resting && !ball.dragging).sort((a, b) => b.y - a.y)
  for (const ball of sleeping) {
    if (ball.y >= height - ball.r - GROUND_SLOP) continue
    if (supportInfo(ball, balls, height).stable) continue
    ball.resting = false
    ball.sleepFrames = 0
  }
}

/** 一帧物理：先积分下落，再解碰撞，最后判定谁可以睡觉 */
export function stepPhysics(balls: BallBody[], size: FieldSize, dt: number) {
  const { w, h } = size
  if (!w || !h || dt <= 0) return
  const maxFall = fallSpeed(h)

  for (const ball of balls) {
    ball.lastX = ball.x
    ball.lastY = ball.y
    if (ball.dragging || ball.resting) continue
    ball.vy = Math.min(ball.vy + GRAVITY * dt, maxFall)
    ball.vx *= Math.max(0, 1 - AIR_DRAG * dt)
    ball.x += ball.vx * dt
    ball.y += ball.vy * dt
    clampToWalls(ball, w)
    landOnGround(ball, h, dt)
  }

  for (let pass = 0; pass < CONTACT_PASSES; pass += 1) {
    for (let i = 0; i < balls.length; i += 1) {
      const a = balls[i]
      if (a.resting || a.dragging) continue
      for (let j = 0; j < balls.length; j += 1) {
        if (i === j) continue
        const b = balls[j]
        if (b.dragging) continue
        separatePair(a, b)
      }
    }
  }

  for (const ball of balls) {
    if (ball.dragging || ball.resting) continue
    clampToWalls(ball, w)
    landOnGround(ball, h, dt)
    const speed = Math.hypot(ball.vx, ball.vy)
    const support = supportInfo(ball, balls, h)
    // 骑在一颗球顶上：重力沿球面的切向分量要去把它带向一侧；
    // 正好压在正上方时切向分量为 0，按它现在偏向哪边（都没偏就按场地左右半边）给个初始推力
    const atWall = ball.x <= ball.r + 0.5 || ball.x >= w - ball.r - 0.5
    const perched = support.count === 1 && !support.onGround && !atWall
    if (perched && support.anchor) {
      const dx = ball.x - support.anchor.x
      const dir = Math.abs(dx) > 0.75 ? Math.sign(dx) : ball.x < w / 2 ? -1 : 1
      ball.vx += dir * ROLL_PUSH * dt
    }
    const moved = Math.hypot(ball.x - ball.lastX, ball.y - ball.lastY)
    // 有的球会被墙 / 三颗球卡在缝里：位置基本不动，速度却被重力反复推出来（每帧抖零点几像素）。
    // 这种球按「已经落定」处理，否则它会永远醒着，发球也跟着卡住。
    const wedged = moved < STILL_EPSILON && touchingSomething(ball, balls, h)
    // 骑在一颗球顶上，但旁边还贴着一颗睡着的球：左右都被卡住，它其实滚不动，可以睡了
    const pinned = perched && support.touchCount >= 2
    // 单支撑的「骑在球顶上」不算落定：它还在往两边滚，这时候睡着就会叠成柱子
    if ((!perched || pinned) && ((speed < SLEEP_SPEED && support.stable) || wedged)) {
      ball.sleepFrames += 1
      if (ball.sleepFrames >= SLEEP_FRAMES) {
        ball.resting = true
        ball.vx = 0
        ball.vy = 0
      }
    } else {
      ball.sleepFrames = 0
    }
  }
}

/** 球是不是正贴着地面或另一颗球（不含正在被拖的那颗） */
function touchingSomething(ball: BallBody, balls: BallBody[], height: number) {
  if (ball.y >= height - ball.r - GROUND_SLOP) return true
  return balls.some(other => {
    if (other === ball || other.dragging) return false
    return Math.hypot(other.x - ball.x, other.y - ball.y) <= ball.r + other.r + TOUCH_SLOP
  })
}

function clampToWalls(ball: BallBody, width: number) {
  if (ball.x < ball.r) {
    ball.x = ball.r
    if (ball.vx < 0) ball.vx = 0
  } else if (ball.x > width - ball.r) {
    ball.x = width - ball.r
    if (ball.vx > 0) ball.vx = 0
  }
}

function landOnGround(ball: BallBody, height: number, dt: number) {
  if (ball.y < height - ball.r) return
  ball.y = height - ball.r
  if (ball.vy > 0) ball.vy = 0
  ball.vx *= Math.max(0, 1 - GROUND_DRAG * dt)
}

/**
 * 把两颗叠在一起的球沿圆心连线推开，并吃掉互相靠近的法向速度。
 * 停住的球不挪位置（只推运动中的那颗），这样已经码好的球堆不会散架；
 * 法向速度归零后剩下的切向速度，就是球顺着圆面滚下去的力。
 */
function separatePair(a: BallBody, b: BallBody) {
  const dx = a.x - b.x
  const dy = a.y - b.y
  const minD = a.r + b.r
  const distanceSq = dx * dx + dy * dy
  if (distanceSq >= minD * minD) return

  const distance = Math.sqrt(distanceSq)
  const nx = distance === 0 ? 0 : dx / distance
  const ny = distance === 0 ? -1 : dy / distance
  const overlap = minD - distance

  if (b.resting) {
    a.x += nx * overlap
    a.y += ny * overlap
  } else if (a.resting) {
    b.x -= nx * overlap
    b.y -= ny * overlap
  } else {
    a.x += nx * overlap * 0.5
    a.y += ny * overlap * 0.5
    b.x -= nx * overlap * 0.5
    b.y -= ny * overlap * 0.5
  }

  const relativeX = a.vx - b.vx
  const relativeY = a.vy - b.vy
  const normalSpeed = relativeX * nx + relativeY * ny
  if (normalSpeed >= 0) return
  if (b.resting) {
    a.vx -= normalSpeed * nx
    a.vy -= normalSpeed * ny
  } else {
    a.vx -= normalSpeed * nx * 0.5
    a.vy -= normalSpeed * ny * 0.5
    b.vx += normalSpeed * nx * 0.5
    b.vy += normalSpeed * ny * 0.5
  }
}
