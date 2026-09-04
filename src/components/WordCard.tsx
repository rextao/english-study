import { useEffect, useState } from 'react'
import { Button, Popover, Select, Tag } from '../ui'
import type { SelectOption } from '../ui'
import type { DictionaryEntry, StudyList } from '../types/vocab'
import type { DictionaryStatus } from '../hooks/useDictionary'
import type { StudyStatus } from '../hooks/useStudy'
import './WordCard.css'

interface WordCardProps {
  entry: DictionaryEntry | null
  status: DictionaryStatus
  sourceIds: string[]
  getLabelById: (id: string) => string
  studyStatus: StudyStatus
  studyListIds: string[]        // lists this word already belongs to
  lists: StudyList[]            // all available lists
  onCheckStudy: (word: string) => void
  /** 加入学习列表；要背的释义交给服务端自动挑（中文 + 第一条英文释义） */
  onAddToList: (listId: string) => Promise<void>
}

const FALLBACK_LIST: StudyList = { id: 'default', name: '默认列表', createdAt: 0, wordCount: 0 }

export function WordCard({
  entry, status, sourceIds, getLabelById,
  studyStatus, studyListIds, lists,
  onCheckStudy, onAddToList,
}: WordCardProps) {

  const [adding, setAdding] = useState(false)
  const [target, setTarget] = useState('')

  useEffect(() => {
    if (entry?.word) onCheckStudy(entry.word)
    setTarget('')
  }, [entry?.word])

  if (status === 'loading') {
    return (
      <div className="word-card word-card--loading">
        <span className="word-card__spinner" />
        <span>查询中...</span>
      </div>
    )
  }
  if (status === 'no-server') {
    return (
      <div className="word-card word-card--warn">
        本地服务未启动，请在项目目录运行 <code>npm run dev:all</code>
      </div>
    )
  }
  if (status === 'error' || (status === 'done' && !entry)) {
    return <div className="word-card word-card--empty">未找到该单词的释义</div>
  }
  if (!entry) return null

  const isChecking = studyStatus === 'checking'
  const availableLists = lists.length > 0 ? lists : [FALLBACK_LIST]
  const inAnyList = studyListIds.length > 0
  const joinedNames = studyListIds
    .map((id) => availableLists.find((list) => list.id === id)?.name ?? id)
    .join('、')

  const listOptions: SelectOption[] = availableLists.map((list) => ({
    value: list.id,
    label: list.name,
    extra: studyListIds.includes(list.id) ? '已加入' : list.wordCount + ' 条',
    disabled: studyListIds.includes(list.id),
  }))

  // 默认落在第一个还没加过的列表上
  const firstFree = availableLists.find((list) => !studyListIds.includes(list.id))
  const targetId = availableLists.some((list) => list.id === target)
    ? target
    : (firstFree ?? availableLists[0]).id
  const targetTaken = studyListIds.includes(targetId)

  async function handleAdd(close: () => void) {
    setAdding(true)
    await onAddToList(targetId)
    setAdding(false)
    close()
  }

  return (
    <div className="word-card">
      {/* 头部：左边是词，右上角是加入学习的小按钮 */}
      <div className="word-card__header">
        <div className="word-card__title">
          <span className="word-card__word">{entry.word}</span>
          {entry.phonetic && (
            <span className="word-card__phonetic">{entry.phonetic}</span>
          )}
          {entry.source && (
            <Tag
              color={entry.source === 'ecdict' ? 'green' : 'blue'}
              title={entry.source === 'ecdict'
                ? '释义来自本地 ECDICT 词典，查这个词没有联网'
                : '释义来自外部在线词典接口'}
            >
              {entry.source === 'ecdict' ? '本地词典' : '在线词典'}
            </Tag>
          )}
        </div>

        <Popover
          wide
          placement="bottomRight"
          title={'加入学习 · ' + entry.word}
          render={(close) => (
            <div className="word-card__add-panel">
              {/* 浮层只给音标 + 中文：不显示词性和英文释义，要背的释义交给服务端自动挑 */}
              <div className="word-card__add-brief">
                {entry.phonetic
                  ? <span className="word-card__add-phonetic">{entry.phonetic}</span>
                  : <span className="word-card__add-phonetic word-card__add-phonetic--none">音标待补齐</span>}
                <span className={entry.translation ? 'word-card__add-cn' : 'word-card__add-cn word-card__add-cn--none'}>
                  {entry.translation || '暂无中文释义'}
                </span>
              </div>

              {(!entry.phonetic || !entry.translation) && (
                <p className="hint word-card__add-tip">加入后会自动去补一次音标和中文。</p>
              )}

              <div className="word-card__pick-list">
                <span className="field-label">加到哪个列表</span>
                <Select
                  aria-label="加到哪个列表"
                  size="small"
                  value={targetId}
                  options={listOptions}
                  onChange={setTarget}
                />
              </div>

              <div className="word-card__add-actions">
                <Button size="small" onClick={close}>取消</Button>
                <Button
                  type="primary"
                  size="small"
                  loading={adding}
                  disabled={targetTaken}
                  onClick={() => { void handleAdd(close) }}
                >
                  {targetTaken ? '已在这个列表' : '加入学习'}
                </Button>
              </div>
            </div>
          )}
        >
          <Button
            size="small"
            type={inAnyList ? 'default' : 'primary'}
            loading={adding || isChecking}
            className={inAnyList ? 'word-card__add word-card__add--done' : 'word-card__add'}
            title={inAnyList ? '已在：' + joinedNames : '加入学习列表'}
            aria-label="加入学习列表"
          >
            {inAnyList ? '✓ 已加入' : '+ 学习'}
          </Button>
        </Popover>
      </div>

      {/* 词库标签紧跟在词下面，命中词库才显示；这里只展示，改名统一去词库页 */}
      {sourceIds.length > 0 && (
        <div className="word-card__tags">
          {sourceIds.map((id) => (
            <Tag key={id} color="blue" title="词库标签，改名请去「词库」页">{getLabelById(id)}</Tag>
          ))}
        </div>
      )}

      {entry.translation && (
        <p className="word-card__translation">{entry.translation}</p>
      )}
    </div>
  )
}
