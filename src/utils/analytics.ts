import posthog from 'posthog-js'

/**
 * PostHog 会话回放（浏览器侧唯一的第三方分析依赖）。
 *
 * 设计要点：
 * - key 走构建期环境变量 `VITE_POSTHOG_KEY`（见 `.env.example`）。没配就整个模块静默跳过，
 *   不影响任何现有功能，界面也不会出现同意条。
 * - 同意之前不初始化：不写 cookie、不发请求；点「允许」之后才 init 并开始会话回放。
 * - 配置里再兜一层 `opt_out_capturing_by_default`，即使将来有人提前 init 也不会采集。
 * - 输入内容一律打码（`maskAllInputs`）：令牌门、搜索框、短文正文都在里面。
 * - 同意状态存 localStorage（`es-analytics-consent`），只记 granted / denied，不存任何用户数据。
 */

const CONSENT_KEY = 'es-analytics-consent'
const POSTHOG_KEY = (import.meta.env.VITE_POSTHOG_KEY ?? '').trim()
const POSTHOG_HOST = (import.meta.env.VITE_POSTHOG_HOST ?? '').trim() || 'https://us.i.posthog.com'

export type AnalyticsConsent = 'granted' | 'denied' | 'pending'

/** 构建时有没有配 PostHog key；没配就什么都不做 */
export const analyticsConfigured = POSTHOG_KEY !== ''

let initialized = false

/** 读同意状态：没选过（或没配 key）都算 pending */
export function getAnalyticsConsent(): AnalyticsConsent {
  if (!analyticsConfigured) return 'pending'
  try {
    const stored = localStorage.getItem(CONSENT_KEY)
    return stored === 'granted' || stored === 'denied' ? stored : 'pending'
  } catch {
    // 隐私模式下 localStorage 不可用，当成没同意
    return 'pending'
  }
}

/** 启动时调用：只有之前已经允许过才真正初始化 PostHog */
export function initAnalytics() {
  if (getAnalyticsConsent() === 'granted') ensureInitialized()
}

/**
 * 初始化 PostHog 客户端并打开采集 + 回放；重复调用只生效一次，没配 key 时直接跳过。
 * 返回是否处于可用状态。
 */
function ensureInitialized(): boolean {
  if (initialized) return true
  if (!analyticsConfigured) return false
  try {
    posthog.init(POSTHOG_KEY, {
      api_host: POSTHOG_HOST,
      // 页面切换是 hash 路由，由 trackPageview 自己上报，别让 SDK 再按 history 猜
      capture_pageview: false,
      capture_pageleave: true,
      autocapture: true,
      person_profiles: 'identified_only',
      // 双保险：默认 opt-out，采集必须由下面的 opt_in_capturing 显式打开
      opt_out_capturing_by_default: true,
      disable_session_recording: false,
      session_recording: {
        maskAllInputs: true,
        // 需要额外隐藏的正文 / 词表加 data-ph-mask；整块隐藏加 .ph-no-capture
        maskTextSelector: '[data-ph-mask]',
        blockSelector: '.ph-no-capture',
      },
    })
    posthog.opt_in_capturing()
    posthog.startSessionRecording()
    initialized = true
  } catch {
    // 分析是旁路：SDK 起不来也不能拖垮页面
    initialized = false
  }
  return initialized
}

/** 当前 hash 路由对应的 tab 名，用于同意放行时的第一条页面事件 */
function currentTab() {
  return window.location.hash.replace(/^#\/?/, '') || 'search'
}

/** 用户点「允许 / 不允许」时调用：落盘同意状态并立即生效 */
export function setAnalyticsConsent(consent: Exclude<AnalyticsConsent, 'pending'>) {
  try {
    localStorage.setItem(CONSENT_KEY, consent)
  } catch {
    // 写不了就只在本次会话生效，下次重新问
  }
  if (consent === 'granted') {
    // 回放从同意这一刻开始串用户路径
    if (ensureInitialized()) trackPageview(currentTab())
  } else if (initialized) {
    posthog.stopSessionRecording()
    posthog.opt_out_capturing()
  }
}

/** SPA 页面切换上报，回放按 tab 串起用户路径（同意前直接跳过） */
export function trackPageview(tab: string) {
  if (!initialized) return
  try {
    posthog.capture('$pageview', { tab })
  } catch {
    // 跳过这次上报即可
  }
}
