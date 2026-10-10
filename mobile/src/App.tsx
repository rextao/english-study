/**
 * App.tsx — 手机版状态中枢
 *
 * 只读原型：从云端 Worker 拉整库快照，默认进入「学习成果」页（底部 icon 导航，仅此一页）。
 * 同步配置存在 localStorage，没配过或点「重新配置」时进配置页。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { readConfig, writeConfig } from './lib/config'
import {
  fetchSnapshot,
  parseSnapshot,
  type Snapshot,
  type ParsedSnapshot,
  type SyncConfig,
} from './lib/snapshot'
import { applyTally, pushSnapshot, type SuccessKind } from './lib/tally'
import SetupScreen from './components/SetupScreen'
import AchievementsTab from './components/AchievementsTab'
import GamesTab from './games/GamesTab'

type LoadState = 'loading' | 'ready' | 'error'
type Tab = 'study' | 'games'

/**
 * kiosk 路由判定：hash 命中 '#/play'（兼容 '#play'）时进入「游戏中心」整屏模式。
 * 抽成纯函数，初始化 state 和 hashchange 回调复用同一套判定。
 */
function isKioskHash(): boolean {
  const hash = window.location.hash
  return hash === '#/play' || hash === '#play'
}

export default function App() {
  const [config, setConfig] = useState<SyncConfig | null>(() => readConfig())
  const [editing, setEditing] = useState(false)
  const [data, setData] = useState<ParsedSnapshot | null>(null)
  const [state, setState] = useState<LoadState>('loading')
  const [error, setError] = useState('')
  const [saveError, setSaveError] = useState('')
  // 底部 tab：学习成果 / 游戏。游戏不依赖云端数据，独立于同步状态
  const [tab, setTab] = useState<Tab>('study')
  // kiosk 整屏模式：命中 '#/play' 路由时只放游戏中心，无头部、无底部 tab、无回首页入口
  const [kiosk, setKiosk] = useState<boolean>(() => isKioskHash())
  // 当前内存里的整库快照：加减直接改它，是写回云端的唯一真相
  const snapshotRef = useRef<Snapshot | null>(null)
  // 推送协调：busy 时只更新 pending，推完再把最新的一份推上去，避免并发覆盖
  const pushRef = useRef<{ pending: Snapshot | null; busy: boolean }>({ pending: null, busy: false })

  const load = useCallback(async (target: SyncConfig) => {
    setState('loading')
    setError('')
    setSaveError('')
    try {
      const snapshot = await fetchSnapshot(target)
      snapshotRef.current = snapshot
      setData(parseSnapshot(snapshot))
      setState('ready')
    } catch (err) {
      setError(err instanceof Error ? err.message : '拉取快照失败')
      setState('error')
    }
  }, [])

  // 串行推送（带合并）：推送期间来的新快照先攒着，推完再推最后一份
  const flushPush = useCallback(async (target: SyncConfig) => {
    if (pushRef.current.busy) return
    pushRef.current.busy = true
    try {
      while (pushRef.current.pending) {
        const snapshot = pushRef.current.pending
        pushRef.current.pending = null
        await pushSnapshot(target, snapshot)
      }
    } catch (err) {
      pushRef.current.pending = null
      setSaveError(err instanceof Error ? err.message : '保存到云端失败')
      // 云端是唯一真相：保存失败就拉回云端数据，把没存上的加减退掉
      void load(target)
    } finally {
      pushRef.current.busy = false
    }
  }, [load])

  // 加减某个词的某一项：先本地乐观更新，再后台推送
  const handleTally = useCallback((wordKey: string, kind: SuccessKind, delta: number) => {
    if (!config) return
    const base = snapshotRef.current
    if (!base) return
    const result = applyTally(base, wordKey, kind, delta)
    if (!result.changed) return
    snapshotRef.current = result.snapshot
    setData(parseSnapshot(result.snapshot))
    setSaveError('')
    pushRef.current.pending = result.snapshot
    void flushPush(config)
  }, [config, flushPush])

  useEffect(() => {
    if (config && !editing) void load(config)
  }, [config, editing, load])

  // 监听 hash 变化实时切换 kiosk 模式；StrictMode 下 effect 会跑两次，必须成对清理监听
  useEffect(() => {
    const onHashChange = () => setKiosk(isKioskHash())
    window.addEventListener('hashchange', onHashChange)
    // 挂载时再对齐一次，防止 state 初始化后到绑定监听之间 hash 已经变过
    setKiosk(isKioskHash())
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  function handleSaved(next: SyncConfig) {
    writeConfig(next)
    setConfig(next)
    setEditing(false)
  }

  // 游戏 tab 完全独立于云端同步：没配过同步也能直接从底部栏进来玩。
  // 只有「学习成果」tab 需要先配置同步，此时把配置页内嵌进主区域，底部栏始终在。
  const needsSetup = !config || editing

  // kiosk 模式：顶层提前 return，只渲染游戏中心，不出现头部 / 底部 tab / 任何回首页入口。
  // GamesTab 内部「选游戏 → 玩 → onExit 回列表」照常，用户出不去到学习首页即可。
  if (kiosk) {
    return (
      <div className="app app--kiosk">
        <div className="app--kiosk__title">游戏中心</div>
        <GamesTab />
      </div>
    )
  }

  return (
    <div className="app">
      <header className="app__header">
        <div className="app__row">
          <h1 className="app__title">
            {tab === 'games' ? '游戏' : !needsSetup && data ? data.wordCount + ' 个单词' : '英语学习'}
          </h1>
          {config && !editing ? (
            <button className="app__reset" type="button" onClick={() => setEditing(true)}>
              重新配置
            </button>
          ) : null}
        </div>
      </header>

      <main className="app__main">
        {tab === 'games' ? (
          <GamesTab />
        ) : needsSetup ? (
          <SetupScreen initial={editing ? config : null} onSaved={handleSaved} />
        ) : (
          <>
            {state === 'loading' ? <p className="empty">正在拉取云端数据…</p> : null}
            {state === 'error' ? (
              <div className="callout">
                <p>{error}</p>
                <button className="btn" type="button" onClick={() => void load(config)}>
                  重试
                </button>
              </div>
            ) : null}
            {state === 'ready' && saveError ? (
              <div className="callout">
                <p>{saveError}</p>
              </div>
            ) : null}
            {state === 'ready' && data ? (
              <AchievementsTab
                achievements={data.achievements}
                labels={data.labels}
                onTally={handleTally}
              />
            ) : null}
          </>
        )}
      </main>

      <nav className="tabbar">
        <button
          className={'tabbar__item' + (tab === 'study' ? ' tabbar__item--active' : '')}
          type="button"
          aria-current={tab === 'study' ? 'page' : undefined}
          onClick={() => setTab('study')}
        >
          <svg className="tabbar__icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path
              fill="currentColor"
              d="M18 2H6v2H3v4a4 4 0 0 0 4 4 5 5 0 0 0 4 2.9V18H8v2h8v-2h-3v-3.1A5 5 0 0 0 17 12a4 4 0 0 0 4-4V4h-3V2ZM6 10a2 2 0 0 1-2-2V6h2v4Zm14-2a2 2 0 0 1-2 2V6h2v2Z"
            />
          </svg>
          <span className="tabbar__label">学习成果</span>
        </button>
        <button
          className={'tabbar__item' + (tab === 'games' ? ' tabbar__item--active' : '')}
          type="button"
          aria-current={tab === 'games' ? 'page' : undefined}
          onClick={() => setTab('games')}
        >
          <svg className="tabbar__icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path
              fill="currentColor"
              d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 2a8 8 0 0 1 7.4 5H14.8A3 3 0 0 0 12 7.2 8 8 0 0 1 12 4Zm-5.4 3.2A3 3 0 0 0 9 10.2v3.6a3 3 0 0 0-2.4 2.9A8 8 0 0 1 4 12a8 8 0 0 1 2.6-4.8ZM12 15a3 3 0 1 1 0-6 3 3 0 0 1 0 6Zm0 5a8 8 0 0 1-3-0.6A3 3 0 0 0 11.2 17h1.6a3 3 0 0 0 2.2 2.4A8 8 0 0 1 12 20Z"
            />
          </svg>
          <span className="tabbar__label">游戏</span>
        </button>
      </nav>
    </div>
  )
}
