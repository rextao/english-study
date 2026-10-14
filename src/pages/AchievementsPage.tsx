import { useEffect, useMemo, useState } from 'react'
import type { StudyListApi } from '../hooks/useStudyList'
import type { LearningAchievement, VocabLibraryInfo } from '../types/vocab'
import { useLearningAchievements } from '../hooks/useLearningRecords'
import { PageHeader } from '../components/PageHeader'
import { Button, Select, Tag } from '../ui'
import './AchievementsPage.css'

const ALL_LIBRARIES = ''

// 手机端没有表头，排序做成一排按钮：点同一个维度切换正逆序，点别的维度按默认方向
const SORT_KEYS: SortKey[] = ['word', 'spelling', 'reading', 'remembered', 'recent']
const SORT_LABEL: Record<SortKey, string> = {
  word: '单词', spelling: '会拼', reading: '会读', remembered: '知意', recent: '最近学习',
}

// 排序维度：单词字母 / 会拼 / 会读 / 知意 次数 / 最近一次学习时间
type SortKey = 'word' | 'spelling' | 'reading' | 'remembered' | 'recent'
type SortDir = 'asc' | 'desc'
interface SortState { key: SortKey; dir: SortDir }

// 每个维度点第一次的默认方向：字母默认 a-z，次数和时间默认从高到低
const DEFAULT_DIR: Record<SortKey, SortDir> = {
  word: 'asc', spelling: 'desc', reading: 'desc', remembered: 'desc', recent: 'desc',
}

// 次数维度对应到成果字段（「最近学习」比的是时间，不走这里）
const COUNT_FIELD: Record<Exclude<SortKey, 'word' | 'recent'>, keyof Pick<LearningAchievement,
  'spellingCount' | 'readingCount' | 'rememberedCount'>> = {
  spelling: 'spellingCount', reading: 'readingCount', remembered: 'rememberedCount',
}

// 「最近学习」列只看这个窗口内的词：更久没碰过的显示成「超出 N 天」而不是具体天数
const RECENT_WINDOW_DAYS = 30
const RECENT_WINDOW_MS = RECENT_WINDOW_DAYS * 86_400_000

/** 距上一次学习过了几天；没有记录或超出统计窗口返回 null。 */
function recentDaysOf(item: LearningAchievement, now: number) {
  if (!item.lastAt) return null
  const elapsed = now - item.lastAt
  if (elapsed >= RECENT_WINDOW_MS) return null
  return Math.floor(Math.max(0, elapsed) / 86_400_000)
}

/** 最近学习格：窗口内是「今天 / N 天前」，没有记录或超出窗口给灰色占位。 */
function recentDaysText(days: number | null) {
  if (days === null) return '超出 ' + RECENT_WINDOW_DAYS + ' 天'
  return days === 0 ? '今天' : days + ' 天前'
}

interface AchievementsPageProps {
  libraries: VocabLibraryInfo[]
  getLabelById: (id: string) => string
  /** App 仍统一传入学习列表 API；永久成果本身不再依赖它。 */
  study: StudyListApi
}

/** 次数格：桌面端是表格的一格；手机端是卡片统计条上的一格（大数字在上、小标签在下）。 */
function CountCell({ label, value, tone }: { label: string; value: number; tone?: 'remembered' }) {
  const classes = ['achievements-table__count']
  if (tone) classes.push('achievements-table__count--' + tone)
  if (value === 0) classes.push('achievements-table__count--zero')
  return (
    <td className="achievements-table__number" data-label={label}>
      <span className={classes.join(' ')}>{value}</span>
    </td>
  )
}

export function AchievementsPage({ libraries, getLabelById }: AchievementsPageProps) {
  const [selectedLibrary, setSelectedLibrary] = useState(ALL_LIBRARIES)
  const [sort, setSort] = useState<SortState>({ key: 'word', dir: 'asc' })
  const achievements = useLearningAchievements(selectedLibrary)

  // 「最近学习」是相对时间：一次渲染共用同一个基准，同屏卡片的说法才不会自相矛盾
  const now = Date.now()

  useEffect(() => {
    if (selectedLibrary && !libraries.some(library => library.id === selectedLibrary)) setSelectedLibrary(ALL_LIBRARIES)
  }, [libraries, selectedLibrary])

  const options = useMemo(() => [
    { value: ALL_LIBRARIES, label: '全部词库' },
    ...libraries.map(library => ({ value: library.id, label: getLabelById(library.id) })),
  ], [libraries, getLabelById])

  // 点同一维度切换升降序，切到别的维度用该维度默认方向
  const toggleSort = (key: SortKey) => setSort(current =>
    current.key === key
      ? { key, dir: current.dir === 'asc' ? 'desc' : 'asc' }
      : { key, dir: DEFAULT_DIR[key] })

  // 排序：最近学习按时间戳（没有记录的排最后）；次数相同退回字母 a-z，保证顺序稳定
  const sortedItems = useMemo(() => {
    const factor = sort.dir === 'asc' ? 1 : -1
    return achievements.items.slice().sort((a, b) => {
      if (sort.key === 'word') return factor * a.word.localeCompare(b.word, 'en')
      if (sort.key === 'recent') {
        const left = a.lastAt ?? -Infinity
        const right = b.lastAt ?? -Infinity
        if (left !== right) return factor * (left < right ? -1 : 1)
        return a.word.localeCompare(b.word, 'en')
      }
      const field = COUNT_FIELD[sort.key]
      const diff = a[field] - b[field]
      if (diff !== 0) return factor * diff
      return a.word.localeCompare(b.word, 'en')
    })
  }, [achievements.items, sort])

  // 可排序的表头：点标题就地排序，箭头显示在标题旁边；提示文案跟着维度走
  const SortHeader = ({ sortKey, label }: { sortKey: SortKey; label: string }) => {
    const active = sort.key === sortKey
    return (
      <button type="button"
        className={'achievements-table__sort' + (active ? ' achievements-table__sort--active' : '')}
        aria-pressed={active} onClick={() => toggleSort(sortKey)}
        title={sortKey === 'word' ? '点击按字母排序'
          : sortKey === 'recent' ? '点击按最近学习时间排序' : '点击按次数排序'}>
        {label}
        <span className="achievements-table__sort-arrow" aria-hidden="true">
          {active ? (sort.dir === 'asc' ? '↑' : '↓') : '↕'}
        </span>
      </button>
    )
  }

  return (
    <div className="page page--wide achievements-page">
      <PageHeader title="学习成果" />

      <div className="card card--pad achievements-filter">
        <label className="field-label" htmlFor="achievements-library">按词库筛选</label>
        <Select id="achievements-library" className="achievements-filter__select" value={selectedLibrary}
          options={options} onChange={setSelectedLibrary} aria-label="按词库筛选学习成果" />
        <span className="achievements-filter__result">共 {achievements.items.length} 个词</span>
        {/* 手机端没有表头，排序入口搬到这里：按钮形式，点同一个维度切换正逆序 */}
        <div className="achievements-sort">
          {SORT_KEYS.map(key => {
            const active = sort.key === key
            return (
              <Button
                key={key}
                size="small"
                type={active ? 'primary' : 'default'}
                aria-pressed={active}
                title={active
                  ? (sort.dir === 'asc' ? '当前正序，点击切换为逆序' : '当前逆序，点击切换为正序')
                  : '按' + SORT_LABEL[key] + '排序'}
                onClick={() => toggleSort(key)}
              >
                {SORT_LABEL[key]}
                <span className="achievements-sort__arrow" aria-hidden="true">
                  {active ? (sort.dir === 'asc' ? '↑' : '↓') : '↕'}
                </span>
              </Button>
            )
          })}
        </div>
      </div>

      {achievements.error && (
        <div className="callout callout--warn achievements-notice">
          <span>{achievements.error}</span><Button size="small" onClick={achievements.reload}>重新加载</Button>
        </div>
      )}
      {achievements.loading && (
        <p className="empty achievements-loading"><span className="ui-spin" aria-hidden="true" />正在读取学习成果...</p>
      )}
      {!achievements.loading && !achievements.error && achievements.items.length === 0 && (
       <p className="empty">还没有学习记录。完成会拼、会读或知意等操作后，成果会永久保存在这里。</p>
      )}

      {!achievements.loading && achievements.items.length > 0 && (
        <div className="card achievements-table-wrap">
          <table className="achievements-table">
            <thead><tr>
              <th><SortHeader sortKey="word" label="单词" /></th><th>词库</th>
              <th className="achievements-table__number"><SortHeader sortKey="spelling" label="会拼" /></th>
              <th className="achievements-table__number"><SortHeader sortKey="reading" label="会读" /></th>
              <th className="achievements-table__number"><SortHeader sortKey="remembered" label="知意" /></th>
              <th className="achievements-table__number"><SortHeader sortKey="recent" label="最近学习" /></th></tr></thead>
            <tbody>
             {sortedItems.map(item => {
               const recentDays = recentDaysOf(item, now)
               return (
                <tr key={item.word} className="achievements-table__row">
                 <td className="achievements-table__cell-word">
                   <strong className="achievements-table__word">{item.word}</strong>
                 </td>
                 <td className="achievements-table__libs"><div className="achievements-table__tags">
                   {item.sourceIds.map(id => <Tag key={id} color="blue">{getLabelById(id)}</Tag>)}
                 </div></td>
                 <CountCell label="会拼" value={item.spellingCount} />
                 <CountCell label="会读" value={item.readingCount} />
                 <CountCell label="知意" value={item.rememberedCount} tone="remembered" />
                 <td className="achievements-table__number" data-label="最近学习">
                   <span className={'achievements-table__recent' +
                     (recentDays === null ? ' achievements-table__recent--none' : '')}>
                     {recentDaysText(recentDays)}
                   </span>
                 </td>
                </tr>
               )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
