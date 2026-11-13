import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'
import { shuffleWords } from '../data'
import type { GameProps, GameWord } from '../types'
import { STILL_EPSILON, fallSpeed, stepPhysics, wakeUnsupported } from './physics'
import type { BallBody, BallKind } from './physics'
import { MagicMissileFx } from './magicMissile'
import monster1Url from './images/monster1.png'
import monster2Url from './images/monster2.png'
import monster3Url from './images/monster3.png'
import monster4Url from './images/monster4.png'
import monster5Url from './images/monster5.png'
import monster6Url from './images/monster6.png'
import monster7Url from './images/monster7-cutout.png'
import hitUrl from './images/hit-fx.png'
import bubbleUrl from './images/bubble.png'
import './monster.css'
/** 平时每配对一次扣 100 血 */
const HIT_DAMAGE = 100
/** 每凑够 5 次成功配对，这一下伤害翻倍成 200 */
const HARD_HIT_EVERY = 5
const HARD_HIT_DAMAGE = 200
/** 受击整套反馈持续多久（毫秒）：身体抖动 + 痛苦表情 + 红白闪光 */
const HIT_FEEDBACK_MS = 420
/** 痛苦表情比闪光多留一会儿，免得一帧都看不清 */
const HIT_FACE_MS = 480
/** 每隔多久扔一个球（秒）；球堆越高小怪兽扔得越慢 */
const SPAWN_EVERY = 0.65
/** 上一颗球赖着不落定时最多再等多久（秒），到点就照常发下一颗，避免整局卡死 */
const STUCK_WAIT = 3
/** 开局先往底部铺 5 个单词（每个词两张球：英文 + 中文），一进来就有东西可以配对 */
const START_WORDS = 5
/** 开局铺底时球与球之间不留缝：泡泡本身已经比碰撞圆大一点，再留缝就散了 */
const START_GAP = 0
/** 开局铺底最多抬高多少像素再落下：有个「落到底部」的过程，但不用等太久 */
const START_DROP = 160
/** 怪兽状态：精灵图从左到右四格，满血 / 受击 / 残血 / 战败 */
const MOOD_IDLE = 0
const MOOD_HIT = 1
const MOOD_WEAK = 2
const MOOD_DEFEATED = 3
const MOOD_LABELS = ['满血待机', '受击痛苦', '残血虚弱', '最后关头']
/** 场上只剩最后这么多个单词时，切到精灵图的最后一个状态 */
const FINAL_PAIRS = 3
/** 怪兽本体上沿落在场地多少像素处（血条下方一点） */
const ART_TOP = 26
/** 顶部怪兽带占场地高度的比例：iPad / 桌面跟着场地一起缩放 */
const MONSTER_BAND_RATIO = 0.25
/** 手机横屏场地太矮时怪兽带的保底高度，再小就看不清了 */
const MONSTER_BAND_MIN = 110
/** 暂停发球时，球堆顶再往上要留出的余量（除了下一颗球自己的直径） */
const PILE_GAP = 8
/** 配错时两张球闪红的时长（毫秒） */
const WRONG_MS = 380

type Status = 'idle' | 'playing' | 'won'
type Ball = BallBody

interface Token {
  group: number
  kind: BallKind
  text: string
}

/** 开局铺底用的一颗球：token 是内容，r 是按场地算出来的半径 */
interface OpeningBall {
  token: Token
  r: number
}

interface Pop {
  id: number
  x: number
  y: number
  bornAt: number
}

interface DragState {
  id: string
  offsetX: number
  offsetY: number
  left: number
  top: number
}

/** 一张怪兽精灵图的规格：横排若干格状态图，本体在格内上下方向有留白 */
interface MonsterSheet {
  url: string
  sheetW: number
  sheetH: number
  /** 四格状态共用的本体竖直带（源图像素）：渲染时只保留这段，裁掉格内上下空白 */
  artTopY: number
  artBottomY: number
  /** 各状态帧在源图里的横向范围（像素），从左到右对应 MOOD_* 四种状态 */
  frames: { fromX: number; toX: number }[]
}

/**
 * 怪兽图库：按列表顺序轮流出场（刷新页面 / 再玩一次都换下一只）。加新图只要往这儿加一条，
 * 按源图像素量好四帧本体的横向范围（fromX / toX）与共用的竖直带即可。
 * monster1.png 的四格并不等宽，逐帧量范围才不会把下一格的脚带进来。
 * monster2–7 都是 2608×912 的 2x 图，但每只的作画位置 / 体型不一样，
 * 套用同一组帧范围会裁掉耳朵或脚，所以每张都按透明像素单独量过。
 * 底部 746–878 那条是图上的 AI 水印，不属于本体，竖直带一律避开。
 * monster7 用的是抠掉白色棋盘底后的 images/monster7-cutout.png。
 */
const MONSTER_SHEETS: MonsterSheet[] = [
  {
    url: monster1Url,
    sheetW: 1774,
    sheetH: 887,
    artTopY: 218,
    artBottomY: 682,
    frames: [
      { fromX: 28, toX: 399 },
      { fromX: 426, toX: 828 },
      { fromX: 859, toX: 1298 },
      { fromX: 1301, toX: 1759 },
    ],
  },
  {
    url: monster2Url,
    sheetW: 2608,
    sheetH: 912,
    artTopY: 78,
    artBottomY: 614,
    frames: [
      { fromX: 33, toX: 669 },
      { fromX: 697, toX: 1278 },
      { fromX: 1337, toX: 1860 },
      { fromX: 1894, toX: 2575 },
    ],
  },
  {
    url: monster3Url,
    sheetW: 2608,
    sheetH: 912,
    artTopY: 37,
    artBottomY: 661,
    frames: [
      { fromX: 34, toX: 575 },
      { fromX: 659, toX: 1270 },
      { fromX: 1354, toX: 1867 },
      { fromX: 1953, toX: 2587 },
    ],
  },
  {
    url: monster4Url,
    sheetW: 2608,
    sheetH: 912,
    artTopY: 20,
    artBottomY: 623,
    frames: [
      { fromX: 13, toX: 623 },
      { fromX: 691, toX: 1276 },
      { fromX: 1346, toX: 1917 },
      { fromX: 1978, toX: 2587 },
    ],
  },
  {
    url: monster5Url,
    sheetW: 2608,
    sheetH: 912,
    artTopY: 117,
    artBottomY: 633,
    frames: [
      { fromX: 27, toX: 625 },
      { fromX: 707, toX: 1272 },
      { fromX: 1349, toX: 1849 },
      { fromX: 1916, toX: 2576 },
    ],
  },
  {
    url: monster6Url,
    sheetW: 2608,
    sheetH: 912,
    artTopY: 48,
    artBottomY: 602,
    frames: [
      { fromX: 44, toX: 587 },
      { fromX: 712, toX: 1224 },
      { fromX: 1358, toX: 1921 },
      { fromX: 1983, toX: 2580 },
    ],
  },
  {
    url: monster7Url,
    sheetW: 2608,
    sheetH: 912,
    artTopY: 54,
    artBottomY: 600,
    frames: [
      { fromX: 78, toX: 612 },
      { fromX: 704, toX: 1265 },
      { fromX: 1369, toX: 1882 },
      { fromX: 1989, toX: 2574 },
    ],
  },
]

/** 一局的数据全放 ref 里：动画每帧直接改它，再靠 setFrame 触发重绘，避免每帧都造新数组 */
interface World {
  hp: number
  /** 本局满血血量：血条百分比与残血判定都按它算 */
  hpMax: number
  /** 成功配对的累计次数：每凑够 5 次，这一下扣血翻倍成 200 */
  matchCount: number
  score: number
  combo: number
  mistakes: number
  spawnTimer: number
  balls: Ball[]
  deck: Token[]
  deckIndex: number
  /** 小怪兽受击的时间点，用来抖一下 */
  hitAt: number
}

/**
 * 一局的总伤害（也就是总血量）：每配对一次扣 100，每凑够 5 次那一下翻倍成 200。
 * 血量按它算，最后一个词配对完的那一刻正好见底 → 这一局结束。
 */
function totalDamageFor(wordCount: number) {
  const hardHits = Math.floor(wordCount / HARD_HIT_EVERY)
  return HIT_DAMAGE * wordCount + (HARD_HIT_DAMAGE - HIT_DAMAGE) * hardHits
}

/** 一局的数据：血量由词表里的单词数算出来（见 totalDamageFor） */
function emptyWorld(hpMax = 0): World {
  return {
    hp: hpMax,
    hpMax,
    matchCount: 0,
    score: 0,
    combo: 0,
    mistakes: 0,
    spawnTimer: SPAWN_EVERY,
    balls: [],
    deck: [],
    deckIndex: 0,
    hitAt: 0,
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

/** 顶部怪兽带：随场地高度缩放，手机横屏保底 110px；本体下沿就在这个高度 */
function monsterBandFor(height: number) {
  return Math.max(MONSTER_BAND_MIN, Math.round(height * MONSTER_BAND_RATIO))
}

/** 怪兽本体高度：怪兽带减去血条和头顶留白 */
function monsterFaceFor(height: number) {
  const band = monsterBandFor(height)
  return { band, faceH: band - ART_TOP }
}

/**
 * 怪兽轮换：不再纯随机——按列表顺序一只轮一只，
 * 刷新页面进来换下一只，点「再玩一次」也换下一只，
 * 开始页预览的那只就是等会儿要打的，不会进了游戏变脸。
 */
const MONSTER_TURN_KEY = 'es-monster-turn'
/** 当次页面加载里缓存轮到哪只，防止重复前进 */
let turnIndexCache: number | null = null

function readStoredTurn(): number {
  if (turnIndexCache !== null) return turnIndexCache
  const stored = Number(localStorage.getItem(MONSTER_TURN_KEY))
  return Number.isFinite(stored) && stored >= 0 ? stored : -1
}

/** 写入本轮轮次并返回它，顺带带回索引，省得外面再判一次 null */
function writeStoredTurn(index: number): number {
  turnIndexCache = index
  try {
    localStorage.setItem(MONSTER_TURN_KEY, String(index))
  } catch {
    // 无痕 / 隐私模式存不进：本轮内照常轮换，下次进来从第一只重新数
  }
  return index
}

/** 本轮该出哪只怪兽：每次进页面（含刷新）前进一格 */
function currentMonsterSheet(): MonsterSheet {
  if (turnIndexCache === null) {
    return MONSTER_SHEETS[writeStoredTurn((readStoredTurn() + 1) % MONSTER_SHEETS.length)]
  }
  return MONSTER_SHEETS[turnIndexCache]
}

/** 重新开局时前进一格：连着玩也会换下一只，不会盯着同一只打 */
function nextMonsterSheet(): MonsterSheet {
  return MONSTER_SHEETS[writeStoredTurn((readStoredTurn() + 1) % MONSTER_SHEETS.length)]
}

/**
 * 怪兽当前显示哪一格状态：受击压过其它，其次看还剩几个单词。
 * 打到它 → 痛苦；还剩最后 3 个词（以及血量见底）→ 第 4 格那个最后状态；
 * 其它时候按血量走满血 / 残血。
 */
function monsterMood(hp: number, hpMax: number, hitAt: number, now: number, pairsLeft: number) {
  if (hp <= 0) return MOOD_DEFEATED
  if (hitAt > 0 && now - hitAt < HIT_FACE_MS) return MOOD_HIT
  if (pairsLeft <= FINAL_PAIRS) return MOOD_DEFEATED
  if (hp <= hpMax * 0.4) return MOOD_WEAK
  return MOOD_IDLE
}

/**
 * 这副「球」怎么发：每个单词拆成英文球 + 中文球，同一对挨着发，
 * 保证两个球会同时在场上，不会出现搭档还没出来就先落地的情况。
 */
function buildDeck(words: GameWord[]): Token[] {
  return shuffleWords(words.map((word, index) => ({ word, index }))).flatMap(({ word, index }) => {
    const pair: Token[] = [
      { group: index, kind: 'word', text: word.word },
      { group: index, kind: 'meaning', text: word.translation },
    ]
    return Math.random() < 0.5 ? pair : [pair[1], pair[0]]
  })
}

/**
 * 球的大小跟着场地走：单词球按 13px 单行反推半径，保证整个单词一行放得下；
 * 中文球按字数略微加码，两三行之内装得下释义。
 */
function ballRadiusFor(text: string, kind: BallKind, width: number, height: number) {
  const base = Math.round(Math.min(width / 8.5, height / 6.5))
  const chars = [...text].length
  if (kind === 'word') {
    const need = Math.ceil((chars * 13 * 0.62) / 1.56) + 7
    return clamp(Math.max(base, need), 38, 64)
  }
  const extra = Math.min(12, Math.max(0, chars - 8) * 0.8)
  return clamp(base + extra, 38, 64)
}

/** 反推字号：单词球固定单行，太长的词按球内宽度缩一点也绝不折行；中文球最多三行 */
function fitFontSize(text: string, kind: BallKind, r: number) {
  const chars = [...text].length
  const innerWidth = 1.62 * r - 12
  if (kind === 'word') {
    return clamp(Math.min(13, (innerWidth / (chars * 0.62)) * 0.94), 11, 13)
  }
  const lines = chars <= 6 ? 1 : chars <= 14 ? 2 : 3
  const perLine = Math.ceil(chars / lines)
  const byWidth = (innerWidth / perLine) * 0.94
  const byHeight = (1.6 * r) / (lines * 1.18)
  return clamp(Math.min(byWidth, byHeight), 12, r * 0.56)
}

/**
 * 小球贴图：images/bubble.png 是 1536×1536 的精灵图，4 列 3 行共 12 只泡泡。
 * 图上的泡泡并不压在等分的格子里（横向间距 ~375、纵向 ~421，直径 ~342），
 * 所以按测好的圆心逐个定位，而不是按 4×3 平均切；这样泡泡的边缘正好落在碰撞圆上。
 * 每只泡泡的直径都在 336–349 之间，统一按 BUBBLE_DIAMETER 缩放，误差不到 2%。
 */
const BUBBLE_SHEET_SIZE = 1536
const BUBBLE_DIAMETER = 342
/**
 * 泡泡再放大一点画：贴图边缘有一圈很淡的玻璃描边，按碰撞圆 1:1 画时两颗球落在
 * 一起看着还有缝。放大 8% 让相邻泡泡边缘真的叠上一点，球堆才显得贴紧。
 */
const BUBBLE_ZOOM = 1.08
const BUBBLE_CENTERS: { cx: number; cy: number }[] = [
  { cx: 208, cy: 338 },
  { cx: 582, cy: 336 },
  { cx: 956, cy: 337 },
  { cx: 1332, cy: 334 },
  { cx: 206, cy: 761 },
  { cx: 582, cy: 760 },
  { cx: 957, cy: 759 },
  { cx: 1334, cy: 754 },
  { cx: 208, cy: 1183 },
  { cx: 584, cy: 1184 },
  { cx: 958, cy: 1182 },
  { cx: 1334, cy: 1183 },
]

/** 同一对球（英文 / 中文）错开半张图取泡泡，颜色一眼就能分开 */
function bubbleCellFor(group: number, kind: BallKind) {
  return (group + (kind === 'meaning' ? 6 : 0)) % BUBBLE_CENTERS.length
}

/**
 * 把某一只泡泡放大到正好铺满球（球盒 = 碰撞圆），再把它挪到盒中心。
 * 背景按百分比定位：p = 目标偏移 / (盒宽 - 图宽)，换算成 CSS 的 background-position 百分比。
 */
function bubbleBackdrop(cell: number): CSSProperties {
  const { cx, cy } = BUBBLE_CENTERS[cell] ?? BUBBLE_CENTERS[0]
  // 泡泡画多大：碰撞圆直径 × BUBBLE_ZOOM
  const artDiameter = BUBBLE_DIAMETER / BUBBLE_ZOOM
  const sheetScale = BUBBLE_SHEET_SIZE / artDiameter
  const percent = (center: number) =>
    (((0.5 - center / artDiameter) / (1 - sheetScale)) * 100).toFixed(2) + '%'
  return {
    backgroundImage: 'url(' + bubbleUrl + ')',
    backgroundSize: sheetScale * 100 + '% ' + sheetScale * 100 + '%',
    backgroundPosition: percent(cx) + ' ' + percent(cy),
    backgroundRepeat: 'no-repeat',
  }
}

/**
 * 单词打怪兽。单词全部来自 props（当期背词任务），游戏自己管投放、拖拽、
 * 配对判定和血量，不碰任何接口。
 */
export function MonsterGame({ words }: GameProps) {
  // 只在每帧推进后 +1，用来重绘；真正的数据在 worldRef 里
  const [, setFrame] = useState(0)
  const [status, setStatus] = useState<Status>('idle')
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [monsterSheet, setMonsterSheet] = useState(() => currentMonsterSheet())

  const fieldRef = useRef<HTMLDivElement | null>(null)
  const fxCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const fxRef = useRef<MagicMissileFx | null>(null)
  if (fxRef.current === null) fxRef.current = new MagicMissileFx()
  const sizeRef = useRef({ w: 0, h: 0 })
  const wordsRef = useRef(words)
  const worldRef = useRef<World>(emptyWorld())
  const dragRef = useRef<DragState | null>(null)
  const popsRef = useRef<Pop[]>([])
  const seqRef = useRef(0)

  function addPop(x: number, y: number) {
    seqRef.current += 1
    popsRef.current.push({ id: seqRef.current, x, y, bornAt: performance.now() })
  }

  /**
   * 怪兽扣血时在它胸前飘出红色伤害数字：直接建 DOM、播完自己删，不进 React 状态，
   * 游戏每帧重绘时也就不会多带一堆一次性文字节点。
   */
  function floatDamage(amount: number, y: number) {
    const field = fieldRef.current
    if (!field) return
    const el = document.createElement('span')
    el.className = 'mst__dmg'
    el.textContent = '-' + amount
    el.style.left = field.clientWidth / 2 + (Math.random() - 0.5) * 64 + 'px'
    // 飘字从命中点（怪兽胸前）升起，不再写死一个 top
    el.style.top = y + 'px'
    field.appendChild(el)
    const remove = () => el.remove()
    el.addEventListener('animationend', remove, { once: true })
    // 兜底：动画被打断或系统没触发 animationend（比如 reduced-motion），到点也得清掉
    window.setTimeout(remove, 1200)
  }

  /** 飞弹的落点：小怪兽胸前 */
  function monsterHitPoint() {
    const { faceH } = monsterFaceFor(sizeRef.current.h)
    return { x: sizeRef.current.w / 2, y: ART_TOP + faceH * 0.45 }
  }

  /**
   * 飞弹命中后才真正扣血：抖动、爆点、伤害数字都在这一刻出现。
   * 血量正好等于本局全部单词配对完的总伤害，所以最后一个词配对完的那一刻血量见底，
   * 这一局就结束了——牌堆不会补新词，整局不会出现重复的单词。
   */
  function applyHit(x: number, y: number, damage: number) {
    const world = worldRef.current
    if (world.hp <= 0) return
    world.hp = Math.max(0, world.hp - damage)
    world.hitAt = performance.now()
    addPop(x, y)
    floatDamage(damage, y)
    if (world.hp <= 0) {
      // 打败了：马上收掉还在场上的飞弹、命中爆点和伤害飘字，
      // 否则动画循环随 playing 停下，最后一下的攻击特效会一直停在胜利画面上
      fxRef.current?.reset()
      popsRef.current = []
      fieldRef.current?.querySelectorAll('.mst__dmg').forEach(el => el.remove())
      setStatus('won')
    }
  }

  function prefersReducedMotion() {
    return Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)
  }

  function resetWorld() {
    // 血量 = 这一局所有单词配对完的总伤害：单词用完的那一刻正好打倒小怪兽
    const world = emptyWorld(totalDamageFor(wordsRef.current.length))
    // 整局只有这一副牌：每个词一对球，发完不再补，不会重复出词
    world.deck = buildDeck(wordsRef.current)
    worldRef.current = world
    popsRef.current = []
    dragRef.current = null
    fxRef.current?.reset()
    // 上一局残留的伤害飘字一并清掉
    fieldRef.current?.querySelectorAll('.mst__dmg').forEach(el => el.remove())
  }

  /** 从牌堆里看一眼下一个球（还没消费）；牌堆是有限的，发完返回 null，不再补词 */
  function peekToken(): Token | null {
    const world = worldRef.current
    return world.deck[world.deckIndex] ?? null
  }

  /** 这个位置能不能放下一颗半径 r 的新球（别一出生就嵌在球堆里） */
  function spawnSpotFree(x: number, y: number, r: number) {
    return worldRef.current.balls.every(ball =>
      ball.dragging || Math.hypot(ball.x - x, ball.y - y) >= ball.r + r + 3)
  }

  /**
   * 找一个能放下新球的落点：优先用 preferredX（补发搭档时用），
   * 否则在小怪兽下方随机试几次。找不到 = 现在的球堆连下球的位置都没有了。
   */
  function findSpawnX(r: number, preferredX?: number) {
    const { w, h } = sizeRef.current
    if (!w || !h) return null
    const y = monsterBandFor(h) + r + 6
    if (preferredX != null) {
      const x = clamp(preferredX, r, Math.max(r, w - r))
      if (spawnSpotFree(x, y, r)) return x
    }
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const x = clamp(w / 2 + (Math.random() - 0.5) * Math.min(w * 0.44, 210), r, Math.max(r, w - r))
      if (spawnSpotFree(x, y, r)) return x
    }
    return null
  }

  /**
   * 发一颗球。找不到落点时返回 false，调用方下一帧再试：
   * 球堆满了就暂停发球，等清出空间继续，不结束游戏。
   */
  function spawnBall(preferredX?: number, force = false) {
    const world = worldRef.current
    const { w, h } = sizeRef.current
    if (!w || !h) return false
    const band = monsterBandFor(h)
    const token = peekToken()
    if (!token) return false
    const r = ballRadiusFor(token.text, token.kind, w, h)
    const x = force
      ? clamp(preferredX ?? w / 2, r, Math.max(r, w - r))
      : findSpawnX(r, preferredX)
    if (x == null) return false
    world.deckIndex += 1
    seqRef.current += 1
    world.balls.push({
      id: 'ball-' + seqRef.current,
      group: token.group,
      kind: token.kind,
      text: token.text,
      x,
      // 整颗球从小怪兽下边冒出来，不压到它
      y: band + r + 6,
      vx: (Math.random() - 0.5) * 60,
      vy: fallSpeed(h) * (0.92 + Math.random() * 0.2),
      r,
      resting: false,
      fontSize: fitFontSize(token.text, token.kind, r),
      dragging: false,
      wrongUntil: 0,
      sleepFrames: 0,
      lastX: x,
      lastY: band + r + 6,
    })
    return true
  }

  /**
   * 开局先把 5 个单词（每个词两张球）铺到底部：从牌堆里取前 5 对，
   * 打乱后按行码在场地底部，再整体抬高一点让它们落下来。
   * 这样一进游戏就有东西可以配对，不用先等一颗一颗慢慢掉。
   */
  function dropOpeningWords() {
    const world = worldRef.current
    const { w, h } = sizeRef.current
    if (!w || !h) return
    const pairCount = Math.min(START_WORDS, wordsRef.current.length)
    if (pairCount <= 0) return

    // buildDeck 保证每个词的两张球挨着，取 2×N 张正好 N 对；再打乱，别让开局左右相邻
    const tokens: Token[] = []
    for (let i = 0; i < pairCount * 2; i += 1) {
      const token = peekToken()
      if (!token) break
      tokens.push(token)
      world.deckIndex += 1
    }
    const seeds: OpeningBall[] = shuffleWords(tokens).map(token => ({
      token,
      r: ballRadiusFor(token.text, token.kind, w, h),
    }))

    // 从下往上按行码放：这一行放得下就接着放，放不下换一行
    const rows: OpeningBall[][] = []
    let row: OpeningBall[] = []
    let rowWidth = 0
    for (const seed of seeds) {
      const need = seed.r * 2 + (row.length > 0 ? START_GAP : 0)
      if (row.length > 0 && rowWidth + need > w) {
        rows.push(row)
        row = []
        rowWidth = 0
      }
      row.push(seed)
      rowWidth += need
    }
    if (row.length > 0) rows.push(row)

    // 先算出贴地时的落点：底行贴地，上面的行架在下一行顶部
    const placed: { seed: OpeningBall; x: number; y: number }[] = []
    let floor = h
    rows.forEach((currentRow, rowIndex) => {
      const rowHeight = Math.max(...currentRow.map(seed => seed.r * 2))
      const rowTotal = currentRow.reduce((sum, seed) => sum + seed.r * 2, 0)
        + START_GAP * (currentRow.length - 1)
      // 单数行错开半颗球，正好卡进下一行的凹槽里，落下来就是稳的
      const stagger = rowIndex % 2 === 1 ? (currentRow[0]?.r ?? 0) : 0
      let cursor = Math.min(
        Math.max(0, w - rowTotal),
        Math.max(0, (w - rowTotal) / 2 + stagger),
      )
      for (const seed of currentRow) {
        placed.push({ seed, x: cursor + seed.r, y: floor - seed.r })
        cursor += seed.r * 2 + START_GAP
      }
      floor -= rowHeight + START_GAP
    })

    // 整堆抬高一点再落：抬高量不能把最上面一行顶进小怪兽身体里
    const band = monsterBandFor(h)
    const lift = clamp(floor - band - 8, 0, START_DROP)
    for (const item of placed) {
      // 每颗球单独限制抬升量：既不入侵小怪兽，也不会被反向推到比落点更低
      const ballLift = Math.min(lift, Math.max(0, item.y - item.seed.r - band))
      const startY = item.y - ballLift
      seqRef.current += 1
      world.balls.push({
        id: 'ball-' + seqRef.current,
        group: item.seed.token.group,
        kind: item.seed.token.kind,
        text: item.seed.token.text,
        x: item.x,
        y: startY,
        vx: 0,
        // 从静止开始落，重力会把它加速到底；比直接给终端速度更像「掉下来」
        vy: 0,
        r: item.seed.r,
        resting: false,
        fontSize: fitFontSize(item.seed.token.text, item.seed.token.kind, item.seed.r),
        dragging: false,
        wrongUntil: 0,
        sleepFrames: 0,
        lastX: item.x,
        lastY: startY,
      })
    }
    world.spawnTimer = 0
  }

  /**
   * 球堆顶到小怪兽、暂停扔球时的唯一例外：场上某颗球找不到同组搭档（搭档还在牌堆里），
   * 就把搭档换到牌堆下一位发出来——不然这颗球永远消不掉，堆永远空不下来。
   * 这时候允许硬塞：实在找不到空位就贴着单张球发，物理会把重叠挤开。
   */
  function spawnStrandedPartner() {
    const world = worldRef.current
    const stranded = world.balls.find(ball =>
      !world.balls.some(other => other !== ball && other.group === ball.group))
    if (!stranded) return
    // 搭档一定还在牌堆里：同组的另一张要么在场上（那就不算单张了），要么还没发；
    // 牌堆发完就不再补词，找不到搭档直接返回（这一局不会再有新词）
    const partnerIndex = world.deck.findIndex(token =>
      token.group === stranded.group && token.kind !== stranded.kind)
    if (partnerIndex < 0) return
    if (partnerIndex > world.deckIndex) {
      const ahead = world.deck[world.deckIndex]
      world.deck[world.deckIndex] = world.deck[partnerIndex]
      world.deck[partnerIndex] = ahead
    }
    world.spawnTimer = 0
    spawnBall(stranded.x, true)
  }

  /** 一步动画：扔新球、推进物理、清理命中特效 */
  function stepWorld(dt: number) {
    const world = worldRef.current
    const { w, h } = sizeRef.current
    if (!w || !h) return
    const band = monsterBandFor(h)

    world.spawnTimer += dt

    // 球堆越高小怪兽扔得越慢，给孩子留出清场的时间
    const resting = world.balls.filter(ball => ball.resting)
    const pileTop = resting.length > 0
      ? Math.min(...resting.map(ball => ball.y - ball.r))
      : h
    const pressure = clamp(1 - (pileTop - band) / Math.max(1, h - band), 0, 1)
    const spawnEvery = SPAWN_EVERY * (1 + pressure * 1.6)
    // 上一颗球还没落定（含正被拖走的那颗）就不发新的：小球一个一个下落，全部落完才发下一个。
    // 这里看「这一帧的真实位移」而不是 resting 标记：偶尔有球卡在墙边 / 夹缝里一直不肯睡，
    // 只看 resting 的话它会永远算作「还在空中」，从此一颗球都不再发。
    const moving = world.balls.filter(ball =>
      ball.dragging ||
      (!ball.resting && Math.hypot(ball.x - ball.lastX, ball.y - ball.lastY) > STILL_EPSILON),
    ).length
    // 再发一颗就会叠到小怪兽身上时暂停：留出它的整个直径，等孩子清出空间再继续，不判输
    const next = peekToken()
    const nextRadius = next ? ballRadiusFor(next.text, next.kind, w, h) : 0
    const pileFull = resting.length > 0 && pileTop < band + nextRadius * 2 + PILE_GAP
    // 等太久说明有球赖在场上迟迟不落定：别再等了，照常发下一颗（不做这层兜底就可能永久停发）
    const waitedTooLong = world.spawnTimer > STUCK_WAIT
    if ((moving === 0 || waitedTooLong) && world.spawnTimer >= spawnEvery && next) {
      if (pileFull) {
        // 暂停时只有一种情况照发：场上有单张球，得补发它的搭档，不然卡死
        spawnStrandedPartner()
      } else if (spawnBall()) {
        world.spawnTimer = 0
      }
    }

    // 重力、落地、球与球的碰撞、睡觉判定都在 physics 里，组件只管发球和配对
    stepPhysics(world.balls, sizeRef.current, dt)

    // 飞弹按自己的时间轴推进，命中那一帧才把伤害交给游戏结算
    const fx = fxRef.current
    if (fx) {
      for (const impact of fx.update(dt)) {
        applyHit(impact.x, impact.y, impact.damage)
      }
      fx.render()
    }

    const now = performance.now()
    if (popsRef.current.length > 0) {
      popsRef.current = popsRef.current.filter(pop => now - pop.bornAt < 620)
    }
  }

  /** 抽走一颗球（配对成功 / 被拾起 / 配错弹开）后，让失去支撑的球重新落下来 */
  function wakeStack() {
    wakeUnsupported(worldRef.current.balls, sizeRef.current.h)
  }

  // 场地尺寸：手机旋转、窗口变化都跟着更新
  useEffect(() => {
    const field = fieldRef.current
    if (!field) return
    const update = () => {
      // clientWidth / clientHeight 是绝对定位子元素的坐标空间，也不受外层 transform 影响
      const w = field.clientWidth
      const h = field.clientHeight
      sizeRef.current = { w, h }
      setSize({ w, h })
      const canvas = fxCanvasRef.current
      const fx = fxRef.current
      if (canvas && fx) {
        fx.attach(canvas)
        fx.resize(w, h)
      }
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(field)
    return () => observer.disconnect()
  }, [])

  // 换一批单词（正常只会发生一次）就重开一局
  useEffect(() => {
    wordsRef.current = words
    resetWorld()
    setStatus('idle')
  }, [words])

  // 主循环：只有 playing 时才跑
  useEffect(() => {
    if (status !== 'playing') return
    let raf = 0
    let last = performance.now()
    const loop = (now: number) => {
      const dt = clamp((now - last) / 1000, 0, 0.05)
      last = now
      stepWorld(dt)
      setFrame(value => value + 1)
      raf = window.requestAnimationFrame(loop)
    }
    raf = window.requestAnimationFrame(loop)
    return () => window.cancelAnimationFrame(raf)
  }, [status])

  /** rotate=false：用开始页预览的那只开打；rotate=true（再玩一次）：换下一只 */
  function start(rotate: boolean) {
    resetWorld()
    dropOpeningWords()
    if (rotate) setMonsterSheet(nextMonsterSheet())
    setStatus('playing')
  }

  /** 手指 / 鼠标下面压着的那颗球（按中心距离取最近的一颗） */
  function findTarget(ball: Ball): Ball | null {
    let best: Ball | null = null
    let bestDistance = Infinity
    for (const other of worldRef.current.balls) {
      if (other === ball) continue
      const distance = Math.hypot(other.x - ball.x, other.y - ball.y)
      if (distance > (ball.r + other.r) * 0.82) continue
      if (distance < bestDistance) {
        bestDistance = distance
        best = other
      }
    }
    return best
  }

  function pickUp(event: ReactPointerEvent<HTMLButtonElement>, ball: Ball) {
    if (status !== 'playing' || dragRef.current) return
    const field = fieldRef.current
    if (!field) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    const rect = field.getBoundingClientRect()
    dragRef.current = {
      id: ball.id,
      // 保持抓取点与球心的相对位置，球不会在手指按下的瞬间跳到手心里
      offsetX: ball.x - (event.clientX - rect.left),
      offsetY: ball.y - (event.clientY - rect.top),
      left: rect.left,
      top: rect.top,
    }
    ball.dragging = true
    ball.resting = false
    ball.sleepFrames = 0
    ball.vx = 0
    ball.vy = 0
    // 从球堆里抽走一颗，压在上面的球失去支撑，要重新落
    wakeStack()
  }

  function drag(event: ReactPointerEvent<HTMLButtonElement>, ball: Ball) {
    const state = dragRef.current
    if (!state || state.id !== ball.id) return
    const { w, h } = sizeRef.current
    ball.x = clamp(event.clientX - state.left + state.offsetX, ball.r, Math.max(ball.r, w - ball.r))
    ball.y = clamp(event.clientY - state.top + state.offsetY, ball.r, Math.max(ball.r, h - ball.r * 0.5))
  }

  function drop(event: ReactPointerEvent<HTMLButtonElement>, ball: Ball) {
    const state = dragRef.current
    if (!state || state.id !== ball.id) return
    dragRef.current = null
    ball.dragging = false
    ball.sleepFrames = 0
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }

    const world = worldRef.current
    const { w, h } = sizeRef.current
    const target = findTarget(ball)
    const now = performance.now()

    // 松手后接着往下掉
    ball.vx = (Math.random() - 0.5) * 60
    ball.vy = fallSpeed(h) * 0.92

    if (!target) return

    if (target.group === ball.group && target.kind !== ball.kind) {
      // 配成一对：两张球一起消失，从合并点朝小怪兽打出一颗魔法飞弹
      world.balls = world.balls.filter(item => item !== ball && item !== target)
      world.score += 100 + world.combo * 20
      world.combo += 1
      // 这一下扣多少：平时 100，每凑够 5 次成功配对翻倍成 200
      world.matchCount += 1
      const damage = world.matchCount % HARD_HIT_EVERY === 0 ? HARD_HIT_DAMAGE : HIT_DAMAGE
      wakeStack()
      const hitPoint = monsterHitPoint()
      const fired = !prefersReducedMotion() && fxRef.current?.fire({
        x0: (ball.x + target.x) / 2,
        y0: (ball.y + target.y) / 2,
        x1: hitPoint.x,
        y1: hitPoint.y,
        damage,
      })
      // 画布还没准备好 / 用户要求减少动态效果时，直接结算这一下
      if (!fired) applyHit(hitPoint.x, hitPoint.y, damage)
      return
    }

    // 配错：两张一起闪红、被压住的那颗弹开一点，不扣血也不扣命
    world.mistakes += 1
    world.combo = 0
    ball.wrongUntil = now + WRONG_MS
    target.wrongUntil = now + WRONG_MS
    const angle = Math.atan2(target.y - ball.y, target.x - ball.x) || -Math.PI / 2
    const band = monsterBandFor(h)
    target.x = clamp(target.x + Math.cos(angle) * (ball.r + 8), target.r, Math.max(target.r, w - target.r))
    target.y = clamp(
      target.y + Math.sin(angle) * (ball.r + 8),
      band,
      Math.max(band, h - target.r),
    )
    // 被弹开的球如果本来睡着，先醒来重新落定；压在上面的球也跟着重落
    target.resting = false
    target.sleepFrames = 0
    target.vx = 0
    target.vy = 0
    wakeStack()
  }

  const world = worldRef.current
  const now = performance.now()
  const hit = world.hitAt > 0 && now - world.hitAt < HIT_FEEDBACK_MS
  // 还剩几对没打：一场总共 words.length 个词，配对一次少一个
  const pairsLeft = Math.max(0, words.length - world.matchCount)
  const mood = monsterMood(world.hp, world.hpMax, world.hitAt, now, pairsLeft)
  const moodLabel = mood === MOOD_DEFEATED && world.hp <= 0 ? '战败倒地' : MOOD_LABELS[mood]
  const hpPercent = world.hpMax > 0 ? Math.max(0, Math.round((world.hp / world.hpMax) * 100)) : 0
  // 按帧量好的本体范围切图：竖直带整段缩放到当前怪兽带高度，横向只取这一帧的像素，不会带到下一格
  const frame = monsterSheet.frames[mood] ?? monsterSheet.frames[0]
  const { band, faceH } = monsterFaceFor(size.h)
  const artScale = faceH / (monsterSheet.artBottomY - monsterSheet.artTopY)
  const faceW = Math.round((frame.toX - frame.fromX) * artScale)
  // 背景三层的锚点：站立线 = 怪兽脚底（band，台沿就在这条线上），
  // 台面条带按场地宽度等比缩（源图台面段 1760×42）
  const stageH = Math.round(clamp(size.w * (42 / 1760), 14, 36))
  const fieldVars = { '--mst-feet': band + 'px', '--mst-stage': stageH + 'px' } as CSSProperties
  // 受击抖动绕身体中下部转，高度随怪兽带一起变
  const faceOrigin = '50% ' + Math.round(ART_TOP + faceH * 0.64) + 'px'

  function ballStyle(ball: Ball): CSSProperties {
    return {
      width: ball.r * 2,
      height: ball.r * 2,
      transform: 'translate3d(' + (ball.x - ball.r) + 'px, ' + (ball.y - ball.r) + 'px, 0)',
      fontSize: Math.round(ball.fontSize),
      ...bubbleBackdrop(bubbleCellFor(ball.group, ball.kind)),
    }
  }

  return (
    <div className="mst">
      <div
        className={'mst__field' + (status === 'won' ? ' is-won' : '')}
        ref={fieldRef}
        style={fieldVars}
      >
        {/* 背景三层：远景（底边贴站立线）→ 地面草地（从站立线铺到底）→ 台面条带（顶边压住脚） */}
        <div className="mst__sky" aria-hidden="true" />
        <div className="mst__ground" aria-hidden="true" />
        <div className="mst__shadow" aria-hidden="true" style={{ width: Math.round(faceW * 0.72) }} />
        <div
          className={'mst__monster' + (hit ? ' is-hit' : '')}
          style={{ transformOrigin: faceOrigin }}
        >
          <div
            className={'mst__hp' + (hpPercent <= 40 ? ' is-low' : '')}
            aria-label={'小怪兽血量 ' + hpPercent + '%'}
          >
            <i style={{ width: hpPercent + '%' }} />
          </div>
          <div
            className={'mst__face' + (hit ? ' is-flash' : '')}
            role="img"
            aria-label={'小怪兽：' + moodLabel}
            style={{
              top: ART_TOP,
              width: faceW,
              height: faceH,
              backgroundImage: 'url(' + monsterSheet.url + ')',
              backgroundSize: monsterSheet.sheetW * artScale + 'px ' + monsterSheet.sheetH * artScale + 'px',
              backgroundPosition: '-' + frame.fromX * artScale + 'px -' + monsterSheet.artTopY * artScale + 'px',
            }}
          />
        </div>

        <div className="mst__stage" aria-hidden="true" />

        <canvas ref={fxCanvasRef} className="mst__fx" aria-hidden="true" />

        {world.balls.map(ball => {
          const className = [
            'mst__ball',
            'mst__ball--' + ball.kind,
            ball.dragging ? 'is-dragging' : '',
            now < ball.wrongUntil ? 'is-wrong' : '',
          ].filter(Boolean).join(' ')
          return (
            <button
              key={ball.id}
              type="button"
              className={className}
              style={ballStyle(ball)}
              onPointerDown={event => pickUp(event, ball)}
              onPointerMove={event => drag(event, ball)}
              onPointerUp={event => drop(event, ball)}
              onPointerCancel={event => drop(event, ball)}
            >
              <span className="mst__ball-text">{ball.text}</span>
            </button>
          )
        })}

        {popsRef.current.map(pop => (
          <img
            key={pop.id}
            src={hitUrl}
            className="mst__hitfx"
            style={{ left: pop.x, top: pop.y }}
            alt=""
            aria-hidden="true"
          />
        ))}

        {status === 'idle' && (
          <div className="mst__overlay">
            <div className="mst__card">
              <p className="mst__card-title">拖一拖，打小怪兽</p>
              <p className="mst__card-sub">把英文球和它对应的中文球拖到一起，合上就能攻击它。</p>
              <button type="button" className="mst__btn" onClick={() => start(false)} disabled={size.w === 0}>
                开始游戏
              </button>
            </div>
          </div>
        )}

        {/* 打赢后不弹窗：胜利图案直接摆在场地中心 */}
        {status === 'won' && (
          <div className="mst__win">
            <svg className="mst__win-art" viewBox="0 0 96 96" role="img" aria-label="胜利奖杯">
              <defs>
                <linearGradient id="mst-win-gold" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#FFE7A8" />
                  <stop offset="52%" stopColor="#F3B85B" />
                  <stop offset="100%" stopColor="#DA8B31" />
                </linearGradient>
              </defs>
              <path d="M28 12h40v16a20 20 0 0 1-40 0V12Z" fill="url(#mst-win-gold)" />
              <path d="M28 17h-7a11 11 0 0 0 11 13" fill="none" stroke="#E9A94A" strokeWidth="5.5" strokeLinecap="round" />
              <path d="M68 17h7a11 11 0 0 1-11 13" fill="none" stroke="#E9A94A" strokeWidth="5.5" strokeLinecap="round" />
              <rect x="42" y="48" width="12" height="14" rx="4" fill="#E9A94A" />
              <rect x="30" y="62" width="36" height="9" rx="4.5" fill="#F3B85B" />
              <rect x="24" y="71" width="48" height="12" rx="6" fill="url(#mst-win-gold)" />
              <path d="M22 8v4M18 10h8M74 6v3M72.5 7.5h3M64 20v3M62.5 21.5h3" stroke="#FFE7A8" strokeWidth="3" strokeLinecap="round" />
            </svg>
            <p className="mst__win-title">小怪兽被打跑啦</p>
            <p className="mst__win-sub">得分 {world.score} · 配错 {world.mistakes} 次</p>
            <button type="button" className="mst__btn" onClick={() => start(true)}>再玩一次</button>
          </div>
        )}
      </div>
    </div>
  )
}

