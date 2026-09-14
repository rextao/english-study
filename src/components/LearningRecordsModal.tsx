import { useEffect, useMemo, useState } from 'react'
import type { LearningRecordEvent, VocabLibraryInfo } from '../types/vocab'
import { useLearningRecords } from '../hooks/useLearningRecords'
import type { LearningRecordFilterAction } from '../hooks/useLearningRecords'
import { Button, Input, Modal, Popconfirm, Select, Tag } from '../ui'
import './LearningRecordsModal.css'

const ALL_LIBRARIES = ''
const ALL_ACTIONS: LearningRecordFilterAction = 'all'

interface LearningRecordsModalProps {
  open: boolean
  libraries: VocabLibraryInfo[]
  getLabelById: (id: string) => string
  onClose: () => void
  onRecordsChanged: () => void
}

const ACTION_OPTIONS = [
  { value: ALL_ACTIONS, label: '全部标记' },
  { value: 'review', label: '背过' },
  { value: 'done', label: '记住' },
  { value: 'again', label: '没记住' },
]

const ACTION_LABELS: Record<string, string> = {
  start: '开始学习', restart: '重新开始', done: '记住', again: '没记住',
  stop: '退出学习', print: '打印', spelling: '背过',
}

function formatTime(at: number) {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date(at))
}

function eventDescription(event: LearningRecordEvent) {
  const details: string[] = []
  if (event.scope) details.push(event.scope === 'week' ? '按周' : '按天')
  if (typeof event.stage === 'number') details.push(`第 ${event.stage} 轮`)
  return details.join(' · ')
}

export function LearningRecordsModal({ open, libraries, getLabelById, onClose, onRecordsChanged }: LearningRecordsModalProps) {
  const [searchInput, setSearchInput] = useState('')
  const [searchWord, setSearchWord] = useState('')
  const [libraryId, setLibraryId] = useState(ALL_LIBRARIES)
  const [action, setAction] = useState<LearningRecordFilterAction>(ALL_ACTIONS)

  useEffect(() => {
    const timer = window.setTimeout(() => setSearchWord(searchInput), 300)
    return () => window.clearTimeout(timer)
  }, [searchInput])

  useEffect(() => {
    if (libraryId && !libraries.some(library => library.id === libraryId)) setLibraryId(ALL_LIBRARIES)
  }, [libraries, libraryId])

  const filters = useMemo(() => ({ libraryId, word: searchWord, action }), [action, libraryId, searchWord])
  const records = useLearningRecords(filters, open)
  const libraryOptions = useMemo(() => [
    { value: ALL_LIBRARIES, label: '全部词库' },
    ...libraries.map(library => ({ value: library.id, label: getLabelById(library.id) })),
  ], [getLabelById, libraries])

  async function handleRemoveEvent(eventId: string) {
    if (await records.removeEvent(eventId)) onRecordsChanged()
  }

  async function handleClearWord(word: string) {
    if (await records.clearWord(word)) onRecordsChanged()
  }

  return (
    <Modal open={open} width="wide" title="学习记录管理"
      description="这里保存全部学习历史。删除学习列表中的单词或列表，不会影响这些记录。"
      onClose={onClose} footer={<Button onClick={onClose}>关闭</Button>}>
      <div className="learning-records__notice">
        删除这里的历史只会重新计算学习成果，不会删除学习列表中的单词，也不会改变当前复习计划。
      </div>

      <div className="learning-records__filters">
        <Input block value={searchInput} placeholder="搜索单词" aria-label="搜索学习记录中的单词"
          allowClear onClear={() => setSearchInput('')} onChange={event => setSearchInput(event.target.value)} />
        <Select value={libraryId} options={libraryOptions} onChange={setLibraryId} aria-label="按词库筛选学习记录" />
        <Select value={action} options={ACTION_OPTIONS}
          onChange={value => setAction(value as LearningRecordFilterAction)} aria-label="按标记筛选学习记录" />
      </div>

      {records.error && (
        <div className="callout callout--warn learning-records__error">
          <span>{records.error}</span><Button size="small" onClick={records.reload}>重新加载</Button>
        </div>
      )}
      {records.loading && (
        <p className="empty learning-records__loading"><span className="ui-spin" aria-hidden="true" />正在读取学习记录...</p>
      )}
      {!records.loading && !records.error && records.items.length === 0 && <p className="empty">没有符合条件的学习记录。</p>}

      {!records.loading && records.items.length > 0 && (
        <div className="learning-records__groups">
          {records.items.map(group => (
            <section className="learning-records__group" key={group.word}>
              <header className="learning-records__group-head">
                <div className="learning-records__group-main">
                  <strong className="learning-records__word">{group.word}</strong>
                  <div className="learning-records__tags">
                    {group.sourceIds.map(sourceId => <Tag key={sourceId} color="blue">{getLabelById(sourceId)}</Tag>)}
                  </div>
                </div>
                <div className="learning-records__summary" aria-label={`${group.word} 的统计`}>
                  <span>背过 {group.reviewCount}</span><span>记住 {group.rememberedCount}</span><span>没记住 {group.forgottenCount}</span>
                </div>
                <Popconfirm title={`清空 ${group.word} 的全部学习记录？`}
                  description="此操作会删除该单词的永久历史并重新计算成果，但不会影响学习列表和复习计划。"
                  okText="确认清空" danger placement="bottomRight" disabled={records.mutating}
                  onConfirm={() => { void handleClearWord(group.word) }}>
                  <Button size="small" type="text" danger disabled={records.mutating}>清空记录</Button>
                </Popconfirm>
              </header>

              <ol className="learning-records__timeline">
                {group.events.map(event => {
                  const detail = eventDescription(event)
                  return (
                    <li className="learning-records__event" key={event.id}>
                      <span className="learning-records__dot" aria-hidden="true" />
                      <div className="learning-records__event-content">
                        <span className="learning-records__event-action">{ACTION_LABELS[event.action] ?? event.action}</span>
                        <time dateTime={new Date(event.at).toISOString()}>{formatTime(event.at)}</time>
                        {detail && <span className="learning-records__event-detail">{detail}</span>}
                      </div>
                      <Popconfirm title="删除这条学习记录？"
                        description="删除后会重新计算该单词的成果，但不会改变当前复习计划。"
                        okText="确认删除" danger placement="bottomRight" disabled={records.mutating}
                        onConfirm={() => { void handleRemoveEvent(event.id) }}>
                        <Button size="small" type="text" danger disabled={records.mutating}>删除</Button>
                      </Popconfirm>
                    </li>
                  )
                })}
              </ol>
            </section>
          ))}
        </div>
      )}

      {!records.loading && records.items.length > 0 && (
        <div className="learning-records__more">
          <span>已显示 {records.items.length} / {records.total} 个单词</span>
          {records.hasMore && <Button loading={records.loadingMore} onClick={records.loadMore}>加载更多</Button>}
        </div>
      )}
    </Modal>
  )
}
