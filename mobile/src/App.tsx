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

type LoadState = 'loading' | 'ready' | 'error'

export default function App() {
  const [config, setConfig] = useState<SyncConfig | null>(() => readConfig())
  const [editing, setEditing] = useState(false)
  const [data, setData] = useState<ParsedSnapshot | null>(null)
  const [state, setState] = useState<LoadState>('loading')
  const [error, setError] = useState('')
  const [saveError, setSaveError] = useState('')
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

  function handleSaved(next: SyncConfig) {
    writeConfig(next)
    setConfig(next)
    setEditing(false)
  }

  if (!config || editing) {
    return (
      <div className="app app--setup">
        <SetupScreen initial={editing ? config : null} onSaved={handleSaved} />
      </div>
    )
  }

  return (
    <div className="app">
      <header className="app__header">
        <div className="app__row">
          <h1 className="app__title">{data ? data.wordCount + ' 个单词' : '英语学习'}</h1>
          <button className="app__reset" type="button" onClick={() => setEditing(true)}>
            重新配置
          </button>
        </div>
      </header>

      <main className="app__main">
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
      </main>

      <nav className="tabbar">
        <button className="tabbar__item tabbar__item--active" type="button" aria-current="page">
          <svg className="tabbar__icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path
              fill="currentColor"
              d="M18 2H6v2H3v4a4 4 0 0 0 4 4 5 5 0 0 0 4 2.9V18H8v2h8v-2h-3v-3.1A5 5 0 0 0 17 12a4 4 0 0 0 4-4V4h-3V2ZM6 10a2 2 0 0 1-2-2V6h2v4Zm14-2a2 2 0 0 1-2 2V6h2v2Z"
            />
          </svg>
          <span className="tabbar__label">学习成果</span>
        </button>
      </nav>
    </div>
  )
}
