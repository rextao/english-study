import { useEffect, useMemo, useState } from 'react'
import type { StudyListApi } from '../hooks/useStudyList'
import { useDictBatch } from '../hooks/useDictBatch'
import { useDictPrefetch } from '../hooks/useDictPrefetch'
import type { StudyWordItem } from '../types/vocab'
import { PageHeader } from '../components/PageHeader'
import { SensePicker } from '../components/SensePicker'
import { Button, Checkbox, Input, Popconfirm, Popover, Tag } from '../ui'
import { pickSenses } from '../utils/flashcards'
import './ListsPage.css'

const DEFAULT_LIST_ID = 'default'

interface ListsPageProps {
  getLabelById: (id: string) => string
  study: StudyListApi
}

export function ListsPage({ getLabelById, study }: ListsPageProps) {
  const {
    lists, loading, createList, renameList, deleteList,
    fetchListWords, removeItem, removeItems, updateItemSenses,
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
    return () => { alive = false }
  }, [selectedId, fetchListWords])

  const current   = lists.find(l => l.id === selectedId)
  const isDefault = selectedId === DEFAULT_LIST_ID

  const visibleWords = useMemo(() => {
    const k = keyword.trim().toLowerCase()
    const sorted = [...words].sort((a, b) => b.addedAt - a.addedAt)
    return k ? sorted.filter(w => w.word.includes(k)) : sorted
  }, [words, keyword])

  // 选中项以列表里真实存在的词条为准：某个词被别处删掉后这里自动跟着消失
  const selectedWords = useMemo(
    () => words.filter(w => selected.has(w.word)).map(w => w.word),
    [words, selected],
  )
  const allVisibleSelected = visibleWords.length > 0 && visibleWords.every(w => selected.has(w.word))

  // 音标 / 释义来自词典缓存，列表本身只存要背的释义 id
  const wordTexts = useMemo(() => words.map(w => w.word), [words])
  const dict      = useDictBatch(wordTexts)
  const prefetch  = useDictPrefetch(dict.reload)

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

  /** 把缺音标 / 缺释义的词重新抓一遍，抓完自动刷新这一页的显示 */
  async function handleRepair() {
    setError('')
    setNotice('')
    const res = await prefetch.repair(wordTexts)
    if (!res.ok) { setError(res.error); return }
    // 一个词都没排队，说明这批词的音标和释义都已经在缓存里了
    if (res.queued === 0) setNotice('这个列表的音标和释义都是齐的，不用补')
  }

  /** 保存这个词这一阶段要背的释义 */
  async function handlePickSenses(text: string, senseIds: string[]) {
    setError('')
    const saved = await updateItemSenses(selectedId, text, senseIds)
    if (!saved) { setError('保存释义失败，请确认本地服务已启动'); return }
    setWords(prev => prev.map(w => (w.word === text ? saved : w)))
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
      {!error && notice && <div className="callout callout--success lists-alert">{notice}</div>}

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
            <Button
              size="small"
              loading={prefetch.busy}
              disabled={words.length === 0}
              title="把缺音标或缺英文释义的词重新抓一遍"
              onClick={handleRepair}
            >
              {prefetch.busy
                ? (prefetch.state.total > 0
                    ? '补齐中 ' + prefetch.state.done + '/' + prefetch.state.total
                    : '补齐中...')
                : dict.pending.length > 0 ? '补齐释义 ' + dict.pending.length : '补齐释义'}
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

      <ul className="word-rows">
        {visibleWords.map(item => {
          const entry = dict.getEntry(item.word)
          const picked = item.senseIds ?? []
          // 词条下面那句灰字：中文 + 这一阶段要背的英文释义
          const gloss = [entry?.translation, ...pickSenses(entry, picked)]
            .filter(Boolean).join(' · ')
          // 词 + 音标；多选模式下把它塞进勾选框的 label，点词本身也能勾上
          const head = (
            <>
              <span className="word-row__text">{item.word}</span>
              {entry?.phonetic && (
                <span className="word-row__phonetic">{entry.phonetic}</span>
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
                <Popover
                  wide
                  placement="bottomRight"
                  title={'要背的释义 · ' + item.word}
                  render={close => (
                    <SensePicker
                      entry={entry}
                      value={picked}
                      onSubmit={async ids => {
                        await handlePickSenses(item.word, ids)
                        close()
                      }}
                    />
                  )}
                >
                  <Button type="text" size="small" className="word-row__pick">
                    {picked.length > 0 ? '释义 ' + picked.length : '释义'}
                  </Button>
                </Popover>
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
              {gloss && <p className="word-row__gloss">{gloss}</p>}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
