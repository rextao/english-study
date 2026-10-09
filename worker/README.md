# 云端数据同步服务（Cloudflare Worker + D1）

> ⚠️ 部署方式已变更：同步 API 现在和手机端静态站**合并进同一个 Worker**（`english-study-mobile`），
> 部署配置是**仓库根目录的 `wrangler.toml`**（`[assets]` 发页面 + `main` 指向本目录 `src/index.js` 处理 `/sync/*`）。
> 本目录的 `src/index.js` 和 `schema.sql` 仍在用；但 `worker/wrangler.toml` 和 `worker/deploy.sh` 是**旧的独立部署配置（legacy）**，
> 单独用它们会多出一个 `english-study-sync` 域名、重新制造跨域，别再用。日常部署在仓库根目录跑 `npm run deploy:mobile`。

桌面端的学习数据通过这里中转：本地服务把整库快照推到 D1，另一台设备再拉下去。
**只存数据，页面不部署到云端**——前端还是跑在本机 / 手机本地。

## 为什么这样设计

- 整库快照 + 哈希，不做逐行合并。学习数据是「以某一台为准」的顺序交接，合并反而容易算错。
- 快照哈希在本地服务算（server/sync.mjs），Worker 只当带令牌鉴权的存储，不在云端重算，
  避免两端哈希算法分叉后互相认不出。
- 浏览器不直连云端，同步由本地服务（127.0.0.1:3456）发起，令牌不暴露给页面。

## 接口

除 /sync/health 外都要 Authorization: Bearer <SYNC_TOKEN>：

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | /sync/status | 当前快照摘要（哈希 + 行数 + 谁推的 + 时间），省流量 |
| GET | /sync/snapshot | 完整快照 |
| POST | /sync/snapshot | { snapshot, snapshotHash } 覆盖云端快照，返回上一个哈希 |
| DELETE | /sync/snapshot | 清空云端快照（另一台会拉到空数据，慎用） |
| GET | /sync/health | 探活，不用令牌 |

## 部署

现在和手机端一起部署，不再单独部署这个服务。在仓库根目录（有外网的环境）执行：

- npm run deploy:mobile      # 构建手机端 + 部署合并 Worker（english-study-mobile）

首次部署后，给这个 Worker 建表、设令牌各一次（D1 库名仍是 english-study-sync）：

- npx wrangler d1 execute english-study-sync --remote --file=worker/schema.sql
- npx wrangler secret put SYNC_TOKEN                 （起一个足够长的随机串）

部署完拿到 https://english-study-mobile.xxx.workers.dev 地址。桌面端在「设置 -> 数据同步」
填这个地址 + 令牌；手机端打开同一个地址、只填令牌（同源，不用填地址）。

> 旧的独立部署（legacy）：`cd worker && ./deploy.sh` 会把同步服务单独部署成
> english-study-sync Worker，和手机端分成两个域名、制造跨域，已不推荐。

## 数据只存一份

D1 里只有一张 sync_snapshot 表，永远只有一行（id = current）：最后推上去的那份快照
覆盖前一份。历史版本不保留，所以同步冲突时应用会让你选方向，而不是自动合并。
