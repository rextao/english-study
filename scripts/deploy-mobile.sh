#!/usr/bin/env bash
# 手机端静态站 + 云端同步 API 一键部署到 Cloudflare（合并成同一个 Worker）
#
# 部署配置在仓库根目录的 wrangler.toml：
#   - [assets] directory = "./mobile/dist" —— 命中静态文件直接发（手机端页面）；
#   - main = "./worker/src/index.js"       —— 只处理 /sync/* 同步接口，其余回落到静态资源。
# 页面和它请求的 /sync/* 现在同源，不再有跨域。本脚本只是把「构建」和「部署」串起来，
# 实际部署动作就是最后那一句 npx wrangler deploy。
#
# 前置条件（在能连外网的机器上跑一次即可）：
#   1. Node 24（脚本会自动把本机 nvm 的 node 加到 PATH）
#   2. 首次运行 npx 会拉 wrangler，并要求 npx wrangler login 授权一次
#   3. 首次还要给这个 Worker 建表 + 设同步令牌（各跑一次即可）：
#        npx wrangler d1 execute english-study-sync --remote --file=worker/schema.sql
#        npx wrangler secret put SYNC_TOKEN
#
# 用法（在仓库根目录执行）：
#   npm run deploy:mobile            # 构建 + 部署
#   bash scripts/deploy-mobile.sh    # 同上
#   npx wrangler deploy              # 只部署（要求 mobile/dist 已经构建好）
set -euo pipefail

# 切到仓库根目录（脚本在 scripts/ 下，.. 即根目录，wrangler.toml 就在那里）
cd "$(dirname "$0")/.."

# Node 24 固定路径（与本机 nvm 保持一致，不存在则跳过）
NODE_BIN="/Users/rextao/.nvm/versions/node/v24.18.0/bin"
if [ -d "$NODE_BIN" ]; then
  export PATH="$NODE_BIN:$PATH"
fi

PROJECT="english-study-mobile"

echo "==> node 版本：$(node -v)"
echo "==> 构建手机端（tsc 类型检查 + vite build，产物 mobile/dist）..."
npm run build:mobile

echo "==> 部署到 Cloudflare（读取根目录 wrangler.toml，部署 mobile/dist）"
echo "==> 首次部署会要求 npx wrangler login 授权一次。"
npx wrangler deploy

echo ""
echo "==> 部署完成。"
echo "    访问地址以 wrangler 输出的 URL 为准，一般是 https://${PROJECT}.<你的子域>.workers.dev"
echo "    这个 Worker 同时服务 /sync/* 同步接口（和页面同源）。首次部署后记得建表 + 设令牌："
echo "      npx wrangler d1 execute english-study-sync --remote --file=worker/schema.sql"
echo "      npx wrangler secret put SYNC_TOKEN"
