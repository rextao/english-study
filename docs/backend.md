# 后端开发地图

## 入口和分层

- `worker/src/index.js`：鉴权、静态资源和 Worker fetch 入口。
- `worker/src/app.js`：请求级应用上下文和 store 组装。
- `worker/src/routes.js`：API 路由分发和响应协议。
- `worker/src/db.js`：D1 最小适配层；测试使用同一接口的 shim。
- `worker/schema.sql`：完整数据库结构。

领域实现位于 `worker/src/` 的对应模块，例如 `study-lists.js`、`study-history.js`、`review.js`、`dict.js` 和 `kv.js`。

## 修改约定

- 所有 `/api/*`（健康检查除外）需要 Bearer 令牌。
- 学习列表和进度使用定向 SQL；请求路径不能整库加载后重写。
- `nextDueAt`、`state`、`weekStart` 等派生值只在读取时计算，不落盘。
- 复习行为统一经过 `review.js` 的实现。
- 新增或改变 API 时，同时更新 route、类型/调用方和 `worker/test/api.test.mjs`。
- 改 schema 时新增 `worker/migrations/*.sql`，并确认部署顺序。

## 后端验证

```bash
node --version  # 必须为 24.x；项目版本见 .nvmrc
npm run test:server
npm run build
```

测试不得依赖联网、线上 D1 或真实 secret。
