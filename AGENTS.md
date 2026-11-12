# AGENTS.md — 项目地图（给 AI 读）

读完这一份就能直接动手改代码，不必再全量扫源码。面向人的使用说明在 `README.md`；两份分工：README 讲「怎么用」，这份讲「怎么改」。`docs/` 只放设计决策与临时交接（规则见 `docs/README.md`），架构事实就地写在本文件，不再往文档目录同步。

## 协作方式（给 AI：优先并行子 agent）

- **能并行就并行**：只要任务能拆成互相独立的小块，且用并行子 agent 能提高效率，就尽量开多个子 agent 同时干，不要人为限制数量或场景。默认倾向并行，而不是串行。
- **典型该并行的活**：全库检索 / 批量读多个文件 / 分头调研多个模块（如同时看 `src/pages/*` 和 `worker/src/*`）/ 跑多组互不影响的检查 / 对照多个数据流或接口。扇出型、只读型任务一律优先派子 agent。
- **串行只在有依赖时**：下一步要用上一步的结果，才按顺序来；没有依赖关系就别排队。
- **并行不越过硬约束**：子 agent 同样守下面「硬约束」——删文件 / 动 git / 改 AI 锁定区前先问用户；写盘类改动要收口协调，避免多个子 agent 改同一文件打架。最终的 `npm run build` / `npm run test:server` 验证由主 agent 统一兜底。

## 是什么

背单词应用，前后端整体部署在 Cloudflare 上。前端 React 19 + TypeScript + Vite 6（`src/`），构建产物由同一个 Worker 的 [assets] 直接发；后端是 Cloudflare Worker（`worker/src/index.js`）+ D1 数据库（SQLite 方言），页面与 `/api` 同源、无 CORS。数据库 `english-study-sync`（学习列表 / 历史 / 标签 / 目标 / 打印批次 / 词典缓存全在里头），词库本体是 `vocab/` 下构建期打包的 JSON。查词链路只有云端缓存 → dictionaryapi.dev → 百度翻译（本地 ECDICT 已随上云退役）。所有 `/api/*` 需要 Bearer 令牌（Worker secret `API_TOKEN`）。UI 文案和代码注释一律中文。

历史上的本地 Node 服务（`server/dict-server.mjs`，127.0.0.1:3456）、本地 ECDICT 词典（`data/ecdict/`）与快照同步机制（`worker` 里的 sync API、手机端 `mobile/` 独立应用）均已删除。

## 硬约束（动手前先看）

- **Node 24**：运行 node / npm 命令前确认 `node --version` 为 24.x；项目用 `.nvmrc` 固定版本，系统默认版本不满足时先切换到 Node 24（`node:sqlite` 需要 24）。
- **AI 锁定区不可改动**：用户用 `<!-- AI_LOCK_START -->` / `<!-- AI_LOCK_END -->` 包起来的文字，任何情况下都不要修改、删除、挪位置或改写——重排格式、批量替换、翻译、润色、压缩文档时也必须原样保留，两条标记注释本身也不要动。非要动那块区域时先问用户。
- **零新增运行时依赖**：Worker 只用全局（`fetch` / `crypto.randomUUID` / `TextEncoder`），测试只用 `node:sqlite`；浏览器侧唯一的第三方分析依赖是 `posthog-js`（会话回放，见 `src/utils/analytics.ts`），别再加别的运行时依赖。
- **UI 禁原生控件**：页面里不要出现 `<select>`、`<textarea>`、`type='checkbox'`，统一用 `src/ui` 里的 `Select` / `TextArea` / `Checkbox`。
- **TS 严格**：`tsconfig.app.json` 开了 `strict` + `noUnusedLocals` + `noUnusedParameters` + `noFallthroughCasesInSwitch`（**没开** `noUncheckedIndexedAccess`）。
- **验证命令**：`npm run build`（= `tsc -b && vite build`）必须 exit 0；动过 `worker/` 再跑 `npm run test:server`（跑在临时目录的 node:sqlite shim 上，不碰真实数据）。文档结构检查使用 `npm run docs:check`。
- **密钥不进 git**：`API_TOKEN` / 百度翻译密钥 / Google TTS 密钥（`GOOGLE_TTS_API_KEY`）只能通过 `npx wrangler secret put <NAME>` 配成 Worker secret；沙箱连不了外网，部署 / 建表 / 迁数据 / 配密钥由用户在本机执行。
- **D1 写路径**：学习列表 / 词条与学习进度使用定向 SQL 和行级 INSERT / UPDATE / DELETE；不要在请求路径整库 load 或重写。全库读取仅留在测试断言辅助中。小型配置仍可用 kv JSON；打印记录目前有 60 条上限，若单批次规模明显增长，再评估拆成关系表。

## 目录地图（一行一职责）

```
src/main.tsx                      挂载 React + index.css；生产环境注册 /sw.js（PWA 外壳缓存），dev 不注册
src/App.tsx                       状态中枢：useVocabLibraries / useStudyList / useStudyPlan / useTabRoute 都在这，按 tab 渲染各页面并下传 props；背词会话也在这拉（reciteStarted 为 true 才 start，否则只读本周任务概况）；TokenGate 挂这——localStorage 无令牌或任何请求 401 时整页只渲染令牌输入
src/App.css                       通用类：.page/--narrow/--wide(1080) .card/--pad .callout/--success/--error/--warn .hint .empty/--inline .field-label .page-header
src/index.css                     设计 token：--color-* --radius-* --shadow-* --content-width --nav-height --font-*
src/types/vocab.ts                所有共享类型；前后端字段的唯一约定处

src/pages/SearchPage.tsx          查词页：标题左上角切换按钮（mode state）切批量导入，导入模式内嵌 ImportPage embedded；查词模式 = 输入 400ms 防抖 → useDictionary，词库命中 → useVocabMatch，渲染 WordCard
src/pages/ImportPage.tsx          批量导入：多行文本 → 归一化 / 去重 / 词库筛选（NO_FILTER | ANY_LIB | 词库 id）→ 预览上限 200 行 → 先 POST /api/dict/search-batch 走完整查询链路选好中文 → study.importItems → useDictPrefetch 盯后台补齐进度；embedded=true 时不渲染页头和 .page 外壳，目标列表控件抽成 targetControls 复用
src/pages/ListsPage.tsx           学习列表：切换 / 新建 / 重命名 / 删除；词条平铺一行一个；useDictBatch 取音标和中文词义；「批次」checkbox 按加入日期分组展示、可就地重命名（自定义名 + 只读日期 Tag）；「多选」开关 → 每行勾选框 + 全选 + 批量删除（二次确认）；词条首行 = 词 + 音标（左）+ 句子 / 词库 Tag 与「会拼 / 会读 / 知意」浅色小字（右），中文释义单独一行；音标后喇叭按钮（SpeakerButton）播 Google TTS，失败提示在页面顶部
src/pages/LibrariesPage.tsx       词库标签页（已并进设置页）：只显示 name + file + 显示标签 / 打印标签改名 / 重置默认值；embedded=true 时不渲染页头，主体抽成 content 变量
src/pages/StudyPage.tsx           英语学习页：StudyGoal + 挑词弹窗（Modal，勾词 → 打印卡片 + plan.startWords）+ 月历复习计划「按天 / 按周」粒度切换（mode 只存组件 state，按天选一天 / 按周选整周，逾期折叠进今天或本周，只有当前这天 / 这周可打卡）+ 标题旁「配置背词任务」按钮跳二级页 #/recite/tasks（ReciteTasksPage，可返回）；
                                  月历格子右上角「背」小角标：完成的那天标绿（完成日期来自 /api/recite/history），今天以后按整周进度标金（进行中）/ 灰（未开始），今天之前没完成的日子不显示；日历下方一行图例说明三种颜色，角标悬停有 title、格子 aria-label 写明进度；复习面板头部用 Tag 标「未配置背词 / 背词 X/Y · 学习中」+ 打印记录：每导出一次卡片留一条档，可整批打卡 / 删记录（usePrintBatches）
src/pages/SettingsPage.tsx        设置页（tab=settings）：顶部子菜单「词库配置 / 学习列表 / 学习记录 / 课堂录音 / 补充音标 / 补充音频 / 查询链路」；查询链路 = useDictSources.chain 排成有序列表（云端缓存 → dictionaryapi → 百度翻译），不可用步骤灰色标「跳过」并给原因；词库配置 = LibrariesPage embedded，学习记录 = LearningRecordsPage embedded
src/pages/AchievementsPage.tsx    学习成果页（tab=achievements）：目标达成度统计
src/pages/GoalPage.tsx            目标页（tab=goal，导航「更多」里有入口）：长期里程碑时间轴 + 单词目标四项进度；周期与目标词数全在 src/config/goalMilestones.ts，页面不写死阶段数量
src/pages/LearningRecordsPage.tsx  学习记录页：学习 / 打卡日志明细 + 筛选 + 批量删除；默认 embedded 进设置页「学习记录」分区，也仍挂在 #/records 上独立成页（导航里没有，从成果页进，带 onBack 和页头）；默认先只显示物理删除不可找回的红字提示（revealed=false 时不发请求），确认后才拉列表
src/pages/RecitePage.tsx          横屏背单词（tab=recite）：小朋友的全屏独立页，不渲染导航，也没有返回 / 退出按钮，只能从查词首页右上角「开始背单词」进；先停在本周任务首页（只读 GET /api/recite/task，不创建会话，避免一进页面就把词条标成「已开始」），点「开始 / 继续学习」才建会话；刷新 / 重新进页面时 task.activeSessionIndex 不为 null 就直接进背词流回到当前那张卡；
                                  普通卡只显示英文（中文与音标不显示），拼写卡显示中文 + 两行放大的虚拟键盘（第一行 Q、W + 删除键，第二行 A–Z 顺序，q、w 位置留半透明空位，一行放不下自动折行；「不会」在左下、「提交 / 下一个」在右下）；点「会 / 不会」先写服务端草稿 /api/recite/sessions/:id/drafts（不推进轮次，家长换设备也能读），翻面后底行左下角是「上一个」（第一张禁用，按草稿恢复上一张的翻面 / 输入）、右下角是「下一个」；顶部进度轨道上已学过的节点可点击回看（从草稿恢复判定状态：普通卡翻面、拼写卡回填）；最后一张后进完成动画页（奖杯 + 会 / 不会 / 拼写统计，页面背景无彩条也无背景动画），「完成」按钮只重播庆祝特效：特效共四种（五彩烟雾上飘 / 底部发射烟花 / 泡泡上飘到顶放大炸开 / 爱心上飘），每次打开或刷新完成页随机挑一种（同一次打开里反复点「完成」重播的总是同一种，且新的一轮叠在旧的上面、最多同时叠 3 轮，满了再点要等最早那轮播完才响应；不关窗口、不跳转，避免跳回首页时重新拉数据触发令牌门）；顶部进度轨道只有最后一张是 🎁 礼物节点，其余都是序号；单词卡右下角圆形喇叭按钮（纯图标）= utils/speech.ts 播 Google TTS（拼写卡判定前不出声，按钮始终渲染），请求 / 播放失败把原因（缺密钥 / 断网 / 超时 / 浏览器拦截）写在页面上；左下角录音小图标（每页都有，只有图标不写文字、绝对定位不占排版）：绿=录音中 / 灰=没开 / 黄=正在开启 / 红=不可用或开录失败（红图标可点重试）；首页同一位置是可点的开关（默认开启，偏好存 localStorage es-recite-record），浏览器 / 页面不支持录音时换成红色小图标；点「开始学习」时先在手势里预取麦克风（Safari 只认手势，等会话回来再要常被拒）；刷新 / 直接进背词流时自动开录没手势，失败后红图标可点重试，且下一次任意点击（点卡片 / 会 / 不会）会自动再要一次，进背词流开始 MediaRecorder 录音（还有没判过的卡片才录：完成页刷新进来不会自动开录），学完 / 切后台 / 关页面 / 离开页面 / 连续 1 分钟没声音都会停下这一段：先落本地队列再上传，传不上去留在本机等下次补传；因静音停下的，下一次点页面或按键会自动重开（见 useReciteRecording.ts）；打开页面还没点「开始学习」时 useRecitePreload 先把本周发音预取到本地；右下角齿轮（绝对定位、不占排版；灰=正常，红=录音不可用 / 开录失败）输入口令 123 打开 ReciteDebugPanel 看录音状态与本地缓存情况
src/pages/ReciteParentPage.tsx    家长端（#/recite/parent，保留的独立页，已没有 UI 入口）：按日期列出待保存 / 已保存的背诵记录，逐词显示 会 / 不会 / 拼写正确 / 拼写跳过；「保存记录」才统一提交 commit 推进轮次与次数。家长确认主入口在 #/recite/tasks 的任务列表行内直接判定与保存
src/pages/ReciteTasksPage.tsx     背词任务配置二级页（#/recite/tasks，从英语学习页进，页头可返回）：一周一行，本周到 12 周后；第 1 列日期区间（周一开始，只有本周标「本周」），无任务的周给「配置本周 / 这一周任务」按钮，有任务的周按每次一行展开：第 2 列「第 N 次」（已完成 / 学习中 / 主动推送 Tag），第 3 列读的词，第 4 列背的词；本周日期格子下面有「推送」按钮（有进行中会话时禁用）：弹 RecitePushPanel 选一批词强行推送，本周次数 +1 并直接开始这一次；两列单词前面都有序号（任务接口 wordOrder：已完成 / 学习中的次数取实际卡片位置，没开始的按 startSession 同一套 sortCards 预测），与背词页卡片出现顺序一致；
                                  已完成的次数在单词后直接显示判定（读的列只显知意，背的列知意 + 拼写，来自 fetchReciteHistory 60 条）；进行中的那一次读 sessions/active 的卡片与草稿同样行内显示（没判定的单词不显示标记），行右侧「保存」先弹保存抽屉（Drawer）：按背词页卡片序号列出这次还没保存的卡片，每张默认加 1 次（普通卡记「知意」、拼写卡记「会拼」，上下按钮 0–10 可调），点抽屉里的「保存」才 commit（30 张一批）并按填的次数累加熟悉度，点「取消」不写库；没开始（todo）/ 学习中（active）的那一次整行可点，点行只改这一行的词，学习中改词会把这次会话作废、这批单词需要重新学（行内右侧「保存」按钮不触发编辑），已学过的次数不可改；行内「修改配置」改整周，只在整周还没开始时出现；每一次「次数」单元格下面有喇叭（components/ReciteRecordingButton.tsx），这一次有课堂录音时点它能试听（同一次学习因为关页面 / 切后台录成几段时，顺序可信就合成一条连着播，不可信就分段各给一个按钮；同时只播一条，失败原因显示在表格上方）；保存后重读任务列表 / history / sessions/active 三份数据
src/pages/PassagesPage.tsx        短文页（tab=passages）：短文正文 + 生词分组（分批 / 很久没复习 / 知意或会读次数少 / 从未知意或会读），文中生词点开看释义、可打「会读 / 知意」标记；数据层 src/hooks/usePassages.ts
src/config/goalMilestones.ts      目标里程碑与各周期累计词数（改目标只改这里，GoalPage 自动重算）

src/components/Nav.tsx            顶部导航：普通 tab = 查词 / 学习列表 / 学习成果（列表角标 = totalItems）+ 右侧「英语学习」流光胶囊（角标 = plan.dueCount）+ 齿轮图标按钮（设置）；TabKey 定义在此（settings / records 都不在 tab 里，visibleActive 把 records 高亮到「学习成果」；recite-parent / recite-tasks 也高亮到「英语学习」）
src/components/TokenGate.tsx      访问令牌门：首次打开 / 401 时填令牌；令牌存 localStorage（key es-api-token）+ 同名 cookie 兜底（iOS PWA / 隐私模式清掉 localStorage 后不用重输）
src/components/AnalyticsConsent.tsx  回放同意条（main.tsx 里挂在 App 旁边）：没配 key 或已选过就不渲染
src/components/PageHeader.tsx     页标题区（title / subtitle / actions），样式在 App.css
src/components/WordCard.tsx       词卡：音标 / 词库标签 / 中文释义 / 右上角「加入学习」小按钮；卡片上不显示英文释义、也不显示例句
src/components/SpeakerButton.tsx  音标旁的喇叭按钮：点一下走 utils/speech 的 speak() 播放 /api/tts 发音，取音频 / 播放中图标变蓝（不旋转）；多选模式在 Checkbox label 内，onClick 拦事件；失败原因由 onError 透传给 ListsPage 的红色 toast（lists-toast--error）
src/components/StudyGoal.tsx      目标模块：目标词库（useStudyGoal）vs 已开始学的词 → 达成度 +「目标外的获得」；buildFormIndex 做词形宽松匹配
src/components/RecitePushPanel.tsx 主动推送弹窗（受控 Modal）：第 1 步选词 = 学习列表下拉 + ReciteWordGrid（与配置弹窗同一个选词网格），第 2 步确认里逐词勾「拼写」（句子 / 没释义的词不出拼写卡），底部「已选择 N 个 / 取消 / 下一步 / 返回选词 / 推送」；推送调 POST /api/recite/push（带 spellingWords），成功后刷新任务列表；有进行中的会话时整窗禁用并说明原因
src/components/ReciteWordGrid.tsx 背词选词网格（配置弹窗与推送弹窗共用）：搜索 + 按批次分组 + 每组「全选」+ 单词后的（N）（本周其他次数也选了它）；导出 wordKey / selectionKeyOf / wordLabelOf，两边的勾选键规则只此一份
src/components/ReciteTaskPanel.tsx  背词任务配置弹窗（受控 Modal）：标题只显示这一周的日期区间（如 11.9—11.15），每次单词数 / 每周学习次数（默认 15 / 3，次数是 1–7 下拉框）/ 学习列表 / 选择单词排成一行不分组；弹窗内视图切换的选词器每个分组表头固定写「全选」，单词后的（N）表示本周其他次数也选了它、不禁选；
                                  点某一行进来时（focusSession）只改第 N 次的词、其他次数原样保留（此时隐藏每次词数 / 次数）；选词「确定」、回填已有任务、改每次词数 / 次数都自动生成任务预览（无「预览任务」按钮），保存按钮在弹窗右下角，弹窗只做配置、没有进入学习的入口（学习只从查词页右上角「开始背单词」进）；配置哪一周完全由点开的那一行决定；整周任务已开始时没开始 / 学习中的那一次还能改（保存带 session，学习中改词会重置会话），已完成的次数与整周配置锁成只读；保存走 saveReciteTask（带 weekStart）；现在只挂在 ReciteTasksPage 内
src/components/ReciteTaskConfirm.tsx  家长确认弹窗（**已无调用方、死代码，待删**）：行内保存改造前的旧实现，功能已由 ReciteTasksPage 的行内判定 + 行右侧「保存」按钮取代
src/components/AudioRepair.tsx    设置页「补充音频」分区（embedded 进 SettingsPage）：列出学习列表里还没有 tts_cache 缓存的词 / 句子，一键排进后台预合成队列，轮询进度、失败可重试；Google TTS 未配置（缺 GOOGLE_TTS_API_KEY secret）时给配置指引并禁用按钮
src/components/ReciteRecordingManager.tsx  设置页「课堂录音」分区：列出最近 15 天的录音（时间 / 第几次 / 时长 / 大小），可试听、全选或多选后统一删除（DELETE /api/recite/recordings，音频分片一起删）；播放按钮 ReciteRecordingButton.tsx 同时用在 recite/tasks 每行的「次数」下面
src/components/ReciteDebugPanel.tsx 背词页右下角齿轮弹出的调试面板（输入口令 123 才进）：录音状态（支持 / 当前状态 / 失败原因，能开关录音与重试）+ 本地缓存情况（本周拉取进度、本地音频条数与占用、失败词单独重试 / 重新拉取本周 / 清空本地缓存）

src/hooks/useTabRoute.ts          hash 路由（#/search #/lists #/settings #/achievements #/records #/study #/recite），刷新与前进后退都停在原页；二级页 #/recite/parent、#/recite/tasks 走独立 hash；#/games/<id> 归到 tab=games 且首次进入时不会被规范成 #/games（保住游戏名）；LEGACY_TABS 把 #/import → #/search、#/libraries → #/settings，老书签不会失效
src/hooks/useSearch.ts            useVocabMatch：词 → 命中的词库 id 列表（纯内存 Map，不走网络）
src/hooks/useDictionary.ts        单词查询 GET /api/dict；走共享读缓存 apiCache（TTL 5 分钟），同一个词反复查不再打接口；服务端回错误状态码 → 'error'（这次没抓到释义），请求根本没发出去 → 'no-server'
src/hooks/useDictBatch.ts         批量读缓存 POST /api/dict/batch → entries / missing / incomplete
src/hooks/useDictPrefetch.ts      后台补齐队列：repair() 排队 + 1.2s 轮询进度；响应认不出就报 stale 而不是照抄进 state
src/hooks/useTtsPrefill.ts        发音预合成队列：prefill() 入队 + 1.2s 轮询 /api/tts/prefill 进度（形状与 useDictPrefetch 一致）
src/hooks/useDictSources.ts       词典来源状态 GET /api/dict/sources（字段校验不过 / 老服务 404 → null，界面不显示）；buildChain 排成设置页的查词链路（缓存 → dictionaryapi → 百度翻译，不可用给原因）
src/hooks/useStudy.ts             某个词在哪些学习列表里（查词页用）；走 apiCache（TTL 5 分钟），markAdded 增量更新；invalidateMembership(词 或 词数组) 按词作废，删列表时用 invalidateListMembership 全量作废
src/hooks/useStudyList.ts         学习列表全套 CRUD + 导入 + senseIds + 批量移除（removeItems）；导出类型 StudyListApi；fetchListWords / fetchBatches 走共享读缓存 apiCache，写操作自己作废；增删词后连带调 invalidateMembership（成员关系变了，查词页不能停在旧结果）
src/hooks/useStudyPlan.ts         复习计划 GET /api/study/plan + startWords + reviewWords + tallyUndo；三个写操作成功后按 listId 作废 apiCache 的词条缓存（否则学习页打卡后停在旧数据）；导出 StudyPlanApi / ReviewAction / ReviewOptions
src/hooks/usePrintBatches.ts      打印批次：留档 + 整批打卡 + 删记录（/api/print-batches 四个接口）；导出 PrintBatchesApi；只在 StudyPage 里用，不进 App.tsx
src/hooks/useStudyGoal.ts         目标词库读写 GET|PUT /api/study/goal
src/hooks/useVocabLibraries.ts    构建期打包 vocab/*.json + 标签读写 + localStorage 镜像与迁移
src/hooks/useLearningRecords.ts   学习记录页的数据层：achievements / history 分页 / 删事件 / 清词 / purge
src/hooks/useReciteRecording.ts   背词页课堂录音（MediaRecorder）：每 10 秒切块，Web Audio AnalyserNode 每 250ms 量一次音量（RMS ≥ 0.02 算有声音），连续 60 秒无声音就停下这一段并在下次点击 / 按键时重开；任何一次停（学完 / 切后台 / 关页面 / 离开页面 / 静音 / 录满 30 分钟或 16MB）都先把整段字节写进 IndexedDB 队列，再分片上传，传完才删本地副本；每段带会话 id、片段序号（localStorage es-recite-seg:<sessionId> 自增）、录制时间，永远绑在当前这次学习上；回前台 / 从 bfcache 回来重新开一段
src/hooks/useReciteRecordingPlayback.ts  课堂录音播放：把一次学习的一个 / 多个片段当成一条音频顺序播（按需拉 /api/recite/recordings/:id/audio、跨段进度与拖动、全站同时只播一条）
src/hooks/useRecitePreload.ts     背词首页的发音预取：没点「开始学习」时把本周词池的发音并发 2 拉到 IndexedDB，优先下一次要学的那一次（activeSessionIndex ?? completedSessions+1），主动推送的那次排最后；已缓存跳过，503 / 401 整体停下并给原因；点开始后暂停，调试面板可重试失败词

src/ui/                           手写组件库：Button Select Dropdown Input(含 TextArea) Checkbox Tag Popconfirm Popover Modal Drawer + useDismiss；统一从 src/ui/index.ts 导出（它顺带 import ui.css）

src/games/data.ts                 游戏统一数据层：useGameWords 取当期单词（与背词页同源：进行中的会话卡片 → 本周任务词表，句子卡与无释义的不要，按小写去重、去掉词性前缀）；shuffleWords / createWordDeck / dealWordRounds 提供「每个词只取一次」的牌堆，取完即这一局单词全部用完；所有游戏只从这里拿词，组件自己不请求接口
src/games/types.ts                游戏公共类型：GameWord（单词 + 中文释义）/ GameProps（外壳下发的 words，已去重）/ GameManifest（id + title + subtitle + Component）
src/games/registry.ts             游戏清单 GAMES + findGame(id)：加新游戏只往这里加一条，其余文件不动
src/games/GamesPage.tsx           游戏外壳（tab=games，全屏、不渲染导航，页内暂时没有任何入口，只能手输 #/games/<id>）：从 hash 取 slug → findGame，单词由 src/games/data.ts 的 useGameWords 统一提供（与背词页同一份词表，去重、去掉词性前缀）当 GameWord[] 下发；无页头也没有返回按钮，未找到 / 加载中 / 无任务 / 词太少都有中文提示
src/games/games.css              游戏外壳布局与 --g-* 粉彩变量（与背词页同一套配色，游戏子文件夹直接用）
src/games/xiaoxiaole/index.ts    消消乐清单项（id=xiaoxiaole，标题「单词消消乐」）
src/games/xiaoxiaole/XiaoxiaoleGame.tsx  单词消消乐：一关 6 对（12 张牌，4 列 3 行），英文牌与中文牌打乱混排，先点一张再点另一张，同组（同一对）就按两张牌中心画一条 SVG 线（stroke-dashoffset 描边动画）再一起缩掉；不同组则两张红外抖动 + 失误 +1；消掉的牌留在格子里透明（牌桌不重排）；每一关的词由 data.ts 的 dealWordRounds 从牌堆里发（7 个词切成 4+3，不留只有一对的尾巴；一个词整局只出现一次，打完最后一关 = 单词全部用完），每关底部「下一关」，全消完给用时 / 失误 /「再玩一次」（重洗牌回第一关）；游戏只管关卡与判定，不碰接口
src/games/xiaoxiaole/xiaoxiaole.css  消消乐牌面 / 连线 / 过关面板样式（横屏竖屏都能一屏放下 12 张牌，reduced-motion 关动画）
src/games/monster/index.ts       打怪兽清单项（id=monster，标题「单词打怪兽」）
src/games/monster/MonsterGame.tsx  单词打怪兽：场地桌面上限 1200×840 居中、手机横屏铺满（顶部怪兽带 = 场地高度 25%，保底 110px），得分 / 连击绝对定位在小怪兽右侧；顶部一只小怪兽往下扔中英文小球（开局先把 5 个单词、共 10 张球铺到底部再落下，之后同一时间只有一颗在飞：前一颗落定——含正被拖走的那颗——才发下一颗；球更大，单词球单行不换行、中文球最多 3 行，约 2 秒穿场落地），按住一个球拖到它的英文 / 中文配对上盖住就配对成功——两张球一起消失、得分 / 连击立刻结算，并从合并点朝小怪兽胸前打出一颗魔法飞弹（magicMissile.ts），命中那一刻才掉血 + 抖动 / 受击表情 / 伤害数字；配错则两张闪红并弹开（只计失误）；落下的球受重力、在球堆和地面上滚动（physics.ts 负责碰撞与休眠），球堆越高小怪兽扔得越慢，球堆顶逼近小怪兽时暂停发球（留出下一颗球的直径 + PILE_GAP；场上若只剩单张球则补发它的搭档防卡死），清出空间后自动继续，没有堆满判输；血量 = 本局全部单词配对完的总伤害（平时一刀 100、每 5 刀一次 200），牌堆里每个词只发一次、发完不再补：单词全部配对完的那一刻正好打倒小怪兽，这局结束（没有倒计时，也不重复出词），怪兽本体用 MONSTER_SHEETS 图库里的横排 4 状态精灵图（满血 / 受击 / 残血 / 最后关头，images/monster1–7 共 7 只，按列表轮换出场；2–7 每只的帧范围与竖直带都按透明像素单独量过，底部 746–878 是图上的 AI 水印要避开；7 号用抠掉白色棋盘底的 images/monster7-cutout.png），四帧在源图里并不等宽，按逐帧量好的像素范围裁剪，不会把下一格的脚带进来；按受击、剩余词数与血量切状态（场上只剩最后 3 个词就切到第 4 格那个最后状态），挨打时闪白变红、胸前飘红色伤害数字；打赢不弹窗：场地中心直接摆胜利奖杯图案 + 得分 / 配错，只有「再玩一次」按钮可点，最后一击结算时立即 reset 飞弹并清掉爆点 / 伤害飘字（胜利画面上不再残留攻击特效），场上残留的球与小怪兽淡出；发球门禁看「这一帧的真实位移」而不是 resting 标记（墙边抖动的球不会再把发球卡死），且上一颗球等超过 STUCK_WAIT = 3 秒仍未落定就照常发下一颗；每帧在 ref 里推进物理和飞弹再用 setFrame 重绘，不碰接口；prefers-reduced-motion 或画布没准备好时跳过飞弹、直接结算伤害
src/games/monster/physics.ts     打怪兽小球物理（纯函数、不碰 React / 接口）：重力 + 空气阻力下落（fallSpeed 约 2.6 秒穿过整块场地）、圆–圆分离与切向滚动、墙面 / 地面夹紧、静止休眠（落地或两颗球夹成凹槽才睡；一帧位移小于 STILL_EPSILON = 1.2px 也算「没动」，卡在墙边 / 夹缝里抖零点几像素的球不会再一直醒着）与 wakeUnsupported 从下往上唤醒、卡死兜底；骑在一颗球顶上（单支撑）不算落定，会按重力沿球面的切向被推开（ROLL_PUSH）滚向左右两边（球心正好压在上方时按场地左右半边选边），只有被旁边另一颗睡着的球卡住（pinned）才允许睡，不会叠成柱子
src/games/monster/magicMissile.ts  魔法飞弹特效（纯 canvas、不碰 React / 接口）：合并点 → 小怪兽胸前飞一颗像素飞弹，蓄力光点 → 扭动光带拖尾 → 命中星芒 + 冲击环 + 四散火星；画布按 1/3 低分辨率渲染（有序抖动 + 加色光缓冲），CSS 用 image-rendering: pixelated 放大；参考 pixelfx 的 projectiles/magic-missile（MIT）重写，不引运行时依赖；update() 在命中那一帧返回 CSS 坐标的 impact，由游戏结算伤害
src/games/monster/monster.css    打怪兽的场地（桌面上限 1200×840 居中）/ 底部地面色带 / 小怪兽（血条 + 0×0 定位锚 + 逐帧裁剪的四状态本体）/ 得分连击 HUD（绝对定位在小怪兽右侧）/ 小球（单词球 nowrap 单行）/ 魔法飞弹画布（.mst__fx，铺满场地、不挡指针）/ 命中特效（images/hit-fx.png，由 hit.png 抠掉灰底转成的透明爆炸图）/ 受击闪光 / 伤害飘字 / 开始面板与胜利层（中心奖杯图案、场上残留淡出）

src/utils/apiBase.ts              API 基址（恒为 ''，同源）+ getStoredToken/setStoredToken（localStorage 主、cookie 兜底）+ apiFetch（统一带 Bearer 头、401 时广播 AUTH_REQUIRED_EVENT）+ apiJson
src/utils/apiCache.ts             所有只读接口共用的会话级缓存：queryApi / peekApiCache / invalidateApiCache / ApiError；key = 登录态 + URL（参数排序）+ 方法 + body，按 tag 作废，同 key 在途请求合并；写入按 LRU 封顶 200 条；带 refresh=1 的请求既不读也不写缓存
src/utils/flashcards.ts           打印卡片：fetchCards（顺手补释义）/ pickSenses / mirrorRows / buildFlashcardsHtml / openCardWindow / renderCardsInto（打印会话 + 卡片右上角 ✕）；偶数页逐行左右镜像；卡片反面只印音标 + 中文，英文释义不上卡片
src/utils/analytics.ts            PostHog 会话回放：initAnalytics / getAnalyticsConsent / setAnalyticsConsent / trackPageview；默认 opt-out（同意前不采集、不录像），输入框统一 maskAllInputs 打码，同意状态存 localStorage es-analytics-consent；没配 VITE_POSTHOG_KEY 就整个跳过
src/utils/translations.ts         中文词义工具：translationOptions / selectedTranslationOptions / formatTranslationOptions；formatTranslationWithCustom 把自定义词义并进摘要；stripTranslationPos 去掉每个词性组的 n. / v. 前缀（游戏里只显中文）
src/utils/speech.ts               背单词发音：speak / stopSpeech / speechErrorMessage（错误翻成页面提示）；优先读 utils/reciteCache 的 IndexedDB 本地音频（背词首页预取的那份，断网也能播），没有才 /api/tts 现取并顺手落一份；base64 MP3 解成 Blob URL 复用（会话内按词缓存，换词掐掉上一段）；fetchSpeechStatus（/api/tts/status）只留作诊断
src/utils/reciteRecordingQueue.ts  录音片段本地待传队列（IndexedDB es-recite-uploads）：存原始字节，上传成功才删；15 天过期、最多 80 段，no-IDB 静默降级
src/utils/reciteRecordingUpload.ts  录音分片上传（POST 建记录带幂等 clientKey → PUT 400KB 一片 → POST complete，每片重试 3 次）+ flushQueuedRecordings 把本地队列依次补传
src/utils/reciteRecordings.ts      课堂录音归组与合并判定：按「周 + 第几次」归组，全部带片段序号 / 录制时间、序号不重复且序号顺序与时间顺序一致才 merged=true，否则分段显示（宁可不合并也不拼错顺序）
src/utils/reciteCache.ts          背词页本地音频缓存（IndexedDB）：audio / audioMeta / meta 三个仓库，键 = trim + 压空白 + 小写（与 speech.ts 同一套）；音频留 30 天、每 50 次写清一次过期；no-IDB / 隐私模式全静默降级成不缓存；导出 loadPersistedAudio / storePersistedAudio / getAudioCacheStats / saveReciteMeta / loadReciteMeta / clearReciteCache

worker/src/index.js               Worker 入口：/api/* 先校验 Bearer 令牌（safeEqual 恒定时间比较，health 免鉴权）再进 handleApi；其余请求交给 env.ASSETS（vite 构建产物，SPA 回落）
worker/src/app.js                 每请求应用上下文 createApp(env, waitUntil)：db 适配层 + 各 store + config
worker/src/db.js                  D1 最小适配层：all / first / run / batch（batch = 事务）；测试用 node:sqlite 实现同一接口
worker/src/routes.js              全部 /api 路由（handleApi 纯函数，返回 {status, body}；fetch 与测试共用）
worker/src/dict.js                词典链路：缓存 → dictionaryapi.dev → 百度大模型翻译；normalizeEntry / mergeEntry / resolveEntry / resolvePhoneticOnly / search-batch 的 mapConcurrent
worker/src/prefetch.js            后台补齐队列：状态存 D1 kv（prefetch-state），执行走 app.waitUntil（生产 = ctx.waitUntil，测试收进数组）；队头「认领」写回缩小并发撞车窗口
worker/src/tts-prefill.js         发音预合成队列（设置页「补充音频」）：状态存 D1 kv（tts-prefill-state），串行 + 限速调 synthesizeSpeech 写回 tts_cache，未配 GOOGLE_TTS_API_KEY 时拒绝入队
worker/src/review.js              艾宾浩斯算法：REVIEW_INTERVALS / nextDueAt / studyState / applyReview（打卡唯一实现）
worker/src/lists.js               列表领域服务：syncListTranslation / selectedTranslation / 标签 / 目标 / 打印批次三份小文档 / enrichBatch
worker/src/study-lists.js         lists / list_words 两张表的 store（行 ↔ StudyWordItem 映射；业务路径按列表 / 词条定向读写）
worker/src/study-history.js       learning_events / meaning_profiles store：内容寻址词义身份 + 聚合 + 软删
worker/src/kv.js                  kv 表（标签 / 目标 / 打印批次 / 补齐状态整份 JSON 一行）+ dict_cache 表（一词一行）
worker/src/passages.js            短文 store：正文 + 生词分组快照整份存 kv（key study-passages，最多 100 篇）
worker/src/recite.js              背词任务 / 会话 / 卡片：选词预览、稳定随机、草稿、commit（内部只调 review.js）；单行改词（saveSessionWords）改学习中的那一次会删掉该会话、草稿与卡片，需要重新学；主动推送（pushSession）给本周加一条次数并直接建 active 会话，跨天没学完的推送由 sweepPushedSessions 按「不会」收尾成已完成
worker/src/recordings.js          背词课堂录音：分三步上传（POST 建记录 → PUT 逐片 400KB → POST complete），单片幂等、可单独重试；分片与元数据存 D1（recite_recordings / recite_recording_chunks），只保留 15 天（没传完的半成品 1 天），读写时顺带清过期数据；音频走 /api/recite/recordings/:id/audio；设置页统一删除走 DELETE /api/recite/recordings（没选的 id 会被跳过）；listTasks 返回全部任务（按 week_start 排序，供配置二级页与学习页月历标记）
worker/src/text.js                normalizeText / capitalizeSentence（全库唯一主键规则）
worker/src/sha256.js              纯 JS 同步 SHA-256（Workers 没有 node:crypto 的同步 createHash；输出与 node:crypto 一致，迁移来的旧 meaning_key 能对上）
worker/schema.sql                 全量建表 SQL（wrangler d1 execute 一次性执行；含 DROP 废弃的 sync_snapshot）

worker/test/d1-shim.mjs           node:sqlite 模拟 D1 接口（prepare→bind→all/first/run + batch 事务）
worker/test/api.test.mjs          350+ 项断言：直接驱动 handleApi + 走真正 workerIndex.fetch 的鉴权用例

public/manifest.json              PWA 清单：name「背单词」、display standalone、theme_color #2563eb、start_url ./#/recite；图标 /icons/icon-192.png（any）与 /icons/icon-512.png（any maskable），图标文件由用户手动放进 public/icons/，不在代码里生成
public/sw.js                      手写 service worker：缓存应用外壳（导航网络优先 + 断网回落缓存的 index.html，静态资源缓存优先），/api 全部直连不缓存（数据实时 + 鉴权头）；版本号在文件顶部

scripts/study-cli.mjs             本地 CLI（npm run study）：列学习列表 / 列分组（复用 studyWordGroups.ts）/ 按词或分组导出打印 HTML / 默认写打印记录；线上地址 / 令牌从 .dev.vars 的 STUDY_API_BASE / STUDY_API_TOKEN 读取（命令行不可覆盖）；复用 src/utils/flashcards.ts 的 fetchCards 与排版（Node 24 直接 import .ts，该文件别用 enum / 参数属性等不可擦除语法）；新命令加在 COMMANDS 表

vocab/format.md                   词库统一格式（唯一规范来源）
vocab/ket.json                    剑桥 A2 Key，id=a2-key-2020，1661 条词条
vocab/parse_a2_key.py             pdftotext 文本 → 词库 JSON；正则与该 PDF 版式绑定，不通用
506886-a2-key-2020-vocabulary-list.pdf  词库原始 PDF

vite.config.ts                    vite：5173 / 监听所有网卡 / /api 代理到 8788；启动时把 .dev.vars 里的 VITE_* 注入前端
wrangler.toml                     部署配置：name=english-study、[assets] binding=ASSETS、D1 绑定 DB、DICT_TZ_OFFSET_HOURS=8
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
                                             │    ├ dict_cache（词典缓存，kv.js）
                                             │    ├ tts_cache（单词发音 MP3，tts.js）
                                             │    ├ recite_tasks / recite_task_words / recite_sessions /
                                             │    │   recite_cards / recite_card_drafts（背词，recite.js）
                                             │    │   recite_recordings / recite_recording_chunks（课堂录音，recordings.js）
                                             │    └ kv 里的 study-passages（短文，passages.js）
                                             └ 外部：dictionaryapi.dev / 百度大模型文本翻译 API（缓存没有才走）

vocab/*.json ──import.meta.glob(eager, 构建期打包)──▶ useVocabLibraries
```

页面内的局部状态：`useDictionary` + `useStudy` 在 SearchPage；`useDictBatch` 在 ListsPage；`useDictPrefetch` 在 ImportPage（查词页以 embedded 形式渲染时也归 SearchPage）；`useStudyGoal` 在 StudyGoal 组件内部；`useDictSources`（查词链路）在 SettingsPage；`usePrintBatches` 在 StudyPage 内部（只有那一页要打印记录）；`usePassages` 在 PassagesPage 内部；`useRecite` 的读写函数由 App / ReciteParentPage / ReciteTasksPage / ReciteTaskPanel 各自调用（服务端是唯一状态源，不往 App 里加背词数据）；`useLearningRecords` 在 LearningRecordsPage 内部（设置页嵌入与 #/records 独立页共用同一个组件，不额外挂状态）。

`useTabRoute` 的合法 tab：search / lists / settings / achievements / records / study / goal / passages / recite / recite-parent（`#/recite/parent`）/ recite-tasks（`#/recite/tasks`），LEGACY_TABS 兼容 `#/import` → search、`#/libraries` → settings。新增页面要同时改这里、`Nav.tsx` 的 `TabKey` / `TABS` 和 `App.tsx` 分支。

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

`markCount` / `reviewCount` / `spellingCount` / `readingCount` / `rememberedCount` / `forgottenCount` = 去规范化的累计次数，落盘供后续统计使用；只有学习列表词条首行右侧把 `spellingCount` / `readingCount` / `rememberedCount` 显示成「会拼 / 会读 / 知意」的浅色小字（0 次再淡一档），其余界面不显示这些计数。打标日志本身（时间 / 动作 / 粒度 / 轮次）**只写 D1 事件表**：撤销已改成事件软删，镜像同步不上。`markCount` 记总打标次数；`reviewCount` 只数实际 done/again 复习操作（done = 进入下一轮）；`spellingCount` / `readingCount` / `rememberedCount` / `forgottenCount` 分别统计会拼、会读、知意和没记住，**四者完全独立**。会拼 / 会读 / 知意走 action=`tally`（`successKind` 必传），只加对应计数，**不推进轮次、不改排期**，可重复点击各算一次；done 只推进轮次不加熟悉度计数。`lastDoneAt` 记最近一次 done 打卡时间，是轮次排期的锚点。`processedReviewKeys` 最多保留最近 80 个复习任务键，用于网络重试和重复点击幂等。

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
| `GET /api/tts/status` | `{available, configured, voice, language, limit}`；没配 `GOOGLE_TTS_API_KEY` 或断网时 available=false；仅诊断用，页面不据此隐藏喇叭 | speech.ts |
| `GET /api/tts?text=word` | Google TTS 合成 → `{text, mime, audio(base64 MP3), cached}`；命中 `tts_cache` 不再走外网，文本上限 160 字符 | speech.ts（RecitePage 喇叭） |
| `GET /api/tts/missing` | 学习列表里没有发音缓存的词 / 句子（超 160 字符的排除）+ TTS 状态 | AudioRepair |
| `POST /api/tts/prefill` | 把缺发音的文本排进后台预合成队列；没配 `GOOGLE_TTS_API_KEY` 回 503 | useTtsPrefill.prefill |
| `GET /api/tts/prefill` | 预合成队列进度 `{total,done,failed,pending,running,finished}` | useTtsPrefill |
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
| `GET \| PUT /api/recite/task` `{weekStart?, perSessionCount, sessionCount, selections, spellingWords, session?}` | 周任务读写；PUT 在本周已有会话时 409 `TASK_STARTED`；带 `session`（1-based）时只替换这一次的词，这一次没开始时即使整周已开始也能改，这一次已学过 / 正在学 → 409 `SESSION_STARTED` | useRecite |
| `GET /api/recite/tasks` | 全部周任务列表（按 week_start 排序），供配置二级页与学习页月历标记 | ReciteTasksPage / StudyPage |
| `POST /api/recite/preview` | 只算不存：容量截断、学习成果逆序自动填充、非法选词 | ReciteTaskPanel |
| `POST /api/recite/push` `{weekStart, selections, spellingWords?}` | 主动推送一批单词：本周 `session_count + 1`、直接建好这一次 active 会话（id 带 `recite-push-` 前缀标记来源），卡片规则与计划里的一次相同（每个词一张知意卡，`spellingWords` 里的词再加拼写卡）；已有进行中会话 409 `有进行中的一次学习` | RecitePushPanel |
| `GET /api/recite/sessions/active` | 家长端读当前待确认会话 + 草稿；**只读，不建会话** | ReciteParentPage / ReciteTasksPage |
| `GET /api/recite/history?limit=` | 已保存的背诵记录（最多 60 条，含每张卡的判定与 weekStart） | ReciteParentPage / ReciteTasksPage |
| `POST /api/recite/sessions/start` | 取 / 建 active 会话（进入页面本身不消耗次数） | useRecite |
| `GET \| POST /api/recite/sessions/:id/drafts` | 学生端「会 / 不会 / 拼写」草稿；不推进轮次、不累计次数 | useRecite.saveReciteDraft |
| `POST /api/recite/sessions/:id/commit` `{answers}` | 家长确认后统一落库；单次上限 60 张，前端按 30 张一批 | useRecite.commitReciteSession |
| `POST /api/recite/sessions/:id/cards/:cardId/(result\|spelling)` | 单卡提交（commit 内部复用，按 requestId 幂等） | useRecite.answerReciteCard |
| `GET /api/passages` · `POST /api/passages` · `PATCH /api/passages/:id` | 短文读写（正文 + 生词分组） | usePassages |
| `POST /api/passages/:id/mark` `{action: reading\|meaning}` | 短文里的词打会读 / 知意 | usePassages |
| `PATCH /api/study/achievements/:word` `{kind}` | 学习成果页改单词的知意 / 会读状态 | AchievementsPage |

环境变量（Worker 侧）：`API_TOKEN`（secret，鉴权令牌）、`BAIDU_TRANSLATE_API_KEY` / `BAIDU_TRANSLATE_APP_ID`（secrets，百度翻译）、`BAIDU_TRANSLATE_API_URL`（可选，测试 / 自定义网关）、`DICT_NO_NETWORK=1`（只吃缓存）、`DICT_NETWORK_TIMEOUT_MS`（默认 10000）、`DICT_TZ_OFFSET_HOURS`（默认 8，见复习算法）。`wrangler.toml` 的 `[vars]` 里已配 `DICT_TZ_OFFSET_HOURS=8`。

前端构建期变量（vite 从 `.dev.vars` 只取 `VITE_*` 注入）：`VITE_POSTHOG_KEY`（PostHog Project API Key，留空则不启用回放）、`VITE_POSTHOG_HOST`（默认 `https://us.i.posthog.com`）。这两个变量会打进 bundle，只能放 Project API Key 这类公开 key，不能放 secret。

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
  dict_cache            一个词一行 entry_json + status（`ok` / `partial`；冗余列，只为统计和
                        运维查询，行为判断仍以 entry_json 里的 status 为准）
  recite_tasks          周任务（week_start 唯一；per_session_count / session_count / capacity / config_version）
  recite_task_words     任务词池快照（主键 task_id+word；词、中文、list_id、position、spelling_enabled）
  recite_sessions       一次学习（task_id+session_index 唯一；status / cursor / completed_at）
  recite_cards          卡片与结果（session_id+position 唯一；card_type / result / request_id 唯一）
  recite_card_drafts    学生端暂存的判定（主键 session_id+card_id；不推进轮次，家长 commit 后删除）
  recite_recordings     课堂录音（id / session_id / week_start / session_index / mime / duration_ms / created_at；
                        client_key 上传幂等键唯一索引、recorded_at 录制时间、segment_index 会话内片段序号；
                        只保留 15 天，读写接口顺带清过期数据）
  recite_recording_chunks  录音音频分段（主键 recording_id+idx；base64，按 200KB 一段存）

STRICT 表。schema 由 `npx wrangler d1 execute english-study-sync --remote --file=worker/schema.sql`
一次性建好，Worker 运行时不做 DDL。学习数据已全部迁移进 D1：本地历史 sqlite、
一次性导入脚本（`scripts/migrate-to-d1.mjs`）与 `migration.sql` 均已删除，
不再存在本地旧数据覆盖线上 D1 的路径。

已有库改结构要另写迁移：`worker/migrations/*.sql` 一次性执行，必须赶在使用新结构的版本
上线之前跑完（例如 `dict_cache.status`：新代码的 UPSERT 会写这一列，列不存在直接报错）。
```

## 数据归属（取代旧的「跨设备共享」章节）

D1 是唯一数据源：桌面浏览器和手机浏览器打开同一个 Worker URL、带同一个令牌，看到并操作的就是同一份数据。没有同步、没有快照、没有手动提交 sqlite。本地 `cache/` 目录只剩上云前的历史遗留文件（`dict-cache.json.bak`、`backups/`），应用与脚本都不再读写它。
本地 `npm run dev` 读写的是另一份本地 D1（`.wrangler/state/`，`npm run db:local:sync` 创建或刷新），与线上库完全隔离，测试造数据不会污染生产（见「部署与迁移」的本地开发小节）。

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

## 背词任务（recite，`worker/src/recite.js`）

```
配置端 #/recite/tasks：ReciteTasksPage 一周一行列表 → 某周无任务时弹 ReciteTaskPanel 选词 →
      POST /api/recite/preview（只算）→ PUT /api/recite/task（存快照）
      容量 = 每次单词数 × 学习次数；超出部分丢弃（不删学习列表），不足按学习成果最近学习逆序自动填充
      任务词池：每词一张 meaning 卡；spelling_enabled 的词再加一张 spelling 卡
      顺序按 stableHash(taskId|sessionIndex|word|type) 排，避开连续 3 张拼写卡
学生端 #/recite：POST sessions/start → 点会 / 不会 / 拼写只 POST sessions/:id/drafts（不推进轮次）
家长端：入口在 #/recite/tasks 任务列表行内——进行中的那一次直接显示草稿判定，行右侧「保存」提交 commit；
      已完成的次数在单词后直接显示判定（history 按周 / 第几次归组 + sessions/active 的卡片与草稿）
      → 点「保存」POST sessions/:id/commit（30 张一批，requestId 幂等）
```

背词不新增第二套排期：`stage` / `nextDueAt` / `state` 仍只从 `list_words` + `review.js` 派生。任务已开始
（存在 active / completed 会话）后整周改词池一律 409；单行改词（`PUT /api/recite/task` 带 `session`）只允许
没开始 / 学习中的那一次——改学习中那一次时该会话连同草稿与卡片一起删除（响应里 `resetSession: true`），
下一次 start 会按新词重建会话，等于重新学。已完成的会话与卡片顺序作为历史保留。设计取舍见
`docs/decisions/001-recite-sessions.md`。

**主动推送**：本周日期格子下面「推送」→ RecitePushPanel 选词 → POST /api/recite/push：本周
`session_count` 加一（如 3 次变 4 次）并直接建好这一次 active 会话（id 带 `recite-push-` 前缀标记推送来源），
推送的词只存在这次会话的卡片里，不掺进计划的每次词表；卡片用 `buildSessionCards` 生成
（与 `startSession` 同一套：每词一张知意卡，勾了拼写的词再加一张拼写卡，stableHash 排序 + 避开连续 3 张拼写卡）。
有进行中的会话时拒绝推送（409）。跨天还没学完的推送：任一读接口进来时 `sweepPushedSessions` 先收尾——
没学的知意卡记「不会」（写学习记录）、没写的拼写卡记「skipped」（同背词页的跳过），会话置 `completed`，
history 里能直接看到这批结果。startSession 取「1..次数 里第一条没建过会话的序号」，
推送的会话不按顺序完成也不会撞号。

**课堂录音**：背词页首页左下角的开关默认开启（偏好存 localStorage），进背词流后用 MediaRecorder 录音。

一次学习可能录成**多段**：学完、切后台（visibilitychange → hidden）、关页面（pagehide）、离开页面、**连续 1 分钟没声音**
都会先停下当前这段；回前台 / 从 bfcache 回来再开一段，静音停下后则在下一次点页面 / 按键时重开（重新要麦克风发生在那次手势里，Safari 也认）。
静音检测走 AudioContext + AnalyserNode（每 250ms 一次，归一化 RMS ≥ 0.02 算有声音，AudioContext 接到 gain=0 再进 destination 保证图在跑），
不支持 AudioContext 时退化成不检测、照常录。注意停止时不会把尾部那 60 秒静音裁掉，音频里会保留这段空白。每段都记住会话 id、片段序号（localStorage `es-recite-seg:<sessionId>` 自增）
和录制时间，所以无论怎么停，录音都绑在当前这次学习上，补传后也能按时间拼回去。

**不丢音频**：停下的第一时间把整段字节写进 IndexedDB 队列（`es-recite-uploads`），再上传；上传成功才删本地副本。
断网 / 关页面 / 上传失败时副本留在本机，下次进背词页（或网络恢复）由 `flushQueuedRecordings` 依次补传，
`client_key` 幂等键保证重传不会多出重复记录。

上传分三步：POST /api/recite/recordings 先建一条 `uploading` 记录（带分片数、clientKey、recordedAt、segmentIndex）→
PUT /api/recite/recordings/:id/parts/:index 按 400KB 一片传（幂等，每片重试 3 次、失败的片再补一轮）→
POST /api/recite/recordings/:id/complete 校验片数齐了才标 `ready`。断网只丢某一片、重传那一片即可，
不会整段报废。24kbps 语音 6MB ≈ 33 分钟；单条上限 16MB，录满 30 分钟或撞上限自动停。服务端一片一行存在
recite_recording_chunks（D1 单行有大小上限，不能整段塞一行），元数据在 recite_recordings；只保留 15 天
（没传完的半成品 1 天），没有 cron，读写时顺带清过期数据。

**显示**：recite/tasks 每一行「次数」下面有喇叭，音频走 /api/recite/recordings/:id/audio（同样要 Bearer）。
同一次学习的多段按会话归组：全部带片段序号与录制时间、序号不重复且序号顺序与录制时间顺序一致，才当成一条连着播；
任何一项不满足（老数据没序号、跨会话、时间倒退）就**不合并**，分段各给一个按钮——宁可不合并，也不拼错时间顺序。
顺序播放由 `useReciteRecordingPlayback` 统一处理（跨段进度、拖动、倍速，全站同时只播一条）。
设置页「课堂录音」分区仍逐条展示 / 试听、全选后统一删除（DELETE /api/recite/recordings，只删音频，不动学习记录）。

已有库要先跑 `worker/migrations/2026-11-11-recording-segments.sql` 再加三列（client_key / recorded_at / segment_index）
与唯一索引，否则新代码写录音会报错。

## 词典链路（云端：缓存 → 外部）

```
GET /api/dict → ensureEntry(word, force) → resolveEntry(word, force) → { entry, network }
  1 缓存 status===ok 且未 force → 直接返回，network=false
      例外：句子的翻译来源不是百度、或音标 / 翻译不齐 → 重抓（旧缓存不能挡住重翻）
  2 上次没抓齐（partial）且还在冷却期内 → 也用缓存，network=false
      例外：force（refresh=1）；上次是「百度密钥没配」且现在已经配好 → 立刻重试
  3 NO_NETWORK：只有旧缓存可用，没有回空 partial
  4 fetchDictEntry(word)：非短语 → dictionaryapi.dev 取 phonetic + senses 全集，
      再打百度大模型文本翻译 API 取中文；dictionaryapi 404 = 确认没这个词（spellingStatus=suspect），
      超时 / 限流 = unknown，留给下次 repair
  5 句子：逐词查音标按原句拼回（允许部分成功 → phoneticStatus=partial），
      整句中文必须百度（translationSource=baidu）
  收尾 mergeEntry({ fresh, old })：这次抓的 > 旧缓存；status = (dictOk && translation) ? ok : partial
```

- 本地 ECDICT 已删除：`source: 'ecdict'` 只出现在迁移来的旧缓存里，`GET /api/dict/sources` 没有 `local` 字段。
- 容量上限：`MAX_SENSES_PER_POS=12`、`MAX_SENSES=40`、`MAX_PICKED_SENSES=12`、`MAX_BATCH_SEARCH_ITEMS=200`、`BATCH_SEARCH_CONCURRENCY=2`。
- `isBadTranslation`：空 / 等于原词 / **一个汉字都没有** → 当失败（不会写入缓存）。
- 补齐队列：`PREFETCH_CONCURRENCY=2`、`PREFETCH_PACE_MS=250`，只有真打了外部接口（`network===true`）才 sleep。执行挂在 `app.waitUntil`（生产 = `ctx.waitUntil`，平台给约 30s；没跑完的留在队列里，下次 repair 续上）。加词 / 导入只排 `phoneticOnly` 任务（不重翻中文，不覆盖快照）。
- 「查一次就永久复用」是有意设计：`status=ok` 的词条不再碰外部接口（没有 TTL、没有版本号）。改「什么算抓齐」的规则时要自己失效旧缓存。
- 抓不齐的重试冷却：`PARTIAL_RETRY_COOLDOWN_MS=10 分钟`，判断依据是 `entry.lastAttemptAt`（只有完整抓取才会写它，后台补音标不算）。没有它就变成「每次被看到都重打一遍 dictionaryapi + 百度」。句子不适用冷却——句子规则（必须有百度翻译 + 音标）优先。
- 缓存就是 D1 的 `dict_cache` 表，无常驻内存副本，每次按需 `IN` 查询（`IN_CHUNK=80` 防 D1 绑定参数上限）。统计接口（`/api/dict/sources`、`/api/cache/stats`）只数 `status` 列，不读 `entry_json`。

## UI 层约定

- 组件一律 `import { X } from '../ui'`；`src/ui/index.ts` 会顺带引入 `ui.css`。API 命名对齐 antd（`size` / `block` / `allowClear` / `options` / `okText`…），将来换真 antd 基本只改 import。
- z-index 约定：`.ui-select__list` / `.ui-menu` = 30，`.ui-popover` = 40，`.ui-drawer-mask` = 50（右侧抽屉），`.ui-modal-mask` = 60。
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
- **前端读缓存是会话级的，写完必须作废**：所有只读接口走 `src/utils/apiCache.ts`（TTL 由调用方给，切 tab 重建页面时直接复用、不打接口），缓存按 tag 作废。新增任何改 `list_words` 的写路径，成功后必须调对应的 `invalidateApiCache(['list-words:<listId>', ...])` / `invalidateMembership(词)`，否则页面停在旧数据：学习页打卡靠 `setReloadToken` 触发 `fetchListWords`，缓存没作废等于白刷新。带 `refresh=1` 的请求是服务端「跳过缓存」语义，`queryApi` 对它既不读也不写缓存。

## 改动落点索引

| 想改什么 | 改哪里 |
| --- | --- |
| 导航菜单、学习入口胶囊 | `src/components/Nav.tsx` + `Nav.css` |
| 批量导入入口 | `src/pages/SearchPage.tsx` 标题左上角的切换按钮 |
| 令牌门 / 鉴权 | `src/components/TokenGate.tsx` + `src/App.tsx` + `src/utils/apiBase.ts` + `worker/src/index.js` |
| 有哪些页面 / 默认页 | `useTabRoute.ts` 的 `TAB_KEYS` + `Nav.tsx` 的 `TabKey`/`TABS` + `App.tsx` 的分支 |
| 查词交互、防抖 | `src/pages/SearchPage.tsx` |
| 词卡展示、加入学习按钮 | `src/components/WordCard.tsx` + `src/pages/SearchPage.tsx` |
| 词库标签改名交互 | 只有 `src/pages/LibrariesPage.tsx`（已嵌进 SettingsPage） |
| 查词链路展示 | `src/pages/SettingsPage.tsx` + `useDictSources.ts` 的 `buildChain` + `GET /api/dict/sources` |
| 释义数据兼容与上限 | `src/components/SensePicker.tsx`（当前无页面引用） + 服务端 `MAX_PICKED_SENSES` |
| 导入筛选 / 去重 / 预览 | `src/pages/ImportPage.tsx`（`wordForms` 管词形宽松匹配） |
| 学习列表行样式、多选批量删除 | `src/pages/ListsPage.tsx` + `useStudyList.removeItems` + `POST /api/lists/:id/remove` |
| 学习列表批次分组 / 批次重命名 | `src/pages/ListsPage.tsx` + `useStudyList.fetchBatches`/`renameBatch` + 服务端 batches 接口 |
| 目标达成度算法 | `src/components/StudyGoal.tsx` |
| 挑词弹窗 / 月历 / 打卡 | `src/pages/StudyPage.tsx` |
| 打印记录、整批打卡 | `src/pages/StudyPage.tsx` + `src/hooks/usePrintBatches.ts` + 服务端打印批次 |
| 按天 / 按周粒度、打卡按钮 | `src/pages/StudyPage.tsx` + 服务端 review 的 done/tally 语义 |
| 打标日志字段、保留条数 | 服务端 `pushMark` / `MAX_REVIEW_KEYS` / `PURE_MARK_ACTIONS` / `withoutMarks` |
| 卡片版式、打印 CSS、每页行列 | `src/utils/flashcards.ts` + StudyPage 的 `LAYOUTS` |
| 复习节奏、到期判断 | `worker/src/review.js` 的 `REVIEW_INTERVALS`/`nextDueAt`/`studyState` |
| 外部词典接口、缓存字段 | `worker/src/dict.js` 的 `fetchDictEntry`/`normalizeEntry`/`mergeEntry` |
| 补齐队列速率 | `worker/src/prefetch.js` 的 `PREFETCH_CONCURRENCY`/`PREFETCH_PACE_MS` |
| API 路由 / 新增接口 | `worker/src/routes.js` + `worker/test/api.test.mjs` |
| D1 表结构 | `worker/schema.sql`；已有数据的库另写 `worker/migrations/*.sql`，上线前必须跑完 |
| 本地 CLI / 脚本调用线上 API | `scripts/study-cli.mjs` 的 COMMANDS 表 + README「本地命令行」 |
| 部署配置 | `wrangler.toml` |
| 词库格式规范 | `vocab/format.md`；改了同步 `src/types/vocab.ts` |
| 设计 token / 通用类 | `src/index.css`、`src/App.css`、`src/ui/ui.css` |

## 部署与迁移（用户在本机执行；沙箱连不了外网）

建表 / 迁移 SQL、密钥配置、本地开发（`npm run dev` / `npm run db:local:sync` / `.dev.vars` 读法）全部见 README「快速开始」「本地环境变量：只有 `.dev.vars`」「部署（一次性配置）」三节，本文件不重复。提醒：已有库改结构必须另写 `worker/migrations/*.sql` 并在上线前跑完，再发布使用新结构的 Worker。

## 验证清单

```bash
node --version  # 必须为 24.x；项目版本见 .nvmrc
npm run build          # tsc -b && vite build，必须 exit 0
npm run test:server    # 动过 worker/ 就跑；测试不得联网，也不得修改真实数据
```

改完后自查：有没有新增原生 `<select>` / `<textarea>` / `checkbox`；有没有绕过 `apiFetch` 的裸 `fetch`；有没有新引依赖；有没有把 `nextDueAt` / `state` 这类派生字段写进表；归一化规则是不是几处都改了；`DICT_NO_NETWORK=1`（断网）时功能是不是照样能跑。
