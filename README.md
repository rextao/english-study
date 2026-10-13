# 背单词（English-skill）

一个部署在 Cloudflare 上的英语背单词工具：查词 → 选择目标学习列表并加入 → 按艾宾浩斯节奏复习 → 打印正反面卡片。
词库来自剑桥官方词汇表 PDF，解析成统一格式的 JSON；前端和后端是同一个 Cloudflare Worker，数据在 D1 里，
桌面和手机浏览器打开同一个网址、用同一个访问令牌，看到并操作的就是同一份数据。

> 要让 AI 接手这个项目，让它先读根目录的 `AGENTS.md`，那是给 AI 的项目地图（目录职责、类型契约、接口表、改动落点），能省掉一整轮全量读代码。



<!-- AI_LOCK_START -->

目的：为了可以将单词打印出来，让小朋友背诵，顺便可以复习记录，希望3年后能KET 优秀，加油~

<!-- AI_LOCK_END -->



## 技术栈

- 前端：React 19 + TypeScript + Vite 6（`src/`），构建产物由同一个 Worker 的 assets 直接发
- 后端：Cloudflare Worker（`worker/src/`），零运行时依赖，只用平台全局（`fetch` / D1 / `waitUntil`）
- 存储：Cloudflare D1 数据库 `english-study-sync`（学习列表 / 进度 / 标签 / 目标 / 打印记录 / 词典缓存全在里头），唯一数据源
- 词典：查词链路只有云端缓存 → dictionaryapi.dev → 百度大模型翻译（本地 ECDICT 已随上云退役）
- UI 组件全部手写在 `src/ui/`，API 刻意对齐 antd，将来想换成真 antd 基本只改 import
- 鉴权：所有 `/api/*` 需要 Bearer 访问令牌（Worker secret `API_TOKEN`），首次打开页面填一次，存在浏览器 localStorage

## 快速开始

本机开发需要 Node >= 24（测试用了 `node:sqlite`）。

```bash
git clone https://github.com/rextao/english-study.git   # 已经克隆过就 cd 进去 git pull 拉到最新
cd english-study
npm install
npm run dev             # wrangler dev(8787) + vite(5173) 一起起，vite 的 /api 代理到 wrangler
```

打开 http://localhost:5173，首次会弹出令牌门，填访问令牌（`API_TOKEN` secret 的值）即可。

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 本地开发：wrangler dev + vite 一起起 |
| `npm run build` | 类型检查 + 打包到 `dist/` |
| `npm run test:server` | 服务端测试，282 项，跑在临时目录的 node:sqlite shim 上、不联网，不会动你的数据 |
| `npm run migrate:to-d1` | 把本地历史 sqlite 生成 migration.sql（已迁移过就不用再跑） |
| `npm run deploy` | 构建 + `wrangler deploy`（Worker + 静态资源一起发） |

## 部署（一次性配置）

```bash
npm run build
npx wrangler deploy

# 首次 / schema 变更：建表
npx wrangler d1 execute english-study-sync --remote --file=worker/schema.sql

# 从本地历史 sqlite 迁数据（幂等：先 DELETE 再 INSERT）
npm run migrate:to-d1
npx wrangler d1 execute english-study-sync --remote --file=migration.sql

# 密钥（Worker secret，不进 git）
npx wrangler secret put API_TOKEN
npx wrangler secret put BAIDU_TRANSLATE_API_KEY
npx wrangler secret put BAIDU_TRANSLATE_APP_ID
```

部署完成后，桌面和手机浏览器打开 `https://english-study-mobile.rextao666.workers.dev`（Worker 名见 `wrangler.toml`），填同一个访问令牌即可。本地 `cache/study-history.sqlite` 迁移后保留作回滚兜底，应用不再读写它。

## 五个页面

### 查词（首页）

输入单词，停手 400ms 自动查询，显示音标和中文词义（页面上不显示例句）。点击「+ 学习」后可选择这一阶段要背的中文词义，再加入搜索区域选定的学习列表。
词下面显示它属于哪些词库的标签，**不属于任何词库就不显示标签**。
词的右上角有个小按钮，点它把词加进学习列表。

### 批量导入（查词页里的第二个模式）

查词页标题左上角有一个「批量导入」按钮，点一下就切到批量导入模式；导入模式下按钮变成「← 返回查询」，点回来。
粘贴多行文本，每行一个单词或句子；确认导入前可以逐条选择要背的中文词义。
输入框上方是词库筛选标签，点一下就只留下属于该词库的行；句子按「句中出现过该词库的词」判断，能容忍 apples → apple 这类常见变形。
左上角选导入到哪个学习列表，也可以现场新建列表。
导入完成后，服务端会在后台队列把音标补上（不重翻中文），页面上能看到进度。

### 学习列表

顶部切换列表，右侧新建。默认列表 `default` 不能删。
词条一行一个平铺，显示单词、音标、已选择的中文词义和词库标签，也能移除；加入时选择的词义会保存为快照。
要一次清掉一批，点工具条上的「多选」：每行前面出现勾选框（点词本身也能勾），上方有全选、已选条数和「删除选中」。筛选状态下全选只勾筛出来的那些。

### 设置

**词库**：只显示词库名称、来源文件，以及标签的改名和重置默认值。
标签就是这个词库在别处（查词页、导入页）显示成什么名字，默认是词库 id；另有单独的打印标签，印在卡片右上角，没设过就沿用显示标签。

**查词链路**：按顺序列出查词时会依次尝试的来源——云端缓存 → dictionaryapi.dev → 百度翻译，某一步拿到完整释义就不再往后走。
灰色的步骤表示查词时会被跳过并给原因（比如百度密钥没配——密钥是 Worker secret，只能用 `npx wrangler secret put` 配，页面上只读展示）。

### 英语学习

导航栏右侧那颗会流光的胶囊，角标是今天要复习的词数。四块内容：

- **目标**：选一个词库当目标，用「已经会的词」和词库词条对比给出达成度；背了词库外的词算「目标外的获得」。
- **挑一批新词开始学**：弹窗里勾词 → 新标签页生成正反面 A4 卡片（默认每页 2 列 × 3 行；正面英文、反面音标 + 中文释义）→ 同时把当前时间记为开始学习时间。打印页可以用上下箭头分别调整单词和语句字号；单词始终保持一行，并在所选字号范围内自动缩小到卡片可容纳的最大尺寸。
- **复习计划**：月历视图 + 左上角「按天 / 按周」粒度切换。按天点某天看当天要复习的词；按周点任意一天选中整周，面板列出这一周所有到期的词。只有当前这一天 / 这一周能打卡，打卡分「记住了」（进下一轮）、「没记住」（周期从今天重来）、「退出学习」。
- **打印记录**：每导出一批卡片都会自动留一条档（标题、时间、词数、是不是按周印的、还有多少词待复习）。过一段时间——比如一周后——拿着那批卡片回来，展开记录就能整批标「记住了 / 没记住」，不必在月历里一个个点。按周印的卡片默认按周打卡；卡片里的词后来被从学习列表删掉了会自动跳过；删记录只是删档，不动学习进度。只留最近 60 条。

按周模式适合一周只坐下来复习一次的节奏：卡片按整周一批导出（「打印整周卡片」），打卡时会把这一周内排到的多个复习轮次一次过完——比如周一开始学的词，第 1 / 2 / 4 天都落在同一周，按周打一次卡就直接推到下一周的轮次，行里会标「连过 N 轮」。

## 复习节奏（艾宾浩斯）

开始学习后第 **1 / 2 / 4 / 7 / 15 / 30 / 60** 天各复习一次，7 轮走完算「毕业」。
下次复习日期 = 开始那天的 0 点 + 当前轮次对应的天数；到期只按「天」判断，同一天内几点无所谓。
逾期的词不会散落在过去的日期里，全部折叠进「今天」。
按周打卡时同理，逾期的词折叠进「本周」。

「今天 0 点」按用户时区算：Worker 进程是 UTC，服务端用 `DICT_TZ_OFFSET_HOURS`（`wrangler.toml` 里配了 8）做偏移。

## 数据存在哪

唯一数据源是 Cloudflare D1 库 `english-study-sync`，桌面和手机看到的就是同一份，没有同步、没有快照。

| 表 | 内容 |
| --- | --- |
| `lists` / `list_words` | 学习列表和词条（含累计次数、排期锚点、幂等键） |
| `learning_events` / `learning_event_meanings` | 打标日志（撤销 = 软删） |
| `meaning_profiles` | 内容寻址的词义画像 |
| `kv` | 词库标签 / 学习目标 / 打印批次 / 补齐队列状态（整份 JSON 一行） |
| `dict_cache` | 词典缓存，一个词一行 |

本地仓库里：`vocab/*.json` 是词库本体（构建期打包进前端）；`cache/` 只剩迁移前的历史遗留，不进 git。
访问令牌存浏览器 localStorage（key `es-api-token`）；词库标签也在浏览器留一份镜像，服务端可用时以服务端为准。

## 词库格式与新增词库

统一格式定义在 `vocab/format.md`，一个词库就是一个 JSON 文件：

```json
{
  "id": "a2-key-2020",
  "name": "A2 Key Vocabulary List",
  "level": "A2",
  "source": "Cambridge English (UCLES 2025)",
  "description": "可选",
  "words": [
    { "word": "a few", "pos": ["det", "adj", "pron"], "examples": ["I invited a few of my friends."] }
  ]
}
```

现有词库：`vocab/ket.json`（剑桥 A2 Key，1661 条词条）。

新增一个词库：

1. 把词表整理成上面的格式，存成 `vocab/<id>.json`；`id` 用 kebab-case、全局唯一。
2. 重新构建 / 重启 dev（`vocab/*.json` 是构建期打包进去的，热更新不一定认新文件）。
3. 需要的话在 `vocab/` 里放一个 `parse_<来源>.py`，方便以后重新解析。

从 PDF 解析的现成例子是 `vocab/parse_a2_key.py`，两步：

```bash
pdftotext -layout 506886-a2-key-2020-vocabulary-list.pdf _pdf_raw.txt
python3 vocab/parse_a2_key.py
```

需要 poppler 的 `pdftotext`（macOS `brew install poppler`）。
注意这个脚本认的是「单词 (词性)」+ 圆点开头例句的版式，**换一份排版不同的 PDF 就得改里面的正则**，它不是通用解析器。

## 释义从哪来

查一个词的顺序：

1. D1 词典缓存里已经查齐的（`status: ok`）直接用；
2. dictionaryapi.dev 给单词音标和英文释义全集，百度大模型文本翻译 API 给中文；句子直接交给百度翻译（逐词拼音标）。

外部接口有限流，批量补齐走后台队列：并发 2、每次间隔 250ms（Worker 里用 `waitUntil` 驱动，一次请求约 30 秒内跑不完的留在队列里，下次补齐接着跑）。百度密钥是 Worker secret（`BAIDU_TRANSLATE_API_KEY` / `BAIDU_TRANSLATE_APP_ID`），接口地址可用 `BAIDU_TRANSLATE_API_URL` 覆盖。
一条缓存只有音标 / 释义 / 中文都拿到才标成 `ok`，缺一块标 `partial`，下次查会自动重取。
带空格的短语和句子不查 dictionaryapi.dev（查不到），音标逐词拼回。
「一个汉字都没有」的百度返回会被当失败，不写进缓存。

关于例句：**应用不显示例句**——词卡只有音标 + 中文释义，打印卡片反面同样只印音标 + 中文，缓存里也不存例句字段。

设 `DICT_NO_NETWORK=1` 可以完全断网跑（只吃缓存），服务端测试就是这么跑的。

## 常见问题

- **页面弹令牌门 / 提示「云端服务不可用」**：令牌没填或填错了，填 Worker secret `API_TOKEN` 的值；云端连接失败则检查网络或 Worker 是否在线。
- **查词一直没有中文**：百度两个 secret 没配或百度翻译 API 不可用。服务端会把「一个汉字都没有」的返回当失败，不会把错误提示写进缓存。
- **点打印卡片没反应**：浏览器拦了新标签页，允许本站弹窗后重试，或者改用「仅标记开始学习」。
- **卡片上没有音标**：那些词的词典数据还没补齐，等导入后的后台队列跑完，或重新查询这些词。
- **打印记录里的词写着「已移除」**：那个词后来被从学习列表删了，整批打卡时会跳过它，同一批的其他词照常标记。
- **卡片开出来了，却提示「打印记录没保存」**：请求中途失败。卡片和学习进度都不受影响，只是这一批没进「打印记录」，之后不能整批打卡。补救办法：在月历里给这些词单独打卡，或者等它们到期时用「今日复习 / 打印整周卡片」再导一次，那次会重新留档。
- **打印页如何排列**：卡片默认按 A4 横向、2 列 × 3 行排版，奇数页是英文正面，偶数页是对应的音标与中文反面；偶数页会逐行左右镜像，行的上下顺序不变，方便短边翻转双面打印后裁切对齐。顶部可分别调整单词和语句字号，单词不会换行，过长时会自动缩小；反面的音标和中文也会作为整体自动使用卡片可容纳的最大字号。
