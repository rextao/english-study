class_name GameState
extends RefCounted

# 「黑洞2」纯逻辑引擎（从 React 版 engine.ts 1:1 照搬），不碰任何绘制 / 输入设备。
# 世界是方形场景，玩家操纵黑洞吞噬比自己小的道具，体型越吃越大；场上还有若干对手黑洞。

# ── 内部数据结构：道具 / 坠落粒子 / 黑洞 ──────────────────────
class Particle:
    var angle: float = 0.0
    var dist: float = 0.0
    var speed: float = 0.0
    var spin: float = 0.0
    var size: float = 0.0

class Thing:
    var id: int = 0
    var kind: String = "bush"
    var x: float = 0.0
    var y: float = 0.0
    var radius: float = 0.0
    var value: int = 0
    var eaten: bool = false
    var suck: float = 0.0
    var variant: float = 0.0
    var tilt: float = 0.0
    var word: String = ""

class Hole:
    var is_player: bool = false
    var name: String = ""
    var hue: float = 0.0
    var x: float = 0.0
    var y: float = 0.0
    var radius: float = 0.0
    var area: float = 0.0
    var spin: float = 0.0
    var bvx: float = 0.0
    var bvy: float = 0.0
    var wander: float = 0.0
    var max_radius: float = 0.0
    var grow_rate: float = 0.0
    var drain_cd: float = 0.0
    var score: float = 0.0
    var score_rate: float = 0.0
    var particles: Array = []

# ── 常量：世界 / 玩法节奏（与 engine.ts 完全一致）──────────────
const WORLD = 2600.0
const MARGIN = 60.0
const BASE_RADIUS = 26.0
const PLAYER_SPEED = 250.0
const AI_SPEED = 150.0
const MASS_PER_VALUE = 70.0
const SUCK_TIME = 0.5
const DURATION = 150.0
const PROP_TARGET = 440
const AI_COUNT = 10
const SWALLOW_RATIO = 0.9
const BOUNCE_IMPULSE = 320.0
const PLAYER_ACCENT = "#38bdf8"
const AI_GROW_PER_SEC = 0.12
const AI_MAX_RADIUS_LO = BASE_RADIUS * 1.15
const AI_MAX_RADIUS_HI = BASE_RADIUS * 2.1
const DRAIN_RATIO = 0.12
const DRAIN_COOLDOWN = 1.4
const PLAYER_PARTICLES = 16
const AI_PARTICLES = 4

const PROP_KINDS = [
    {"kind": "bush", "radius": 11.0, "value": 1, "weight": 26},
    {"kind": "person", "radius": 15.0, "value": 2, "weight": 30},
    {"kind": "tree", "radius": 22.0, "value": 4, "weight": 18},
    {"kind": "car", "radius": 28.0, "value": 9, "weight": 14},
    {"kind": "house", "radius": 44.0, "value": 22, "weight": 8},
    {"kind": "tower", "radius": 64.0, "value": 52, "weight": 4},
]
const TOTAL_WEIGHT = 100

const NAME_BASES = [
    "小宇", "阿强", "团子", "大黑", "波波", "西瓜", "阿飞", "九九", "饺子", "豆豆",
    "阿凯", "糖糖", "老王", "果果", "七七", "皮皮", "嘟嘟", "毛毛", "大圣", "可乐",
    "Luna", "Momo", "Neo", "Zoe", "Rin", "Kai", "Yuki", "Toby", "Nova", "Leo",
    "Mia", "Coco", "Sora", "Echo", "Volt", "Jade", "Finn", "Ace", "Pixel", "Ghost",
]
const NAME_SUFFIXES = ["", "", "", "", "66", "77", "233", "007", "99", "_", "xo", "酱", "呀", "TT", "2k", "888"]

# ── 运行时状态 ────────────────────────────────────────────────
var things: Array = []
var holes: Array = []
var player: Hole = null
var input_x: float = 0.0
var input_y: float = 0.0
var elapsed: float = 0.0
var over: bool = false
var score: int = 0
var eaten: int = 0
var next_id: int = 1
var drains: int = 0
var last_word: String = ""

func _init() -> void:
    reset()

# 重开一局：清空世界、重新铺道具和对手
func reset() -> void:
    things = []
    holes = []
    input_x = 0.0
    input_y = 0.0
    elapsed = 0.0
    over = false
    score = 0
    eaten = 0
    next_id = 1
    drains = 0
    last_word = ""

    player = Hole.new()
    player.is_player = true
    player.name = "你"
    player.hue = 199.0
    player.x = WORLD / 2.0
    player.y = WORLD / 2.0
    player.radius = BASE_RADIUS
    player.area = PI * BASE_RADIUS * BASE_RADIUS
    player.max_radius = BASE_RADIUS
    player.particles = _make_particles(PLAYER_PARTICLES)
    holes.append(player)

    var ai_names = _make_names(AI_COUNT)
    for i in range(AI_COUNT):
        var radius = BASE_RADIUS * randf_range(0.6, 1.3)
        var max_radius = maxf(radius, randf_range(AI_MAX_RADIUS_LO, AI_MAX_RADIUS_HI))
        var ai = Hole.new()
        ai.is_player = false
        ai.name = ai_names[i]
        ai.hue = floor(randf_range(0.0, 360.0))
        ai.x = randf_range(MARGIN, WORLD - MARGIN)
        ai.y = randf_range(MARGIN, WORLD - MARGIN)
        ai.radius = radius
        ai.area = PI * radius * radius
        ai.spin = randf_range(0.0, TAU)
        ai.wander = randf_range(0.0, TAU)
        ai.max_radius = max_radius
        ai.grow_rate = AI_GROW_PER_SEC * randf_range(0.6, 1.4)
        ai.score = randf_range(0.0, 30.0)
        ai.score_rate = randf_range(0.6, 2.2)
        ai.particles = _make_particles(AI_PARTICLES)
        holes.append(ai)

    for i in range(PROP_TARGET):
        things.append(_spawn_thing(true))

# 设置移动方向，分量范围约 -1..1（摇杆归一化后传进来）
func set_input(x: float, y: float) -> void:
    input_x = clampf(x, -1.0, 1.0)
    input_y = clampf(y, -1.0, 1.0)

# 体型越大移动越慢，但有下限
func _speed_factor(radius: float) -> float:
    return clampf(pow(BASE_RADIUS / radius, 0.4), 0.45, 1.0)

func radius_of(area: float) -> float:
    return sqrt(area / PI)

func time_left() -> float:
    return maxf(0.0, DURATION - elapsed)

func rank() -> int:
    var r = 0
    for i in range(1, holes.size()):
        if holes[i].radius < player.radius:
            r += 1
    return r

# 生成一个坠落粒子：角度随机、从视界外（dist>1）起步，向心旋入
func _spawn_particle() -> Particle:
    var p = Particle.new()
    p.angle = randf_range(0.0, TAU)
    p.dist = randf_range(1.5, 2.8)
    p.speed = randf_range(0.6, 1.4)
    p.spin = randf_range(1.6, 3.2)
    p.size = randf_range(0.6, 1.6)
    return p

func _make_particles(count: int) -> Array:
    var list: Array = []
    for i in range(count):
        list.append(_spawn_particle())
    return list

# 随机生成 count 个不重复的对手名字，带点人味儿
func _make_names(count: int) -> Array:
    var used: Dictionary = {}
    var names: Array = []
    var guard = 0
    while names.size() < count and guard < count * 60:
        guard += 1
        var base_name = NAME_BASES[randi() % NAME_BASES.size()]
        var suffix = NAME_SUFFIXES[randi() % NAME_SUFFIXES.size()]
        var name = base_name + suffix
        if used.has(name):
            continue
        used[name] = true
        names.append(name)
    return names

# 按权重随机抽一种道具
func _pick_kind() -> Dictionary:
    var r = randf() * TOTAL_WEIGHT
    for k in PROP_KINDS:
        r -= k["weight"]
        if r <= 0:
            return k
    return PROP_KINDS[0]

func _spawn_thing(away_from_player: bool) -> Thing:
    var k = _pick_kind()
    var x = randf_range(MARGIN, WORLD - MARGIN)
    var y = randf_range(MARGIN, WORLD - MARGIN)
    if away_from_player:
        for i in range(8):
            if Vector2(x - WORLD / 2.0, y - WORLD / 2.0).length() > BASE_RADIUS + 150.0:
                break
            x = randf_range(MARGIN, WORLD - MARGIN)
            y = randf_range(MARGIN, WORLD - MARGIN)
    var t = Thing.new()
    t.id = next_id
    next_id += 1
    t.kind = k["kind"]
    t.x = x
    t.y = y
    t.radius = k["radius"]
    t.value = k["value"]
    t.variant = randf()
    t.word = Words.pick_word()
    return t

func update(dt: float) -> void:
    if over:
        return
    elapsed += dt
    if elapsed >= DURATION:
        elapsed = DURATION
        over = true

    # 玩家：按手势方向移动
    var in_len = Vector2(input_x, input_y).length()
    if in_len > 0.001:
        var sp = PLAYER_SPEED * _speed_factor(player.radius)
        var mag = minf(1.0, in_len)
        player.x += (input_x / in_len) * sp * mag * dt
        player.y += (input_y / in_len) * sp * mag * dt
    if player.drain_cd > 0.0:
        player.drain_cd = maxf(0.0, player.drain_cd - dt)

    # 对手黑洞：随机游走 + 体型缓慢长大到各自上限 + 自然涨分
    for i in range(1, holes.size()):
        var ai: Hole = holes[i]
        ai.score += ai.score_rate * dt
        if ai.radius < ai.max_radius:
            ai.radius = minf(ai.max_radius, ai.radius + ai.grow_rate * dt)
            ai.area = PI * ai.radius * ai.radius
        ai.wander += randf_range(-1.0, 1.0) * dt * 4.0
        var sp2 = AI_SPEED * _speed_factor(ai.radius)
        ai.x += cos(ai.wander) * sp2 * dt
        ai.y += sin(ai.wander) * sp2 * dt

    # 弹开速度：施加位移并衰减；自转与坠落粒子推进
    for h in holes:
        h.x += h.bvx * dt
        h.y += h.bvy * dt
        var decay = maxf(0.0, 1.0 - dt * 5.0)
        h.bvx *= decay
        h.bvy *= decay
        h.spin += dt * (2.0 if h.is_player else 1.4)
        _step_particles(h, dt)

    _clamp_holes()
    _resolve_collisions()
    _clamp_holes()
    _consume(dt)

# 推进一个黑洞的坠落粒子：向心靠近、同向自转，坠到中心就从外圈重生
func _step_particles(h: Hole, dt: float) -> void:
    for p in h.particles:
        var accel = 1.0 + maxf(0.0, 1.8 - p.dist) * 0.9
        p.dist -= p.speed * accel * dt
        p.angle += p.spin * dt
        if p.dist <= 0.08:
            var np = _spawn_particle()
            p.angle = np.angle
            p.dist = np.dist
            p.speed = np.speed
            p.size = np.size

func _clamp_holes() -> void:
    for i in range(holes.size()):
        var h: Hole = holes[i]
        var bx = h.x
        var by = h.y
        h.x = clampf(h.x, h.radius, WORLD - h.radius)
        h.y = clampf(h.y, h.radius, WORLD - h.radius)
        if not h.is_player and (bx != h.x or by != h.y):
            h.wander = atan2(WORLD / 2.0 - h.y, WORLD / 2.0 - h.x) + randf_range(-0.6, 0.6)

func _resolve_collisions() -> void:
    for i in range(1, holes.size()):
        var ai: Hole = holes[i]
        var dx = player.x - ai.x
        var dy = player.y - ai.y
        var dist = sqrt(dx * dx + dy * dy)
        var min_dist = player.radius + ai.radius
        if dist >= min_dist or dist == 0.0:
            continue
        var nx = dx / dist
        var ny = dy / dist
        var overlap = min_dist - dist
        if ai.radius > player.radius * 1.04:
            # 对手更大：把玩家整体推出去并给一记弹飞
            player.x += nx * overlap
            player.y += ny * overlap
            player.bvx += nx * BOUNCE_IMPULSE
            player.bvy += ny * BOUNCE_IMPULSE
            # 轻松版：被更大的对手撞上只扣一点体型（带冷却、有下限），绝不判负、也不扣分
            if player.drain_cd <= 0.0:
                var min_area = PI * BASE_RADIUS * BASE_RADIUS
                player.area = maxf(min_area, player.area * (1.0 - DRAIN_RATIO))
                player.radius = radius_of(player.area)
                player.drain_cd = DRAIN_COOLDOWN
                drains += 1
        elif player.radius > ai.radius * 1.04:
            # 玩家更大：反过来把对手弹开
            ai.x -= nx * overlap
            ai.y -= ny * overlap
            ai.bvx -= nx * BOUNCE_IMPULSE
            ai.bvy -= ny * BOUNCE_IMPULSE
        else:
            # 体型相近：各退一半
            player.x += nx * overlap * 0.5
            player.y += ny * overlap * 0.5
            ai.x -= nx * overlap * 0.5
            ai.y -= ny * overlap * 0.5

# 玩家吞噬：吸比自己小、且已进嘴的道具；只有玩家吃东西，对手只是移动障碍
func _consume(dt: float) -> void:
    var removed = 0
    var pull = minf(1.0, dt * 9.0)
    for thing in things:
        if not thing.eaten:
            var dist = Vector2(thing.x - player.x, thing.y - player.y).length()
            if player.radius >= thing.radius * SWALLOW_RATIO and dist < player.radius:
                thing.eaten = true
        if thing.eaten:
            thing.suck += dt / SUCK_TIME
            thing.tilt += dt * 9.0
            # 螺旋坠入：绕着黑洞中心一边转圈一边向心靠近
            var dx = thing.x - player.x
            var dy = thing.y - player.y
            var ang = atan2(dy, dx) + dt * 7.0
            var d = Vector2(dx, dy).length() * (1.0 - pull)
            thing.x = player.x + cos(ang) * d
            thing.y = player.y + sin(ang) * d
            if thing.suck >= 1.0:
                score += thing.value
                eaten += 1
                last_word = thing.word
                player.area += thing.value * MASS_PER_VALUE
                player.radius = radius_of(player.area)
                removed += 1
    if removed > 0:
        var kept: Array = []
        for t in things:
            if not (t.eaten and t.suck >= 1.0):
                kept.append(t)
        things = kept
        for i in range(removed):
            things.append(_spawn_thing(false))

# 排行榜：玩家读引擎实时得分，对手读自然累加 score；按分数降序取前 5
func _cmp_rows(a: Dictionary, b: Dictionary) -> bool:
    if a["score"] != b["score"]:
        return a["score"] > b["score"]
    if a["is_player"]:
        return true
    if b["is_player"]:
        return false
    return false

func leaderboard() -> Array:
    var rows: Array = []
    for h in holes:
        rows.append({
            "name": "你" if h.is_player else h.name,
            "score": score if h.is_player else int(round(h.score)),
            "is_player": h.is_player,
        })
    rows.sort_custom(_cmp_rows)
    return rows.slice(0, 5)

