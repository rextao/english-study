import { useState } from 'react'
import { Button } from '../ui'
import { analyticsConfigured, getAnalyticsConsent, setAnalyticsConsent } from '../utils/analytics'

/**
 * PostHog 会话回放的同意条。
 * 没配 `VITE_POSTHOG_KEY`（本地开发 / 未接分析）或用户已经选过就整块不渲染；
 * 未选之前 PostHog 处于 opt-out，不会采集事件也不会录像。
 */
export function AnalyticsConsent() {
  const [consent, setConsent] = useState(getAnalyticsConsent)

  if (!analyticsConfigured || consent !== 'pending') return null

  const decide = (next: 'granted' | 'denied') => {
    setAnalyticsConsent(next)
    setConsent(next)
  }

  return (
    <div className="app__consent" role="dialog" aria-label="使用回放授权">
      <div className="app__consent-text">
        <strong>允许记录操作回放吗？</strong>
        <p>允许后用 PostHog 记录页面操作回放，帮我们找出用起来卡住的地方；输入框内容会全部打码。不允许也不影响任何功能。</p>
      </div>
      <div className="app__consent-actions">
        <Button size="small" onClick={() => decide('denied')}>不允许</Button>
        <Button size="small" type="primary" onClick={() => decide('granted')}>允许</Button>
      </div>
    </div>
  )
}
