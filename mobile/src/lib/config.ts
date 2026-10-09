/**
 * config.ts — 手机端的同步配置（localStorage）
 *
 * 手机端页面和同步 API 同源部署，同步地址固定用当前站点 origin，
 * 所以这里只存一个「访问令牌」。令牌留在本机 localStorage，
 * 不进任何共享数据——和桌面端把密钥放 cache/dict-keys.json 是一个思路。
 */
import type { SyncConfig } from './snapshot'

const STORAGE_KEY = 'english-study-sync-config'

/** 读配置；没填过令牌或内容损坏都返回 null，让界面进配置页。旧数据里的 url 字段忽略 */
export function readConfig(): SyncConfig | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    const token = typeof parsed.token === 'string' ? parsed.token.trim() : ''
    if (!token) return null
    return { token }
  } catch {
    return null
  }
}

export function writeConfig(config: SyncConfig): SyncConfig {
  const token = config.token.trim()
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ token }))
  return { token }
}
