import { existsSync, readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 本地开发证书（scripts/dev-cert.mjs 生成）：有就开 https。麦克风 / MediaRecorder /
// crypto.randomUUID 都只在「安全上下文」里可用，而 host: true 让浏览器实际访问的是
// http://<本机IP>:5173，不是安全上下文，背词页的课堂录音就开不起来。
// 想临时退回 http（例如证书过期又没网重签）：DEV_HTTPS=0 npm run dev。
function readDevHttps() {
  if (process.env.DEV_HTTPS === '0') return undefined
  const key = new URL('./.certs/dev-key.pem', import.meta.url)
  const cert = new URL('./.certs/dev-cert.pem', import.meta.url)
  if (!existsSync(key) || !existsSync(cert)) return undefined
  return { key: readFileSync(key), cert: readFileSync(cert) }
}

// 本地环境变量只有 .dev.vars 一份：wrangler dev 自动读整份，vite 默认不读它。
// 这里把其中的 VITE_* 补进 process.env，vite 启动时会按前缀注入 import.meta.env；
// 非 VITE_ 的密钥（API_TOKEN / 百度 / TTS）不会进前端 bundle。
function injectViteEnvFromDevVars() {
  let text: string
  try {
    text = readFileSync(new URL('./.dev.vars', import.meta.url), 'utf8')
  } catch {
    return
  }
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
    if (!match) continue
    const key = match[1]
    if (!key.startsWith('VITE_') || process.env[key] !== undefined) continue
    let value = match[2].trim()
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) value = value.slice(1, -1)
    process.env[key] = value
  }
}

injectViteEnvFromDevVars()

export default defineConfig({
  plugins: [react()],
  server: {
    // 监听所有网卡，这样手机在同一局域网内用 https://<本机IP>:5173 也能访问开发环境；
    // 用 https 是因为局域网 IP 上的 http 不是安全上下文，麦克风（背词页课堂录音）会被
    // 浏览器禁用；本机也可以直接用 https://localhost:5173。
    // /api 代理到本地 wrangler dev，端口见 wrangler.toml 的 [dev] port（默认 8787 被本机
    // 常驻服务 mfcli-proxy 占用，约定用 8788）；用的是本地 D1（.wrangler/state），不碰线上数据。
    // 代理目标仍是 http：这一段是 vite 在本机内部发请求，与浏览器用 http 还是 https 无关。
    // 注意目标必须写 127.0.0.1：这一段是 vite 在本机内部发起的请求，workerd 只监听回环地址
    // （127.0.0.1 / ::1），写成局域网 IP（如 172.16.92.150）会 ECONNREFUSED——浏览器用哪个
    // 地址访问 vite 都一样。想对着线上调试就把下面的目标临时换成线上域名。
    host: true,
    https: readDevHttps(),
    proxy: {
      '/api': 'http://127.0.0.1:8788',
    },
  },
})
