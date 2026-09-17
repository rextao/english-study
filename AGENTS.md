# AGENTS.md — 项目地图（给 AI 读）

读完这一份就能直接动手改代码，不必再全量扫源码。面向人的使用说明在 `README.md`；两份分工：README 讲「怎么用」，这份讲「怎么改」。

## 是什么

本机单机跑的背单词应用。前端 React 19 + TypeScript + Vite 6（`src/`），后端是一个 Node 原生 `node:http` 写的本地服务（`server/dict-server.mjs`，监听 127.0.0.1:3456），数据库就是 JSON 文件（`cache/`、`vocab/`）。释义优先查本机 ECDICT（开源英汉简明字典，约 77 万词条，产物在 `data/ecdict/`，读取层 `server/ecdict.mjs`），本地查不到才打外部接口。UI 文案和代码注释一律中文。
本机单机跑的背单词应用。前端 React 19 + TypeScript + Vite 6（`src/`），后端是一个 Node 原生 `node:http` 写的本地服务（`server/dict-server.mjs`，监听 127.0.0.1:3456），数据库是一个 SQLite 单文件 `cache/study-history.sqlite`（学习列表 / 历史 / 标签 / 目标 / 打印批次 / 词典缓存全在里头，提交它即可跨设备共享），词库本体是 `vocab/` 下的 JSON。释义优先查本机 ECDICT（开源英汉简明字典，约 77 万词条，产物在 `data/ecdict/`，读取层 `server/ecdict.mjs`），本地查不到才打外部接口。UI 文案和代码注释一律中文。

## 硬约束（动手前先看）

- **Node 24**：每条 node / npm 命令前先 `export PATH=/Users/rextao/.nvm/versions/node/v24.18.0/bin:$PATH`。
- **git 仓库零 commit**：`.git` 在，但一次提交都没有、所有文件都是 untracked，删掉不可恢复。删任何文件前先问用户。
- **装不了新依赖**：环境无外网，`npm i <pkg>` 必定失败。这就是没有 antd、没有 eslint、没有测试框架的原因——服务端测试是手写断言。
- **服务端零依赖**：`dict-server.mjs` 只用 `node:http / fs / path / url`，不要引入 express 之类；`scripts/ecdict-*.mjs` 同样只用内置模块（解 zip 用 `node:zlib`）。
- **本地词典数据在沙箱里装不上**：`npm run ecdict:fetch` 要连 GitHub，只能让用户在自己机器上跑。代码必须在没装词典时照常工作（`ecdictInfo().ready === false` → 自动回落外部接口），别写成硬依赖。
- **UI 禁原生控件**：页面里不要出现 `<select>`、`<textarea>`、`type='checkbox'`，统一用 `src/ui` 里的 `Select` / `TextArea` / `Checkbox`。
- **TS 严格**：`tsconfig.app.json` 开了 `strict` + `noUnusedLocals` + `noUnusedParameters` + `noFallthroughCasesInSwitch`（**没开** `noUncheckedIndexedAccess`）。
- **无法实测运行中的页面**：连不上 localhost，只能靠 `tsc` + `vite build` + 读代码推断，别声称「已在浏览器里验证」。
- **验证命令**：`npm run build`（= `tsc -b && vite build`）必须 exit 0；动过服务端再跑 `npm run test:server`（284 项，跑在临时 `DICT_DATA_DIR` + `DICT_ECDICT_DIR` + `DICT_NO_NETWORK=1`，不会碰真实 `cache/` 和 `data/`）。
 - **验证命令**：`npm run build`（= `tsc -b && vite build`）必须 exit 0；动过服务端再跑 `npm run test:server`（315 项，跑在临时 `DICT_DATA_DIR` + `DICT_ECDICT_DIR` + `DICT_NO_NETWORK=1`，不会碰真实 `cache/` 和 `data/`）。

## 目录地图（一行一职责）

```
src/main.tsx                   挂载 React，引入 index.css
src/App.tsx                    状态中枢：useVocabLibraries / useStudyList / useStudyPlan / useTabRoute 都在这里，
                               按 tab 渲染五个页面并把 props 往下传；顶部「本地服务未启动」提示也在这里
src/App.css                    通用类：.page/--narrow/--wide(1080) .card/--pad .callout/--success/--error/--warn
                               .hint .empty/--inline .field-label .page-header
src/index.css                  设计 token：--color-* --radius-* --shadow-* --content-width --nav-height --font-*
src/types/vocab.ts             所有共享类型；前后端字段的唯一约定处

src/pages/SearchPage.tsx       查词页：输入 400ms 防抖 → useDictionary；词库命中 → useVocabMatch；渲染 WordCard
src/pages/ImportPage.tsx       批量导入：多行文本 → 归一化 / 去重 / 词库筛选（NO_FILTER | ANY_LIB | 词库 id）
                               → 预览上限 200 行 → study.importItems → useDictPrefetch 盯后台补齐进度
src/pages/ListsPage.tsx        学习列表：切换 / 新建 / 重命名 / 删除；词条平铺一行一个；useDictBatch 取音标和中文词义；
                               显示加入时保存的中文词义（兼容旧数据的默认摘要），不显示英文释义；
                               「批次」checkbox → 按加入日期分成批次展示，点批次标题就地折叠 / 展开，批次可就地重命名（自定义名 + 只读日期 Tag）；
                               「多选」开关 → 每行勾选框（点词也能勾）+ 全选（只勾当前筛选出的）+ 批量删除（二次确认）
src/pages/LibrariesPage.tsx    词库页：只显示 name + file + 标签改名 / 重置默认值
src/pages/StudyPage.tsx        英语学习页：StudyGoal + 挑词弹窗（Modal，勾词 → 打印卡片 + plan.startWords；
                               分组与学习列表批次共用同一份 batchNames，学习列表改名这里同步）
                               + 月历复习计划：「按天 / 按周」粒度切换（mode，只存组件 state），
                               按天选一天 / 按周选整周，逾期折叠进今天或本周，只有当前这天 / 这周可打卡
                               + 打印记录：每导出一次卡片留一条档，可整批打卡 / 删记录（usePrintBatches）

src/components/Nav.tsx         顶部导航：四个普通 tab +「英语学习」流光胶囊（角标 = plan.dueCount）；TabKey 定义在此
src/components/PageHeader.tsx  页面标题区（title / subtitle / actions），样式在 App.css
src/components/WordCard.tsx    词卡：音标 / 来源标签 / 词库标签 / 中文释义 / 右上角「加入学习」小按钮；
                               首页的目标列表在搜索区域选择，点击「+ 学习」先选择中文词义再加入（不列词性、不列英文释义）；
                               卡片上不显示英文释义、也不显示例句（例句字段整个删了）
src/components/LibraryTag.tsx  已废弃：曾是「点一下就地改名」的标签，现在全项目零引用（改名只允许在词库页），留着但没人用
src/components/SensePicker.tsx 旧版释义选择组件，当前页面不再引用；为兼容旧数据和接口暂时保留
src/components/StudyGoal.tsx   目标模块：目标词库（useStudyGoal）vs 已开始学的词 → 达成度 +「目标外的获得」；
                               buildFormIndex 做词形宽松匹配

src/hooks/useTabRoute.ts       hash 路由（#/search #/import #/lists #/libraries #/study），刷新与前进后退都停在原页
src/hooks/useSearch.ts         useVocabMatch：词 → 命中的词库 id 列表（纯内存 Map，不走网络）
src/hooks/useDictionary.ts     单词查询 GET /api/dict
src/hooks/useDictBatch.ts      批量读缓存 POST /api/dict/batch → entries / missing / incomplete / pending
src/hooks/useDictPrefetch.ts   后台补齐队列：repair() 排队 + 1.2s 轮询进度；响应认不出就报 stale 而不是照抄进 state
src/hooks/useDictSources.ts    词典来源状态 GET /api/dict/sources；字段校验不过（含旧服务 404）返回 null，界面就不显示
src/hooks/useStudy.ts          某个词在哪些学习列表里（查词页用）
src/hooks/useStudyList.ts      学习列表全套 CRUD + 导入 + senseIds + 批量移除（removeItems）；导出类型 StudyListApi
src/hooks/useStudyPlan.ts      复习计划 GET /api/study/plan + startWords + reviewWords；
                               导出 StudyPlanApi / ReviewAction / ReviewOptions
src/hooks/usePrintBatches.ts   打印批次：留档 + 整批打卡 + 删记录（/api/print-batches 四个接口）；
                               导出 PrintBatchesApi；只在 StudyPage 里用，不进 App.tsx
src/hooks/useStudyGoal.ts      目标词库读写 GET|PUT /api/study/goal
src/hooks/useVocabLibraries.ts 构建期打包 vocab/*.json + 标签读写 + localStorage 镜像与迁移

src/ui/                        手写组件库：Button Select Dropdown Input(含 TextArea) Checkbox Tag Popconfirm
                               Popover Modal + useDismiss；统一从 src/ui/index.ts 导出（它顺带 import ui.css）
src/utils/flashcards.ts        打印卡片：fetchCards（顺手补释义）/ pickSenses / mirrorRows / buildFlashcardsHtml；偶数页逐行左右镜像
                               / openCardWindow；卡片反面只印音标 + 中文，英文释义不上卡片
                               / renderCardsInto（打印会话 + 卡片右上角 ✕，hover 才显示、打印时隐藏；
                                 点 ✕ 只把这个词从本次打印里摘掉，不动学习状态与打印留档）
src/utils/translations.ts      中文词义工具：translationOptions（把缓存 translations 拆成可勾选候选）/ selectedTranslationOptions
                               / formatTranslationOptions（按词性分组合成摘要串）；formatTranslationWithCustom 把用户手填的
                               自定义词义（无词性）并进摘要。列表页和卡片只认 translation 这一个快照串

server/dict-server.mjs         全部后端逻辑：路由 + 词典缓存 + 本地词典优先 + 外部接口 + 学习列表 + 复习进度
                               + 打印批次 + 标签 + 目标
server/db.mjs                  study-history.sqlite 的共享连接层：openStudyDb（按解析路径缓存、常驻、
                               DELETE 日志模式无侧车文件）/ openStudyDbSnapshot（测试断言用的临时只读短连接）
server/study-lists.mjs         学习列表 store：lists / list_words 表，启动时把 study-lists.json 一次性迁进库
server/kv.mjs                  小文档 store：kv 表（标签 / 目标 / 打印批次整份 JSON 存一行）+ dict_cache 表
                               （一个词一行）；启动时把四个老 json 一次性迁进库；缓存重载靠 PRAGMA data_version
server/ecdict.mjs              本地 ECDICT 读取层：index.bin 读进内存二分 → 按偏移从 records.tsv 读那一行；
                               导出 ecdictEntry / ecdictRecord / ecdictInfo / resetEcdict / hashKey / STORE_FILES 等
server/text.mjs                normalizeText（trim + 空白压缩 + 小写）；服务端和 ecdict.mjs 共用这一份
server/dict-server.test.mjs    315 项断言测试；临时 DICT_DATA_DIR + DICT_ECDICT_DIR + DICT_NO_NETWORK=1
                               + DICT_SERVER_NO_LISTEN=1

scripts/ecdict-fetch.mjs       装词典一条龙：下 zip → unzipFirstCsv（零依赖解 zip）→ buildEcdict → 试查 apple 自检；
                               支持 ECDICT_URL / --url= / --data= / --keep-zip，csv 已存在就跳过下载
scripts/ecdict-build.mjs       buildEcdict：流式解析 ecdict.csv → 同词按信息量去重 → 写 records.tsv / index.bin /
                               meta.json（先写 .tmp 再依次 rename，中途挂了不会留半份产物）

vocab/format.md                词库统一格式（唯一规范来源）
vocab/ket.json                 剑桥 A2 Key，id=a2-key-2020，1661 条词条
vocab/parse_a2_key.py          pdftotext 文本 → 词库 JSON；正则与该 PDF 版式绑定，不通用
cache/study-history.sqlite     唯一的运行时数据文件：学习列表 / 学习历史 / 词库标签 / 学习目标 /
                              打印批次 / 词典缓存全在这一个库里，提交它即可跨设备共享（见「跨设备共享」）
cache/backups/                 迁移前 / 删除前的自动备份，不进 git
data/ecdict.csv                ECDICT 原始 csv（约 200MB），只在建索引时读，建完可以删
data/ecdict/                   词典产物 records.tsv + index.bin + meta.json（十几 MB），服务端查词直接读它
.gitignore                     node_modules / dist / data / .DS_Store（`data/` 太大，不进 git）
.gitignore                     `cache/*` 全部忽略，只 `!cache/study-history.sqlite` 放行一个文件
506886-a2-key-2020-vocabulary-list.pdf   词库原始 PDF
```

## 状态归属与数据流

```
App.tsx（唯一状态中枢，避免切 tab 后数据不同步）
 ├ useVocabLibraries → libraries / getLabelById / updateLabel / resetLabel → 所有页面
 ├ useStudyList      → study: StudyListApi                                → Search / Import / Lists / Study
 ├ useStudyPlan      → plan: StudyPlanApi                                 → Nav 角标 + StudyPage
 └ useTabRoute       → [tab, setTab]

页面 / 组件 ──fetch http://127.0.0.1:3456── server/dict-server.mjs
                                             ├ cache/study-history.sqlite（唯一的落盘来源）
                                             │    ├ lists / list_words（学习列表，study-lists.mjs）
                                             │    ├ learning_events / learning_event_meanings（打标日志，study-history.mjs）
                                             │    ├ kv（标签 / 目标 / 打印批次，kv.mjs）
                                             │    └ dict_cache（词典缓存，kv.mjs）
                                             └ data/ecdict/（本地词典，只读，查词优先用它）
                                             └ 外部：dictionaryapi.dev / 百度大模型文本翻译 API（本地查不到才走）

vocab/*.json ──import.meta.glob(eager, 构建期打包)──▶ useVocabLibraries（服务没起也能浏览词库）
```

页面内的局部状态：`useDictionary` + `useStudy` 在 SearchPage；`useDictBatch` 在 ListsPage；`useDictPrefetch` 在 ImportPage；`useStudyGoal` 在 StudyGoal 组件内部；`usePrintBatches` 在 StudyPage 内部（只有那一页要打印记录）。

## 类型契约（`src/types/vocab.ts`）

```ts
DictionarySource 'ecdict' | 'api'                           // 这条释义是本机词典给的还是外部接口给的
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

`phonetic` 和 `translation` 是加入学习列表时保存的音标、中文翻译快照，旧数据可以没有；`translationIds` 是加入时选择的中文词义 id 子集。学习列表显示已保存的中文词义，旧数据则回退到词典摘要。`senseIds` 是兼容旧数据的英文释义 id 子集，当前界面不提供英文释义选择入口。中文释义**全集**永远存在词典缓存里。`customTranslations` 是用户手填的自定义中文词义（没有词性、没有 id），加入时并入 `translation` 快照一起背诵，单独落盘只是为了二次编辑时能还原成可删标签；上限 6 条 / 单条 60 字（`MAX_CUSTOM_TRANSLATIONS` / `MAX_CUSTOM_TRANSLATION_LEN`，前后端常量同名同值）。

`markCount` / `reviewCount` / `spellingCount` / `rememberedCount` / `forgottenCount` = 去规范化的累计次数，**界面上一律不显示**，落盘供后续统计使用。打标日志本身（时间 / 动作 / 粒度 / 轮次）**只写 SQLite 事件表**，JSON 里不再留 `marks` 镜像：两处来源容易打架，撤销已改成事件软删，镜像同步不上。`markCount` 记总打标次数；`reviewCount` 只数实际 done/again 复习操作（done = 进入下一轮）；`spellingCount` / `readingCount` / `rememberedCount` / `forgottenCount` 分别统计会拼、会读、知意和没记住（按钮与统计文案统一为：会拼 | 会读 | 知意），**四者完全独立**。会拼 / 会读 / 知意走 action=`tally`（`successKind` 必传），只加对应计数，**不推进轮次、不改排期**，可重复点击各算一次；done 只推进轮次不加熟悉度计数。`lastDoneAt` 记最近一次 done 打卡时间，是轮次排期的锚点。`processedReviewKeys` 最多保留最近 80 个复习任务键，用于网络重试和重复点击幂等。`saveLists()` 落盘时顺手 delete `item.marks`，老数据残留下次保存自动清掉；要打标日志走 `/api/study/history`。

打印批次文件里**只存 `listId` + `word`**，每个词的 `state` / `stage` / `nextDueAt` 以及批次上的 `dueCount` / `markableCount` / `missingCount` 都是读接口时从学习列表现算的（`enrichBatch`）——同一个词的进度只有学习列表一个来源，不会两处打架。打印之后被移出列表的词，批次里标 `missing`，整批打卡时跳过它。

## 服务端接口表（`server/dict-server.mjs`）

| 接口 | 作用 | 前端调用方 |
| --- | --- | --- |
| `GET /api/dict?word=&refresh=1` | 查词，顺序 = 缓存 → 本地 ECDICT → 外部接口；`refresh=1` 跳过缓存但仍本地优先 | useDictionary |
| `POST /api/dict/batch` `{words}` | 批量读缓存，先 `fillFromLocal` 用本地词典补缺 → `{entries, missing, incomplete}` | useDictBatch、flashcards.ts |
| `POST /api/dict/prefetch` `{words, force?}` | 把词排进后台补齐队列 | （导入接口内部） |
| `GET /api/dict/prefetch` | 队列进度 `{total,done,failed,pending,running,finished}` | useDictPrefetch |
| `POST /api/dict/repair` `{words?, force?}` | 扫学习列表里缺音标 / 缺释义的词并排队；`force:true` 连已经 `ok` 的也重查（把旧机翻译文换成 ECDICT） | useDictPrefetch.repair |
| `GET /api/dict/sources` | 词典来源状态 `{local: {ready, count, dir, builtAt, ...}, network}` | useDictSources |
| `GET /api/cache/stats` | 缓存统计 | — |
| `GET /api/lists` | 所有列表（含 default） | useStudyList |
| `POST /api/lists` `{name}` | 新建列表，重名报错 | useStudyList |
| `PATCH /api/lists/:id` `{name}` | 重命名 | useStudyList |
| `DELETE /api/lists/:id` | 删除，`default` 被服务端拒绝 | useStudyList |
| `GET /api/lists/:id/words` | 列表词条 | useStudyList.fetchListWords |
| `POST /api/lists/:id/words` `{text, sourceIds?, senseIds?, translationIds?, customTranslations?}` | 加一条并保存选择的中文词义；没带快照时用 customs 兜底 | useStudyList.addItem |
| `PATCH /api/lists/:id/words/:text` `{senseIds?, translationIds?, translation?, customTranslations?}` | 改释义 / 中文快照 / 自定义词义；空数组=恢复自动，`translation:''` 且有 customs 时用 customs 重建 | useStudyList.updateItemSenses / updateItemTranslations |
| `DELETE /api/lists/:id/words/:text` | 移除 | useStudyList.removeItem |
| `POST /api/lists/:id/import` `{items}`（每项可带 `translationIds?` / `customTranslations?`） | 批量导入，返回 `{added, skipped, queued}` | useStudyList.importItems |
| `POST /api/lists/:id/remove` `{words}` | 批量移除，归一化去重后只写一次盘，返回 `{removed, missing}`；`words` 为空 → 400 | useStudyList.removeItems |
| `GET /api/lists/:id/batches` | 批次（按 addedAt 自然日分组）的显示名 `{batchNames}` | useStudyList.fetchBatches |
| `PATCH /api/lists/:id/batches` `{date:'2026-09-15', name}` | 重命名批次；空串=重置为日期；非法日期 400、超 40 字 409 | useStudyList.renameBatch |
| `GET /api/word-lists?word=` | 这个词在哪些列表里 | useStudy、useStudyList.getWordListIds |
| `POST /api/lists/:id/start` `{words, startedAt?, restart?, scope?}` | 标记开始学习，scope 只进打标日志不影响排期 | useStudyPlan.startWords |
 | `POST /api/lists/:id/review` | 打卡：`done` 进入下一轮 / `again` 没记住 / `stop` 退出 / `tally` 熟悉度计数（`successKind` 必传，只计数不动排期）；`done`/`again` 会把 scope 写进 `reviewScope` 影响排期（week → 下周一）；每词 `requestIds` 幂等 | useStudyPlan.reviewWords |
| `POST /api/lists/:id/mark` `{words, action?, scope?}` | 只记打标（当前只允许 `print`），不动排期 | —（前端已无调用方，留作底层原语） |
| `POST /api/lists/:id/tally-undo` `{words, successKind, scope?, now?}` | 撤销本周期内最近一次会拼 / 会读 / 知意：删最近一条本周期内的 tally mark，对应累计计数 -1（下限 0），并软删对应永久事件；`undone` 表示实际撤销了几条 | useStudyPlan.undoTally |
| `GET /api/study/plan` | 所有在学的词 + 节奏 + 服务端今天 0 点 | useStudyPlan |
| `GET|PUT /api/study/goal` `{libraryId}` | 目标词库，空串=不设目标 | useStudyGoal |
| `GET /api/print-batches?limit=` | 打印记录（新在前，默认 20 条，最多留 60 条） | usePrintBatches |
| `POST /api/print-batches` `{groups:[{listId,words}], title?, kind?, scope?, printedAt?}` | 记一次卡片导出，顺带给每个词打一条 `print` 标；一个词都没对上 → 400 | usePrintBatches.record |
| `POST /api/print-batches/:id/review` | 按批次整批打卡；scope 缺省沿用打印时的粒度，每词可通过 `requestIds` 独立幂等 | usePrintBatches.reviewBatch |
| `DELETE /api/print-batches/:id` | 只删这条记录，复习进度不动 | usePrintBatches.removeBatch |
| `GET /api/vocab-labels` | `{labels: {词库id: 标签}}` | useVocabLibraries |
| `POST /api/vocab-labels` `{labels}` | 批量合并（localStorage 迁移用） | useVocabLibraries |
| `PATCH /api/vocab-labels/:id` `{label}` | 改标签（拦空值、重名、超 40 字） | useVocabLibraries |
| `DELETE /api/vocab-labels/:id` | 重置为默认（回落到词库 id） | useVocabLibraries |

环境变量：`DICT_PORT`（默认 3456）、`DICT_DATA_DIR`（默认 `../cache`）、`DICT_ECDICT_DIR`（默认 `../data/ecdict`）、`DICT_ECDICT_OFF=1`（这次启动不用本地词典）、`DICT_NO_NETWORK=1`（只吃缓存 + 本地词典）、`DICT_SERVER_NO_LISTEN=1`（只导出 server，测试用）。

## 落盘文件结构

```
cache/study-history.sqlite   一个库装全部运行时数据，提交它即跨设备共享；DELETE 日志模式无 -wal/-shm 侧车
  lists                 学习列表头（id / name / createdAt / batchNames JSON）；study-lists.mjs
  list_words            列表词条（持久字段含各累计次数 / lastDoneAt / processedReviewKeys /
                         reviewScope；不含 nextDueAt / state / marks；批次名 batchNames 存列表头上）
  learning_events       打标日志（动作 / 时间 / 粒度 / 轮次），撤销=软删；study-history.mjs
  learning_event_meanings  事件关联的词义快照
  kv                    一整份 JSON 存一行：vocab-labels / study-goal / print-batches（KV_KEYS）；kv.mjs
  dict_cache            一个词一行 entry_json；kv.mjs
  schema_migrations     一次性迁移标记（study-lists / marks / 四个小文档各一条），二次启动不重跑
  meaning_profiles / legacy_totals  词义画像与历史总量（study-history.mjs）

老 json（study-lists / vocab-labels / study-goal / print-batches / dict-cache）只在第一次启动时
迁移一次：读出来 → 事务里入库 + 记标记 → 提交后备份到 cache/backups/ 再删文件。之后 sqlite 是唯一来源。

data/ecdict/records.tsv  一行一条词，TAB 分隔，列 = RECORD_COLUMNS
                         key / word / phonetic / translation / definition / exchange / tag / frq
data/ecdict/index.bin    定长 16 字节 × 词数：h1 h2 offset length（都是 uint32BE），按哈希升序，二分用
data/ecdict/meta.json    { format, count, builtAt, source, sourceBytes, columns }，构建时最后才写
```

## 跨设备共享

数据全在 `cache/study-history.sqlite` 一个文件里，`.gitignore` 只放行它：

1. A 机正常用，数据自动写库；想同步时提交 `cache/study-history.sqlite` 即可
2. B 机 `git pull`，拿到完整的学习列表 / 进度 / 标签 / 目标 / 打印批次 / 词典缓存
3. B 机直接启动服务就能用，不用重新查词、重新导入

注意：这是「手动提交、手动拉取」的顺序交接，不是实时同步。两台机各自改了再合并会冲突，
那时以某一台的 sqlite 为准即可（库是二进制，无法合并冲突，只能整体取舍）。
词典产物 `data/ecdict/` 不进 git，B 机要重跑 `npm run ecdict:fetch`。

归一化主键 = `normalizeText` = trim + 连续空白压成一个空格 + 转小写。服务端已经收成一份（`server/text.mjs`，`ecdict.mjs` 里的 `ecdictKey` 直接复用它，**词典索引就是按这个主键建的，改它必须重建 `data/ecdict/`**）；前端还是各写一遍：`useDictBatch.keyOf`、`ImportPage.normalize`、`StudyGoal.keyOf`、`flashcards.ts`。改规则这 4 处要一起改。

## 复习算法（艾宾浩斯，全在服务端）

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
review  done → stage+1（上限 7）且 lastDoneAt=now，并把粒度写进 reviewScope（week = 排到下周一，day = 按天顺延）；
        一次点击只推进一轮。按周词同一周内再点 done 仍停在下周一，不继续往后滚
        again → stage=0 且 startedAt=now 且清 lastDoneAt（同样写 reviewScope）；stop → 删掉
        startedAt/stage/reviewedAt/lastDoneAt/reviewScope 退回 new
        reviewedAt 只保留最近 40 条；每次 done/again 都 reviewCount++；结束时记一条 mark
        tally（successKind=spelling/reading/meaning 必传）→ 只加对应熟悉度计数，不动轮次 / reviewedAt / 排期
        requestIds / processedReviewKeys 保证同一复习任务重复提交不重复计数
mark    POST /mark 只 pushMark，不动 stage / startedAt；当前页面不调用，action 主要用于 print，保留 spelling 兼容旧调用

applyReview() 是打卡的唯一实现：列表打卡（/api/lists/:id/review）和按打印批次整批打卡
（/api/print-batches/:id/review）都走它。整批打卡先按 listId 把批次里的词分组，再逐个列表调用；
scope 不传就沿用打印那一刻记下的粒度；该粒度会经 `reviewScope` 影响排期（按周批次整批打卡后排到下周一）。
```

`nextDueAt` / `state` / `weekStart` 都是读接口时算的派生字段，不写进文件。到期判断只比「天」，同一天内几点无所谓。前端 StudyPage 额外做一件事：把所有逾期的词折叠进「今天」（按周模式折叠进「本周」），且只有当前这一天 / 这一周允许打卡。

按周不只是展示粒度：按周打卡会把 `reviewScope` 持久化成 `week`，`nextDueAt` 直接排到**下周一**（真正的一周一次）；
按天打卡写 `day`，仍按间隔逐天顺延。旧数据没有该字段，等价于 `day`，行为不变。前端 StudyPage 的按周分桶
（`startOfWeek(nextDueAt)`）天然适配下周一排期，不用改。

## 词典链路（本地优先）

```
GET /api/dict → ensureEntry(word, force) → resolveEntry(word, force) → { entry, network }
  1 缓存 status===ok 且未 force → 直接返回，network=false
      例外 staleAgainstLocal(old)：再问一次本地词典，能升级就换成 ECDICT 版并落盘，
      本地查不到就原样返回旧缓存；这条岔路永远不打网络
  2 localEntry(word)：查本机 ECDICT（server/ecdict.mjs）
      拿到且 status===ok → 落盘返回，一个网络请求都不发
      force 也不打网络：不然刷新一次又被外部翻译结果盖回去
  3 NO_NETWORK：本地有就用本地，没有回旧缓存 / 空 partial
  4 fetchDictEntry(word)：非短语（不含空格）→ dictionaryapi.dev 取 phonetic + senses 全集，
      再打百度大模型文本翻译 API 取中文；dictionaryapi 404 = 确认没这个词，dictOk=true 不再重试，
      超时 / 限流留给下次
  收尾 mergeEntry({ local, fresh, old })：
    音标 / 中文  本地 > 这次抓的 > 旧缓存（ECDICT 是人工词典，百度翻译负责外部中文和句子）
    senses      pickSenses：local 有就用 local，其次 fresh，最后 old（不再为例句破例）
    source      local ? 'ecdict' : (fresh || old 的来源)
    status      (dictOk && translation) ? ok : partial
```

- `staleAgainstLocal(entry)`：装了词典的前提下，「没抓齐的」和「`source` 不是 `ecdict` 的历史缓存」都算过期。三处闸门都得带上它才生效——`GET /api/dict` 的缓存短路、`POST /api/dict/batch` 的 `want` 过滤、`resolveEntry` 里的就地升级；所以装 ECDICT 之前留下的旧数据下次被查到就自动换成本地词典的音标 / 中文 / 释义，不用手动跑 repair。词典没装或 `DICT_ECDICT_OFF=1` 时一律返回 false，老缓存原样保留。
- 产物结构：`records.tsv`（一行一条词，TAB 分隔，列顺序 = `RECORD_COLUMNS`）+ `index.bin`（定长 16 字节：双 FNV 哈希 h1/h2 + 偏移 + 长度，按哈希升序）+ `meta.json`（构建时最后才写，`format` 对不上就当没装）。查词只把 index（约 12MB）读进内存二分，命中后按偏移 `readSync` 那一行，所以不用把 77 万词读进内存。
- `meta.json` 的 mtime / size 变了就重开句柄；store 为空时每次查都试着开一次，因此刚建完词典不重启服务也能生效。记录级 Map 缓存带负缓存，查不到的词不会反复读盘。
- ECDICT 只有音标 / 中文 / 英文 definition，**没有例句**——产品也不再有例句这个概念：`DictionarySense` 没有 `example` 字段，`normalizeEntry` / `fetchDictEntry` 把外部接口给的例句直接丢掉。`pickPhonetic` 把裸音标包成 `/…/`；`pickTranslation` 取前 2 行用 `；` 拼、学科标注行（`[医]` 这类）排到后面、超 `MAX_TRANSLATION_LEN=60` 字在标点处截断加省略号；`buildSenses` 优先英文 definition、词性缩写经 `POS_MAP` 展开成 `noun` 那套全称、上限 `MAX_LOCAL_SENSES=20`。
- 变形词（apples / running）自己那条常常只有 `exchange` 没释义 → 按 `0:lemma` 回原形取释义，音标仍用这个词形自己的。表面形式查不到时还会试连字符 ↔ 空格 ↔ 直接连起来几种写法。
- `fillFromLocal(words)` 在 `POST /api/dict/batch` 里先跑一遍：本地能补的一次补齐、只写一次盘，这些词就不用再排队补齐了。
- 容量上限：`MAX_SENSES_PER_POS=12`、`MAX_SENSES=40`、`MAX_PICKED_SENSES=12`。
- `isBadTranslation`：空 / 等于原词 / **一个汉字都没有** → 当失败（百度接口返回错误提示时不会写入缓存）。
- 缓存常驻内存，别的连接改了库（PRAGMA data_version 变了）下次 getCache 就整表重读；本连接自己的写不算，所以写完不会触发无谓重载。
- 补齐队列：`PREFETCH_CONCURRENCY=2`、`PREFETCH_PACE_MS=250`（`NO_NETWORK` 时 0），两个免费接口都限流，别调高。**只有 `resolveEntry` 报 `network===true` 才 sleep**，本地命中的词一个接一个过，导入几百个常见词几乎瞬间完成。
- `DICT_ECDICT_OFF=1` 把本地词典整个跳过（`localEntry` 返回 null、`fillFromLocal` 返回 0、`/api/dict/sources` 报 `disabled`、`staleAgainstLocal` 恒为 false），用来对比外部接口的效果或排查词典本身。

## UI 层约定

- 组件一律 `import { X } from '../ui'`；`src/ui/index.ts` 会顺带引入 `ui.css`。API 命名对齐 antd（`size` / `block` / `allowClear` / `options` / `okText`…），将来换真 antd 基本只改 import。
- z-index 约定：`.ui-select__list` / `.ui-menu` = 30，`.ui-popover` = 40，`.ui-modal-mask` = 60。
- 白色主题。全局 token 在 `src/index.css` 的 `:root`；组件库私有 token 在 `src/ui/ui.css` 的 `:root`（`--ui-*`）。
- 每个页面 / 组件配同名 `.css`，只放局部类；跨页面复用的类放 `App.css`。加载态用 `.ui-spin`。

## 已知坑

- 服务地址 `http://127.0.0.1:3456` **写死在 11 个文件**里（10 个 hook + `utils/flashcards.ts`）。换端口要全改，`vite.config.ts` 里那条 `/api` proxy 目前实际没被用到。
- `vocab/*.json` 是 `import.meta.glob('/vocab/*.json', { eager: true })` 构建期打包的，新增词库文件后要重启 vite。
- 词库标签是唯一还用 localStorage 的地方（key `vocab-labels`），只作镜像：服务端可用时以服务端为准，并把浏览器里多出来的标签 POST 上去迁移。其余状态全在服务端文件里，**不要往 localStorage 里加新东西**。
- 词库标签的改名入口**只有词库页**。查词页 / 学习列表 / 英语学习页里的标签都是只读 `<Tag color="blue">`，别再给它们加 `onClick` 或把 `LibraryTag` 装回去；`updateLabel` 只应该传给 `LibrariesPage`。
- `openCardWindow()` 必须在 click 事件里同步调用，否则被浏览器当弹窗拦掉：流程是先开一个进度页，等释义查完再回填卡片 HTML。卡片没开出来就不写学习状态，避免开始时间和手里的卡片对不上。
- `sense.id` 用「词性 + 序号」而不是内容 hash，重抓后 id 仍然对得上，所以 `senseIds` 存 id 是安全的。
- 中文快照的合并语义前后端必须一致：选中词典词义 + 自定义词义 →「选中词义；自定义」；没选中词典词义但填了自定义 → 只剩自定义。服务端 `selectedTranslation(entry, ids, customs)` 和前端 `formatTranslationWithCustom` 是两处实现，改一处要同步另一处和测试断言。
- 旧版服务没有 prefetch 接口时会回 404，`useDictPrefetch` 必须按 stale 处理；照抄响应体进 state 会让界面显示 `undefined/undefined` 并且「补齐中」永远转下去（这是修过的真实 bug，别改回去）。
- `detectType`：命中任意词库就算 `word`（`a few` 这类固定短语也算），否则含空格才算 `sentence`。
- 打卡一次只推进一轮；下次复习锚点：按天词锚定最近一次 `done` 打卡当天（`lastDoneAt`）按间隔顺延，
  按周词（`reviewScope` 为 `week`）锚到 `startOfWeek(lastDoneAt) + 7 天`（下周一）。改动排期锚点要同步 `nextDueAt` 和测试断言。
- `markWords` 仍保留在 `useStudyPlan` 作为兼容性的纯标记原语，但当前页面没有调用它；「会拼 / 会读 / 知意」走 `/api/lists/:id/review` 的 `tally`（只计数不推进轮次），「进入下一轮」走同接口的 `done`。打印现在走 `POST /api/print-batches`，它自己会给每个词打一条 `print` 标，再单独打标就重复了；`/api/lists/:id/mark` 仍保留供测试和未来纯标记动作使用。
- 卡片导出失败和留档失败要分开处理：卡片窗口没开出来就既不写学习状态也不留档；卡片开出来但留档接口失败时只提示「卡片已导出，但打印记录没保存」，别把已经开始学的状态回滚掉。
- 打印页卡片右上角的 ✕ 只是「这次打印不要这张卡」：页面脚本调主窗口的 `__removePrintCard`（`renderCardsInto` 登记的会话，按 `data-print-id` 找回）过滤后整页重渲，沿用用户调过的字号 / 缩放 / 模式并还原滚动；主窗口不可用时就地把卡片清空兜底。它**不改学习列表、开始学习状态和打印留档**——留档用的是用户最初选中的列表，删词纯粹是打印页本地行为。
- `GET /api/dict` 必须把 query 里的 `refresh` 透传给 `ensureEntry`，**别写死 `true`**（改成本地优先之前就是写死的）：写死等于每次查词都跳过缓存去打外部接口，本地词典刚写好的中文又被百度翻译结果盖回去。
- 本地词典没装是正常状态，不是错误：`ecdictInfo().ready === false`、`localEntry` 返回 null、`useDictSources` 返回 null，界面上什么都不显示，链路自动回落外部接口。别在这条路径上抛异常。
- `data/` 不进 git（csv 约 200MB、索引十几 MB），也别提交：换台机器重跑 `npm run ecdict:fetch` 就有。词典产物是可再生的派生数据。
- 改 `unzipFirstCsv`（`scripts/ecdict-fetch.mjs`）要跑测试里手搓 zip 那组用例——沙箱里下不到真 zip，那组是唯一的验证手段。它只认 store / deflate，zip64 会明确报错让人手动解压。

## 改动落点索引

| 想改什么 | 改哪里 |
| --- | --- |
| 导航菜单、学习入口胶囊 | `src/components/Nav.tsx` + `Nav.css` |
| 有哪些页面 / 默认页 | `useTabRoute.ts` 的 `TAB_KEYS` + `Nav.tsx` 的 `TabKey`、`TABS` + `App.tsx` 的分支 |
| 查词交互、防抖 | `src/pages/SearchPage.tsx` |
| 词卡展示、加入学习按钮和首页目标列表 | `src/components/WordCard.tsx` + `src/pages/SearchPage.tsx` |
| 词库标签改名交互 | 只有 `src/pages/LibrariesPage.tsx`（别的页面一律只读 `<Tag>`，不给入口） |
| 释义数据兼容与上限 | `src/components/SensePicker.tsx`（当前无页面引用） + 服务端 `MAX_PICKED_SENSES` |
| 导入筛选 / 去重 / 预览 | `src/pages/ImportPage.tsx`（`wordForms` 管词形宽松匹配） |
| 学习列表行样式、多选批量删除 | `src/pages/ListsPage.tsx` + `useStudyList.removeItems` + 服务端 `POST /api/lists/:id/remove` |
| 学习列表批次分组 / 批次重命名 | `src/pages/ListsPage.tsx`（`visibleBatches` / `batchKeyOf`）+ `useStudyList.fetchBatches` / `renameBatch` + 服务端 `GET|PATCH /api/lists/:id/batches`（落盘 `batchNames`） |
| 目标达成度算法 | `src/components/StudyGoal.tsx` |
| 挑词弹窗 / 月历 / 打卡 | `src/pages/StudyPage.tsx` |
| 打印记录、整批打卡 | `src/pages/StudyPage.tsx` 的打印记录 section + `src/hooks/usePrintBatches.ts` + 服务端打印批次小节（`MAX_PRINT_BATCHES` / `enrichBatch`） |
| 按天 / 按周粒度、打卡按钮（会拼/会读/知意/✅下一轮） | `src/pages/StudyPage.tsx` 的 `mode` / `dueByWeek` / `handleWordAction` + 服务端 review 的 done/tally 语义 |
| 打标日志字段、保留条数 | 服务端 `pushMark` / `MAX_MARKS` / `PURE_MARK_ACTIONS` / `withoutMarks` |
| 卡片版式、打印 CSS、每页行列 | `src/utils/flashcards.ts` + StudyPage 的 `LAYOUTS` |
| 复习节奏、到期判断 | 服务端 `REVIEW_INTERVALS` / `nextDueAt` / `studyState` |
| 外部词典接口、缓存字段 | 服务端 `fetchDictEntry` / `normalizeEntry`（`normalizeEntry` 负责保留 `source`） |
| 本地优先顺序、三份来源怎么合 | 服务端 `resolveEntry` / `mergeEntry` / `pickSenses` / `localEntry` / `fillFromLocal` |
| 本地词典怎么查、释义怎么取 | `server/ecdict.mjs`（`ecdictEntry` / `pickTranslation` / `buildSenses` / `POS_MAP` / `altKeys` / `lemmaOf`） |
| 词典产物格式、索引结构 | `server/ecdict.mjs` 的 `STORE_FORMAT` / `STORE_FILES` / `INDEX_RECORD_SIZE` + `scripts/ecdict-build.mjs`（改了要重建 `data/ecdict/`） |
| 词典下载地址、解 zip | `scripts/ecdict-fetch.mjs`（`DEFAULT_URL` / `ECDICT_URL` / `unzipFirstCsv`） |
| 释义来源标签、装没装的提示 | `src/components/WordCard.tsx` + `src/pages/SearchPage.tsx` + `src/hooks/useDictSources.ts` |
| 补齐队列速率 | 服务端 `PREFETCH_CONCURRENCY` / `PREFETCH_PACE_MS`（只对 `network===true` 生效） |
| 数据文件位置 | 服务端 `DATA_DIR` 和五个 `*_FILE` |
| 端口 | 服务端 `PORT` + 11 处写死的 `SERVER` 常量 + `vite.config.ts` |
| 词库格式规范 | `vocab/format.md`（改了要同步 `src/types/vocab.ts`） |
| 设计 token / 通用类 | `src/index.css`、`src/App.css`、`src/ui/ui.css` |

## 验证清单

```bash
export PATH=/Users/rextao/.nvm/versions/node/v24.18.0/bin:$PATH
npm run build          # tsc -b && vite build，必须 exit 0
npm run test:server    # 动过 server/ 或 scripts/ 就跑，期望「284 passed, 0 failed」
```

改完后自查：有没有新增原生 `<select>` / `<textarea>` / `checkbox`；有没有新引依赖；有没有把 `nextDueAt` / `state` 这类派生字段写进 JSON 文件；归一化规则是不是几处都改了；本地词典没装（`data/ecdict/` 不存在）时功能是不是照样能跑。
