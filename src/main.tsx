import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { AnalyticsConsent } from './components/AnalyticsConsent'
import { initAnalytics } from './utils/analytics'

// 手机端禁用手势缩放：iOS Safari 从 iOS 10 起就忽略 viewport 的 user-scalable=no，
// 双指捏合仍会放大页面，只能靠 gesture* 事件拦掉；Android 等由 index.html 的 viewport
// 和 index.css 里的 touch-action 兜底。passive: false 才能 preventDefault 生效。
for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
  document.addEventListener(type, (event) => event.preventDefault(), { passive: false })
}

// PostHog 会话回放：没配 VITE_POSTHOG_KEY 时内部直接跳过，默认 opt-out，等用户在同意条上点「允许」
initAnalytics()

// PWA：生产环境注册 service worker（public/sw.js，构建时原样复制到产物根），
// 缓存应用外壳。开发时不注册——vite 端口与 /api 代理混着跑，缓存会干扰热更新。
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {})
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <AnalyticsConsent />
  </StrictMode>,
)
