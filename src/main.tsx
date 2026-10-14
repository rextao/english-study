import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// 手机端禁用手势缩放：iOS Safari 从 iOS 10 起就忽略 viewport 的 user-scalable=no，
// 双指捏合仍会放大页面，只能靠 gesture* 事件拦掉；Android 等由 index.html 的 viewport
// 和 index.css 里的 touch-action 兜底。passive: false 才能 preventDefault 生效。
for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
  document.addEventListener(type, (event) => event.preventDefault(), { passive: false })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
