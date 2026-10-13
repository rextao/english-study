import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    // 监听所有网卡，这样手机在同一局域网内用 http://<本机IP>:5173 也能访问开发环境；
    // /api 仍然走下面的代理到本地 wrangler dev（8787），前端不必关心 D1 绑定细节。
    host: true,
    proxy: {
      '/api': 'https://study.rextao666.xyz/',
    },
  },
})
