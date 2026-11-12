/**
 * 后端 API 基址与统一请求入口（云端版）。
 *
 * 后端已全部搬上 Cloudflare Worker，页面与 /api 同源部署，所以基址恒为相对路径。
 * apiFetch 在普通 fetch 之上统一做两件事：
 *   1. 带 Authorization: Bearer <token>（令牌填一次就存起来：localStorage 为主，cookie 兜底）；
 *   2. 收到 401 时广播事件，让顶部的令牌门重新弹出输入框。
 *
 * 为什么还要 cookie 兜底：iOS 主屏幕 PWA / 隐私模式 / 浏览器清理站点数据后 localStorage
 * 会丢，令牌就又被问一次。cookie 多一份副本，任一份还在就不用重输。
 */

export const API_BASE = ''

const TOKEN_STORAGE_KEY = 'es-api-token'
/** 令牌 cookie 的有效期（400 天 = 浏览器允许的上限），尽量久地免去重输 */
const TOKEN_COOKIE_MAX_AGE = 400 * 86400

function readTokenCookie(): string {
  try {
    const match = document.cookie.match(/(?:^|;\s*)es-api-token=([^;]*)/)
    return match ? decodeURIComponent(match[1]) : ''
  } catch {
    return ''
  }
}

function writeTokenCookie(token: string) {
  try {
    const secure = location.protocol === 'https:' ? '; Secure' : ''
    document.cookie = token
      ? 'es-api-token=' + encodeURIComponent(token) + '; Path=/; Max-Age=' + TOKEN_COOKIE_MAX_AGE + '; SameSite=Lax' + secure
      : 'es-api-token=; Path=/; Max-Age=0; SameSite=Lax' + secure
  } catch { /* 写不了 cookie 就只靠 localStorage */ }
}

export function getStoredToken(): string {
  try {
    const stored = localStorage.getItem(TOKEN_STORAGE_KEY) ?? ''
    if (stored) return stored
  } catch { /* localStorage 不可用（隐私模式 / 存储被禁）：往下读 cookie */ }
  const fromCookie = readTokenCookie()
  // cookie 里还有：顺手补回 localStorage，其他读取路径就不用每次翻 cookie
  if (fromCookie) {
    try { localStorage.setItem(TOKEN_STORAGE_KEY, fromCookie) } catch { /* 写不进去也不影响 */ }
  }
  return fromCookie
}

export function setStoredToken(token: string) {
  try {
    if (token) localStorage.setItem(TOKEN_STORAGE_KEY, token)
    else localStorage.removeItem(TOKEN_STORAGE_KEY)
  } catch { /* localStorage 不可用（隐私模式）：靠下面的 cookie 记住 */ }
  writeTokenCookie(token)
}

/** 401 时派发；TokenGate 监听它重新弹出令牌输入 */
export const AUTH_REQUIRED_EVENT = 'es-auth-required'

export async function apiFetch(url: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers)
  const token = getStoredToken()
  if (token && !headers.has('Authorization')) headers.set('Authorization', 'Bearer ' + token)
  const response = await fetch(url, { ...init, headers })
  if (response.status === 401) {
    try { window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT)) } catch { /* 非浏览器环境忽略 */ }
  }
  return response
}

/** 与 apiFetch 相同，但解析 JSON 并在非 2xx 时抛错（错误信息取 body.error / body.message） */
export async function apiJson<T = unknown>(url: string, init?: RequestInit): Promise<T> {
  const response = await apiFetch(url, init)
  let body: unknown = null
  try { body = await response.json() } catch { /* 空响应体 */ }
  if (!response.ok) {
    const message = (body as { error?: string; message?: string } | null)?.error
      ?? (body as { message?: string } | null)?.message
      ?? '请求失败（HTTP ' + response.status + '）'
    throw new Error(message)
  }
  return body as T
}
