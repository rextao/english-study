/**
 * index.js — Worker 入口：鉴权 → 静态资源 / API 分发
 *
 * 与本地版的差异：
 *  - 本地版裸 HTTP 服务只监听 127.0.0.1；上云后任何人都能打到 URL，
 *    所以 /api/* 统一要求 Authorization: Bearer <API_TOKEN>（secret），
 *    只有 /api/health 免鉴权给前端探活。比较用恒定时间方式，避免时序侧信道。
 *  - 非 /api/* 的请求交给 Workers Assets（vite 构建产物），页面和 API 同源。
 */

import { createApp } from './app.js'
import { handleApi } from './routes.js'

function safeEqual(a, b) {
  const ab = new TextEncoder().encode(String(a ?? ''))
  const bb = new TextEncoder().encode(String(b ?? ''))
  const len = Math.max(ab.length, bb.length)
  let diff = ab.length ^ bb.length
  for (let i = 0; i < len; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0)
  return diff === 0
}

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders },
  })
}

function bearerToken(request) {
  const header = request.headers.get('Authorization') || ''
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match ? match[1].trim() : ''
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    const pathname = url.pathname

    // API 分发（鉴权在先）
    if (pathname === '/api' || pathname.startsWith('/api/')) {
      if (pathname === '/api/health') return json({ ok: true, time: Date.now() })

      const token = bearerToken(request)
      if (!env.API_TOKEN) return json({ error: 'server not configured: API_TOKEN missing' }, 500)
      if (!token || !safeEqual(token, env.API_TOKEN)) {
        return json({ error: 'unauthorized' }, 401, {
          'WWW-Authenticate': 'Bearer realm="english-study"',
        })
      }

      const app = createApp(env, p => ctx.waitUntil(p))
      let body = undefined
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        try {
          const text = await request.text()
          body = text ? JSON.parse(text) : {}
        } catch {
          return json({ error: 'invalid json body' }, 400)
        }
      }
      try {
        const { status, body: out } = await handleApi(
          request.method, pathname, url.searchParams, body, app,
        )
        return json(out, status)
      } catch (e) {
        console.error('[api]', pathname, e?.stack || e?.message || e)
        return json({ error: 'internal error' }, 500)
      }
    }

    // 其余全部交给静态资源（vite build 产物）
    return env.ASSETS.fetch(request)
  },
}
