# 手机端（mobile/）

桌面端（src/）跑在本机、强依赖本地服务 server/dict-server.mjs（127.0.0.1:3456）；
手机端要部署到云端给手机访问，所以做成一个独立的精简 Vite 应用，和桌面端互不干扰。
手机端页面和云端同步 API 合并部署在同一个 Worker（见仓库根 `wrangler.toml`），同源、不跨域。

## 结构

```
mobile/
├── index.html              入口，移动端 viewport / 安全区 / PWA meta
├── vite.config.ts          独立配置：root=mobile/，base 相对路径，产物 mobile/dist
├── tsconfig.json           继承根 tsconfig.app.json，只编译 mobile/src
└── src/
    ├── main.tsx            挂载 React
    ├── App.tsx             状态中枢：同步配置 / 拉取快照 / 会拼会读知意加减写回 / 学习成果页（默认进入，底部 icon 导航）
    ├── index.css           移动端基础样式 / 设计 token / 组件样式
    ├── lib/
    │   ├── config.ts       同步配置读写（localStorage：仅令牌；地址用当前站点 origin）
    │   ├── format.ts       时间格式化
    │   ├── snapshot.ts     拉取并解析云端整库快照（读取 + 解析，聚合规则对齐桌面端）
    │   └── tally.ts        会拼 / 会读 / 知意的加减写回：改内存快照 → 重算哈希 → POST /sync/snapshot 整份覆盖
    ├── components/
    │   ├── SetupScreen.tsx   同步配置页（只填令牌，地址同源）
    │   ├── RecordsTab.tsx    （已停用，入口已移除）单词记录：按列表分组 + 搜索过滤
    │   └── AchievementsTab.tsx  学习成果：单词模糊筛选 + 复习/会拼/会读/知意排序 + 逐词 / 词义小计
    └── vite-env.d.ts       vite 类型声明
```

部署相关的文件在仓库根目录（不在 mobile/ 里）：

- `wrangler.toml`：Cloudflare 部署配置，`[assets] directory = "./mobile/dist"` + `main = "./worker/src/index.js"`，在根目录 `npx wrangler deploy` 即可部署手机端页面 + 同步 API（同一个 Worker）。
- `scripts/deploy-mobile.sh`：「构建 + 部署」封装脚本，`npm run deploy:mobile` 调用的就是它。

## 命令（在仓库根目录执行）

```
npm run dev:mobile       # 本地开发，http://localhost:5174
npm run build:mobile     # 类型检查 + 构建，产物在 mobile/dist
npm run preview:mobile   # 本地预览构建产物
npm run deploy:mobile    # 构建 + 部署到 Cloudflare（scripts/deploy-mobile.sh）
npx wrangler deploy      # 只部署（前提：mobile/dist 已构建好）
```

所有命令复用仓库根的 node_modules，不需要额外装依赖。

## 部署

部署配置在仓库根目录的 `wrangler.toml`，走 Cloudflare Workers 静态资源（`[assets]` 指向 `./mobile/dist`），
同时 `main` 指向 `worker/src/index.js` 处理 `/sync/*` 同步接口——页面和同步 API 同在一个 Worker、同源。
所以在根目录执行 `npx wrangler deploy`（或 `npm run deploy:mobile`，后者会先自动构建）就能把手机端发上去。

需要能连外网。首次运行会要求 npx wrangler login 授权一次：

```
npm run deploy:mobile
```

部署成功后访问 `https://english-study-mobile.<你的子域>.workers.dev`（具体地址以 wrangler 输出的 URL 为准）。
首次部署后还要给这个 Worker 建表并设同步令牌（各一次）：`npx wrangler d1 execute english-study-sync --remote --file=worker/schema.sql` 和 `npx wrangler secret put SYNC_TOKEN`。

## 后续功能迁移思路

桌面端数据都在本地服务和 cache/study-history.sqlite，手机端不可能直接连本机服务，
所以迁移靠「云端快照中转」：手机端从同一个 Worker 的 `/sync/*` 拉整库快照（代码见
`worker/src/index.js`）。写回也走这套——会拼 / 会读 / 知意的加减直接改内存里的整库快照、
重算哈希后用已有的 POST /sync/snapshot 整份覆盖推回云端，不用给 Worker 加新接口
（写逻辑见 `mobile/src/lib/tally.ts`）。后面要迁的功能（如批量导入生词）按同样思路加即可。

## 当前进度

1. **只读 + 加减写回（已完成）**：从云端 Worker 拉整库快照（GET /sync/snapshot，Bearer 鉴权），
   默认进入「学习成果」页（支持单词模糊筛选 + 按复习/会拼/会读/知意排序，逐词 / 词义小计），
   并能对会拼 / 会读 / 知意就地加减——先本地乐观更新，再把整库快照用 POST /sync/snapshot 推回云端。
   同步配置（仅令牌，地址与同步接口同源）存在本机 localStorage，首次打开填一次即可。
2. **手机端导入（待做）**：手机端能把生词批量导入到某个学习列表（继续复用整份快照覆盖）。
3. **增量同步（待做）**：现在是整库快照一把拉、一把推，数据多了之后要改成按行 / 按时间戳的增量同步。

数据说明：快照里的 learning_events 记的是打标日志（开始 / 打卡 / 会拼 / 会读 / 知意 / 打印等动作，
含时间、粒度、轮次），list_words 是学习列表里的单词本体；学习成果的聚合规则和桌面端
server/study-history.mjs 的 aggregate() 保持一致，删掉的事件（deleted_at）不计入。
