// 手写最小 service worker：只缓存应用外壳（HTML / JS / CSS / 图标），
// 让 PWA 从桌面打开更快、断网也能打开壳子；数据接口全部直连网络。
// /api 不缓存：数据要新，而且请求带 Bearer 鉴权头，缓存容易串。
// 部署在 Cloudflare assets 上，同源根路径，scope 默认就是 '/'，两个 PWA 入口共用这一个。
//
// 两个入口：'/'（index.html，背单词）与 '/games.html'（单词游戏）。
// HTML 壳必须按页面路径分别缓存，断网时各回各的壳，不能互相覆盖。

const VERSION = 'v2'
const CACHE_NAME = 'english-study-shell-' + VERSION

// 应用外壳：两个入口的 HTML 壳 + 清单。图标不预缓存（可能还没传），访问时路过再存。
const SHELL = ['./', './index.html', './games.html', './manifest.json', './manifest-games.json']

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME)
    await Promise.all(SHELL.map((url) => cache.add(url).catch(() => {})))
    await self.skipWaiting()
  })())
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys()
    await Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
    await self.clients.claim()
  })())
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  if (url.pathname.startsWith('/api')) return

  // 导航（打开 / 刷新页面）：网络优先，断网回落到这一页自己缓存的 HTML 壳。
  // 请求 URL 不含 hash，所以 /#/search 和 /#/games/home 是同一份壳，各入口各存各的。
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const response = await fetch(request)
        const cache = await caches.open(CACHE_NAME)
        cache.put(request, response.clone()).catch(() => {})
        return response
      } catch {
        const cache = await caches.open(CACHE_NAME)
        const fallback = await cache.match(request)
        if (fallback) return fallback
        // 没存过这一页（例如第一次就直接打开 /games.html）：退回根壳，SPA 仍能跑起来
        const root = await cache.match('./')
        if (root) return root
        return new Response('当前离线，且还没有缓存过这页内容。', {
          status: 503,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        })
      }
    })())
    return
  }

  // 其它同源静态资源（JS / CSS / 图标）：缓存优先，路过就存一份
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME)
    const cached = await cache.match(request)
    if (cached) return cached
    try {
      const response = await fetch(request)
      if (response.ok) cache.put(request, response.clone()).catch(() => {})
      return response
    } catch {
      return cached || Response.error()
    }
  })())
})
