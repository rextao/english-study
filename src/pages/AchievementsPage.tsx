import { useEffect, useMemo, useState } from 'react'
import type { StudyListApi } from '../hooks/useStudyList'
import type { VocabLibraryInfo } from '../types/vocab'
import { useLearningAchievements } from '../hooks/useLearningRecords'
import { PageHeader } from '../components/PageHeader'
import { Button, Select, Tag } from '../ui'
import './AchievementsPage.css'

const ALL_LIBRARIES = ''

interface AchievementsPageProps {
  libraries: VocabLibraryInfo[]
  getLabelById: (id: string) => string
  /** App 仍统一传入学习列表 API；永久成果本身不再依赖它。 */
  study: StudyListApi
  onManageRecords: () => void
}

export function AchievementsPage({ libraries, getLabelById, onManageRecords }: AchievementsPageProps) {
  const [selectedLibrary, setSelectedLibrary] = useState(ALL_LIBRARIES)
  const achievements = useLearningAchievements(selectedLibrary)

  useEffect(() => {
    if (selectedLibrary && !libraries.some(library => library.id === selectedLibrary)) setSelectedLibrary(ALL_LIBRARIES)
  }, [libraries, selectedLibrary])

  const options = useMemo(() => [
    { value: ALL_LIBRARIES, label: '全部词库' },
    ...libraries.map(library => ({ value: library.id, label: getLabelById(library.id) })),
  ], [libraries, getLabelById])

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
        <p className="empty">还没有学习记录。完成背过、记住或没记住等操作后，成果会永久保存在这里。</p>
      )}

      {!achievements.loading && achievements.items.length > 0 && (
        <div className="card achievements-table-wrap">
          <table className="achievements-table">
            <thead><tr><th>单词</th><th>词库</th><th className="achievements-table__number">背过</th>
              <th className="achievements-table__number">记住</th><th className="achievements-table__number">没记住</th></tr></thead>
            <tbody>
              {achievements.items.map(item => (
                <tr key={item.word}>
                  <td><strong className="achievements-table__word">{item.word}</strong></td>
                  <td><div className="achievements-table__tags">
                    {item.sourceIds.length > 0
                      ? item.sourceIds.map(id => <Tag key={id} color="blue">{getLabelById(id)}</Tag>)
                      : <span className="achievements-table__none">未归属词库</span>}
                  </div></td>
                  <td className="achievements-table__number">{item.reviewCount}</td>
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
