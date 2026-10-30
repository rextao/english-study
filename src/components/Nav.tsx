import './Nav.css'
import { Dropdown } from '../ui'
import type { MenuItemType } from '../ui'

export type TabKey = 'search' | 'lists' | 'settings' | 'achievements' | 'records' | 'study' | 'goal' | 'passages'

// extra = 手机端收进折叠菜单的 tab（查词始终留在导航栏上）
const TABS: { key: TabKey; label: string; extra?: boolean }[] = [
  { key: 'search', label: '查词' },
  { key: 'lists',  label: '学习列表', extra: true },
  { key: 'achievements', label: '学习成果', extra: true },
  { key: 'passages', label: '短文', extra: true },
  { key: 'goal', label: '目标', extra: true },
]

/** 手机端折叠菜单的「更多」图标：三道短横线，和齿轮同尺寸的圆形按钮 */
const moreIcon = (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
  </svg>
)

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
  /** 今天要复习的词数，显示在「英语学习」入口的角标上 */
  dueToday: number
}

export function Nav({ active, onChange, dueToday }: NavProps) {
  const visibleActive = active === 'records' ? 'achievements' : active

  // 手机端折叠菜单里装着学习列表 / 学习成果 / 短文 / 目标 / 设置，落在这些页面上时「更多」按钮要高亮
  const moreActive = active === 'lists' || active === 'achievements' || active === 'goal' || active === 'settings' || active === 'records' || active === 'passages'
  const moreItems: MenuItemType[] = [
      { key: 'lists', label: '学习列表' },
      { key: 'achievements', label: '学习成果' },
       { key: 'passages', label: '短文' },
      { key: 'goal', label: '目标' },
     { key: 'settings', label: '设置', icon: gearIcon },
  ]

  return (
    <nav className="nav" aria-label="主导航">
      <div className="nav__inner">
        <div className="nav__brand">
          <span className="nav__logo" aria-hidden="true">词</span>
          <span className="nav__brand-text">背单词</span>
        </div>

        <div className="nav__tabs">
          {TABS.map(tab => {
            return (
              <button
                key={tab.key}
                type="button"
                className={'nav__tab' + (tab.extra ? ' nav__tab--extra' : '')
                  + (visibleActive === tab.key ? ' nav__tab--active' : '')}
                 aria-current={visibleActive === tab.key ? 'page' : undefined}
                onClick={() => onChange(tab.key)}
              >
                {tab.label}
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

        {/* 设置：齿轮图标按钮，待在英语学习右侧，不进分段控件；
            「云端有更新」小提示绝对定位挂在齿轮右边，显示与否都不挤动布局。
            手机端齿轮收进下面的折叠菜单，桌面端才单独露出来 */}
        <div className="nav__settings">
          <button
            type="button"
            className={'nav__icon-btn nav__settings-desktop' + (active === 'settings' ? ' nav__icon-btn--active' : '')}
            aria-current={active === 'settings' ? 'page' : undefined}
            aria-label="设置"
            title="设置"
            onClick={() => onChange('settings')}
          >
            {gearIcon}
          </button>

           {/* 手机端折叠菜单：学习列表 / 学习成果 / 目标 / 设置 都收这里；桌面端隐藏 */}
          <div className="nav__more">
            <Dropdown
              menu={{ items: moreItems, onClick: info => onChange(info.key as TabKey) }}
              placement="bottomRight"
            >
              <button
                type="button"
                className={'nav__icon-btn' + (moreActive ? ' nav__icon-btn--active' : '')}
                aria-current={moreActive ? 'page' : undefined}
                aria-label="更多"
                title="更多"
              >
                {moreIcon}
              </button>
            </Dropdown>
          </div>
        </div>
      </div>
    </nav>
  )
}
