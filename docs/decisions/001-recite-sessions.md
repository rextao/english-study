# 背词任务与会话模型（recite）

## 状态

accepted

## 背景

「开始背单词」有配置端（`#/study` 的 ReciteTaskPanel）和学习端（`#/recite`）两个入口。学习端由小朋友操作，家长在 `#/recite/parent` 确认后才算一次学习。如果让学生端每点一次「会 / 不会」就推进轮次，误点、换设备、中途放弃都会污染复习排期，且无法回退。

## 决定

- 学生端点「会 / 不会 / 拼写」只写 `recite_card_drafts`（D1），不推进轮次、不累计次数；家长点「保存记录」才走 `POST /api/recite/sessions/:id/commit` 统一落库。
- 草稿存服务端而不是 localStorage：学生换一台设备或刷新后能接着判，家长在另一台设备也能读到同一份计数。
- 周任务是 `recite_tasks` / `recite_task_words` 的快照（词、中文、列表归属在任务生成时定格），不复制 `stage` / `nextDueAt` / `state`；这些派生值仍只来自 `list_words` + `worker/src/review.js`。
- 卡片结果统一由 `worker/src/recite.js` 的 `applyCardReview` 调用 `applyReview`：普通卡「会」= `done` + `meaning` tally，「不会」= `again`，拼写正确 = `spelling` tally（不改排期）。
- 幂等靠 `requestId` / `recite_cards.request_id` 与「已答过的卡直接返回 alreadyProcessed」；重复确认不会重复推进轮次或累计次数。
- 单次 commit 最多 60 张卡（`MAX_COMMIT_ANSWERS`），前端按 30 张一批循环提交；任务已经开始（有 active / completed 会话）后不能静默改词池，接口回 409 `TASK_STARTED`。
- `GET /api/recite/sessions/active` 只读，不会因为家长打开页面而创建会话、消耗学习次数。

## 影响

- 新增背词相关接口时，必须同时更新 `worker/src/routes.js`、`worker/src/recite.js`、`src/hooks/useRecite.ts` 和 `worker/test/api.test.mjs`。
- 卡片结果写成功后要作废前端 `recite-task` / `recite-session` / `study-plan` / `achievements` / `history` 缓存。
- 不要把会话或卡片状态写进 `list_words`，否则同一进度会两处打架。

## 相关代码

- `worker/src/recite.js`、`worker/migrations/003-recite-tasks.sql`、`005-recite-card-drafts.sql`
- `src/pages/RecitePage.tsx`、`src/pages/ReciteParentPage.tsx`、`src/components/ReciteTaskPanel.tsx`、`src/hooks/useRecite.ts`

