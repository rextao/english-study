# 黑洞2 — 用 Godot 4.7 重做黑洞游戏（跨电脑工作交接）

> 换机后，在新的 Codex 对话里先完整读这份文档，再按第 5 节继续建剩余文件即可，不必重新通读原 React 源码。
> 生成时间：2026-10-10 · 工作目录：/Users/rextao/Documents/GitHub/english-study

---

## 0. 关于「能否去 GitHub 检索」
不能。当前沙箱无外网，GitHub / npm / 任何在线资源都访问不了。但本机已装 Godot，可用它在本地校验工程（见第 7 节）。

## 1. 任务
把现有 React/Canvas 版黑洞游戏，用 Godot 4.7 **1:1 重做**，放到新目录、命名「黑洞2」，**不动旧版**；确认效果后由用户决定是否删旧版。只新增文件，不删文件、不动 git。

- 原版源码目录：mobile/src/games/blackhole/
  - engine.ts（915 行：纯逻辑引擎 + Canvas 2D render，所有玩法与画法都在这）
  - words.ts（单词池，83 词）
  - BlackHoleGame.tsx（表现层：requestAnimationFrame 主循环 / 浮动摇杆手势 / HUD / 结算面板）
  - blackhole.css（HUD 样式，264 行）
- 新工程目录：mobile/game/blackhole/

## 2. 环境与硬约束
- Godot 已装：/opt/homebrew/bin/godot，版本 **4.7.2.stable**（可在沙箱直接跑，--version 与 --headless 均 exit 0 已验证）。
- 可写区：/Users/rextao/Documents/GitHub/english-study、/private/tmp、/tmp、系统临时目录。
- git 仓库零 commit、全部 untracked，删文件不可恢复 → **删任何文件前必须先问用户**。本任务只新增。
- GDScript 一律 **4 空格缩进**，别混 Tab。
- 建/改文件统一用 apply_patch（新建文件用 "*** Add File:"，每行内容前缀 "+"）。读文件用 exec_command 跑 cat/sed/rg。

## 3. 当前进度

### 已完成并已落盘（内容已逐一核对正确）
- **project.godot**：config/name="黑洞2"；config/features=PackedStringArray("4.7", "GL Compatibility")；display 1080x1920；window/stretch/mode="canvas_items"、aspect="expand"；window/handheld/orientation=1（竖屏）；renderer/rendering_method="gl_compatibility"（含 .mobile）。run/main_scene="res://scenes/main.tscn"。
- **scenes/main.tscn**：根 Node2D name="Main"，script = res://scripts/main.gd（所有子节点都在代码里建，场景文件只有一个根节点）。
- **icon.svg**、**.gitignore**（忽略 .godot/、/build/、export_presets.cfg）。
- **scripts/words.gd**：class_name Words extends RefCounted；const POOL（83 词，照抄 words.ts）；static func pick()->Dictionary；static func pick_word()->String（POOL[randi()%POOL.size()]["word"]）。
- **scripts/game_state.gd**：class_name GameState extends RefCounted。纯逻辑引擎，1:1 照搬 engine.ts，已核对一致。含 inner class Particle / Thing / Hole；全部常量（WORLD=2600、DURATION=150、BASE_RADIUS=26、AI_COUNT=10、PLAYER_ACCENT="#38bdf8" 等）；函数 reset / set_input / _speed_factor / radius_of / time_left / rank / _spawn_particle / _make_particles / _make_names / _pick_kind / _spawn_thing / update / _step_particles / _clamp_holes / _resolve_collisions / _consume / _cmp_rows / leaderboard。

### 待建（严格按此顺序）
1. scripts/world.gd —— 见 5.1（**已给出可直接粘贴的完整代码**）
2. scripts/joy_draw.gd —— 见 5.2
3. scripts/hud.gd —— 见 5.3
4. scripts/main.gd —— 见 5.4（**main.tscn 已引用它，建好之前工程无法运行**；注意：main.gd 不要加 class_name）
5. README.md —— 见 5.5

## 4. 关键设计决策（重要，别推翻）
- **不用 Camera2D，改「手动变换 + 屏幕空间绘制」**：world 是 Node2D，_draw() 里自己算 scale/ox/oy（ox = view_size.x/2 - player.x*scale），用 _tx()/_ty() 把世界坐标映射成屏幕像素后直接画。这样线宽/字号都是屏幕 px，与 engine.ts 的 render() 完全 1:1，避免相机换算带来的坐标 bug。world._draw 开头自己 draw_rect 填 #0b1222 背景，**不需要** Camera2D，也不需要 bg CanvasLayer。
- **viewScale 平滑放到 main.gd 的 _update_view()**（每帧算），world._draw 只用传进来的 view_scale（字段 view_scale）。
- stretch=canvas_items + 基准 1080x1920；get_viewport_rect().size 给基准尺寸；输入 event.position 与 HUD / world 同在该画布空间，摇杆视觉与触点一致。
- **新增 START / PLAYING / OVER 三态标题界面**（原 React 版无标题、直接开始；这是独立运行的合理适配，**最终回复要向用户明确标注这一点**）。「返回」按钮回标题。
- 玩法/画法与原版 1:1：世界 2600、时长 150 秒、10 个对手黑洞、6 种 2.5D 手绘道具（楼/房/车/树/行人/灌木）、被更大黑洞撞只扣体型不判负。

## 5. 待建文件详细规格

### 5.1 scripts/world.gd（可直接粘贴）

```gdscript
class_name BhWorld
extends Node2D

# 「黑洞2」世界绘制层（Node2D，屏幕空间手绘）。
# 不用 Camera2D：_draw() 自己把世界坐标按 player 居中、按 view_scale 缩放后映射到屏幕像素，
# 线宽 / 字号都按屏幕像素算，与 React 版 engine.ts 的 render() 完全 1:1。

var state = null
var font: Font = null
var view_scale: float = 1.0
var view_size: Vector2 = Vector2(1080, 1920)

var _scale: float = 1.0
var _ox: float = 0.0
var _oy: float = 0.0

const GRID = 140.0

const TOWER_PALETTE = [
    {"front": "#3b4a63", "side": "#2b394f", "top": "#4b5c79"},
    {"front": "#4a5568", "side": "#38424f", "top": "#5a6a80"},
    {"front": "#2f6b7a", "side": "#234f5c", "top": "#3c8294"},
    {"front": "#6b5a4a", "side": "#51473a", "top": "#7e6c58"},
]
const HOUSE_PALETTE = [
    {"front": "#c9b79c", "side": "#a89779", "roof": "#b4553f", "roof_side": "#8d3e2d"},
    {"front": "#d8cbb4", "side": "#b4a68c", "roof": "#5b7fa6", "roof_side": "#466285"},
    {"front": "#bfc7cf", "side": "#99a3ae", "roof": "#7a8a52", "roof_side": "#5e6c3f"},
]
const CAR_COLORS = [
    {"body": "#d0574b", "cabin": "#a7443b"},
    {"body": "#4e86c6", "cabin": "#3c699b"},
    {"body": "#e3b23c", "cabin": "#b78c2c"},
    {"body": "#cfd6de", "cabin": "#a3abb5"},
    {"body": "#5aa469", "cabin": "#468053"},
]
const TREE_GREENS = [
    {"dark": "#2f6b3f", "light": "#4f9960"},
    {"dark": "#356b2f", "light": "#5aa04f"},
    {"dark": "#2b7a5e", "light": "#46a683"},
]
const PERSON_SKINS = ["#e8b98f", "#d79a6a", "#c08457", "#f0c9a0"]
const PERSON_SHIRTS = ["#d0576e", "#4e86c6", "#e3b23c", "#5aa469", "#9b6bd0", "#e07b3c"]

func _tx(x: float) -> float:
    return x * _scale + _ox

func _ty(y: float) -> float:
    return y * _scale + _oy

func _rgba(r: float, g: float, b: float, a: float) -> Color:
    return Color(r / 255.0, g / 255.0, b / 255.0, a)

func _a(c: Color, alpha: float) -> Color:
    return Color(c.r, c.g, c.b, alpha)

func _pick_from(arr: Array, variant: float):
    var i: int = int(floor(abs(variant) * arr.size())) % arr.size()
    return arr[i]

func _pseudo(seed_v: float, i: int) -> float:
    var x: float = sin(seed_v * 97.17 + i * 12.9898) * 43758.5453
    return x - floor(x)

func _hsl(h_deg: float, s: float, l: float) -> Color:
    var h: float = fposmod(h_deg, 360.0) / 360.0
    var c: float = (1.0 - abs(2.0 * l - 1.0)) * s
    var hp: float = h * 6.0
    var x: float = c * (1.0 - abs(fmod(hp, 2.0) - 1.0))
    var m: float = l - c / 2.0
    var r: float = 0.0
    var g: float = 0.0
    var b: float = 0.0
    if hp < 1.0:
        r = c
        g = x
    elif hp < 2.0:
        r = x
        g = c
    elif hp < 3.0:
        g = c
        b = x
    elif hp < 4.0:
        g = x
        b = c
    elif hp < 5.0:
        r = x
        b = c
    else:
        r = c
        b = x
    return Color(r + m, g + m, b + m)

func _ellipse_pts(cx: float, cy: float, rx: float, ry: float, n: int = 22) -> PackedVector2Array:
    var pts: PackedVector2Array = PackedVector2Array()
    for i in range(n):
        var a: float = TAU * float(i) / float(n)
        pts.append(Vector2(cx + cos(a) * rx, cy + sin(a) * ry))
    return pts

func _round_rect(x: float, y: float, w: float, h: float, r: float, color: Color) -> void:
    var rr: float = minf(r, minf(w / 2.0, h / 2.0))
    draw_rect(Rect2(x + rr, y, w - 2.0 * rr, h), color)
    draw_rect(Rect2(x, y + rr, rr, h - 2.0 * rr), color)
    draw_rect(Rect2(x + w - rr, y + rr, rr, h - 2.0 * rr), color)
    draw_circle(Vector2(x + rr, y + rr), rr, color)
    draw_circle(Vector2(x + w - rr, y + rr), rr, color)
    draw_circle(Vector2(x + rr, y + h - rr), rr, color)
    draw_circle(Vector2(x + w - rr, y + h - rr), rr, color)

func _radial_color(nr: float) -> Color:
    var c_in: Color = Color("#000000")
    var c_mid: Color = Color("#05060c")
    var c_out: Color = Color("#0c1222")
    if nr <= 0.15:
        return c_in
    var f: float = (nr - 0.15) / 0.85
    if f <= 0.72:
        return c_in.lerp(c_mid, f / 0.72)
    return c_mid.lerp(c_out, (f - 0.72) / 0.28)

func _draw_radial(center: Vector2, r: float) -> void:
    var steps: int = 18
    for i in range(steps):
        var frac: float = 1.0 - float(i) / float(steps)
        var rad: float = r * frac
        if rad <= 0.0:
            continue
        draw_circle(center, rad, _radial_color(frac))
    draw_circle(center, maxf(1.0, r * 0.1), Color("#000000"))

func _draw_arc_rot(center: Vector2, radius: float, a0: float, a1: float, spin: float, color: Color, width: float) -> void:
    draw_arc(center, radius, a0 + spin, a1 + spin, 24, color, width, true)

func _draw() -> void:
    if state == null:
        return
    _scale = view_scale
    var vp: Vector2 = view_size
    _ox = vp.x / 2.0 - state.player.x * _scale
    _oy = vp.y / 2.0 - state.player.y * _scale

    # 背景
    draw_rect(Rect2(0, 0, vp.x, vp.y), Color("#0b1222"))

    # 网格
    var grid_col: Color = Color(0.58, 0.64, 0.72, 0.07)
    var left: float = (0.0 - _ox) / _scale
    var right: float = (vp.x - _ox) / _scale
    var top: float = (0.0 - _oy) / _scale
    var bottom: float = (vp.y - _oy) / _scale
    var gx: float = floor(left / GRID) * GRID
    while gx <= right:
        draw_line(Vector2(_tx(gx), 0.0), Vector2(_tx(gx), vp.y), grid_col, 1.0)
        gx += GRID
    var gy: float = floor(top / GRID) * GRID
    while gy <= bottom:
        draw_line(Vector2(0.0, _ty(gy)), Vector2(vp.x, _ty(gy)), grid_col, 1.0)
        gy += GRID

    # 世界边界
    draw_rect(Rect2(_tx(0.0), _ty(0.0), GameState.WORLD * _scale, GameState.WORLD * _scale), Color(0.22, 0.74, 0.97, 0.22), false, 2.0)

    # 道具
    var pcx: float = _tx(state.player.x)
    var pcy: float = _ty(state.player.y)
    for thing in state.things:
        var sx: float = _tx(thing.x)
        var sy: float = _ty(thing.y)
        var r: float = thing.radius * _scale
        if sx + r * 2.0 < 0.0 or sx - r * 2.0 > vp.x or sy + r < 0.0 or sy - r * 3.4 > vp.y:
            continue
        if r < 1.2:
            continue
        var suck: float = (minf(1.0, thing.suck) if thing.eaten else 0.0)
        if suck > 0.08 and suck < 0.95:
            draw_line(Vector2(sx, sy - r * 0.6), Vector2(pcx, pcy), _rgba(1, 3, 10, 0.16 * (1.0 - suck)), maxf(1.0, r * 0.8 * (1.0 - suck)))
        _draw_prop(thing.kind, sx, sy, r, thing.variant, suck, thing.tilt)

    # 黑洞：对手在前，玩家最后画（保证玩家永远最上层）
    for i in range(state.holes.size() - 1, -1, -1):
        _draw_hole(state.holes[i])

func _draw_hole(h) -> void:
    var sx: float = _tx(h.x)
    var sy: float = _ty(h.y)
    var r: float = h.radius * _scale
    if sx + r < -40.0 or sx - r > view_size.x or sy + r < -40.0 or sy - r > view_size.y:
        return
    var color: Color = (Color(GameState.PLAYER_ACCENT) if h.is_player else _hsl(h.hue, 0.8, 0.62))
    var c: Vector2 = Vector2(sx, sy)

    _draw_radial(c, r)

    var arc_w: float = maxf(1.5, r * 0.13)
    _draw_arc_rot(c, r * 0.6, 0.2, PI * 1.15, h.spin, _a(color, 0.33), arc_w)
    _draw_arc_rot(c, r * 0.38, PI, PI * 1.95, h.spin, _a(color, 0.33), arc_w)

    # 发光环（3 层描边近似 shadowBlur）
    var ring_w: float = maxf(2.0, r * 0.06)
    draw_arc(c, r, 0.0, TAU, 48, _a(color, 0.12), ring_w * 3.0, true)
    draw_arc(c, r, 0.0, TAU, 48, _a(color, 0.22), ring_w * 2.0, true)
    draw_arc(c, r, 0.0, TAU, 48, color, ring_w, true)

    # 坠落粒子
    if r > 6.0:
        for p in h.particles:
            var pr: float = r * p.dist
            var px: float = sx + cos(p.angle) * pr
            var py: float = sy + sin(p.angle) * pr
            var t: float = clampf(p.dist / 1.8, 0.0, 1.0)
            var a: float = clampf(t * 0.5, 0.04, 0.5) * (1.0 if h.is_player else 0.7)
            var dot_r: float = maxf(0.5, p.size * r * 0.025 * (0.5 + t * 0.5))
            draw_circle(Vector2(px, py), dot_r, _a(color, a))

    # 对手名牌
    if not h.is_player and r > 10.0 and font != null:
        var fs: int = 12
        var tw: float = font.get_string_size(h.name, HORIZONTAL_ALIGNMENT_LEFT, -1.0, fs).x
        var pos: Vector2 = Vector2(sx - tw / 2.0, sy - r - 6.0)
        draw_string_outline(font, pos, h.name, HORIZONTAL_ALIGNMENT_LEFT, -1.0, fs, 3, Color(0, 0, 0, 0.6))
        draw_string(font, pos, h.name, HORIZONTAL_ALIGNMENT_LEFT, -1.0, fs, Color(0.945, 0.961, 0.976, 0.92))

func _draw_prop(kind: String, gx: float, gy: float, r: float, variant: float, suck: float, tilt: float) -> void:
    var shrink: float = 1.0 - suck * 0.5
    var rr: float = r * shrink
    if rr < 1.0:
        return
    var alpha: float = clampf(1.0 - suck * 0.8, 0.0, 1.0)
    if suck > 0.0:
        var pivot: Vector2 = Vector2(gx, gy - rr * 0.6)
        draw_set_transform_matrix(Transform2D(0.0, pivot) * Transform2D(tilt, Vector2.ZERO) * Transform2D(0.0, -pivot))
    _draw_shadow(gx, gy, rr, alpha)
    match kind:
        "bush":
            _draw_bush(gx, gy, rr, variant, alpha)
        "person":
            _draw_person(gx, gy, rr, variant, alpha)
        "tree":
            _draw_tree(gx, gy, rr, variant, alpha)
        "car":
            _draw_car(gx, gy, rr, variant, alpha)
        "house":
            _draw_house(gx, gy, rr, variant, alpha)
        "tower":
            _draw_tower(gx, gy, rr, variant, alpha)
    if suck > 0.0:
        draw_set_transform(Vector2.ZERO, 0.0, Vector2.ONE)

func _draw_shadow(gx: float, gy: float, rr: float, alpha: float) -> void:
    draw_colored_polygon(_ellipse_pts(gx, gy, rr * 1.05, rr * 0.42), _rgba(2, 4, 12, 0.26 * alpha))

func _draw_box(gx: float, gy: float, half_w: float, height: float, depth: float, front: Color, side: Color, top: Color, with_top: bool, alpha: float) -> void:
    var bx0: float = gx - half_w
    var bx1: float = gx + half_w
    var top_y: float = gy - height
    var ddx: float = depth * 0.8
    var ddy: float = -depth * 0.55
    var side_pts: PackedVector2Array = PackedVector2Array([
        Vector2(bx1, gy),
        Vector2(bx1, top_y),
        Vector2(bx1 + ddx, top_y + ddy),
        Vector2(bx1 + ddx, gy + ddy),
    ])
    draw_colored_polygon(side_pts, _a(side, alpha))
    if with_top:
        var top_pts: PackedVector2Array = PackedVector2Array([
            Vector2(bx0, top_y),
            Vector2(bx1, top_y),
            Vector2(bx1 + ddx, top_y + ddy),
            Vector2(bx0 + ddx, top_y + ddy),
        ])
        draw_colored_polygon(top_pts, _a(top, alpha))
    draw_rect(Rect2(bx0, top_y, half_w * 2.0, height), _a(front, alpha))

func _draw_tower(gx: float, gy: float, rr: float, variant: float, alpha: float) -> void:
    var half_w: float = rr * 0.82
    var height: float = rr * 2.7
    var depth: float = rr * 0.5
    var pal: Dictionary = _pick_from(TOWER_PALETTE, variant)
    _draw_box(gx, gy, half_w, height, depth, Color(pal["front"]), Color(pal["side"]), Color(pal["top"]), true, alpha)
    var top_y: float = gy - height
    var cols: int = 3
    var rows: int = maxi(4, int(round(height / (rr * 0.42))))
    var margin_x: float = half_w * 0.3
    var margin_y: float = rr * 0.2
    var cell_w: float = (half_w * 2.0 - margin_x * 2.0) / float(cols)
    var cell_h: float = (height - margin_y * 2.0) / float(rows)
    var win_w: float = cell_w * 0.58
    var win_h: float = cell_h * 0.56
    for row in range(rows):
        for col in range(cols):
            var lit: bool = _pseudo(variant, row * cols + col) > 0.5
            var wcol: Color = (_rgba(255, 224, 130, 0.92 * alpha) if lit else _rgba(12, 20, 38, 0.75 * alpha))
            var wx: float = gx - half_w + margin_x + col * cell_w + (cell_w - win_w) / 2.0
            var wy: float = top_y + margin_y + row * cell_h + (cell_h - win_h) / 2.0
            draw_rect(Rect2(wx, wy, win_w, win_h), wcol)

func _draw_house(gx: float, gy: float, rr: float, variant: float, alpha: float) -> void:
    var half_w: float = rr * 0.92
    var height: float = rr * 1.05
    var depth: float = rr * 0.5
    var pal: Dictionary = _pick_from(HOUSE_PALETTE, variant)
    var front: Color = Color(pal["front"])
    var side: Color = Color(pal["side"])
    _draw_box(gx, gy, half_w, height, depth, front, side, front, false, alpha)
    var top_y: float = gy - height
    var ddx: float = depth * 0.8
    var ddy: float = -depth * 0.55
    var peak_x: float = gx
    var peak_y: float = top_y - rr * 0.72
    var roof_side_pts: PackedVector2Array = PackedVector2Array([
        Vector2(gx + half_w, top_y),
        Vector2(peak_x, peak_y),
        Vector2(peak_x + ddx, peak_y + ddy),
        Vector2(gx + half_w + ddx, top_y + ddy),
    ])
    draw_colored_polygon(roof_side_pts, _a(Color(pal["roof_side"]), alpha))
    var roof_pts: PackedVector2Array = PackedVector2Array([
        Vector2(gx - half_w, top_y),
        Vector2(gx + half_w, top_y),
        Vector2(peak_x, peak_y),
    ])
    draw_colored_polygon(roof_pts, _a(Color(pal["roof"]), alpha))
    var door_w: float = half_w * 0.4
    var door_h: float = height * 0.6
    draw_rect(Rect2(gx - door_w / 2.0, gy - door_h, door_w, door_h), _a(Color("#4a3728"), alpha))
    var win_w: float = half_w * 0.42
    draw_rect(Rect2(gx + half_w * 0.16, top_y + height * 0.2, win_w, win_w * 0.78), _rgba(255, 224, 130, 0.9 * alpha))

func _draw_car(gx: float, gy: float, rr: float, variant: float, alpha: float) -> void:
    var w: float = rr * 1.4
    var h: float = rr * 0.64
    var col: Dictionary = _pick_from(CAR_COLORS, variant)
    var top_y: float = gy - h
    draw_circle(Vector2(gx - w * 0.28, gy - h * 0.05), h * 0.3, _rgba(27, 33, 48, alpha))
    draw_circle(Vector2(gx + w * 0.28, gy - h * 0.05), h * 0.3, _rgba(27, 33, 48, alpha))
    _round_rect(gx - w / 2.0, top_y, w, h, h * 0.32, _a(Color(col["body"]), alpha))
    _round_rect(gx - w * 0.24, top_y - h * 0.55, w * 0.5, h * 0.62, h * 0.22, _a(Color(col["cabin"]), alpha))
    _round_rect(gx - w * 0.19, top_y - h * 0.44, w * 0.42, h * 0.42, h * 0.14, _rgba(190, 225, 255, 0.9 * alpha))
    draw_circle(Vector2(gx + w * 0.46, top_y + h * 0.42), h * 0.11, _rgba(255, 241, 170, 0.95 * alpha))

func _draw_tree(gx: float, gy: float, rr: float, variant: float, alpha: float) -> void:
    var g: Dictionary = _pick_from(TREE_GREENS, variant)
    var dark: Color = _a(Color(g["dark"]), alpha)
    var light: Color = _a(Color(g["light"]), alpha)
    var trunk_w: float = rr * 0.26
    var trunk_h: float = rr * 0.95
    draw_rect(Rect2(gx - trunk_w / 2.0, gy - trunk_h, trunk_w, trunk_h), _a(Color("#6b4423"), alpha))
    var cx: float = gx
    var cy: float = gy - trunk_h - rr * 0.5
    draw_circle(Vector2(cx - rr * 0.42, cy + rr * 0.22), rr * 0.6, dark)
    draw_circle(Vector2(cx + rr * 0.42, cy + rr * 0.16), rr * 0.58, dark)
    draw_circle(Vector2(cx, cy), rr * 0.82, dark)
    draw_circle(Vector2(cx - rr * 0.2, cy - rr * 0.22), rr * 0.44, light)

func _draw_bush(gx: float, gy: float, rr: float, variant: float, alpha: float) -> void:
    var g: Dictionary = _pick_from(TREE_GREENS, variant)
    var dark: Color = _a(Color(g["dark"]), alpha)
    var light: Color = _a(Color(g["light"]), alpha)
    draw_circle(Vector2(gx - rr * 0.5, gy - rr * 0.32), rr * 0.56, dark)
    draw_circle(Vector2(gx + rr * 0.5, gy - rr * 0.26), rr * 0.5, dark)
    draw_circle(Vector2(gx, gy - rr * 0.58), rr * 0.62, dark)
    draw_circle(Vector2(gx - rr * 0.14, gy - rr * 0.62), rr * 0.34, light)

func _draw_person(gx: float, gy: float, rr: float, variant: float, alpha: float) -> void:
    var skin: Color = _a(Color(_pick_from(PERSON_SKINS, variant)), alpha)
    var shirt: Color = _a(Color(_pick_from(PERSON_SHIRTS, variant * 1.7 + 0.3)), alpha)
    var leg: Color = _a(Color("#2b3240"), alpha)
    draw_rect(Rect2(gx - rr * 0.3, gy - rr * 0.55, rr * 0.22, rr * 0.55), leg)
    draw_rect(Rect2(gx + rr * 0.08, gy - rr * 0.55, rr * 0.22, rr * 0.55), leg)
    _round_rect(gx - rr * 0.4, gy - rr * 1.18, rr * 0.8, rr * 0.74, rr * 0.26, shirt)
    draw_circle(Vector2(gx, gy - rr * 1.42), rr * 0.4, skin)
```

> 说明：engine.ts 原本用 ctx.globalAlpha 统一控制透明度；GDScript 没有全局 alpha，所以每个颜色都乘进 alpha（纯色用 _a(Color, alpha)，带固有透明度的用 _rgba(r,g,b, 固有a*alpha)）。阴影 drawShadow 原是 globalAlpha*=0.26，这里写成 0.26*alpha。被吞旋转用 draw_set_transform_matrix 绕 pivot 旋 tilt，画完 draw_set_transform 复位。渐变洞体和椭圆阴影 Godot 的 _draw 没有原生 API，分别用约 18 层同心 draw_circle 和 22 点多边形近似；对手色用自写 _hsl（engine 是 hsl(hue,80%,62%)，别用 Color.from_hsv）。

### 5.2 scripts/joy_draw.gd —— class_name BhJoy extends Control
- 字段：var joy_active=false、var base_pos=Vector2.ZERO、var knob_pos=Vector2.ZERO。
- _ready()：set_anchors_preset(Control.PRESET_FULL_RECT)；mouse_filter = Control.MOUSE_FILTER_IGNORE。
- func set_joy(active, base, knob)：存三个值后 queue_redraw()。
- _draw()：若 joy_active：draw_circle(base_pos, 56, Color(0.22,0.74,0.97,0.08))；draw_arc(base_pos,56,0,TAU,48,Color(0.22,0.74,0.97,0.35),2.0,true)；draw_circle(knob_pos, 26, Color(0.22,0.74,0.97,0.5))。
- （对应原 css：外圈半径 56、边框 rgba(56,189,248,0.35) 2px、底 rgba(56,189,248,0.08)；knob 半径 26、rgba(56,189,248,0.5)。）

### 5.3 scripts/hud.gd —— class_name BhHud extends CanvasLayer
signals：start_pressed / restart_pressed / exit_pressed / back_pressed。
字段：overlay_mode="start"、playing=false；节点 root / play_hud / exit_btn / timer_label / board(VBoxContainer) / board_rows(5 个 Label) / tip_label / bite_label / joy(BhJoy) / overlay / dim(ColorRect) / card(PanelContainer) / title_label / score_label / sub_label / primary_btn / secondary_btn / ui_font。

build(f: Font)：
- self.layer = 10；用 Theme.new()，theme.default_font=f（给 root 挂 theme，所有子节点统一字体）。
- root = Control，PRESET_FULL_RECT，MOUSE_FILTER_IGNORE，theme=theme；add_child(root)。
- _build_play_hud()；joy=BhJoy.new()，root.add_child(joy)；_build_overlay()。

play_hud（Control，FULL_RECT，IGNORE，加到 root）内：
- exit_btn：Button，文本 "‹ 退出"，position(12,14)，mouse_filter=STOP，_style_secondary(exit_btn)，pressed 连 exit_pressed。
- timer_label：Label，anchor_left=0/right=1/top=0，offset_top=10/bottom=56，水平居中(HORIZONTAL_ALIGNMENT_CENTER)，字号 34，颜色 #f1f5f9，IGNORE。
- board：VBoxContainer，anchor_left=1/right=1，offset_left=-232/right=-12/top=12/bottom=160，alignment=BEGIN，分隔 4，IGNORE；塞 5 个 Label，右对齐(HORIZONTAL_ALIGNMENT_RIGHT)，字号 15，IGNORE。
- tip_label：Label，anchor_top=1/bottom=1，offset_top=-58/bottom=-24，居中，文本 "按住屏幕任意位置拖动，操控黑洞移动"，字号 15，#cbd5e1，IGNORE。
- bite_label：Label，anchor(0.5,0.38)、grow BOTH，文本 "被吞了一口！"，字号 22，#fecaca，IGNORE，modulate.a=0。

overlay（Control，FULL_RECT，IGNORE，加到 root）内：
- dim：ColorRect，FULL_RECT，Color(0.008,0.024,0.078,0.72)，mouse_filter=STOP（挡住底下的摇杆/输入）。
- card：PanelContainer，PRESET_CENTER，grow BOTH，custom_minimum_size(320,0)；StyleBoxFlat 背景 #1e293b、set_corner_radius_all(20)、content_margin 左右 24 上下 28；add_theme_stylebox_override("panel", sb)。
- card 内 VBoxContainer（分隔 10）：title_label(居中,字号16,#94a3b8) / score_label(居中,#38bdf8) / sub_label(autowrap=WORD_SMART, custom_minimum_size(272,0), 居中, 字号14, #cbd5e1) / primary_btn(custom_minimum_size(0,44), _style_primary, 连 _on_primary) / secondary_btn(custom_minimum_size(0,44), _style_secondary, 连 _on_secondary)。

按钮样式：
- _style_primary(btn)：normal=StyleBoxFlat 背景 #38bdf8、corner 12、margin 左右16 上下10；hover=normal.duplicate() 背景 #5cc8fb；override normal/hover/pressed(=hover)/focus(StyleBoxEmpty)；font_color/hover/pressed = #0f172a；font_size 16。
- _style_secondary(btn)：normal 背景 Color(0.09,0.145,0.247,0.55)、corner12、set_border_width_all(1)、border_color Color(0.58,0.64,0.72,0.28)、margin 左右14 上下7；hover 背景 Color(0.12,0.18,0.3,0.7)；font_color #f1f5f9；font_size 15。

方法：
- update_play(state)：timer_label.text = _fmt_time(state.time_left())；若 int(ceil(time_left)) <= 15 用 #f87171 否则 #f1f5f9（add_theme_color_override("font_color", c)）。board = state.leaderboard()，逐行 "%d  %s  %d" % [i+1, name, score]，右对齐；玩家行 #7dd3fc，其余 #e2e8f0；多余的行 visible=false。
- flash_bite()：bite_label.modulate.a=0；create_tween() → tween_property(bite_label,"modulate:a",1.0,0.16) → tween_interval(0.5) → tween_property(bite_label,"modulate:a",0.0,0.24)。
- set_joystick(active, base, knob)：joy.set_joy(...)；tip_label.visible = playing and not active。
- set_playing(b)：playing=b；exit_btn/timer_label/board/tip_label.visible=b；b=false 时 joy.set_joy(false,ZERO,ZERO) 且 bite_label.modulate.a=0。
- show_start()：overlay_mode="start"；overlay.visible=true；title="BLACK HOLE II"(16)；score="黑洞2"(44)；sub=玩法说明（可用多行，描述"吞比自己小的东西，越吃越大；躲开更大的黑洞；150 秒内冲高分"）；primary.text="开始游戏"、visible=true；secondary.visible=false；set_playing(false)。
- show_over(state)：overlay_mode="over"；overlay.visible=true；title="时间到！"(15)；score=str(state.score)(52)；size_x = state.player.radius / GameState.BASE_RADIUS；sub = "吞噬 %d 个目标 · 体型 %.1f× · 超过 %d/%d 个黑洞 · 被吞 %d 次" % [state.eaten, size_x, state.rank(), GameState.AI_COUNT, state.drains]；primary.text="再来一局"、visible=true；secondary.text="返回"、visible=true；set_playing(false)。
- hide_overlays()：overlay.visible=false。
- _fmt_time(sec)：total=int(ceil(maxf(0.0,sec)))；return "%d:%02d" % [total/60, total%60]。
- _on_primary()：overlay_mode=="start" 则 start_pressed.emit() 否则 restart_pressed.emit()。
- _on_secondary()：back_pressed.emit()。

（对应原 css 文案/配色：退出 "‹ 退出"；倒计时 #f1f5f9 / 末 15 秒 #f87171；排行榜玩家行 #7dd3fc、其余 #e2e8f0；被咬 "被吞了一口！" #fecaca；提示语同上；结算标题 #94a3b8、分数 #38bdf8、小字 #cbd5e1、主按钮 #38bdf8 底 #0f172a 字。）

### 5.4 scripts/main.gd —— extends Node2D（**不要加 class_name**，已被 main.tscn 以路径挂载）
- enum Phase { START, PLAYING, OVER }；const JOY_MAX = 70.0。
- 字段：phase=Phase.START；state=null（GameState）；font:Font；world:BhWorld；hud:BhHud；view_scale=1.0；prev_drains=0；touch_index=-1；joy_base=Vector2.ZERO。
- _ready()：randomize()；font=SystemFont.new()，font.font_names=PackedStringArray(["PingFang SC","Heiti SC","STHeiti","Hiragino Sans GB","Microsoft YaHei","Noto Sans CJK SC","sans-serif"])，font.allow_system_fallback=true；world=BhWorld.new()、world.font=font、add_child(world)；hud=BhHud.new()、add_child(hud)、hud.build(font)；连 start_pressed/restart_pressed → _start_game，exit_pressed/back_pressed → _to_title；最后 _to_title()。
- _to_title()：phase=START；若 state==null 则 state=GameState.new() 给 world.state 当背景；hud.show_start()。
- _start_game()：state=GameState.new()；world.state=state；view_scale=1.0；prev_drains=0；phase=PLAYING；_reset_input()；hud.hide_overlays()；hud.set_playing(true)。
- _process(delta)：若 state==null return；PLAYING 时 state.update(minf(0.05, delta))；_update_view()；world.view_scale=view_scale；world.view_size=get_viewport_rect().size；world.queue_redraw()；PLAYING 时 hud.update_play(state)，若 state.drains>prev_drains → hud.flash_bite()，prev_drains=state.drains，若 state.over → phase=OVER + _reset_input() + hud.show_over(state)。
- _update_view()：vp=get_viewport_rect().size；target=clampf(min(vp.x,vp.y)*0.13/state.player.radius, 0.42, 1.7)；view_scale += (target-view_scale)*0.08。
- _unhandled_input(event)：phase!=PLAYING return。处理 InputEventScreenTouch（按下且 touch_index==-1 → touch_index=event.index 并 _joy_down(event.position)；抬起且 index==touch_index → _joy_up()）、InputEventScreenDrag（index==touch_index → _joy_move(event.position)）、InputEventMouseButton 左键（按下且 touch_index==-1 → touch_index=-2 并 _joy_down(event.position)；抬起且 touch_index==-2 → _joy_up()）、InputEventMouseMotion（touch_index==-2 → _joy_move(event.position)）。鼠标分支是为了在桌面编辑器里也能玩。
- _joy_down(pos)：joy_base=pos；hud.set_joystick(true,pos,pos)；state.set_input(0,0)。
- _joy_move(pos)：d=pos-joy_base；length=d.length()；clamped=minf(length, JOY_MAX)；nx = d.x/length if length>0 else 0；ny = d.y/length if length>0 else 0；state.set_input(nx*clamped/JOY_MAX, ny*clamped/JOY_MAX)；hud.set_joystick(true, joy_base, joy_base + Vector2(nx,ny)*clamped)。
- _joy_up()：touch_index=-1；state.set_input(0,0)；hud.set_joystick(false,ZERO,ZERO)。
- _reset_input()：touch_index=-1；若 state!=null state.set_input(0,0)；hud.set_joystick(false,ZERO,ZERO)。

### 5.5 README.md（中文）
内容建议：怎么用 Godot 4.7 打开运行（godot --path mobile/game/blackhole 或编辑器导入）；依赖系统中文字体（SystemFont fallback，列表见 main.gd）；黑洞2 与原 React 版的关系（1:1 重做、原版保留未动）；新增了 START/PLAYING/OVER 标题界面这一适配；实际验证情况（见第 7 节结果）。注意：README 用普通标点，别在里面放会干扰 apply_patch 的三连星号行。

## 6. Godot 4 易错点（已踩/须注意）
- 绘制 API：draw_rect(rect,color,filled=true,width=-1)（描边 filled=false 且给 width）；draw_arc(center,r,a0,a1,count,color,width,aa)；draw_circle(center,r,color)；draw_colored_polygon(PackedVector2Array,color)；draw_line(a,b,color,width)；draw_string / draw_string_outline(font,pos,text,alignment,width,font_size,[outline_size],modulate)。
- Color("#rrggbb")、Color(r,g,b,a) 为 0..1 浮点。对手黑洞颜色用自写 _hsl（不是 from_hsv）。
- Transform2D(rotation_float, position_vec)；复位用 draw_set_transform(Vector2.ZERO,0.0,Vector2.ONE)。
- 数学：minf/maxf/clampf/maxi/mini、int()/round()/floor()/ceil()/abs()/sqrt()/pow()/cos()/sin()/atan2()、fposmod/fmod、PI/TAU；三元 "A if cond else B"；取模长用 Vector2(dx,dy).length()。
- 从未类型化 Array 取出的元素是 Variant：凡是 Variant 成员参与乘除（如 thing.radius*_scale）就显式写 "var x: float = ..."，别用 ":=" 以免推断报错。
- Control：set_anchors_preset(Control.PRESET_FULL_RECT / PRESET_CENTER)；mouse_filter=Control.MOUSE_FILTER_IGNORE/STOP；grow_horizontal/vertical=Control.GROW_DIRECTION_BOTH；add_theme_font_size_override("font_size",n)；add_theme_color_override("font_color",c)；add_theme_stylebox_override("normal"/"panel",sb)；add_theme_constant_override("separation",n)。
- StyleBoxFlat：set_corner_radius_all(n)、set_border_width_all(n)、border_color、content_margin_left/right/top/bottom、.duplicate()。StyleBoxEmpty 用于去掉 focus 边框。PanelContainer 的 stylebox 名是 "panel"。
- autowrap_mode=TextServer.AUTOWRAP_WORD_SMART。Node.create_tween()（CanvasLayer 继承 Node，可用）；tween_property(obj,"modulate:a",v,t)。
- Container 高度为 0 时子节点不显示 → card/board 都给足 custom_minimum_size（已在规格里给出）。
- 对手黑洞 inner class 的字段 name/id 不与 RefCounted 冲突（无 extends 的 inner class 继承 RefCounted，没有这些内置属性）。
- 跨脚本访问常量 GameState.WORLD / BASE_RADIUS / AI_COUNT / PLAYER_ACCENT 均可（class_name + const）。
- main.gd 不加 class_name（已被 tscn 挂载）；其余脚本都加 class_name 以便互相引用（Words / GameState / BhWorld / BhJoy / BhHud）。

## 7. 收尾与验证
1. 建完全部文件后，用 Godot 跑一次编译自检：
   /opt/homebrew/bin/godot --headless --path /Users/rextao/Documents/GitHub/english-study/mobile/game/blackhole --quit-after 5 2>&1
   看有无 GDScript parse / 编译 / 运行报错；有就按报错修。headless 用 dummy 渲染器，_draw 是 no-op，但能验证脚本编译 + _ready/_process 不崩。若沙箱直跑被拦，用 require_escalated（本地二进制、无网络；justification 说明是本地 Godot 校验）。
2. 清理过程里产生的任何临时文件。

## 8. 最终回复要点（给用户，中文、自包含）
- 回答「能否去 GitHub 检索」= 不能，沙箱无外网；但 Godot 本地能跑，已用它验证。
- 新工程位置 mobile/game/blackhole/、项目名「黑洞2」、原 React 版保留未动。
- 新增 START/PLAYING/OVER 标题界面（原版无，独立运行的适配）。
- 依赖系统中文字体（SystemFont fallback）。
- 实际用 Godot 4.7.2 校验的结果（跑没跑通、修了什么）。
- 玩法/画法与原版 1:1（世界 2600、150 秒、10 对手、6 种 2.5D 手绘道具）。

## 9. 新对话第一步建议
先确认已完成文件仍在：ls -R mobile/game/blackhole。再按 5.1 → 5.5 顺序逐个 apply_patch 新建；每建完一个可随手跑第 7 节的 headless 自检。全部建完后跑一次完整自检，清理临时文件，再按第 8 节给用户收尾回复。

