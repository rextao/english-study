import { useState } from 'react'
import { useVocabLibraries } from './hooks/useVocabLibraries'
import { useStudyList } from './hooks/useStudyList'
import { useStudyPlan } from './hooks/useStudyPlan'
import { useTabRoute } from './hooks/useTabRoute'
import { useSync } from './hooks/useSync'
import { Nav } from './components/Nav'
import { SyncNotice } from './components/SyncNotice'
import { SearchPage } from './pages/SearchPage'
import { ListsPage } from './pages/ListsPage'
import { SettingsPage } from './pages/SettingsPage'
import type { SettingsSection } from './pages/SettingsPage'
import { StudyPage } from './pages/StudyPage'
import { AchievementsPage } from './pages/AchievementsPage'
import { LearningRecordsPage } from './pages/LearningRecordsPage'
import './App.css'

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
  // 数据同步：全局唯一一份，顶部提示条和设置页共用，避免切 tab 后状态不同步
  const sync = useSync()

  // 设置页当前子分区（词库配置 / 查询链路 / 数据同步）；提到这里是为了让同步提示条能一键切过去
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('libraries')
  // 每 +1 一次，让设置页的同步面板自动展开并拉一次差异；用计数而不是布尔，连点也能重复触发
  const [syncDiffTick, setSyncDiffTick] = useState(0)

  /** 顶部同步提示条点「选择同步方向 / 详情」：切到设置页数据同步 tab，showDiff 时顺带展开差异 */
  const goToSync = (showDiff: boolean) => {
    setSettingsSection('sync')
    setTab('settings')
    if (showDiff) setSyncDiffTick(tick => tick + 1)
  }

  /** 从云端拉取覆盖本地成功后，页面上的列表 / 计划 / 标签都还是旧数据，刷新一遍 */
  const handleSyncApplied = () => {
    void study.fetchLists()
    void plan.refresh()
    void reloadLabels()
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
            本地服务未启动，学习列表暂不可用，词库标签只会临时存在浏览器里。请在项目目录运行 <code>npm run dev:all</code>
          </div>
        </div>
      )}

      <SyncNotice sync={sync} onApplied={handleSyncApplied} onNavigateToSync={goToSync} />

      <main>
        {tab === 'search' && (
          <SearchPage
            libraries={libraries}
            getLabelById={getLabelById}
            study={study}
          />
        )}
        {tab === 'lists' && (
          <ListsPage
            getLabelById={getLabelById}
            study={study}
          />
        )}
        {tab === 'settings' && (
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
            sync={sync}
            section={settingsSection}
            onSectionChange={setSettingsSection}
            syncDiffTick={syncDiffTick}
          />
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
            onManageRecords={() => setTab('records')}
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
