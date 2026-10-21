import { useEffect, useMemo, useState } from 'react'
import type { StudyListApi } from '../hooks/useStudyList'
import { useDictBatch } from '../hooks/useDictBatch'
import type { StudyWordItem } from '../types/vocab'
import type { VocabLibraryInfo } from '../types/vocab'
import { PageHeader } from '../components/PageHeader'
import { formatTranslationOptions, selectedTranslationOptions } from '../utils/translations'
import { Button, Checkbox, Input, Popconfirm, Select, Tag } from '../ui'
import type { SelectOption } from '../ui'
import { primaryVocabIdForWord } from '../utils/vocabOrder'
import './ListsPage.css'

const DEFAULT_LIST_ID = 'default'

function displayTextOf(item: StudyWordItem): string {
  return item.type === 'sentence' && item.displayText?.trim()
    ? item.displayText.trim()
    : item.word
}

/** 熟悉度小标签：会拼 / 会读 / 知意，0 次的一并列出但压成更淡的字色 */
function tallyChipsOf(item: StudyWordItem) {
  return [
    { key: 'spelling', label: '会拼', count: item.spellingCount ?? 0 },
    { key: 'reading', label: '会读', count: item.readingCount ?? 0 },
    { key: 'meaning', label: '知意', count: item.rememberedCount ?? 0 },
  ]
}

/** 词条加入时间 → 自然日串，形如 2026-09-15（本地时区） */
const batchKeyOf = (ts: number) => {
  const d = new Date(ts)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return d.getFullYear() + '-' + mm + '-' + dd
}

/** 分组默认标题：同年显示月日，跨年补年份 */
function batchTitle(key: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return '自定义分组'
  const [y, m, d] = key.split('-').map(Number)
  const sameYear = y === new Date().getFullYear()
  return sameYear ? m + ' 月 ' + d + ' 日' : y + ' 年 ' + m + ' 月 ' + d + ' 日'
}

/** 分组键对应的创建时间；按分组自身排序，避免移动词条后分组顺序被词条加入时间带偏。 */
function batchSortTs(key: string): number {
  const custom = /^b:(\d+)-/.exec(key)
  if (custom) return Number(custom[1])
  if (/^\d{4}-\d{2}-\d{2}$/.test(key)) {
    const [y, m, d] = key.split('-').map(Number)
    return new Date(y, m - 1, d).getTime()
  }
  return 0
}

interface ListsPageProps {
  libraries: VocabLibraryInfo[]
  getLabelById: (id: string) => string
  study: StudyListApi
  /** 点「新增 / 重命名列表」跳到设置页的「学习列表」分区统一管理 */
  onManageLists: () => void
}

export function ListsPage({ libraries, getLabelById, study, onManageLists }: ListsPageProps) {
  const {
    lists, loading,
    fetchListWords, removeItem, removeItems, fetchBatches, renameBatch, moveItemBatch,
  } = study

  const [selectedId, setSelectedId]     = useState(DEFAULT_LIST_ID)
  const [words, setWords]               = useState<StudyWordItem[]>([])
  const [wordsLoading, setWordsLoading] = useState(false)
  const [keyword, setKeyword]           = useState('')
  const [error, setError]               = useState('')
  const [notice, setNotice]             = useState('')
  // 多选删除：平时关着，开了才在每行前面显示勾选框
  const [selectMode, setSelectMode]     = useState(false)
  const [selected, setSelected]         = useState<Set<string>>(new Set())
  const [removing, setRemoving]         = useState(false)

  // 分组展示：默认关闭保持平铺；batchNames 是各日期的显示名（可重命名）
  const [showBatches, setShowBatches]   = useState(true)
  const [batchNames, setBatchNames]     = useState<Record<string, string>>({})
  const [editingBatch, setEditingBatch] = useState<string | null>(null)
  const [batchDraft, setBatchDraft]     = useState('')
  // 已折叠的分组（日期串集合），点分组标题切换
  const [collapsed, setCollapsed]       = useState<Set<string>>(new Set())
  const [moveBatchKey, setMoveBatchKey] = useState('')
  const [moving, setMoving]             = useState(false)

  // 选中的列表被删掉后回退到默认列表
  useEffect(() => {
    if (lists.length > 0 && !lists.some(l => l.id === selectedId)) setSelectedId(DEFAULT_LIST_ID)
  }, [lists, selectedId])

  // 切换列表时拉取该列表的全部词条
  useEffect(() => {
    let alive = true
    setKeyword('')
    setNotice('')
    setSelectMode(false)
    setSelected(new Set())
    setWordsLoading(true)
    fetchListWords(selectedId).then(items => {
      if (!alive) return
      setWords(items)
      setWordsLoading(false)
    })
    // 词条一起拉分组显示名
    fetchBatches(selectedId).then(names => {
      if (!alive) return
      setBatchNames(names)
      setEditingBatch(null)
      setBatchDraft('')
      setCollapsed(new Set())
    })
    return () => { alive = false }
  }, [selectedId, fetchListWords, fetchBatches])

  // 删除成功只做短暂提示，不占用页面内容区域。
  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(''), 2600)
    return () => window.clearTimeout(timer)
  }, [notice])

  const current   = lists.find(l => l.id === selectedId)
  const isDefault = selectedId === DEFAULT_LIST_ID
  const currentWordCount = words.filter(item => item.type === 'word').length

  const visibleWords = useMemo(() => {
    const k = keyword.trim().toLowerCase()
    const sorted = [...words].sort((a, b) => b.addedAt - a.addedAt)
    return k ? sorted.filter(w => (
      w.word.toLowerCase().includes(k) || displayTextOf(w).toLowerCase().includes(k)
    )) : sorted
  }, [words, keyword])

  // 按导入日期分成分组：新日期在上，组内保持原来排序
  const visibleBatches = useMemo(() => {
    const groups = new Map<string, StudyWordItem[]>()
    for (const item of visibleWords) {
      const key = item.batchKey || batchKeyOf(item.addedAt)
      const bucket = groups.get(key)
      if (bucket) bucket.push(item)
      else groups.set(key, [item])
    }
    return Array.from(groups.entries()).sort(([a], [b]) => {
      const timeDiff = batchSortTs(b) - batchSortTs(a)
      return timeDiff || b.localeCompare(a)
    })
  }, [visibleWords])

  const batchOptions = useMemo<SelectOption[]>(() => {
    const keys = new Set<string>()
    for (const item of words) keys.add(item.batchKey || batchKeyOf(item.addedAt))
    return Array.from(keys).map(key => ({
      value: key,
      label: batchNames[key] || batchTitle(key),
      extra: words.filter(item => (item.batchKey || batchKeyOf(item.addedAt)) === key).length + ' 条',
    }))
  }, [words, batchNames])

  // 选中项以列表里真实存在的词条为准：某个词被别处删掉后这里自动跟着消失
  const selectedWords = useMemo(
    () => words.filter(w => selected.has(w.word)).map(w => w.word),
    [words, selected],
  )
  const allVisibleSelected = visibleWords.length > 0 && visibleWords.every(w => selected.has(w.word))

  // 新数据优先用加入列表时保存的快照，旧数据再回退词典缓存
  const wordTexts = useMemo(() => words.map(w => w.word), [words])
  const dict      = useDictBatch(wordTexts)

  function selectedTranslation(item: StudyWordItem) {
    if (item.translation) return item.translation
    const entry = dict.getEntry(item.word)
    if (item.translationIds?.length && entry?.translations) {
      const selected = selectedTranslationOptions(entry.translations, item.translationIds)
      if (selected.length > 0) return formatTranslationOptions(selected)
    }
    return entry?.translation
  }

  async function handleRemoveWord(text: string) {
    const ok = await removeItem(selectedId, text)
    if (ok) setWords(prev => prev.filter(w => w.word !== text))
  }

  /** 进出多选模式都把已选清空，避免退出后偷偷留着一批选中项 */
  function toggleSelectMode() {
    setSelected(new Set())
    setSelectMode(prev => !prev)
  }

  /** 进入分组重命名编辑态：草稿默认填当前显示名（自定义名或日期本身） */
  function startBatchEdit(key: string) {
    setEditingBatch(key)
    setBatchDraft(batchNames[key] ?? batchTitle(key))
  }

  /** 提交分组重命名：没变就静默退出；清空 = 还原为最初的日期名称 */
  async function handleBatchEdit() {
    const key = editingBatch
    setEditingBatch(null)
    if (!key) return
    const name = batchDraft.trim()
    const original = batchNames[key] ?? batchTitle(key)
    if (name === original) return
    setError('')
    // 空名由服务端还原为日期；传原名外的新名才是自定义名
    const updated = await renameBatch(selectedId, key, name)
    if (updated == null) { setError('分组重命名失败，请确认云端服务可用'); return }
    setBatchNames(updated)
  }

  /** 复制当前分组里的英文单词；句子不作为单词复制，词之间用英文逗号分隔。 */
  async function copyBatchWords(items: StudyWordItem[]) {
    const wordsToCopy = items
      .filter(item => item.type === 'word')
      .map(item => item.word.trim())
      .filter(Boolean)
    if (wordsToCopy.length === 0) return
    try {
      await navigator.clipboard.writeText(wordsToCopy.join(', '))
      setNotice('已复制 ' + wordsToCopy.length + ' 个单词')
      setError('')
    } catch {
      setError('复制失败，请检查浏览器剪贴板权限')
    }
  }

  /** 点分组标题切换折叠；编辑重命名时不响应 */
  function toggleCollapsed(key: string) {
    if (editingBatch === key) return
    setCollapsed(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function renderRow(item: StudyWordItem) {
    const entry = dict.getEntry(item.word)
    const translation = selectedTranslation(item)
    const phonetic = item.phonetic || entry?.phonetic
    const tallies = tallyChipsOf(item)
    // 词 + 音标；多选模式下把它塞进勾选框的 label，点词本身也能勾上
    const head = (
      <>
        <span className="word-row__text">{displayTextOf(item)}</span>
        {phonetic && (
          <span className="word-row__phonetic">{phonetic}</span>
        )}
      </>
    )
    return (
      <li key={item.word} className="word-row">
        <div className="word-row__main">
          {selectMode ? (
            <Checkbox
              className="word-row__check"
              checked={selected.has(item.word)}
              onChange={e => toggleWord(item.word, e.target.checked)}
            >
              {head}
            </Checkbox>
          ) : (
            <span className="word-row__head">{head}</span>
          )}
          {/* 标签（句子 / 词库）固定在首行最右侧，不与单词或音标互相挤压 */}
          <span className="word-row__tags">
            {item.type === 'sentence' && <Tag>句子</Tag>}
            {primaryVocabIdForWord(item.word, item.sourceIds, libraries) && (
              <Tag color="blue">{getLabelById(primaryVocabIdForWord(item.word, item.sourceIds, libraries)!)}</Tag>
            )}
          </span>
          {/* 多选模式下藏掉单条的 ×，免得和勾选框抢操作 */}
          {!selectMode && (
            <Popconfirm
              title={'从列表移除「' + displayTextOf(item) + '」？'}
              description="只从这个列表移除，其他列表和词典缓存不受影响，但不可恢复"
              okText="移除"
              danger
              placement="bottomRight"
              onConfirm={() => { void handleRemoveWord(item.word) }}
            >
              <Button
                className="word-row__remove"
                type="text"
                size="small"
                danger
                title="从该列表移除"
                aria-label={'从该列表移除 ' + displayTextOf(item)}
              >
                ×
              </Button>
            </Popconfirm>
          )}
        </div>
        <div className="word-row__detail">
          {translation && (
            <span className="word-row__translation">{translation}</span>
          )}
          <span
            className="word-row__tallies"
            aria-label={tallies.map(t => t.label + ' ' + t.count + ' 次').join('，')}
          >
            {tallies.map(t => (
              <span
                key={t.key}
                className={'word-row__tally' + (t.count === 0 ? ' word-row__tally--zero' : '')}
              >
                {t.label} {t.count}
              </span>
            ))}
          </span>
        </div>
      </li>
    )
  }

  function toggleWord(text: string, checked: boolean) {
    setSelected(prev => {
      const next = new Set(prev)
      if (checked) next.add(text)
      else next.delete(text)
      return next
    })
  }

  /** 全选 / 取消全选只作用于当前筛选出来的这些词条 */
  function toggleAllVisible(checked: boolean) {
    setSelected(prev => {
      const next = new Set(prev)
      for (const item of visibleWords) {
        if (checked) next.add(item.word)
        else next.delete(item.word)
      }
      return next
    })
  }

  /** 批量删除：一次请求删掉所有选中的词条 */
  async function handleRemoveSelected() {
    if (selectedWords.length === 0) return
    setError('')
    setNotice('')
    setRemoving(true)
    const res = await removeItems(selectedId, selectedWords)
    setRemoving(false)
    if (!res) { setError('批量删除失败，请确认云端服务可用'); return }
    const gone = new Set(selectedWords)
    const rest = words.filter(w => !gone.has(w.word))
    setWords(rest)
    setSelected(new Set())
    // 删空了就退出多选，不然会停在一个没东西可选的多选态里
    if (rest.length === 0) setSelectMode(false)
    setNotice('已删除 ' + res.removed + ' 条'
      + (res.missing > 0 ? '，另有 ' + res.missing + ' 条已经不在列表里' : ''))
  }

  /** 将多选词条移动到指定分组，只修改分组归属。 */
  async function handleMoveSelected() {
    if (!moveBatchKey || selectedWords.length === 0) return
    setMoving(true)
    setError('')
    const batchName = batchNames[moveBatchKey]
    const results = await Promise.all(selectedWords.map(word => (
      moveItemBatch(selectedId, word, moveBatchKey, batchName)
    )))
    setMoving(false)
    if (results.some(ok => !ok)) {
      setError('移动分组失败，请确认云端服务可用')
      return
    }
    const [updatedWords, updatedNames] = await Promise.all([
      fetchListWords(selectedId),
      fetchBatches(selectedId),
    ])
    setWords(updatedWords)
    setBatchNames(updatedNames)
    setSelected(new Set())
    setMoveBatchKey('')
    setNotice('已移动 ' + selectedWords.length + ' 条到「' + (batchName || batchTitle(moveBatchKey)) + '」')
  }

  return (
    <div className="page lists-page">
      <PageHeader title="学习列表"
        actions={<Button size="small" onClick={onManageLists}>+ 新增列表</Button>} />

      <div className="lists-bar">
        <div className="lists-tabs" role="group" aria-label="选择要查看的列表">
          {lists.map(list => (
            <button
              key={list.id}
              type="button"
              aria-pressed={list.id === selectedId}
              className={'lists-tab' + (list.id === selectedId ? ' lists-tab--active' : '')}
              onClick={() => setSelectedId(list.id)}
            >
              {list.name}
              <span className="lists-tab__count">{list.wordCount} 个词</span>
            </button>
          ))}
        </div>
      </div>

      {error && <div className="callout callout--error lists-alert">{error}</div>}
      {!error && notice && (
        <div className="lists-toast" role="status" aria-live="polite">
          <span className="lists-toast__mark" aria-hidden="true">✓</span>
          <span>{notice}</span>
        </div>
      )}

      {loading && <p className="empty">加载中...</p>}
      {!loading && lists.length === 0 && <p className="empty">还没有任何学习列表</p>}

      {current && (
        <div className="lists-toolbar">
          <h2 className="lists-toolbar__title">
            {current.name}
            {isDefault && <Tag color="blue">默认</Tag>}
            <span className="lists-toolbar__count">
              {currentWordCount + ' · ' + current.wordCount}
            </span>
          </h2>

          <div className="lists-toolbar__actions">
            {/* Checkbox 组件不支持 title，用外层 span 提示 */}
            <span className="lists-toolbar__batch-toggle" title="按导入日期分组展示词条">
              <Checkbox
                checked={showBatches}
                onChange={e => setShowBatches(e.target.checked)}
              >
                分组
              </Checkbox>
            </span>
            <Input
              className="lists-toolbar__filter"
              size="small"
              placeholder="筛选词条..."
              value={keyword}
              aria-label="筛选词条"
              allowClear
              onClear={() => setKeyword('')}
              onChange={e => setKeyword(e.target.value)}
            />
            <Button
              size="small"
              aria-pressed={selectMode}
              disabled={words.length === 0}
              title="勾选多个词条后一次删除"
              onClick={toggleSelectMode}
            >
              {selectMode ? '退出多选' : '多选'}
            </Button>
            <Button
              size="small"
              onClick={onManageLists}
            >
              重命名
            </Button>
          </div>
        </div>
      )}

      {current && selectMode && (
        <div className="lists-select">
          <Checkbox
            checked={allVisibleSelected}
            onChange={e => toggleAllVisible(e.target.checked)}
          >
            {allVisibleSelected ? '取消全选' : '全选'}
            {keyword.trim() ? '（当前筛选出的 ' + visibleWords.length + ' 条）' : ''}
          </Checkbox>
          <span className="lists-select__count">已选 {selectedWords.length} 条</span>
          <Select
            className="lists-select__move"
            size="small"
            value={moveBatchKey}
            options={batchOptions}
            placeholder="移动到分组"
            aria-label="移动到分组"
            disabled={selectedWords.length === 0 || moving}
            onChange={setMoveBatchKey}
          />
          <Button
            size="small"
            loading={moving}
            disabled={selectedWords.length === 0 || !moveBatchKey}
            onClick={() => void handleMoveSelected()}
          >
            移动
          </Button>
          <Popconfirm
            title={'删除选中的 ' + selectedWords.length + ' 条？'}
            description="只从这个列表移除，其他列表和词典缓存不受影响，但不可恢复"
            okText="删除"
            danger
            disabled={selectedWords.length === 0}
            placement="bottomRight"
            onConfirm={handleRemoveSelected}
          >
            <Button
              type="primary"
              size="small"
              danger
              loading={removing}
              disabled={selectedWords.length === 0}
            >
              删除选中
            </Button>
          </Popconfirm>
        </div>
      )}

      {current && wordsLoading && <p className="empty">加载词条中...</p>}
      {current && !wordsLoading && visibleWords.length === 0 && (
        <p className="empty">
          {words.length === 0 ? '这个列表还是空的，去搜索页或批量导入添加词条' : '没有匹配的词条'}
        </p>
      )}

      {showBatches ? (
        <div className="word-batches">
          {visibleBatches.map(([key, items]) => {
            const isCollapsed = collapsed.has(key)
            return (
              <div key={key} className="word-batch">
                <div
                  className={'word-batch__head' + (isCollapsed ? ' word-batch__head--collapsed' : '')}
                  role="button"
                  tabIndex={0}
                  aria-expanded={!isCollapsed}
                  title={isCollapsed ? '展开分组' : '折叠分组'}
                  onClick={() => toggleCollapsed(key)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      toggleCollapsed(key)
                    }
                  }}
                >
                  {editingBatch === key ? (
                    <Input
                      className="word-batch__draft"
                      size="small"
                      value={batchDraft}
                      autoFocus
                      onFocus={e => e.currentTarget.select()}
                      aria-label="重命名分组"
                      onChange={e => setBatchDraft(e.target.value)}
                      onBlur={handleBatchEdit}
                      onPressEnter={handleBatchEdit}
                      onKeyDown={e => { if (e.key === 'Escape') setEditingBatch(null) }}
                    />
                  ) : (
                    <>
                      <span className="word-batch__chevron" aria-hidden="true">{isCollapsed ? '▸' : '▾'}</span>
                      <span className="word-batch__name">{batchNames[key] || batchTitle(key)}</span>
                      <span className="word-batch__count">加入 · {items.length} 个词</span>
                      <Button
                        className="word-batch__copy"
                        type="link"
                        size="small"
                        disabled={!items.some(item => item.type === 'word')}
                        onClick={e => { e.stopPropagation(); void copyBatchWords(items) }}
                      >
                        复制
                      </Button>
                      <Button
                        className="word-batch__rename"
                        type="link"
                        size="small"
                        onClick={e => { e.stopPropagation(); startBatchEdit(key) }}
                      >
                        重命名
                      </Button>
                    </>
                  )}
                </div>
                {!isCollapsed && (
                  <ul className="word-rows">
                    {items.map(item => renderRow(item))}
                  </ul>
                )}
              </div>
            )
          })}
        </div>
      ) : (
        <ul className="word-rows">
          {visibleWords.map(item => renderRow(item))}
        </ul>
      )}
    </div>
  )
}
