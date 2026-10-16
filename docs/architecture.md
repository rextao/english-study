# 系统架构

## 边界

- 前端是 `src/` 下的 React 19 + TypeScript + Vite 应用。
- 后端是 `worker/src/` 下的 Cloudflare Worker。
- Worker 通过 `[assets]` 提供前端构建产物，并处理同源 `/api/*` 请求。
- D1 是学习列表、学习进度、学习记录、标签、目标、打印批次和词典缓存的唯一运行时数据源。
- `vocab/*.json` 是构建期打包进前端的只读词库。

## 请求和状态流

```text
React 页面
  -> hooks / apiCache / apiFetch
  -> 同源 Worker /api
  -> routes -> app stores
  -> D1
```

词典请求的顺序是云端缓存、`dictionaryapi.dev`、百度翻译；完整结果写回 D1 缓存。所有 API 请求都必须经过 `src/utils/apiBase.ts` 的鉴权封装。

`App.tsx` 是前端共享状态中枢。页面状态应尽量留在页面或对应 hook 中；不要为了一个页面功能把局部状态提升到 `App.tsx`。

## 修改边界

- 改页面：先看 `src/App.tsx`、`src/hooks/useTabRoute.ts`、`src/components/Nav.tsx` 和相似页面。
- 改学习数据：同时确认前端缓存失效和 Worker 的定向 SQL 写路径。
- 改复习算法：以 `worker/src/review.js` 为唯一实现，并同步服务端测试。
- 改数据库结构：新增 migration，并在上线前执行；不要在请求路径做 DDL。

## 事实来源

本文只记录跨模块的稳定关系。页面细节看 `frontend.md`，Worker 和 API 细节看 `backend.md`；具体历史决策看 `decisions/`。当本文与代码冲突时，以代码、测试和 schema 为准，并修正文档。
