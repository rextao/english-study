import { lazy, Suspense, useEffect, useState } from 'react'
import { useVocabLibraries } from './hooks/useVocabLibraries'
import { useStudyList } from './hooks/useStudyList'
import { useStudyPlan } from './hooks/useStudyPlan'
import { useTabRoute } from './hooks/useTabRoute'
import { AUTH_REQUIRED_EVENT, getStoredToken, setStoredToken } from './utils/apiBase'
import { Nav } from './components/Nav'
import { TokenGate } from './components/TokenGate'
import { SearchPage } from './pages/SearchPage'
import { ListsPage } from './pages/ListsPage'
import type { SettingsSection } from './pages/SettingsPage'
import { StudyPage } from './pages/StudyPage'
import { AchievementsPage } from './pages/AchievementsPage'
import { LearningRecordsPage } from './pages/LearningRecordsPage'
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
  // 当前页面记在地址栏 hash 上，刷新后不会跳回首页
  const [tab, setTab] = useTabRoute()

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

  const totalItems = study.lists.reduce((sum, l) => sum + l.wordCount, 0)

  return (
    <div className="app">
      <Nav
        active={tab}
        onChange={setTab}
        totalItems={totalItems}
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
          />
        )}
        {tab === 'lists' && (
          <ListsPage
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
            getLabelById={getLabelById}
            getPrintLabelById={getPrintLabelById}
          />
        )}
        {tab === 'achievements' && (
          <AchievementsPage
            libraries={libraries}
            getLabelById={getLabelById}
            study={study}
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
