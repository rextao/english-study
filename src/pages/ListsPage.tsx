import { useEffect, useMemo, useState } from 'react'
import type { StudyListApi } from '../hooks/useStudyList'
import { useDictBatch } from '../hooks/useDictBatch'
import type { StudyWordItem } from '../types/vocab'
import { PageHeader } from '../components/PageHeader'
import { formatTranslationOptions, selectedTranslationOptions } from '../utils/translations'
import { Button, Checkbox, Input, Popconfirm, Tag } from '../ui'
import './ListsPage.css'

const DEFAULT_LIST_ID = 'default'

function displayTextOf(item: StudyWordItem): string {
  return item.type === 'sentence' && item.displayText?.trim()
    ? item.displayText.trim()
    : item.word
}

/** 词条加入时间 → 自然日串，形如 2026-09-15（本地时区） */
const batchKeyOf = (ts: number) => {
  const d = new Date(ts)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return d.getFullYear() + '-' + mm + '-' + dd
}

/** 批次默认标题：同年显示月日，跨年补年份 */
function batchTitle(key: string): string {
  const [y, m, d] = key.split('-').map(Number)
  const sameYear = y === new Date().getFullYear()
  return sameYear ? m + ' 月 ' + d + ' 日' : y + ' 年 ' + m + ' 月 ' + d + ' 日'
}

interface ListsPageProps {
  getLabelById: (id: string) => string
  study: StudyListApi
}

export function ListsPage({ getLabelById, study }: ListsPageProps) {
  const {
    lists, loading, createList, renameList, deleteList,
    fetchListWords, removeItem, removeItems, fetchBatches, renameBatch,
  } = study

  const [selectedId, setSelectedId]     = useState(DEFAULT_LIST_ID)
  const [words, setWords]               = useState<StudyWordItem[]>([])
  const [wordsLoading, setWordsLoading] = useState(false)
  const [keyword, setKeyword]           = useState('')
  const [renaming, setRenaming]         = useState(false)
  const [draftName, setDraftName]       = useState('')
  const [adding, setAdding]             = useState(false)
  const [newListName, setNewListName]   = useState('')
  const [creating, setCreating]         = useState(false)
  const [error, setError]               = useState('')
  const [notice, setNotice]             = useState('')
  // 多选删除：平时关着，开了才在每行前面显示勾选框
  const [selectMode, setSelectMode]     = useState(false)
  const [selected, setSelected]         = useState<Set<string>>(new Set())
  const [removing, setRemoving]         = useState(false)

  // 批次展示：默认关闭保持平铺；batchNames 是各日期的显示名（可重命名）
  const [showBatches, setShowBatches]   = useState(false)
  const [batchNames, setBatchNames]     = useState<Record<string, string>>({})
  const [editingBatch, setEditingBatch] = useState<string | null>(null)
  const [batchDraft, setBatchDraft]     = useState('')
  // 已折叠的批次（日期串集合），点批次标题切换
  const [collapsed, setCollapsed]       = useState<Set<string>>(new Set())

  // 选中的列表被删掉后回退到默认列表
  useEffect(() => {
    if (lists.length > 0 && !lists.some(l => l.id === selectedId)) setSelectedId(DEFAULT_LIST_ID)
  }, [lists, selectedId])

  // 切换列表时拉取该列表的全部词条
  useEffect(() => {
    let alive = true
    setKeyword('')
    setNotice('')
    setRenaming(false)
    setSelectMode(false)
    setSelected(new Set())
    setWordsLoading(true)
    fetchListWords(selectedId).then(items => {
      if (!alive) return
      setWords(items)
      setWordsLoading(false)
    })
    // 词条一起拉批次显示名
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

  const visibleWords = useMemo(() => {
    const k = keyword.trim().toLowerCase()
    const sorted = [...words].sort((a, b) => b.addedAt - a.addedAt)
    return k ? sorted.filter(w => (
      w.word.toLowerCase().includes(k) || displayTextOf(w).toLowerCase().includes(k)
    )) : sorted
  }, [words, keyword])

  // 按导入日期分成批次：新日期在上，组内保持原来排序
  const visibleBatches = useMemo(() => {
    const groups = new Map<string, StudyWordItem[]>()
    for (const item of visibleWords) {
      const key = batchKeyOf(item.addedAt)
      const bucket = groups.get(key)
      if (bucket) bucket.push(item)
      else groups.set(key, [item])
    }
    return Array.from(groups.entries())
  }, [visibleWords])

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

  function closeCreate() {
    setAdding(false)
    setNewListName('')
  }

  async function handleCreate() {
    const name = newListName.trim()
    if (!name) return
    setCreating(true)
    setError('')
    const res = await createList(name)
    setCreating(false)
    if (!res.ok) { setError(res.error); return }
    closeCreate()
    setSelectedId(res.id)
  }

  async function handleRename() {
    if (!current) return
    const name = draftName.trim()
    setRenaming(false)
    if (!name || name === current.name) return
    setError('')
    const res = await renameList(current.id, name)
    if (!res.ok) setError(res.error)
  }

  async function handleDelete() {
    if (!current || isDefault) return
    setError('')
    const res = await deleteList(current.id)
    if (!res.ok) setError(res.error)
    else setSelectedId(DEFAULT_LIST_ID)
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

  /** 进入批次重命名编辑态：草稿默认填当前显示名（自定义名或日期本身） */
  function startBatchEdit(key: string) {
    setEditingBatch(key)
    setBatchDraft(batchNames[key] ?? batchTitle(key))
  }

  /** 提交批次重命名：没变就静默退出；清空 = 还原为最初的日期名称 */
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
    if (updated == null) { setError('批次重命名失败，请确认本地服务已启动'); return }
    setBatchNames(updated)
  }

  /** 点批次标题切换折叠；编辑重命名时不响应 */
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
          {item.type === 'sentence' && <Tag>句子</Tag>}
          {item.sourceIds.map(id => (
            <Tag key={id} color="blue">{getLabelById(id)}</Tag>
          ))}
          {/* 多选模式下藏掉单条的 ×，免得和勾选框抢操作 */}
          {!selectMode && (
            <Button
              className="word-row__remove"
              type="text"
              size="small"
              danger
              title="从该列表移除"
              aria-label="从该列表移除"
              onClick={() => handleRemoveWord(item.word)}
            >
              ×
            </Button>
          )}
        </div>
        <div className="word-row__detail">
          {translation && (
            <span className="word-row__translation">{translation}</span>
          )}
          <span
            className="word-row__stats"
            aria-label={'知意 ' + (item.rememberedCount ?? 0) + ' 次，会拼 ' + (item.spellingCount ?? 0) + ' 次，会读 ' + (item.readingCount ?? 0) + ' 次'}
          >
            知意 {item.rememberedCount ?? 0} · 会拼 {item.spellingCount ?? 0} · 会读 {item.readingCount ?? 0}
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
    if (!res) { setError('批量删除失败，请确认本地服务已启动'); return }
    const gone = new Set(selectedWords)
    const rest = words.filter(w => !gone.has(w.word))
    setWords(rest)
    setSelected(new Set())
    // 删空了就退出多选，不然会停在一个没东西可选的多选态里
    if (rest.length === 0) setSelectMode(false)
    setNotice('已删除 ' + res.removed + ' 条'
      + (res.missing > 0 ? '，另有 ' + res.missing + ' 条已经不在列表里' : ''))
  }

  return (
    <div className="page lists-page">
      <PageHeader
        title="学习列表"
        subtitle="选择一个列表查看它的全部词条，默认列表始终存在且不可删除"
      />

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
              <span className="lists-tab__count">{list.wordCount}</span>
            </button>
          ))}
        </div>

        {adding ? (
          <div className="lists-new">
            <Input
              className="lists-new__input"
              size="small"
              placeholder="列表名称..."
              value={newListName}
              autoFocus
              aria-label="新建列表名称"
              onChange={e => setNewListName(e.target.value)}
              onPressEnter={handleCreate}
              onKeyDown={e => { if (e.key === 'Escape') closeCreate() }}
            />
            <Button
              type="primary"
              size="small"
              disabled={!newListName.trim()}
              loading={creating}
              onClick={handleCreate}
            >
              确定
            </Button>
            <Button type="text" size="small" onClick={closeCreate}>取消</Button>
          </div>
        ) : (
          <Button size="small" onClick={() => setAdding(true)}>+ 新增列表</Button>
        )}
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
          {renaming ? (
            <Input
              className="lists-toolbar__rename"
              value={draftName}
              autoFocus
              aria-label="重命名列表"
              onFocus={e => e.currentTarget.select()}
              onChange={e => setDraftName(e.target.value)}
              onBlur={handleRename}
              onPressEnter={handleRename}
              onKeyDown={e => { if (e.key === 'Escape') setRenaming(false) }}
            />
          ) : (
            <h2 className="lists-toolbar__title">
              {current.name}
              {isDefault && <Tag color="blue">默认</Tag>}
              <span className="lists-toolbar__count">
                {keyword.trim() ? visibleWords.length + ' / ' + words.length + ' 条' : words.length + ' 条'}
              </span>
            </h2>
          )}

          <div className="lists-toolbar__actions">
            {/* Checkbox 组件不支持 title，用外层 span 提示 */}
            <span className="lists-toolbar__batch-toggle" title="按导入日期分组展示词条">
              <Checkbox
                checked={showBatches}
                onChange={e => setShowBatches(e.target.checked)}
              >
                批次
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
              onClick={() => { setDraftName(current.name); setRenaming(true) }}
            >
              重命名
            </Button>
            <Popconfirm
              title="删除这个列表？"
              description="列表里的词条会一起删除，且不可恢复"
              okText="删除"
              danger
              disabled={isDefault}
              placement="bottomRight"
              onConfirm={handleDelete}
            >
              <Button
                type="text"
                danger
                size="small"
                disabled={isDefault}
                title={isDefault ? '默认列表不可删除' : undefined}
              >
                删除
              </Button>
            </Popconfirm>
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
                  title={isCollapsed ? '展开批次' : '折叠批次'}
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
                      aria-label="重命名批次"
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
