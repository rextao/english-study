# 前端开发地图

## 入口和路由

- `src/main.tsx` 挂载应用并引入全局样式。
- `src/App.tsx` 组装共享 hooks、令牌门和页面。
- `src/hooks/useTabRoute.ts` 管理 hash 路由和旧书签兼容。
- `src/components/Nav.tsx` 管理主导航和设置入口。

新增页面时，至少确认：路由 key、导航高亮、`App.tsx` 分支、页面 CSS、返回行为和窄屏布局。

## 现有约定

- UI 组件从 `src/ui` 引入；不要新增原生 `<select>`、`<textarea>` 或 checkbox 控件。
- API 请求必须使用 `apiFetch` / `apiJson`，不能在页面里裸调用 `fetch`。
- 只读 API 使用共享 `apiCache`；成功写入后必须作废对应 tag。
- 页面文案和代码注释使用中文。
- 共享类型集中在 `src/types/vocab.ts`。

## 页面选择

- 查词：`SearchPage.tsx`
- 批量导入：`ImportPage.tsx`
- 学习列表：`ListsPage.tsx`
- 英语学习：`StudyPage.tsx`
- 设置：`SettingsPage.tsx`
- 学习成果：`AchievementsPage.tsx`
- 学习记录：`LearningRecordsPage.tsx`
- 短文：`PassagesPage.tsx`

`LibrariesPage.tsx` 和 `LearningRecordsPage.tsx` 支持嵌入设置页；新增可嵌入页面时，应把页面外壳和内容主体拆开，避免重复渲染页头。

## 页面变更后的验证

```bash
node --version  # 必须为 24.x；项目版本见 .nvmrc
npm run build
```

如果改了路由、导航或 API 调用，还应检查对应 hook 和共享缓存；如果改了 Worker，再运行 `npm run test:server`。
