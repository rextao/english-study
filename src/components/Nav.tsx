import './Nav.css'

export type TabKey = 'search' | 'lists' | 'settings' | 'achievements' | 'records' | 'study'

const TABS: { key: TabKey; label: string }[] = [
  { key: 'search', label: '查词' },
  { key: 'lists',  label: '学习列表' },
  { key: 'achievements', label: '学习成果' },
]

/** 设置入口的齿轮图标，放英语学习右边，不占分段控件的位置 */
const gearIcon = (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.8" />
    <path
      d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)

interface NavProps {
  active: TabKey
  onChange: (tab: TabKey) => void
  /** 所有学习列表里的词条总数，显示在「学习列表」上 */
  totalItems: number
  /** 今天要复习的词数，显示在「英语学习」入口的角标上 */
  dueToday: number
}

export function Nav({ active, onChange, totalItems, dueToday }: NavProps) {
  const visibleActive = active === 'records' ? 'achievements' : active

  return (
    <nav className="nav" aria-label="主导航">
      <div className="nav__inner">
        <div className="nav__brand">
          <span className="nav__logo" aria-hidden="true">词</span>
          <span className="nav__brand-text">背单词</span>
        </div>

        <div className="nav__tabs">
          {TABS.map(tab => {
            const badge = tab.key === 'lists' ? totalItems : 0
            return (
              <button
                key={tab.key}
                type="button"
                className={'nav__tab' + (visibleActive === tab.key ? ' nav__tab--active' : '')}
                aria-current={active === tab.key ? 'page' : undefined}
                onClick={() => onChange(tab.key)}
              >
                {tab.label}
                {badge > 0 && <span className="nav__badge">{badge}</span>}
              </button>
            )
          })}
        </div>

        {/* 学习入口刻意不放进分段控件：会流光的发光胶囊，和左边灰底分段 tab 完全两种质感 */}
        <button
          type="button"
          className={'nav__cta' + (active === 'study' ? ' nav__cta--active' : '')}
          aria-current={active === 'study' ? 'page' : undefined}
          title={dueToday > 0 ? '今天有 ' + dueToday + ' 个词要复习' : '开始英语学习'}
          onClick={() => onChange('study')}
        >
          <span className="nav__cta-shine" aria-hidden="true" />
          <span className="nav__cta-icon" aria-hidden="true">⚡</span>
          <span className="nav__cta-label">英语学习</span>
          {dueToday > 0 && <span className="nav__cta-badge">{dueToday}</span>}
        </button>

        {/* 设置：齿轮图标按钮，待在英语学习右侧，不进分段控件 */}
        <button
          type="button"
          className={'nav__icon-btn' + (active === 'settings' ? ' nav__icon-btn--active' : '')}
          aria-current={active === 'settings' ? 'page' : undefined}
          aria-label="设置"
          title="设置"
          onClick={() => onChange('settings')}
        >
          {gearIcon}
        </button>
      </div>
    </nav>
  )
}
