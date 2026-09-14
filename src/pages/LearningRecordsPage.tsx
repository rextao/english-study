import { useEffect, useMemo, useState } from 'react'
import type { LearningRecordEvent, LearningRecordGroup, VocabLibraryInfo } from '../types/vocab'
import { useLearningRecords } from '../hooks/useLearningRecords'
import type { LearningRecordFilterAction } from '../hooks/useLearningRecords'
import { Button, Checkbox, Input, Modal, Popconfirm, Select, Tag } from '../ui'
import './LearningRecordsPage.css'

const ALL_LIBRARIES = ''
const ALL_ACTIONS: LearningRecordFilterAction = 'all'

interface LearningRecordsPageProps {
  libraries: VocabLibraryInfo[]
  getLabelById: (id: string) => string
  onBack: () => void
}

const ACTION_OPTIONS: Array<{ value: LearningRecordFilterAction; label: string }> = [
  { value: ALL_ACTIONS, label: '全部标记' },
  { value: 'spelling', label: '背过' },
  { value: 'done', label: '记住' },
  { value: 'again', label: '没记住' },
]

const ACTION_LABELS: Record<string, string> = {
  start: '开始学习', restart: '重新开始', done: '记住', again: '没记住',
  stop: '退出学习', print: '打印', spelling: '背过',
}

function formatDate(at: number) {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(at))
}

export function LearningRecordsPage({ libraries, getLabelById, onBack }: LearningRecordsPageProps) {
  const [searchInput, setSearchInput] = useState('')
  const [searchWord, setSearchWord] = useState('')
  const [libraryId, setLibraryId] = useState(ALL_LIBRARIES)
  const [action, setAction] = useState<LearningRecordFilterAction>(ALL_ACTIONS)
  const [detailWord, setDetailWord] = useState<string | null>(null)
  const [selectedWords, setSelectedWords] = useState<Set<string>>(() => new Set())

  useEffect(() => {
    const timer = window.setTimeout(() => setSearchWord(searchInput), 300)
    return () => window.clearTimeout(timer)
  }, [searchInput])

  useEffect(() => {
    if (libraryId && !libraries.some(library => library.id === libraryId)) setLibraryId(ALL_LIBRARIES)
  }, [libraries, libraryId])

  const filters = useMemo(() => ({ libraryId, word: searchWord, action }), [action, libraryId, searchWord])
  const records = useLearningRecords(filters, true)
  const detailGroup = records.items.find(group => group.word === detailWord) ?? null
  const allVisibleSelected = records.items.length > 0
    && records.items.every(group => selectedWords.has(group.word))
  const libraryOptions = useMemo(() => [
    { value: ALL_LIBRARIES, label: '全部词库' },
    ...libraries.map(library => ({ value: library.id, label: getLabelById(library.id) })),
  ], [getLabelById, libraries])

  useEffect(() => {
    if (!records.loading && detailWord && !detailGroup) setDetailWord(null)
  }, [detailGroup, detailWord, records.loading])

  useEffect(() => {
    setSelectedWords(new Set())
  }, [action, libraryId, searchWord])

  function toggleWord(word: string, checked: boolean) {
    setSelectedWords(current => {
      const next = new Set(current)
      checked ? next.add(word) : next.delete(word)
      return next
    })
  }

  function toggleAllVisible(checked: boolean) {
    setSelectedWords(current => {
      const next = new Set(current)
      for (const group of records.items) checked ? next.add(group.word) : next.delete(group.word)
      return next
    })
  }

  async function handleRemoveEvent(event: LearningRecordEvent) {
    await records.removeEvent(event.id)
  }

  async function handleClearWord(group: LearningRecordGroup) {
    if (await records.clearWord(group.word)) setDetailWord(null)
  }

  async function handlePurgeSelected() {
    const words = [...selectedWords]
    if (words.length === 0) return
    if (await records.purgeWords(words)) {
      setSelectedWords(new Set())
      if (detailWord && words.includes(detailWord)) setDetailWord(null)
    }
  }

  async function handlePurgeAll() {
    if (await records.purgeAll()) {
      setSelectedWords(new Set())
      setDetailWord(null)
    }
  }

  return (
    <div className="page page--wide learning-records-page">
      <header className="learning-records-page__header">
        <h1>学习记录管理</h1>
        <span className="learning-records-page__eyebrow">记录管理 · DATA MANAGEMENT</span>
        <div className="learning-records-page__scope">
          <span>背过</span><span>记住</span><span>没记住</span>
        </div>
        <Button className="learning-records-page__back" size="small" onClick={onBack}>返回学习成果</Button>
      </header>

      <div className="learning-records-page__bulk-bar">
        <div className="learning-records-page__bulk-status">
          <span>数据管理模式</span>
          <span>已选 {selectedWords.size} 个</span>
        </div>
        <div className="learning-records-page__bulk-actions">
          <Popconfirm title={`永久删除选中的 ${selectedWords.size} 个单词记录？`}
            description={<>系统会先自动备份数据库，删除后页面内不可撤销。<br />学习列表和复习排期不会受到影响。</>}
            okText="确认物理删除" danger placement="bottomRight"
            disabled={records.mutating || selectedWords.size === 0}
            onConfirm={() => { void handlePurgeSelected() }}>
            <Button type="text" size="small" danger loading={records.mutating}
              disabled={records.mutating || selectedWords.size === 0}>删除已选</Button>
          </Popconfirm>
          <Popconfirm title="永久删除全部学习记录？"
            description={<>这会删除所有单词的学习历史，不受当前搜索和筛选条件影响。<br />系统会先自动备份数据库，页面内不可撤销；学习列表和复习排期不受影响。</>}
            okText="确认全部删除" danger placement="bottomRight" disabled={records.mutating}
            onConfirm={() => { void handlePurgeAll() }}>
            <Button type="text" size="small" danger disabled={records.mutating}>全部删除</Button>
          </Popconfirm>
        </div>
      </div>

      <div className="card card--pad learning-records-page__filters">
        <Input block value={searchInput} placeholder="搜索单词" aria-label="搜索学习记录中的单词"
          allowClear onClear={() => setSearchInput('')} onChange={event => setSearchInput(event.target.value)} />
        <Select value={libraryId} options={libraryOptions} onChange={setLibraryId} aria-label="按词库筛选学习记录" />
        <Select value={action} options={ACTION_OPTIONS}
          onChange={value => setAction(value as LearningRecordFilterAction)} aria-label="按标记筛选学习记录" />
      </div>

      {records.error && (
        <div className="callout callout--warn learning-records-page__error">
          <span>{records.error}</span><Button size="small" onClick={records.reload}>重新加载</Button>
        </div>
      )}
      {records.loading && (
        <p className="empty learning-records-page__loading"><span className="ui-spin" aria-hidden="true" />正在读取学习记录...</p>
      )}
      {!records.loading && !records.error && records.items.length === 0 && <p className="empty">没有符合条件的学习记录。</p>}

      {!records.loading && records.items.length > 0 && (
        <div className="card learning-records-page__table-wrap">
          <table className="learning-records-page__table">
            <thead><tr><th className="learning-records-page__select">
              <Checkbox checked={allVisibleSelected} disabled={records.items.length === 0 || records.mutating}
                onChange={event => toggleAllVisible(event.target.checked)}>
                <span>{allVisibleSelected ? '取消本页' : '本页全选'}</span>
              </Checkbox>
            </th><th>单词</th><th>词库</th><th className="learning-records-page__number">背过</th>
              <th className="learning-records-page__number">记住</th><th className="learning-records-page__number">没记住</th>
              <th className="learning-records-page__actions">操作</th></tr></thead>
            <tbody>{records.items.map(group => (
              <tr key={group.word} className={selectedWords.has(group.word) ? 'learning-records-page__row--selected' : undefined}>
                <td className="learning-records-page__select">
                  <Checkbox checked={selectedWords.has(group.word)} disabled={records.mutating}
                    onChange={event => toggleWord(group.word, event.target.checked)}>
                    <span className="learning-records-page__sr-only">选择 {group.word}</span>
                  </Checkbox>
                </td>
                <td><strong>{group.word}</strong></td>
                <td><div className="learning-records-page__tags">
                  {group.sourceIds.length > 0
                    ? group.sourceIds.map(sourceId => <Tag key={sourceId} color="blue">{getLabelById(sourceId)}</Tag>)
                    : <span className="learning-records-page__none">未归属词库</span>}
                </div></td>
                <td className="learning-records-page__number">{group.spellingCount}</td>
                <td className="learning-records-page__number">{group.rememberedCount}</td>
                <td className="learning-records-page__number">{group.forgottenCount}</td>
                <td className="learning-records-page__actions">
                  <Button size="small" onClick={() => setDetailWord(group.word)}>详情</Button>
                  <Popconfirm title={`清空 ${group.word} 的全部学习记录？`}
                    description="这是普通清空（逻辑删除），会重新计算成果，但不会影响学习列表和复习计划。"
                    okText="确认清空" danger placement="bottomRight" disabled={records.mutating}
                    onConfirm={() => { void handleClearWord(group) }}>
                    <Button size="small" type="text" danger disabled={records.mutating}>清空记录</Button>
                  </Popconfirm>
                </td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}

      {!records.loading && records.items.length > 0 && (
        <div className="learning-records-page__more">
          <span>已显示 {records.items.length} / {records.total} 个单词</span>
          {records.hasMore && <Button loading={records.loadingMore} onClick={records.loadMore}>加载更多</Button>}
        </div>
      )}

      <RecordDetailModal group={detailGroup} mutating={records.mutating}
        onClose={() => setDetailWord(null)} onRemove={handleRemoveEvent} />
    </div>
  )
}

interface RecordDetailModalProps {
  group: LearningRecordGroup | null
  mutating: boolean
  onClose: () => void
  onRemove: (event: LearningRecordEvent) => Promise<void>
}

function RecordDetailModal({ group, mutating, onClose, onRemove }: RecordDetailModalProps) {
  return (
    <Modal open={group !== null} width="wide" title={group ? `${group.word} 的学习记录` : '学习记录详情'}
      description="仅展示背过、记住和没记住的日期记录。" onClose={onClose} footer={<Button onClick={onClose}>关闭</Button>}>
      {group && group.events.length === 0 && (
        <p className="empty empty--inline">这部分旧记录只有累计次数，没有可逐条查看的日期。</p>
      )}
      {group && group.events.length > 0 && (
        <div className="learning-records-page__detail-table-wrap">
          <table className="learning-records-page__detail-table">
            <thead><tr><th>标记</th><th>日期</th><th>操作</th></tr></thead>
            <tbody>{group.events.map(event => (
              <tr key={event.id}>
                <td>{ACTION_LABELS[event.action] ?? event.action}</td>
                <td><time dateTime={new Date(event.at).toISOString()}>{formatDate(event.at)}</time></td>
                <td>
                  <Popconfirm title="删除这条学习记录？"
                    description="删除后会重新计算该单词的成果，但不会改变当前复习计划。"
                    okText="确认删除" danger placement="bottomRight" disabled={mutating}
                    onConfirm={() => { void onRemove(event) }}>
                    <Button size="small" type="text" danger disabled={mutating}>删除</Button>
                  </Popconfirm>
                </td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </Modal>
  )
}
