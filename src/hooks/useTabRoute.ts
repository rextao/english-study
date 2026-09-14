import { useCallback, useEffect, useState } from 'react'
import type { TabKey } from '../components/Nav'

const TAB_KEYS: TabKey[] = ['search', 'import', 'lists', 'libraries', 'achievements', 'records', 'study']
const DEFAULT_TAB: TabKey = 'search'

/** 从 #/lists 这种 hash 里取出页面名，认不出来就回落到查词页 */
function parseHash(): TabKey {
  const raw = window.location.hash.replace(/^#\/?/, '').trim()
  return TAB_KEYS.find(key => key === raw) ?? DEFAULT_TAB
}

/**
 * 把当前页面记在地址栏 hash 上，刷新、前进后退、收藏链接都能停在原来的页面。
 *
 * 用 hash 而不是 pathname：dict-server 只管 /api，dist 也可能被丢给任意静态服务器，
 * hash 不需要 history fallback，刷新任何页面都不会 404。
 */
export function useTabRoute(): [TabKey, (next: TabKey) => void] {
  const [tab, setTab] = useState<TabKey>(parseHash)

  // 首次进入时把地址栏补成规范形式（空 hash 或非法 hash），用 replace 不留历史记录
  useEffect(() => {
    const normalized = '#/' + parseHash()
    if (window.location.hash !== normalized) {
      window.history.replaceState(null, '', normalized)
    }
  }, [])

  // 浏览器前进后退、手动改地址栏都会触发 hashchange
  useEffect(() => {
    const sync = () => setTab(parseHash())
    window.addEventListener('hashchange', sync)
    return () => window.removeEventListener('hashchange', sync)
  }, [])

  // 点导航是一次新的跳转，用 push，这样后退键能回到上一个页面
  const go = useCallback((next: TabKey) => {
    setTab(next)
    const target = '#/' + next
    if (window.location.hash !== target) {
      window.history.pushState(null, '', target)
    }
  }, [])

  return [tab, go]
}
