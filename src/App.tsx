import { useVocabLibraries } from './hooks/useVocabLibraries'
import { useStudyList } from './hooks/useStudyList'
import { useStudyPlan } from './hooks/useStudyPlan'
import { useTabRoute } from './hooks/useTabRoute'
import { Nav } from './components/Nav'
import { SearchPage } from './pages/SearchPage'
import { ListsPage } from './pages/ListsPage'
import { SettingsPage } from './pages/SettingsPage'
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
  } = useVocabLibraries()
  // 学习列表状态提到最外层，三个页面共用一份，避免切换 tab 后数据不同步
  const study = useStudyList()
  // 复习计划跨列表汇总，导航角标和学习页共用同一份
  const plan = useStudyPlan()
  // 当前页面记在地址栏 hash 上，刷新后不会跳回首页
  const [tab, setTab] = useTabRoute()

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
