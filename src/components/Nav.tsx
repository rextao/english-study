import './Nav.css'

export type TabKey = 'search' | 'import' | 'lists' | 'libraries' | 'study'

const TABS: { key: TabKey; label: string }[] = [
  { key: 'search', label: '查词' },
  { key: 'import', label: '批量导入' },
  { key: 'lists',  label: '学习列表' },
  { key: 'libraries', label: '词库' },
]

interface NavProps {
  active: TabKey
  onChange: (tab: TabKey) => void
  /** 所有学习列表里的词条总数，显示在「学习列表」上 */
  totalItems: number
  /** 词库数量，显示在「词库」上 */
  libraryCount: number
  /** 今天要复习的词数，显示在「英语学习」入口的角标上 */
  dueToday: number
}

export function Nav({ active, onChange, totalItems, libraryCount, dueToday }: NavProps) {
  return (
    <nav className="nav" aria-label="主导航">
      <div className="nav__inner">
        <div className="nav__brand">
          <span className="nav__logo" aria-hidden="true">词</span>
          <span className="nav__brand-text">背单词</span>
        </div>

        <div className="nav__tabs">
          {TABS.map(tab => {
            const badge = tab.key === 'lists' ? totalItems : tab.key === 'libraries' ? libraryCount : 0
            return (
              <button
                key={tab.key}
                type="button"
                className={'nav__tab' + (active === tab.key ? ' nav__tab--active' : '')}
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
      </div>
    </nav>
  )
}
