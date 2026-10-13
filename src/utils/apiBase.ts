/**
 * 后端 API 基址与统一请求入口（云端版）。
 *
 * 后端已全部搬上 Cloudflare Worker，页面与 /api 同源部署，所以基址恒为相对路径。
 * apiFetch 在普通 fetch 之上统一做两件事：
 *   1. 带 Authorization: Bearer <token>（令牌在设置页填一次，存 localStorage）；
 *   2. 收到 401 时广播事件，让顶部的令牌门重新弹出输入框。
 */

export const API_BASE = ''

const TOKEN_STORAGE_KEY = 'es-api-token'

export function getStoredToken(): string {
  try { return localStorage.getItem(TOKEN_STORAGE_KEY) ?? '' } catch { return '' }
}

export function setStoredToken(token: string) {
  try {
    if (token) localStorage.setItem(TOKEN_STORAGE_KEY, token)
    else localStorage.removeItem(TOKEN_STORAGE_KEY)
  } catch { /* localStorage 不可用（隐私模式）：本次会话内不持久化 */ }
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
