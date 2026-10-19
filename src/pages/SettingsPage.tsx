import type { StudyListApi } from '../hooks/useStudyList'
import type { VocabLibraryInfo } from '../types/vocab'
import type { UpdateLabelResult } from '../hooks/useVocabLibraries'
import { useDictSources } from '../hooks/useDictSources'
import { LibrariesPage } from './LibrariesPage'
import { LearningRecordsPage } from './LearningRecordsPage'
import { PageHeader } from '../components/PageHeader'
import { StudyListManager } from '../components/StudyListManager'
import { PhoneticRepair } from '../components/PhoneticRepair'
import { Tag } from '../ui'
import './SettingsPage.css'

/** 设置页的子分区：词库配置 / 学习列表 / 学习记录 / 补充音标 / 查询链路 */
export type SettingsSection = 'chain' | 'libraries' | 'lists' | 'records' | 'phonetics'

/** 左侧菜单项，顺序即展示顺序 */
const SECTIONS: { id: SettingsSection; label: string }[] = [
  { id: 'libraries', label: '词库配置' },
  { id: 'lists', label: '学习列表' },
  { id: 'records', label: '学习记录' },
  { id: 'phonetics', label: '补充音标' },
  { id: 'chain', label: '查询链路' },
]

interface SettingsPageProps {
  libraries: VocabLibraryInfo[]
  getLabelById: (id: string) => string
  hasCustomLabel: (id: string) => boolean
  onRename: (id: string, label: string) => Promise<UpdateLabelResult>
  onReset: (id: string) => void
  getPrintLabelById: (id: string) => string
  hasCustomPrintLabel: (id: string) => boolean
  onRenamePrintLabel: (id: string, label: string) => Promise<UpdateLabelResult>
  onResetPrintLabel: (id: string) => void
  /** 云端不可达时词库页显示降级提示 */
  offline: boolean
  /** 学习列表状态中枢，用于「学习列表」分区的新建 / 改名 / 删除 */
  study: StudyListApi
  /** 当前子分区由 App 托管 */
  section: SettingsSection
  onSectionChange: (section: SettingsSection) => void
}

export function SettingsPage(props: SettingsPageProps) {
  const { sources, chain } = useDictSources()
  const { study, section, onSectionChange, offline, libraries, getLabelById, ...libraryProps } = props

  return (
    <div className="page settings-page">
      <PageHeader title="设置" />

      <div className="settings-layout">
        <nav className="settings-nav" role="tablist" aria-label="设置分区">
          {SECTIONS.map(item => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={section === item.id}
              className={'settings-nav__btn' + (section === item.id ? ' settings-nav__btn--active' : '')}
              onClick={() => onSectionChange(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>

        <div className="settings-content">

      {section === 'chain' && (
      <section className="settings-section">
        <div className="settings-section__head">
          <p className="hint">查词时按下面的顺序依次尝试；命中缓存或个人词典就直接返回，不发外部网络请求。未命中时，免费词典取音标和英文释义，百度翻译取中文，两个外部步骤会互补执行。灰色的步骤查词时会被跳过。</p>
        </div>
        {sources === null ? (
          <div className="callout callout--warn">
            无法读取查词链路状态，请确认云端 Worker 已部署且访问令牌正确。
          </div>
        ) : (
          <ol className="chain">
            {chain.map((step, index) => (
              <li
                key={step.id}
                className={'chain-step' + (step.available ? '' : ' chain-step--off')}
              >
                <span className="chain-step__index" aria-hidden="true">{index + 1}</span>
                <div className="chain-step__main">
                  <div className="chain-step__head">
                    <span className="chain-step__name">{step.name}</span>
                    {step.available
                      ? <Tag color="green">已启用</Tag>
                      : <Tag color="default">跳过</Tag>}
                    {step.id === 'cache' && sources.cache.total > 0 && (
                      <span className="chain-step__stat">
                        已缓存 {sources.cache.complete}/{sources.cache.total} 条
                      </span>
                    )}
                  </div>
                  <p className="chain-step__desc">{step.desc}</p>
                  {!step.available && step.reason && (
                    <p className="chain-step__reason">{step.reason}</p>
                  )}
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>
      )}

      {section === 'libraries' && (
        <section className="settings-section">
          <div className="settings-section__head">
            <p className="hint">显示标签用于页面展示；打印标签用于卡片右上角，未设置时沿用显示标签。</p>
          </div>
          <LibrariesPage embedded offline={offline} libraries={libraries} getLabelById={getLabelById} {...libraryProps} />
        </section>
      )}

      {section === 'lists' && (
        <section className="settings-section">
          <StudyListManager study={study} />
        </section>
      )}
      {section === 'records' && (
        <section className="settings-section">
          <LearningRecordsPage embedded libraries={libraries} getLabelById={getLabelById} />
        </section>
      )}
      {section === 'phonetics' && (
        <section className="settings-section">
          <PhoneticRepair />
        </section>
      )}
        </div>
      </div>
    </div>
  )
}
