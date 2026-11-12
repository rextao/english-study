import { lazy, Suspense, useEffect, useState } from 'react'
import { useVocabLibraries } from './hooks/useVocabLibraries'
import { useStudyList } from './hooks/useStudyList'
import { useStudyPlan } from './hooks/useStudyPlan'
import { useTabRoute } from './hooks/useTabRoute'
import { AUTH_REQUIRED_EVENT, getStoredToken, setStoredToken } from './utils/apiBase'
import { trackPageview } from './utils/analytics'
import { Nav } from './components/Nav'
import { TokenGate } from './components/TokenGate'
import { SearchPage } from './pages/SearchPage'
import type { ImportUndoSnapshot } from './pages/ImportPage'
import { ListsPage } from './pages/ListsPage'
import type { SettingsSection } from './pages/SettingsPage'
import { StudyPage } from './pages/StudyPage'
import { AchievementsPage } from './pages/AchievementsPage'
import { LearningRecordsPage } from './pages/LearningRecordsPage'
import { GoalPage } from './pages/GoalPage'
import { PassagesPage } from './pages/PassagesPage'
import { RecitePage } from './pages/RecitePage'
import { GamesPage } from './games/GamesPage'
import { ReciteParentPage } from './pages/ReciteParentPage'
import { ReciteTasksPage } from './pages/ReciteTasksPage'
import { startReciteSession } from './hooks/useRecite'
import type { ReciteSessionPayload } from './hooks/useRecite'
import { fetchReciteTask } from './hooks/useRecite'
import type { ReciteTask } from './hooks/useRecite'
import './App.css'

const SettingsPage = lazy(() => import('./pages/SettingsPage').then(module => ({ default: module.SettingsPage })))

export default function App() {
  const {
    libraries,
    loading,
    offline: labelsOffline,
    getLabelById,
    hasCustomLabel,
    updateLabel,
    resetLabel,
    getPrintLabelById,
    hasCustomPrintLabel,
    updatePrintLabel,
    resetPrintLabel,
    reloadLabels,
  } = useVocabLibraries()
  // 学习列表状态提到最外层，三个页面共用一份，避免切换 tab 后数据不同步
  const study = useStudyList()
  // 复习计划跨列表汇总，导航角标和学习页共用同一份
  const plan = useStudyPlan()
  // 批量导入的撤销快照提到全局：切到学习列表再回到查词页仍可撤销，直到新的导入 / 新输入覆盖
  const [importUndoSnapshot, setImportUndoSnapshot] = useState<ImportUndoSnapshot | null>(null)
  // 当前页面记在地址栏 hash 上，刷新后不会跳回首页
  const [tab, setTab] = useTabRoute()

  const [reciteSession, setReciteSession] = useState<ReciteSessionPayload | null>(null)
  const [reciteLoading, setReciteLoading] = useState(false)
  const [reciteError, setReciteError] = useState<string | null>(null)
  const [reciteReload, setReciteReload] = useState(0)
  // 首页先停一停：只有点「开始学习」后才创建会话，避免一进页面就把词条标成「已开始」
  const [reciteStarted, setReciteStarted] = useState(false)
  const [reciteTask, setReciteTask] = useState<ReciteTask | null>(null)
  const [reciteTaskLoading, setReciteTaskLoading] = useState(false)
  const [reciteTaskError, setReciteTaskError] = useState<string | null>(null)

  useEffect(() => {
    if (tab !== 'recite') return
    let alive = true
    if (reciteStarted) {
      // 点过「开始学习」：创建 / 恢复本次会话
      setReciteLoading(true)
      setReciteError(null)
      startReciteSession().then(payload => {
        if (alive) setReciteSession(payload)
      }).catch(error => {
        if (alive) setReciteError(error instanceof Error ? error.message : '学习任务读取失败')
      }).finally(() => { if (alive) setReciteLoading(false) })
    } else {
      // 首页只读本周任务概况，不创建会话（start 会把词条标记成已开始）
      setReciteTaskLoading(true)
      setReciteTaskError(null)
      fetchReciteTask().then(task => {
        if (!alive) return
        setReciteTask(task)
        // 已经有进行中的会话（刷新 / 重新进页面）：直接回到当前那一张卡，不停在首页
        if (task?.activeSessionIndex != null) setReciteStarted(true)
      }).catch(error => {
        if (!alive) return
        setReciteTaskError(error instanceof Error ? error.message : '学习任务读取失败')
      }).finally(() => { if (alive) setReciteTaskLoading(false) })
    }
  }, [tab, reciteReload, reciteStarted])

  // 离开背单词页就回到首页：下次进来要先点「开始学习」
  useEffect(() => {
    if (tab === 'recite') return
    setReciteStarted(false)
    setReciteSession(null)
  }, [tab])

  // 会话回放的路径：每次切 tab 上报一次 $pageview（同意前 trackPageview 内部直接跳过）
  useEffect(() => {
    trackPageview(tab)
  }, [tab])

  // 访问令牌：云端 API 需要Bearer鉴权，首次打开填一次存 localStorage
  const [token, setToken] = useState(getStoredToken)
  const [authPrompt, setAuthPrompt] = useState(false)

  // 任何请求收到 401 就重新弹令牌输入（令牌被改 / 过期 / 换了部署）
  useEffect(() => {
    const handler = () => setAuthPrompt(true)
    window.addEventListener(AUTH_REQUIRED_EVENT, handler)
    return () => window.removeEventListener(AUTH_REQUIRED_EVENT, handler)
  }, [])

  const handleTokenSubmit = (value: string) => {
    setStoredToken(value)
    setToken(value)
    setAuthPrompt(false)
    // 新令牌生效后，把各页面已失败的请求重打一遍
    void study.fetchLists()
    void plan.refresh()
    void reloadLabels()
  }

  // 设置页当前子分区（词库配置 / 学习列表 / 学习记录 / 查询链路）
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('libraries')

  /** 学习列表页点「新增 / 重命名列表」：切到设置页的「学习列表」分区统一管理 */
  const goToListSettings = () => {
    setSettingsSection('lists')
    setTab('settings')
  }

  if (!token || authPrompt) {
    return <TokenGate onSubmit={handleTokenSubmit} hasExistingToken={Boolean(token)} />
  }

  if (loading) {
    return (
      <div className="app__loading">
        <span className="ui-spin" aria-hidden="true" />
        加载词库中...
      </div>
    )
  }

  // 背单词是给小朋友的全屏模式：不渲染导航、没有返回按钮，只能从查词首页的入口进
  if (tab === 'recite') {
    return (
      <RecitePage
        payload={reciteSession}
        loading={reciteLoading}
        error={reciteError}
        onReload={() => setReciteReload(value => value + 1)}
        started={reciteStarted}
        homeTask={reciteTask}
        homeLoading={reciteTaskLoading}
        homeError={reciteTaskError}
        onStart={() => setReciteStarted(true)}
      />
    )
  }

  // 小游戏也是全屏独立页：目前没有界面入口，只能用 #/games/<id> 这种地址进
  if (tab === 'games') {
    return <GamesPage />
  }

  return (
    <div className="app">
      <Nav
        active={tab}
        onChange={setTab}
        dueToday={plan.dueCount}
      />

      {(study.offline || labelsOffline) && (
        <div className="app__notice">
          <div className="callout callout--warn">
            云端连接失败，学习列表暂不可用，词库标签只会临时存在浏览器里。请检查网络、Worker 部署状态与访问令牌。
          </div>
        </div>
      )}

      <main>
        {tab === 'search' && (
          <SearchPage
            libraries={libraries}
            getLabelById={getLabelById}
            study={study}
            onManageLists={goToListSettings}
            onStartRecite={() => setTab('recite')}
            undoSnapshot={importUndoSnapshot}
            onUndoSnapshotChange={setImportUndoSnapshot}
          />
        )}
        {tab === 'lists' && (
          <ListsPage
            libraries={libraries}
            getLabelById={getLabelById}
            study={study}
            onManageLists={goToListSettings}
          />
        )}
        {tab === 'settings' && (
          <Suspense fallback={<div className="app__loading"><span className="ui-spin" aria-hidden="true" />加载设置中...</div>}>
          <SettingsPage
            libraries={libraries}
            getLabelById={getLabelById}
            hasCustomLabel={hasCustomLabel}
            onRename={updateLabel}
            onReset={resetLabel}
            getPrintLabelById={getPrintLabelById}
            hasCustomPrintLabel={hasCustomPrintLabel}
            onRenamePrintLabel={updatePrintLabel}
            onResetPrintLabel={resetPrintLabel}
            offline={labelsOffline}
            study={study}
            section={settingsSection}
            onSectionChange={setSettingsSection}
          />
          </Suspense>
        )}
        {tab === 'study' && (
          <StudyPage
            libraries={libraries}
            study={study}
            plan={plan}
            getPrintLabelById={getPrintLabelById}
            onOpenReciteTasks={() => setTab('recite-tasks')}
          />
        )}
        {tab === 'recite-tasks' && (
          <ReciteTasksPage
            study={study}
            today={plan.plan.today}
            onBack={() => setTab('study')}
          />
        )}
        {tab === 'recite-parent' && (
          <ReciteParentPage
            onBack={() => setTab('study')}
            onSaved={() => { void plan.refresh() }}
          />
        )}
        {tab === 'achievements' && (
          <AchievementsPage
            libraries={libraries}
            getLabelById={getLabelById}
            study={study}
          />
        )}
        {tab === 'passages' && (
          <PassagesPage
            libraries={libraries}
            getLabelById={getLabelById}
            study={study}
            onBack={() => setTab('search')}
          />
        )}
        {tab === 'goal' && (
          <GoalPage
            libraries={libraries}
            getLabelById={getLabelById}
            plan={plan}
          />
        )}
        {tab === 'records' && (
          <LearningRecordsPage
            libraries={libraries}
            getLabelById={getLabelById}
            onBack={() => setTab('achievements')}
          />
        )}
      </main>
    </div>
  )
}
