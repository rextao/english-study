# AGENTS.md — 项目地图（给 AI 读）

读完这一份就能直接动手改代码，不必再全量扫源码。面向人的使用说明在 `README.md`；两份分工：README 讲「怎么用」，这份讲「怎么改」。

## 协作方式（给 AI：优先并行子 agent）

- **能并行就并行**：只要任务能拆成互相独立的小块，且用并行子 agent 能提高效率，就尽量开多个子 agent 同时干，不要人为限制数量或场景。默认倾向并行，而不是串行。
- **典型该并行的活**：全库检索 / 批量读多个文件 / 分头调研多个模块（如同时看 `src/pages/*` 和 `worker/src/*`）/ 跑多组互不影响的检查 / 对照多个数据流或接口。扇出型、只读型任务一律优先派子 agent。
- **串行只在有依赖时**：下一步要用上一步的结果，才按顺序来；没有依赖关系就别排队。
- **并行不越过硬约束**：子 agent 同样守下面「硬约束」——删文件 / 动 git / 改 AI 锁定区前先问用户；写盘类改动要收口协调，避免多个子 agent 改同一文件打架。最终的 `npm run build` / `npm run test:server` 验证由主 agent 统一兜底。

## 是什么

背单词应用，前后端整体部署在 Cloudflare 上。前端 React 19 + TypeScript + Vite 6（`src/`），构建产物由同一个 Worker 的 [assets] 直接发；后端是 Cloudflare Worker（`worker/src/index.js`）+ D1 数据库（SQLite 方言），页面与 `/api` 同源、无 CORS。数据库 `english-study-sync`（学习列表 / 历史 / 标签 / 目标 / 打印批次 / 词典缓存全在里头），词库本体是 `vocab/` 下构建期打包的 JSON。查词链路只有云端缓存 → dictionaryapi.dev → 百度翻译（本地 ECDICT 已随上云退役）。所有 `/api/*` 需要 Bearer 令牌（Worker secret `API_TOKEN`）。UI 文案和代码注释一律中文。

历史上的本地 Node 服务（`server/dict-server.mjs`，127.0.0.1:3456）、本地 ECDICT 词典（`data/ecdict/`）与快照同步机制（`worker` 里的 sync API、手机端 `mobile/` 独立应用）均已删除。

## 硬约束（动手前先看）

- **Node 24**：每条 node / npm 命令前先 `export PATH=/Users/rextao/.nvm/versions/node/v24.18.0/bin:$PATH`（系统默认 node 23 跑不了测试——`node:sqlite` 需要 24）。
- **AI 锁定区不可改动**：用户用 `<!-- AI_LOCK_START -->` / `<!-- AI_LOCK_END -->` 包起来的文字，任何情况下都不要修改、删除、挪位置或改写——重排格式、批量替换、翻译、润色、压缩文档时也必须原样保留，两条标记注释本身也不要动。非要动那块区域时先问用户。
- **零新增运行时依赖**：Worker 只用全局（`fetch` / `crypto.randomUUID` / `TextEncoder`），测试只用 `node:sqlite`；`npm i` 在沙箱里无外网会失败，也不要引 express / wrangler 之外的运行时依赖。
- **UI 禁原生控件**：页面里不要出现 `<select>`、`<textarea>`、`type='checkbox'`，统一用 `src/ui` 里的 `Select` / `TextArea` / `Checkbox`。
- **TS 严格**：`tsconfig.app.json` 开了 `strict` + `noUnusedLocals` + `noUnusedParameters` + `noFallthroughCasesInSwitch`（**没开** `noUncheckedIndexedAccess`）。
- **验证命令**：`npm run build`（= `tsc -b && vite build`）必须 exit 0；动过 `worker/` 再跑 `npm run test:server`（282 项断言，跑在临时目录的 node:sqlite shim 上，不碰真实数据）。
- **密钥不进 git**：`API_TOKEN` / 百度翻译密钥只能通过 `npx wrangler secret put <NAME>` 配成 Worker secret；沙箱连不了外网，部署 / 建表 / 迁数据 / 配密钥由用户在本机执行。
- **免费版 CPU 限制**：Workers 免费版每请求 10ms CPU。store 的写路径是「一个 batch 事务整表重写」，当前数据量（<1MB）没问题；若超限优先把热点写路径改成行级 UPSERT。

## 目录地图（一行一职责）

```
src/main.tsx                   挂载 React，引入 index.css
src/App.tsx                    状态中枢：useVocabLibraries / useStudyList / useStudyPlan / useTabRoute 都在这里，
                               按 tab 渲染五个页面并把 props 往下传；TokenGate（令牌门）也在这里挂——
                               localStorage 无令牌或任何请求 401 时整页只渲染令牌输入
src/App.css                    通用类：.page/--narrow/--wide(1080) .card/--pad .callout/--success/--error/--warn
                               .hint .empty/--inline .field-label .page-header
src/index.css                  设计 token：--color-* --radius-* --shadow-* --content-width --nav-height --font-*
src/types/vocab.ts             所有共享类型；前后端字段的唯一约定处

src/pages/SearchPage.tsx       查词页：标题左上角一个切换按钮（mode state）切到批量导入，导入模式内嵌 ImportPage embedded；
                               查词模式 = 输入 400ms 防抖 → useDictionary；词库命中 → useVocabMatch；渲染 WordCard
src/pages/ImportPage.tsx       批量导入：多行文本 → 归一化 / 去重 / 词库筛选（NO_FILTER | ANY_LIB | 词库 id）
                              → 预览上限 200 行 → 先 POST /api/dict/search-batch 走完整查询链路选好中文
                              → study.importItems → useDictPrefetch 盯后台补齐进度
                              ；embedded=true 时不渲染页头和 .page 外壳（嵌进查词页），目标列表控件抽成 targetControls 复用
src/pages/ListsPage.tsx        学习列表：切换 / 新建 / 重命名 / 删除；词条平铺一行一个；useDictBatch 取音标和中文词义；
                               「批次」checkbox → 按加入日期分成批次展示，批次可就地重命名（自定义名 + 只读日期 Tag）；
                               「多选」开关 → 每行勾选框 + 全选 + 批量删除（二次确认）
src/pages/LibrariesPage.tsx    词库标签页（已并进设置页）：只显示 name + file + 显示标签 / 打印标签改名 / 重置默认值；
                               embedded=true 时不渲染页头，主体抽成 content 变量
src/pages/StudyPage.tsx        英语学习页：StudyGoal + 挑词弹窗（Modal，勾词 → 打印卡片 + plan.startWords）
                               + 月历复习计划：「按天 / 按周」粒度切换（mode，只存组件 state），
                               按天选一天 / 按周选整周，逾期折叠进今天或本周，只有当前这天 / 这周可打卡
                               + 打印记录：每导出一次卡片留一条档，可整批打卡 / 删记录（usePrintBatches）

src/pages/SettingsPage.tsx     设置页（tab=settings）：顶部「词库配置 / 学习列表 / 学习记录 / 查询链路」子菜单切换；
                               查询链路 = useDictSources.chain 排成有序列表（云端缓存 → dictionaryapi → 百度翻译），
                               不可用的步骤灰色标「跳过」并给原因（密钥未配 = Worker secret 没配）；
                               词库配置 = LibrariesPage embedded
src/pages/AchievementsPage.tsx     学习成果页（tab=achievements）：目标达成度统计；onManageRecords 跳记录页
src/pages/LearningRecordsPage.tsx  学习记录页（tab=records，导航里没有，从成果页进）：学习 / 打卡日志明细

src/components/Nav.tsx         顶部导航：普通 tab = 查词 / 学习列表 / 学习成果（列表角标 = totalItems）
                               + 右侧「英语学习」流光胶囊（角标 = plan.dueCount）+ 齿轮图标按钮（设置）；
                               TabKey 定义在此（settings / records 都不在 tab 里，visibleActive 把 records 高亮到「学习成果」）
src/components/TokenGate.tsx   访问令牌门：首次打开 / 401 时填令牌；令牌存 localStorage（key es-api-token）
src/components/PageHeader.tsx  页面标题区（title / subtitle / actions），样式在 App.css
src/components/WordCard.tsx    词卡：音标 / 词库标签 / 中文释义 / 右上角「加入学习」小按钮；
                               卡片上不显示英文释义、也不显示例句
src/components/StudyGoal.tsx   目标模块：目标词库（useStudyGoal）vs 已开始学的词 → 达成度 +「目标外的获得」；
                               buildFormIndex 做词形宽松匹配

src/hooks/useTabRoute.ts       hash 路由（#/search #/lists #/settings #/achievements #/records #/study），刷新与前进后退都停在原页；
                               LEGACY_TABS 把 #/import → #/search、#/libraries → #/settings，老书签不会失效
src/hooks/useSearch.ts         useVocabMatch：词 → 命中的词库 id 列表（纯内存 Map，不走网络）
src/hooks/useDictionary.ts     单词查询 GET /api/dict；模块级 entryCache（TTL 5 分钟），同一个词反复查不再打接口
src/hooks/useDictBatch.ts      批量读缓存 POST /api/dict/batch → entries / missing / incomplete
src/hooks/useDictPrefetch.ts   后台补齐队列：repair() 排队 + 1.2s 轮询进度；响应认不出就报 stale 而不是照抄进 state
src/hooks/useDictSources.ts    词典来源状态 GET /api/dict/sources（字段校验不过 / 老服务 404 → null，界面不显示）；
                               buildChain 排成设置页的查词链路（缓存 → dictionaryapi → 百度翻译，不可用给原因）
src/hooks/useStudy.ts          某个词在哪些学习列表里（查词页用）；模块级 membershipCache（TTL 5 分钟），
                               markAdded 增量更新；useStudyList 删词 / 删列表时调它导出的 invalidateMembership 作废
src/hooks/useStudyList.ts      学习列表全套 CRUD + 导入 + senseIds + 批量移除（removeItems）；导出类型 StudyListApi；
                               fetchListWords / fetchBatches 走共享读缓存（studyListCache），写操作自己作废
src/hooks/useStudyPlan.ts      复习计划 GET /api/study/plan + startWords + reviewWords + tallyUndo；
                               三个写操作成功后按 listId 作废 studyListCache 的词条缓存（否则学习页打卡后停在旧数据）
                               导出 StudyPlanApi / ReviewAction / ReviewOptions
src/hooks/usePrintBatches.ts   打印批次：留档 + 整批打卡 + 删记录（/api/print-batches 四个接口）；
                               导出 PrintBatchesApi；只在 StudyPage 里用，不进 App.tsx
src/hooks/useStudyGoal.ts      目标词库读写 GET|PUT /api/study/goal
src/hooks/useVocabLibraries.ts 构建期打包 vocab/*.json + 标签读写 + localStorage 镜像与迁移
src/hooks/useLearningRecords.ts 学习记录页的数据层：achievements / history 分页 / 删事件 / 清词 / purge

src/ui/                        手写组件库：Button Select Dropdown Input(含 TextArea) Checkbox Tag Popconfirm
                               Popover Modal + useDismiss；统一从 src/ui/index.ts 导出（它顺带 import ui.css）
src/utils/apiBase.ts           API 基址（恒为 ''，同源）+ getStoredToken/setStoredToken + apiFetch
                               （统一带 Bearer 头、401 时广播 AUTH_REQUIRED_EVENT）+ apiJson
src/utils/studyListCache.ts    学习列表读结果的模块级内存缓存（词条 + 分组名，TTL 5 分钟）；
                               useStudyList / useStudyPlan / usePrintBatches 三个写 hook 共用它，
                               谁改了 list_words 就调 invalidateWords / invalidateBatches / invalidateList
src/utils/flashcards.ts        打印卡片：fetchCards（顺手补释义）/ pickSenses / mirrorRows / buildFlashcardsHtml；偶数页逐行左右镜像
                               / openCardWindow；卡片反面只印音标 + 中文，英文释义不上卡片
                               / renderCardsInto（打印会话 + 卡片右上角 ✕）
src/utils/translations.ts      中文词义工具：translationOptions / selectedTranslationOptions
                               / formatTranslationOptions；formatTranslationWithCustom 把自定义词义并进摘要

worker/src/index.js            Worker 入口：/api/* 先校验 Bearer 令牌（safeEqual 恒定时间比较，health 免鉴权）
                               再进 handleApi；其余请求交给 env.ASSETS（vite 构建产物，SPA 回落）
worker/src/app.js              每请求应用上下文 createApp(env, waitUntil)：db 适配层 + 各 store + config
worker/src/db.js               D1 最小适配层：all / first / run / batch（batch = 事务）；测试用 node:sqlite 实现同一接口
worker/src/routes.js           全部 /api 路由（handleApi 纯函数，返回 {status, body}；fetch 与测试共用）
worker/src/dict.js             词典链路：缓存 → dictionaryapi.dev → 百度大模型翻译；normalizeEntry / mergeEntry /
                               resolveEntry / resolvePhoneticOnly / search-batch 的 mapConcurrent
worker/src/prefetch.js         后台补齐队列：状态存 D1 kv（prefetch-state），执行走 app.waitUntil
                               （生产 = ctx.waitUntil，测试收进数组）；队头「认领」写回缩小并发撞车窗口
worker/src/review.js           艾宾浩斯算法：REVIEW_INTERVALS / nextDueAt / studyState / applyReview（打卡唯一实现）
worker/src/lists.js            列表领域服务：loadLists / saveLists / syncListTranslation / selectedTranslation /
                               标签 / 目标 / 打印批次三份小文档 / enrichBatch
worker/src/study-lists.js      lists / list_words 两张表的 store（行 ↔ StudyWordItem 映射，save = 整库 batch 重写）
worker/src/study-history.js    learning_events / meaning_profiles store：内容寻址词义身份 + 聚合 + 软删
worker/src/kv.js               kv 表（标签 / 目标 / 打印批次 / 补齐状态整份 JSON 一行）+ dict_cache 表（一词一行）
worker/src/text.js             normalizeText / capitalizeSentence（全库唯一主键规则）
worker/src/sha256.js           纯 JS 同步 SHA-256（Workers 没有 node:crypto 的同步 createHash；
                               输出与 node:crypto 一致，迁移来的旧 meaning_key 能对上）
worker/schema.sql              全量建表 SQL（wrangler d1 execute 一次性执行；含 DROP 废弃的 sync_snapshot）

worker/test/d1-shim.mjs        node:sqlite 模拟 D1 接口（prepare→bind→all/first/run + batch 事务）
worker/test/api.test.mjs       282 项断言：直接驱动 handleApi + 走真正 workerIndex.fetch 的鉴权用例
scripts/migrate-to-d1.mjs      本地 study-history.sqlite → migration.sql（INSERT 语句），wrangler d1 execute 导入

vocab/format.md                词库统一格式（唯一规范来源）
vocab/ket.json                 剑桥 A2 Key，id=a2-key-2020，1661 条词条
vocab/parse_a2_key.py          pdftotext 文本 → 词库 JSON；正则与该 PDF 版式绑定，不通用
506886-a2-key-2020-vocabulary-list.pdf   词库原始 PDF
wrangler.toml                  部署配置：name=english-study、[assets] binding=ASSETS、D1 绑定 DB、DICT_TZ_OFFSET_HOURS=8
```

## 状态归属与数据流

```
App.tsx（唯一状态中枢，避免切 tab 后数据不同步）
 ├ useVocabLibraries → libraries / getLabelById / updateLabel / resetLabel → 所有页面
 ├ useStudyList      → study: StudyListApi                                → Search / Import / Lists / Study
 ├ useStudyPlan      → plan: StudyPlanApi                                 → Nav 角标 + StudyPage
 ├ useTabRoute       → [tab, setTab]
 └ TokenGate         → 令牌存 localStorage；apiFetch 收 401 时广播事件，App 重新弹门

页面 / 组件 ──apiFetch('/api/...')（同源 + Bearer）──▶ Cloudflare Worker（worker/src/index.js）
                                             ├ D1 english-study-sync
                                             │    ├ lists / list_words（学习列表，study-lists.js）
                                             │    ├ learning_events / learning_event_meanings（打标日志，study-history.js）
                                             │    ├ meaning_profiles（内容寻址词义画像）
                                             │    ├ kv（标签 / 目标 / 打印批次 / 补齐状态，kv.js）
                                             │    └ dict_cache（词典缓存，kv.js）
                                             └ 外部：dictionaryapi.dev / 百度大模型文本翻译 API（缓存没有才走）

vocab/*.json ──import.meta.glob(eager, 构建期打包)──▶ useVocabLibraries
```

页面内的局部状态：`useDictionary` + `useStudy` 在 SearchPage；`useDictBatch` 在 ListsPage；`useDictPrefetch` 在 ImportPage（查词页以 embedded 形式渲染时也归 SearchPage）；`useStudyGoal` 在 StudyGoal 组件内部；`useDictSources`（查词链路）在 SettingsPage；`usePrintBatches` 在 StudyPage 内部（只有那一页要打印记录）。

## 类型契约（`src/types/vocab.ts`）

```ts
DictionarySource 'ecdict' | 'api'                           // 'ecdict' 只出现在迁移来的旧缓存里，新查词不会再产生
DictionarySense  { id, pos, definition }                     // id = pos + '#' + 该词性下序号，如 noun#0；没有例句字段
DictionaryEntry  { word, phonetic?, translation?, senses: DictionarySense[], cachedAt,
                   status?: 'ok'|'partial', source?: DictionarySource }

VocabWord        { word, pos: string[], examples: string[] }
VocabLibrary     { id, name, level, source, description?, words: VocabWord[] }
VocabLibraryInfo extends VocabLibrary { file }               // file 如 vocab/ket.json，词库页要显示

StudyState       'new' | 'due' | 'scheduled' | 'mastered'
StudyMarkAction  'start' | 'restart' | 'done' | 'again' | 'stop' | 'print' | 'spelling' | 'reading' | 'meaning'
StudyMarkScope   'day' | 'week'
StudyWordItem    { word, type: 'word'|'sentence', sourceIds: string[], addedAt, phonetic?, translation?,
                   senseIds?, customTranslations?: string[], startedAt?, stage?, reviewedAt?: number[], lastDoneAt?,
                   reviewScope?: 'day' | 'week',    // 最近一次 done/again 打卡的粒度，week = 排到下周一
                   markCount?, reviewCount?, spellingCount?, readingCount?,
                   rememberedCount?, forgottenCount?, processedReviewKeys?, // 日志、累计次数与幂等键，界面不显示
                   nextDueAt?: number|null, state?: StudyState }   // 后两个是服务端派生，不落盘
StudyList        { id, name, createdAt, wordCount }
StudyListDetail  extends StudyList { words: StudyWordItem[] }

StudyPlanItem    extends StudyWordItem { listId, listName, weekStart }  // weekStart = 开始那周周一 0 点
StudyPlan        { intervals: number[], today: number, items: StudyPlanItem[] }

PrintBatchItem   { listId, listName, word, missing?, state?, stage?, nextDueAt? }   // 后四个派生，不落盘
PrintBatch       { id, printedAt, kind: 'start'|'review', scope?, title, wordCount,
                   items: PrintBatchItem[],
                   reviewedAt?, reviewAction?, reviewedCount?, reviewCount?,        // 最近一次整批打卡
                   dueCount, markableCount, missingCount }                          // 派生，不落盘
```

`phonetic` 和 `translation` 是加入学习列表时保存的音标、中文翻译快照，旧数据可以没有；`translationIds` 是加入时选择的中文词义 id 子集。`senseIds` 是兼容旧数据的英文释义 id 子集。中文释义**全集**永远存在词典缓存里。`customTranslations` 是用户手填的自定义中文词义（没有词性、没有 id），上限 6 条 / 单条 60 字（`MAX_CUSTOM_TRANSLATIONS` / `MAX_CUSTOM_TRANSLATION_LEN`，前后端常量同名同值）。

`markCount` / `reviewCount` / `spellingCount` / `readingCount` / `rememberedCount` / `forgottenCount` = 去规范化的累计次数，**界面上一律不显示**，落盘供后续统计使用。打标日志本身（时间 / 动作 / 粒度 / 轮次）**只写 D1 事件表**：撤销已改成事件软删，镜像同步不上。`markCount` 记总打标次数；`reviewCount` 只数实际 done/again 复习操作（done = 进入下一轮）；`spellingCount` / `readingCount` / `rememberedCount` / `forgottenCount` 分别统计会拼、会读、知意和没记住，**四者完全独立**。会拼 / 会读 / 知意走 action=`tally`（`successKind` 必传），只加对应计数，**不推进轮次、不改排期**，可重复点击各算一次；done 只推进轮次不加熟悉度计数。`lastDoneAt` 记最近一次 done 打卡时间，是轮次排期的锚点。`processedReviewKeys` 最多保留最近 80 个复习任务键，用于网络重试和重复点击幂等。

打印批次里**只存 `listId` + `word`**，每个词的 `state` / `stage` / `nextDueAt` 以及批次上的 `dueCount` / `markableCount` / `missingCount` 都是读接口时从学习列表现算的（`enrichBatch`）——同一个词的进度只有学习列表一个来源，不会两处打架。打印之后被移出列表的词，批次里标 `missing`，整批打卡时跳过它。

## 服务端接口表（`worker/src/routes.js`）

所有 `/api/*`（除 `/api/health`）需要 `Authorization: Bearer <API_TOKEN>`，401 时前端弹令牌门。

| 接口 | 作用 | 前端调用方 |
| --- | --- | --- |
| `GET /api/health` | 探活，免鉴权 `{ok, time}` | — |
| `GET /api/dict?word=&refresh=1` | 查词，顺序 = 缓存 → 外部接口；`refresh=1` 跳过缓存 | useDictionary |
| `POST /api/dict/batch` `{words}` | 批量读缓存 → `{entries, missing, incomplete}` | useDictBatch、flashcards.ts |
| `POST /api/dict/search-batch` `{words}` | 批量执行完整查询链路（缓存→dictionaryapi→百度）→ `{results, total, succeeded, failed}`；上限 200 词 | ImportPage |
| `POST /api/dict/prefetch` `{words, force?}` | 把词排进后台补齐队列 | （repair 内部） |
| `GET /api/dict/prefetch` | 队列进度 `{total,done,failed,pending,running,finished}` | useDictPrefetch |
| `POST /api/dict/repair` `{words?, force?}` | 扫学习列表里缺音标 / 缺释义的词并排队 | useDictPrefetch.repair |
| `GET /api/dict/sources` | `{network, cache:{total,complete}, external:[...]}`；**没有 local 字段**（云端无本地词典）；百度密钥状态只读（secret 不可经 API 写） | useDictSources |
| `GET /api/cache/stats` | 缓存统计 | — |
| `GET /api/lists` | 所有列表（含 default） | useStudyList |
| `POST /api/lists` `{name}` | 新建列表，重名报错 | useStudyList |
| `PATCH /api/lists/:id` `{name}` | 重命名 | useStudyList |
| `DELETE /api/lists/:id` | 删除，`default` 被服务端拒绝 | useStudyList |
| `GET /api/lists/:id/words` | 列表词条 | useStudyList.fetchListWords |
| `POST /api/lists/:id/words` `{text, sourceIds?, senseIds?, translationIds?, customTranslations?, batchKey?, batchName?}` | 加一条并保存选择的中文词义；响应后只排音标补齐，不重新翻译 | useStudyList.addItem |
| `PATCH /api/lists/:id/words/:text` `{senseIds?, translationIds?, translation?, customTranslations?}` | 改释义 / 中文快照 / 自定义词义；空数组=恢复自动 | useStudyList.updateItemSenses / updateItemTranslations |
| `DELETE /api/lists/:id/words/:text` | 移除 | useStudyList.removeItem |
| `POST /api/lists/:id/import` `{items}`（每项可带 `translationIds?` / `customTranslations?`） | 批量导入（中文快照由 search-batch 阶段定好），返回 `{added, skipped, queued}` | useStudyList.importItems |
| `POST /api/lists/:id/remove` `{words}` | 批量移除，返回 `{removed, missing}`；`words` 为空 → 400 | useStudyList.removeItems |
| `GET /api/lists/:id/batches` | 批次显示名 `{batchNames}` | useStudyList.fetchBatches |
| `PATCH /api/lists/:id/batches` `{date, name}` | 重命名批次；空串=重置；非法日期 400、超 40 字 409 | useStudyList.renameBatch |
| `GET /api/word-lists?word=` | 这个词在哪些列表里 | useStudy、useStudyList.getWordListIds |
| `POST /api/lists/:id/start` `{words, startedAt?, restart?, scope?}` | 标记开始学习 | useStudyPlan.startWords |
| `POST /api/lists/:id/review` | 打卡：`done` / `again` / `stop` / `tally`（`successKind` 必传）；每词 `requestIds` 幂等 | useStudyPlan.reviewWords |
| `POST /api/lists/:id/mark` `{words, action?, scope?}` | 只记打标（`print` / `spelling` / `reading`），不动排期 | —（留作底层原语） |
| `POST /api/lists/:id/tally-undo` `{words, successKind, scope?, now?}` | 撤销本周期内最近一次会拼 / 会读 / 知意（软删事件 + 计数 -1） | useStudyPlan.undoTally |
| `GET /api/study/plan` | 所有在学的词 + 节奏 + 服务端今天 0 点（`tallyCounts` 含本日 / 本周熟悉度） | useStudyPlan |
| `GET /api/study/achievements` | 永久学习成果（按词聚合） | useLearningRecords |
| `GET /api/study/history?word=&action=&limit=&offset=` | 永久历史明细（分页） | useLearningRecords |
| `GET /api/study/history/integrity` | 完整性检查 `{ok, result:'ok'}` | — |
| `DELETE /api/study/history/events/:id` | 删除单条永久事件（软删） | useLearningRecords |
| `DELETE /api/study/history/words/:word` | 清空某词全部历史 | useLearningRecords |
| `POST /api/study/history/purge` `{words}` 或 `{all:true}` | 物理删除事件 + 回退列表累计计数（保留排期锚点） | useLearningRecords |
| `GET\|PUT /api/study/goal` `{libraryId}` | 目标词库，空串=不设目标 | useStudyGoal |
| `GET /api/print-batches?limit=` | 打印记录（新在前，默认 20 条，最多留 60 条） | usePrintBatches |
| `POST /api/print-batches` `{groups:[{listId,words}], title?, kind?, scope?, printedAt?}` | 记一次卡片导出，顺带给每个词打一条 `print` 标 | usePrintBatches.record |
| `POST /api/print-batches/:id/review` | 按批次整批打卡；scope 缺省沿用打印时的粒度 | usePrintBatches.reviewBatch |
| `DELETE /api/print-batches/:id` | 只删这条记录，复习进度不动 | usePrintBatches.removeBatch |
| `GET /api/vocab-labels` | `{labels: {词库id: 标签}}` | useVocabLibraries |
| `POST /api/vocab-labels` `{labels}` | 批量合并（localStorage 迁移用） | useVocabLibraries |
| `PATCH /api/vocab-labels/:id` `{label}` | 改标签（拦空值、重名、超 40 字） | useVocabLibraries |
| `DELETE /api/vocab-labels/:id` | 重置为默认 | useVocabLibraries |
| `GET /api/vocab-print-labels` + 同构 POST/PATCH/DELETE | 打印标签（与显示标签同构的一组接口） | useVocabLibraries |

环境变量（Worker 侧）：`API_TOKEN`（secret，鉴权令牌）、`BAIDU_TRANSLATE_API_KEY` / `BAIDU_TRANSLATE_APP_ID`（secrets，百度翻译）、`BAIDU_TRANSLATE_API_URL`（可选，测试 / 自定义网关）、`DICT_NO_NETWORK=1`（只吃缓存）、`DICT_NETWORK_TIMEOUT_MS`（默认 10000）、`DICT_TZ_OFFSET_HOURS`（默认 8，见复习算法）。`wrangler.toml` 的 `[vars]` 里已配 `DICT_TZ_OFFSET_HOURS=8`。

## D1 数据结构（`worker/schema.sql`）

```
D1 english-study-sync（wrangler.toml 绑定为 DB；沿用同步时代建好的那个库）
  lists                 学习列表头（id / name / createdAt / position / batchNames JSON）
  list_words            列表词条（主键 list_id+word；持久字段含各累计次数 / lastDoneAt /
                        processedReviewKeys / reviewScope / batchKey；不含 nextDueAt / state）
  learning_events       打标日志（动作 / 时间 / 粒度 / 轮次），撤销=软删 deleted_at
  learning_event_meanings  事件 ↔ 词义画像关联
  meaning_profiles      内容寻址词义画像（meaning_key = sha256(词+种类+语言+词性+文本)）
  kv                    一整份 JSON 存一行：vocab-labels / study-goal / print-batches / prefetch-state
  dict_cache            一个词一行 entry_json

STRICT 表。schema 由 `npx wrangler d1 execute english-study-sync --remote --file=worker/schema.sql`
一次性建好，Worker 运行时不做 DDL。本地 `cache/study-history.sqlite` 已迁移进 D1
（scripts/migrate-to-d1.mjs），本地文件只作回滚兜底，不再被应用读写。
```

## 数据归属（取代旧的「跨设备共享」章节）

D1 是唯一数据源：桌面浏览器和手机浏览器打开同一个 Worker URL、带同一个令牌，看到并操作的就是同一份数据。没有同步、没有快照、没有手动提交 sqlite。本地 `cache/` 目录只剩历史遗留，不进 git。

归一化主键 = `normalizeText` = trim + 连续空白压成一个空格 + 转小写。服务端在 `worker/src/text.js`；前端还是各写一遍：`useDictBatch.keyOf`、`ImportPage.normalize`、`StudyGoal.keyOf`、`flashcards.ts`。改规则这几处要一起改（`meaning_profiles` 的 key 也按它算，改了旧画像就对不上）。

## 复习算法（艾宾浩斯，全在服务端 `worker/src/review.js`）

```
REVIEW_INTERVALS = [1, 2, 4, 7, 15, 30, 60]   // 天
nextDueAt(item) = !startedAt ? null
                : stage > 7 ? null
                : stage === 0 ? startOfDay(startedAt)
                : reviewScope === 'week' ? startOfWeek(lastDoneAt ?? startedAt) + 7 * DAY
                : startOfDay(lastDoneAt ?? startedAt) + INTERVALS[stage-1] * DAY
state           = !startedAt ? new : stage > 7 ? mastered
                : nextDueAt <= startOfDay(now) ? due : scheduled

start   已有 startedAt 的词默认 skipped（不清进度）；restart:true 才重置 stage=0 / reviewedAt=[]
        记一条 mark：第一次 start，重开 restart
review  done → stage+1（上限 7）且 lastDoneAt=now，并把粒度写进 reviewScope（week = 排到下周一）；
        again → stage=0 且 startedAt=now 且清 lastDoneAt；stop → 删掉排期字段退回 new
        reviewedAt 只保留最近 40 条；每次 done/again 都 reviewCount++
        tally（successKind=spelling/reading/meaning 必传）→ 只加对应熟悉度计数，不动轮次 / 排期
        requestIds / processedReviewKeys 保证同一复习任务重复提交不重复计数

applyReview() 是打卡的唯一实现：列表打卡（/api/lists/:id/review）和按打印批次整批打卡
（/api/print-batches/:id/review）都走它。整批打卡先按 listId 把批次里的词分组，再逐个列表调用。
```

**时区**：Workers 进程时区是 UTC，「今天 0 点」必须按用户时区算——`startOfDay` / `startOfWeek` 加 `DICT_TZ_OFFSET_HOURS`（默认 +8）偏移后取 UTC 0 点再减回来。改这块先跑测试：测试把偏移设成本机时区，用本地 `startOfDayMs` 逐值对照。

`nextDueAt` / `state` / `weekStart` 都是读接口时算的派生字段，不写进表。到期判断只比「天」。前端 StudyPage 把逾期词折叠进「今天 / 本周」，且只有当前这一天 / 这一周允许打卡。

## 词典链路（云端：缓存 → 外部）

```
GET /api/dict → ensureEntry(word, force) → resolveEntry(word, force) → { entry, network }
  1 缓存 status===ok 且未 force → 直接返回，network=false
      例外：句子的翻译来源不是百度、或音标 / 翻译不齐 → 重抓（旧缓存不能挡住重翻）
  2 NO_NETWORK：只有旧缓存可用，没有回空 partial
  3 fetchDictEntry(word)：非短语 → dictionaryapi.dev 取 phonetic + senses 全集，
      再打百度大模型文本翻译 API 取中文；dictionaryapi 404 = 确认没这个词（spellingStatus=suspect），
      超时 / 限流 = unknown，留给下次 repair
  4 句子：逐词查音标按原句拼回（允许部分成功 → phoneticStatus=partial），
      整句中文必须百度（translationSource=baidu）
  收尾 mergeEntry({ fresh, old })：这次抓的 > 旧缓存；status = (dictOk && translation) ? ok : partial
```

- 本地 ECDICT 已删除：`source: 'ecdict'` 只出现在迁移来的旧缓存里，`GET /api/dict/sources` 没有 `local` 字段。
- 容量上限：`MAX_SENSES_PER_POS=12`、`MAX_SENSES=40`、`MAX_PICKED_SENSES=12`、`MAX_BATCH_SEARCH_ITEMS=200`、`BATCH_SEARCH_CONCURRENCY=2`。
- `isBadTranslation`：空 / 等于原词 / **一个汉字都没有** → 当失败（不会写入缓存）。
- 补齐队列：`PREFETCH_CONCURRENCY=2`、`PREFETCH_PACE_MS=250`，只有真打了外部接口（`network===true`）才 sleep。执行挂在 `app.waitUntil`（生产 = `ctx.waitUntil`，平台给约 30s；没跑完的留在队列里，下次 repair 续上）。加词 / 导入只排 `phoneticOnly` 任务（不重翻中文，不覆盖快照）。
- 缓存就是 D1 的 `dict_cache` 表，无常驻内存副本，每次按需 `IN` 查询（`IN_CHUNK=80` 防 D1 绑定参数上限）。

## UI 层约定

- 组件一律 `import { X } from '../ui'`；`src/ui/index.ts` 会顺带引入 `ui.css`。API 命名对齐 antd（`size` / `block` / `allowClear` / `options` / `okText`…），将来换真 antd 基本只改 import。
- z-index 约定：`.ui-select__list` / `.ui-menu` = 30，`.ui-popover` = 40，`.ui-modal-mask` = 60。
- 白色主题。全局 token 在 `src/index.css` 的 `:root`；组件库私有 token 在 `src/ui/ui.css` 的 `:root`（`--ui-*`）。
- 每个页面 / 组件配同名 `.css`，只放局部类；跨页面复用的类放 `App.css`。加载态用 `.ui-spin`。

## 已知坑

- **所有请求必须走 `apiFetch`**（`src/utils/apiBase.ts`）：裸 `fetch` 不带 Bearer 头，云端直接 401。401 会广播 `AUTH_REQUIRED_EVENT` 让令牌门弹出，别在页面里各自造 401 处理。
- `vocab/*.json` 是 `import.meta.glob('/vocab/*.json', { eager: true })` 构建期打包的，新增词库文件后要重启 vite（或重新构建）。
- 词库标签是唯一还用 localStorage 的地方（key `vocab-labels`），只作镜像：服务端可用时以服务端为准。其余状态全在 D1，**不要往 localStorage 里加新东西**（访问令牌 `es-api-token` 除外）。
- 词库标签的改名入口**只有词库页**。查词页 / 学习列表 / 英语学习页里的标签都是只读 `<Tag color="blue">`。
- `openCardWindow()` 必须在 click 事件里同步调用，否则被浏览器当弹窗拦掉。
- `sense.id` 用「词性 + 序号」而不是内容 hash，重抓后 id 仍然对得上，所以 `senseIds` 存 id 是安全的。
- 中文快照的合并语义前后端必须一致：选中词典词义 + 自定义词义 →「选中词义；自定义」；没选中词典词义但填了自定义 → 只剩自定义。服务端 `selectedTranslation` 和前端 `formatTranslationWithCustom` 是两处实现，改一处要同步另一处和测试断言。
- 旧版服务没有 prefetch 接口时会回 404，`useDictPrefetch` 必须按 stale 处理；照抄响应体进 state 会让「补齐中」永远转下去（修过的真实 bug，别改回去）。
- `detectType`：命中任意词库就算 `word`（`a few` 这类固定短语也算），否则含空格才算 `sentence`。
- 打卡一次只推进一轮；按周词锚到下周一。改动排期锚点要同步 `nextDueAt` 和测试断言。
- 卡片导出失败和留档失败要分开处理：卡片窗口没开出来就既不写学习状态也不留档。
- `GET /api/dict` 必须把 query 里的 `refresh` 透传给 `ensureEntry`，**别写死 `true`**：写死等于每次查词都跳过缓存打外部接口。
- `node:sqlite` 在 Node 23 会抛「只支持 Node 22.5+/24」或直接缺模块——测试必须用 Node 24（见硬约束）。
- `worker/schema.sql` 建表顺序有讲究：`learning_event_meanings` 的索引要在表建好之后建（FOREIGN KEY 引用 `meaning_profiles`），调整时保持顺序。
- Worker 的 `applyReview` 里事件落库从本地版的同步改成「收集后统一 await」：事件表和 list_words 之间没有外键约束，先后顺序不影响结果；但 `onEvent` 别改成 fire-and-forget，测试依赖事件已落库。
- **前端读缓存是模块级的，写完必须作废**：`studyListCache.ts`（词条 / 分组名）、`useDictionary` 的 `entryCache`、`useStudy` 的 `membershipCache` 都是 TTL 5 分钟的模块级 Map，切 tab 重建页面时直接复用、不打接口。新增任何改 `list_words` 的写路径，成功后必须调对应的 `invalidateWords` / `invalidateBatches` / `invalidateList`，否则页面停在旧数据：学习页打卡靠 `setReloadToken` 触发 `fetchListWords`，缓存没作废等于白刷新。

## 改动落点索引

| 想改什么 | 改哪里 |
| --- | --- |
| 导航菜单、学习入口胶囊 | `src/components/Nav.tsx` + `Nav.css` |
| 批量导入入口 | 查词页 `src/pages/SearchPage.tsx` 标题左上角的切换按钮 |
| 令牌门 / 鉴权 | `src/components/TokenGate.tsx` + `src/App.tsx`（401 事件） + `src/utils/apiBase.ts` + `worker/src/index.js`（校验） |
| 有哪些页面 / 默认页 | `useTabRoute.ts` 的 `TAB_KEYS` + `Nav.tsx` 的 `TabKey`、`TABS` + `App.tsx` 的分支 |
| 查词交互、防抖 | `src/pages/SearchPage.tsx` |
| 词卡展示、加入学习按钮 | `src/components/WordCard.tsx` + `src/pages/SearchPage.tsx` |
| 词库标签改名交互 | 只有 `src/pages/LibrariesPage.tsx`（已嵌进 `SettingsPage`） |
| 查词链路展示 | `src/pages/SettingsPage.tsx` + `useDictSources.ts` 的 `buildChain` + 服务端 `GET /api/dict/sources` |
| 释义数据兼容与上限 | `src/components/SensePicker.tsx`（当前无页面引用） + 服务端 `MAX_PICKED_SENSES` |
| 导入筛选 / 去重 / 预览 | `src/pages/ImportPage.tsx`（`wordForms` 管词形宽松匹配） |
| 学习列表行样式、多选批量删除 | `src/pages/ListsPage.tsx` + `useStudyList.removeItems` + 服务端 `POST /api/lists/:id/remove` |
| 学习列表批次分组 / 批次重命名 | `src/pages/ListsPage.tsx` + `useStudyList.fetchBatches` / `renameBatch` + 服务端 batches 接口 |
| 目标达成度算法 | `src/components/StudyGoal.tsx` |
| 挑词弹窗 / 月历 / 打卡 | `src/pages/StudyPage.tsx` |
| 打印记录、整批打卡 | `src/pages/StudyPage.tsx` + `src/hooks/usePrintBatches.ts` + 服务端打印批次小节 |
| 按天 / 按周粒度、打卡按钮 | `src/pages/StudyPage.tsx` + 服务端 review 的 done/tally 语义 |
| 打标日志字段、保留条数 | 服务端 `pushMark` / `MAX_REVIEW_KEYS` / `PURE_MARK_ACTIONS` / `withoutMarks` |
| 卡片版式、打印 CSS、每页行列 | `src/utils/flashcards.ts` + StudyPage 的 `LAYOUTS` |
| 复习节奏、到期判断 | 服务端 `worker/src/review.js` 的 `REVIEW_INTERVALS` / `nextDueAt` / `studyState` |
| 外部词典接口、缓存字段 | 服务端 `worker/src/dict.js` 的 `fetchDictEntry` / `normalizeEntry` / `mergeEntry` |
| 补齐队列速率 | 服务端 `worker/src/prefetch.js` 的 `PREFETCH_CONCURRENCY` / `PREFETCH_PACE_MS` |
| API 路由 / 新增接口 | `worker/src/routes.js`（handleApi）+ 测试 `worker/test/api.test.mjs` + 上面的接口表 |
| D1 表结构 | `worker/schema.sql`（改了要重新 `wrangler d1 execute`；已有数据要写迁移） |
| 部署配置 | `wrangler.toml`（Worker 名 / assets / D1 绑定 / vars） |
| 词库格式规范 | `vocab/format.md`（改了要同步 `src/types/vocab.ts`） |
| 设计 token / 通用类 | `src/index.css`、`src/App.css`、`src/ui/ui.css` |

## 部署与迁移（用户在本机执行；沙箱连不了外网）

```bash
export PATH=/Users/rextao/.nvm/versions/node/v24.18.0/bin:$PATH
npm run build                                  # tsc -b && vite build
npx wrangler deploy                            # 部署 Worker + 静态资源（dist）

# 首次 / schema 变更：建表（会 DROP 废弃的 sync_snapshot）
npx wrangler d1 execute english-study-sync --remote --file=worker/schema.sql

# 本地 sqlite 一次性迁入（幂等：先 DELETE 再 INSERT）
npm run migrate:to-d1                          # 生成 migration.sql
npx wrangler d1 execute english-study-sync --remote --file=migration.sql

# 密钥（Worker secret）
npx wrangler secret put API_TOKEN
npx wrangler secret put BAIDU_TRANSLATE_API_KEY
npx wrangler secret put BAIDU_TRANSLATE_APP_ID

# 本地开发
npx wrangler dev & vite                        # vite 的 /api 代理到 wrangler dev 的 8787
```

## 验证清单

```bash
export PATH=/Users/rextao/.nvm/versions/node/v24.18.0/bin:$PATH
npm run build          # tsc -b && vite build，必须 exit 0
npm run test:server    # 动过 worker/ 就跑，期望「282 passed, 0 failed」
```

改完后自查：有没有新增原生 `<select>` / `<textarea>` / `checkbox`；有没有绕过 `apiFetch` 的裸 `fetch`；有没有新引依赖；有没有把 `nextDueAt` / `state` 这类派生字段写进表；归一化规则是不是几处都改了；`DICT_NO_NETWORK=1`（断网）时功能是不是照样能跑。
