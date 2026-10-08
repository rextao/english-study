import { useEffect, useMemo, useState } from 'react'
import type { StudyListApi } from '../hooks/useStudyList'
import type { LearningAchievement, VocabLibraryInfo } from '../types/vocab'
import { useLearningAchievements } from '../hooks/useLearningRecords'
import { PageHeader } from '../components/PageHeader'
import { Button, Select, Tag } from '../ui'
import './AchievementsPage.css'

const ALL_LIBRARIES = ''

// 排序维度：单词字母 / 会拼 / 会读 / 知意 / 没记住 次数
type SortKey = 'word' | 'spelling' | 'reading' | 'remembered' | 'forgotten'
type SortDir = 'asc' | 'desc'
interface SortState { key: SortKey; dir: SortDir }

// 每个维度点第一次的默认方向：字母默认 a-z，次数默认从高到低
const DEFAULT_DIR: Record<SortKey, SortDir> = {
  word: 'asc', spelling: 'desc', reading: 'desc', remembered: 'desc', forgotten: 'desc',
}

// 次数维度对应到成果字段
const COUNT_FIELD: Record<Exclude<SortKey, 'word'>, keyof Pick<LearningAchievement,
  'spellingCount' | 'readingCount' | 'rememberedCount' | 'forgottenCount'>> = {
  spelling: 'spellingCount', reading: 'readingCount',
  remembered: 'rememberedCount', forgotten: 'forgottenCount',
}

interface AchievementsPageProps {
  libraries: VocabLibraryInfo[]
  getLabelById: (id: string) => string
  /** App 仍统一传入学习列表 API；永久成果本身不再依赖它。 */
  study: StudyListApi
  onManageRecords: () => void
}

export function AchievementsPage({ libraries, getLabelById, onManageRecords }: AchievementsPageProps) {
  const [selectedLibrary, setSelectedLibrary] = useState(ALL_LIBRARIES)
  const [sort, setSort] = useState<SortState>({ key: 'word', dir: 'asc' })
  const achievements = useLearningAchievements(selectedLibrary)

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

  // 次数相同的行退回字母 a-z，保证顺序稳定
  const sortedItems = useMemo(() => {
    const factor = sort.dir === 'asc' ? 1 : -1
    return achievements.items.slice().sort((a, b) => {
      if (sort.key === 'word') return factor * a.word.localeCompare(b.word, 'en')
      const field = COUNT_FIELD[sort.key]
      const diff = a[field] - b[field]
      if (diff !== 0) return factor * diff
      return a.word.localeCompare(b.word, 'en')
    })
  }, [achievements.items, sort])

  // 可排序的表头：点标题就地排序，箭头显示在标题旁边
  const SortHeader = ({ sortKey, label, numeric }: { sortKey: SortKey; label: string; numeric?: boolean }) => {
    const active = sort.key === sortKey
    return (
      <button type="button"
        className={'achievements-table__sort' + (active ? ' achievements-table__sort--active' : '')}
        aria-pressed={active} onClick={() => toggleSort(sortKey)}
        title={numeric ? '点击按次数排序' : '点击按字母排序'}>
        {label}
        <span className="achievements-table__sort-arrow" aria-hidden="true">
          {active ? (sort.dir === 'asc' ? '↑' : '↓') : '↕'}
        </span>
      </button>
    )
  }

  return (
    <div className="page page--wide achievements-page">
      <PageHeader title="学习成果"
        subtitle="汇总永久学习记录；从学习列表移除单词或删除列表，都不会影响这里的成果。"
        actions={<Button onClick={onManageRecords}>管理学习记录</Button>} />

      <div className="card card--pad achievements-filter">
        <label className="field-label" htmlFor="achievements-library">按词库筛选</label>
        <Select id="achievements-library" className="achievements-filter__select" value={selectedLibrary}
          options={options} onChange={setSelectedLibrary} aria-label="按词库筛选学习成果" />
        <span className="achievements-filter__result">共 {achievements.items.length} 个词</span>
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
       <p className="empty">还没有学习记录。完成会拼、会读、知意或没记住等操作后，成果会永久保存在这里。</p>
      )}

      {!achievements.loading && achievements.items.length > 0 && (
        <div className="card achievements-table-wrap">
          <table className="achievements-table">
            <thead><tr>
              <th><SortHeader sortKey="word" label="单词" /></th><th>词库</th>
              <th className="achievements-table__number"><SortHeader sortKey="spelling" label="会拼" numeric /></th>
              <th className="achievements-table__number"><SortHeader sortKey="reading" label="会读" numeric /></th>
              <th className="achievements-table__number"><SortHeader sortKey="remembered" label="知意" numeric /></th>
              <th className="achievements-table__number"><SortHeader sortKey="forgotten" label="没记住" numeric /></th></tr></thead>
            <tbody>
             {sortedItems.map(item => (
                <tr key={item.word}>
                 <td><strong className="achievements-table__word">{item.word}</strong></td>
                 <td><div className="achievements-table__tags">
                   {item.sourceIds.length > 0
                     ? item.sourceIds.map(id => <Tag key={id} color="blue">{getLabelById(id)}</Tag>)
                     : <span className="achievements-table__none">未归属词库</span>}
                 </div></td>
                 <td className="achievements-table__number">{item.spellingCount}</td>
                 <td className="achievements-table__number">{item.readingCount}</td>
                 <td className="achievements-table__number achievements-table__number--remembered">{item.rememberedCount}</td>
                 <td className="achievements-table__number achievements-table__number--forgotten">{item.forgottenCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
