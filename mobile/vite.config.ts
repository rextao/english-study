import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 手机端是独立的 Vite 应用：
//   - root 就在 mobile/，入口是 mobile/index.html → mobile/src/main.tsx
//   - base 用相对路径，部署到 Cloudflare Pages 后无论几级路径都能正确加载资源
//   - 产物输出到 mobile/dist，复用仓库根的 node_modules，不需要额外装依赖
export default defineConfig({
  plugins: [react()],
  root: __dirname,
  base: './',
  build: {
    outDir: './dist',
    emptyOutDir: true,
    target: 'es2020',
  },
  server: {
    port: 5174,
    strictPort: true,
  },
  preview: {
    port: 5174,
  },
})
