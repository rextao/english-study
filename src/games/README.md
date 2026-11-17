# 单词游戏：可复用的统一能力

这里只记录**当前已经存在、新游戏直接能用**的公共能力。玩法细节看各游戏子目录，接口与约束看根目录 `AGENTS.md`。

## 1. 注册与入参

- `registry.ts`：`GAMES` 数组是唯一清单，加一个游戏 = 加一条 `GameManifest`；`findGame(id)` 按 id 查。
- `types.ts`：
  - `GameWord`：`{ word, translation }`，游戏里只给孩子看中文。
  - `GameProps`：`{ words: GameWord[]; onNextRound?: () => void }`，外壳下发，游戏组件不请求接口。
  - `GameManifest`：`{ id, title, subtitle, emoji?, ready?, Component }`；`ready: false` 的条目汇总页不展示、路由也进不去。
- 约定：游戏只管关卡、判定与表现，不碰路由、不碰 `/api`、不碰加载态。

## 2. 路由与页面外壳（`GamesPage.tsx`）

- hash 路由：`#/games/home` 汇总页、`#/games/<id>` 模式选择页、`#/games/<id>/normal|endless` 进游戏。
- 外壳负责：`findGame` 取组件、`ready` 过滤、按模式取词、`key={id:mode:round}` 重挂载（换游戏 / 换模式 / 换回合都从第一关重来）。
- 统一状态提示（中文，带「去游戏列表」链接）：加载中、读取失败、单词太少（`words.length < 3`）、游戏不存在。
- 无尽模式下把 `onNextRound` 交给游戏：`onNextRound()` 让外壳 `round + 1` 换一批新词。
- 汇总页 `GamesHome.tsx`、模式选择页 `GameModePage.tsx` 自动读取 `GAMES`，新增游戏不需要改这两个文件（汇总页没有返回按钮，模式页顶部「← 换个游戏」）。

## 3. 取词（`data.ts`）

- `useGameWords(enabled)`：常规模式词源，与背词页同源——优先「进行中」会话的卡片，否则本周任务词表；句子卡与无中文释义的词不进游戏，按小写去重，`stripTranslationPos` 去掉 `n.` / `v.` 这类词性前缀。
- `useEndlessGameWords(enabled, round)`：无尽模式词源，每回合从设置页配置的取词范围（学习列表 + 可选的具体单词，未配置即全部）随机抽 `ENDLESS_ROUND_SIZE`（20）个带中文释义的单词；`round` 变化重新抽一批。
- 两者都返回 `GameWordsState { words, loading, error }`，错误信息可直接展示。
- 词表接口走共享读缓存 `apiCache`（`/api/lists` 30s，列表单词 5 分钟），反复开新回合不重复打接口。

## 4. 牌堆与发牌（`data.ts`）

- `shuffleWords(list)`：Fisher–Yates，返回新数组，不改入参。
- `createWordDeck(words)`：整局一个词只取一次；暴露 `words / total / taken / remaining / finished / draw() / drawMany(n) / restart()`，牌堆空了就是这一局单词用完。
- `dealWordRounds(words, perRound)`：按每关最多 `perRound` 个词平均分关（7 词给 4+3，不留只有一对的尾巴），内部同样走牌堆，打完最后一关 = 全部用完。

## 5. 样式与视觉 token（`games.css`）

- `.games`：全屏游戏壳（`position: fixed; inset: 0;`、safe-area padding、粉彩背景 `#FDF9F7`、圆体字体），不渲染导航。
- `--g-*` 变量：`--g-primary / --g-primary-tint / --g-primary-wash / --g-primary-deep / --g-line / --g-ink / --g-ink-2 / --g-ink-3 / --radius-full`，子游戏 css 直接使用（与背词页同一套配色）。
- `.games__notice` / `.games__notice-sub`：外壳的空态与提示样式。
- 汇总页 / 模式页样式：`.gh__*`、`.gm__*`。

## 6. 单词发音开关（`sound.tsx`）

- `GameSoundProvider`：由游戏外壳包住所有游戏页；喇叭默认**打开**，偏好存 `localStorage` 的 `es-games-sound`（`on` / `off`），刷新和换游戏都保留；关掉时会 `stopSpeech()` 掐掉正在播的声音。
- `GameSoundToggle`：右上角喇叭按钮（开 = 波纹，关 = 打叉），只在 `GamesPage` 里渲染一次，所有游戏共用；样式 `.games__sound` / `.games__sound.is-off` 在 `games.css`。
- `useGameSound()`：游戏组件里取 `{ enabled, setEnabled, toggle, speakWord }`。
  - `speakWord(word)`：喇叭开着时走 `utils/speech` 的 `speak()` 播 `/api/tts` 发音；关着时什么都不做，失败也静默，不打断游戏、不弹提示。
  - 已经接入的点击：消消乐点英文牌、打怪兽拖起英文球（中文牌 / 中文球不读）；打怪兽里先拖中文球再合到英文球上时，英文球没被拿起过，改在合上的那一刻读一遍。
  - 起播交给 `speak()` 里的 `unlockSpeech()`：先在手势里把共用的 `<audio>` 解锁，await 取完音频再播（否则 iOS 会静默拦掉）。
  - 没有 Provider（比如单独预览某个游戏）时返回静音的空实现，不会报错。

## 7. 接入一个新游戏的最小步骤

1. 建 `src/games/<id>/XxxGame.tsx`，接收 `GameProps`，用 `data.ts` 的牌堆 / 发牌函数发词。
2. 建 `src/games/<id>/index.ts` 导出 `GameManifest`。
3. 往 `registry.ts` 的 `GAMES` 加一条（没写完给 `ready: false`）。
4. 需要发音时，在点击英文单词的地方调 `useGameSound().speakWord(word)`；右上角开关和静音逻辑不用自己实现。

路由、取词、无尽换批、加载 / 错误提示、配色变量、发音开关都由上面的公共层提供，不需要改动。
