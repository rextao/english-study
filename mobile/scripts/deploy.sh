#!/usr/bin/env bash
# 手机端一键部署到 Cloudflare Pages
#
# 前置条件（在能连外网的机器上跑一次即可）：
#   1. Node 24（脚本会自动把本机 nvm 的 node 加到 PATH）
#   2. 首次运行 npx 会拉 wrangler，并要求 npx wrangler login 授权一次
#
# 用法：
#   npm run deploy:mobile               # 部署到 main（生产）
#   bash mobile/scripts/deploy.sh       # 同上
#   bash mobile/scripts/deploy.sh test  # 传分支名部署预览环境
set -euo pipefail

cd "$(dirname "$0")/.."

# Node 24 固定路径（与本机 nvm 保持一致，不存在则跳过）
NODE_BIN="/Users/rextao/.nvm/versions/node/v24.18.0/bin"
if [ -d "$NODE_BIN" ]; then
  export PATH="$NODE_BIN:$PATH"
fi

BRANCH="${1:-main}"
PROJECT="english-study-mobile"

echo "==> node 版本：$(node -v)"
echo "==> 构建手机端（tsc 类型检查 + vite build）..."
npm run build:mobile

echo "==> 部署到 Cloudflare Pages（项目：${PROJECT}，分支：${BRANCH}）"
echo "==> 首次部署会自动创建项目，之后每次都是增量更新。"
npx wrangler pages deploy "./dist" \
  --project-name "$PROJECT" \
  --branch "$BRANCH" \
  --commit-dirty=true

echo ""
echo "==> 部署完成。"
echo "    生产地址：https://${PROJECT}.pages.dev"
echo "    预览地址：https://<commit-hash>.${PROJECT}.pages.dev"
