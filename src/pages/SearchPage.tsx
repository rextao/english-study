import { useState, useEffect, useRef } from 'react'
import { useDictionary } from '../hooks/useDictionary'
import { useVocabMatch } from '../hooks/useSearch'
import { useStudy } from '../hooks/useStudy'
import type { StudyListApi } from '../hooks/useStudyList'
import { WordCard } from '../components/WordCard'
import { ImportPage } from './ImportPage'
import { Button, Input, Select, Tag } from '../ui'
import type { SelectOption } from '../ui'
import type { VocabLibrary } from '../types/vocab'
import type { StudyWordItem } from '../types/vocab'
import { formatTranslationWithCustom, selectedTranslationOptions } from '../utils/translations'
import './SearchPage.css'

/** 空状态下给的示例词，点一下直接查 */
const EXAMPLES = ['apple', 'weather', 'promise', 'decide', 'journey']

function capitalizeSentence(input: string): string {
  return input.trim().replace(/\s+/g, ' ').replace(/[A-Za-z]/, letter => letter.toUpperCase())
}

/** 从自定义分组键 b:时间戳-随机 里取出时间戳，用于把分组按新建时间倒序排 */
const batchKeyTs = (key: string): number => {
  const m = /^b:(\d+)-/.exec(key)
  return m ? Number(m[1]) : 0
}

/** 词条加入时间 → 自然日分组键，形如 2026-10-12（本地时区），与学习列表分组键一致 */
const dayBatchKey = (ts: number): string => {
  const d = new Date(ts)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return d.getFullYear() + '-' + mm + '-' + dd
}

/** 分组键是不是自然日（否则就是自定义分组 b:...） */
const isDateKey = (key: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(key)

/** 自然日分组键 → 当天 0 点时间戳，用于按时间排序 */
const dateKeyTs = (key: string): number => {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, m - 1, d).getTime()
}

/** 分组下拉里一个键显示成什么：自定义名 > 自然日（今天/昨天标注）> 自定义分组 */
function batchKeyLabel(key: string, names: Record<string, string>): string {
  if (names[key]) return names[key]
  if (!isDateKey(key)) return '自定义分组'
  const [y, m, d] = key.split('-').map(Number)
  const now = new Date()
  now.setHours(0, 0, 0, 0)
  const that = new Date(y, m - 1, d).getTime()
  const diff = Math.round((now.getTime() - that) / 86400000)
  const sameYear = y === now.getFullYear()
  const base = sameYear ? (m + ' 月 ' + d + ' 日') : (y + ' 年 ' + m + ' 月 ' + d + ' 日')
  if (diff === 0) return base + '（今天）'
  if (diff === 1) return base + '（昨天）'
  return base
}

const searchIcon = (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.6" />
    <path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
)

interface SearchPageProps {
  libraries: VocabLibrary[]
  getLabelById: (id: string) => string
  study: StudyListApi
  /** 点「+ 新建列表」跳到设置页的学习列表分区统一管理 */
  onManageLists: () => void
}

export function SearchPage({ libraries, getLabelById, study, onManageLists }: SearchPageProps) {
  const [input, setInput] = useState('')
  const [mode, setMode] = useState<'search' | 'import'>('search')
  const { entry, status, lookup, cancelLookup } = useDictionary()
  const { getSourceIds } = useVocabMatch(libraries)
  const { getStatus, getListIds, checkWord, markAdded } = useStudy()
  const { lists, addItem, fetchListWords, updateItemTranslations, fetchBatches } = study
  const [targetList, setTargetList] = useState('default')
  const [targetItem, setTargetItem] = useState<StudyWordItem | null>(null)
  // 分组选择：默认今天的自然日分组键；也可选任意已有分组（自然日或自定义 b:...）
  const [batchChoice, setBatchChoice] = useState(() => dayBatchKey(Date.now()))
  const [batchNames, setBatchNames] = useState<Record<string, string>>({})
  const [listBatchKeys, setListBatchKeys] = useState<Set<string>>(new Set())
  const [addingBatch, setAddingBatch] = useState(false)
  const [newBatchName, setNewBatchName] = useState('')
  // 新建但还没落盘的分组：第一次加词时随词一起写名字到服务端
  const [pendingBatch, setPendingBatch] = useState<{ key: string; name: string } | null>(null)
  const [batchRefresh, setBatchRefresh] = useState(0)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  function updateInput(value: string) {
    cancelLookup(Boolean(value.trim()))
    setInput(value)
  }

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    const trimmed = input.trim()
    if (!trimmed) return
    const sourceIds = getSourceIds(trimmed)
    const query = sourceIds.length === 0 && /\s/.test(trimmed) ? capitalizeSentence(trimmed) : trimmed
    timerRef.current = setTimeout(() => { lookup(query) }, 400)
    return () => { if (timerRef.current) clearTimeout(timerRef.current) }
  }, [input, lookup, getSourceIds])

  const sourceIds   = entry ? getSourceIds(entry.word) : []
  const studyStatus = entry ? getStatus(entry.word) : 'unknown'
  const studyListIds = entry ? getListIds(entry.word) : []

  useEffect(() => {
    let alive = true
    if (!entry?.word) {
      setTargetItem(null)
      return () => { alive = false }
    }
    setTargetItem(null)
    fetchListWords(targetList).then(items => {
      if (!alive) return
      const normalized = entry.word.trim().toLowerCase()
      setTargetItem(items.find(item => item.word === normalized) ?? null)
    })
    return () => { alive = false }
  }, [entry?.word, targetList, fetchListWords])

  // 列表被删除后回到默认列表；服务还没返回列表时也先保留默认值。
  useEffect(() => {
    if (lists.length > 0 && !lists.some(list => list.id === targetList)) setTargetList('default')
  }, [lists, targetList])

  // 拉取目标列表的分组显示名 + 词条上出现过的全部分组键（自然日 + 自定义，供下拉列出）
  useEffect(() => {
    let alive = true
    fetchBatches(targetList).then(names => { if (alive) setBatchNames(names) })
    fetchListWords(targetList).then(items => {
      if (!alive) return
      const keys = new Set<string>()
      for (const it of items) keys.add(it.batchKey || dayBatchKey(it.addedAt))
      setListBatchKeys(keys)
    })
    return () => { alive = false }
  }, [targetList, fetchBatches, fetchListWords, batchRefresh])

  // 切换目标列表时把分组选择重置回今天，避免把 A 列表的分组键带到 B 列表
  useEffect(() => {
    setBatchChoice(dayBatchKey(Date.now()))
    setPendingBatch(null)
    setAddingBatch(false)
    setNewBatchName('')
  }, [targetList])

  const listOptions: SelectOption[] = lists.length > 0
    ? lists.map(list => ({ value: list.id, label: list.name, extra: list.wordCount + ' 条' }))
    : [{ value: 'default', label: '默认列表' }]

  // 下拉可选分组 = 当前列表下的全部分组：分组名表 ∪ 词条上出现过的键 ∪ 今天，按时间倒序；
  // 未保存的新分组置顶，其余（含自然日分组）都能选来导入
  const batchOptions: SelectOption[] = (() => {
    const keys = new Set<string>()
    for (const k of Object.keys(batchNames)) keys.add(k)
    listBatchKeys.forEach(k => keys.add(k))
    keys.add(dayBatchKey(Date.now()))
    if (pendingBatch) keys.delete(pendingBatch.key)
    const sortTs = (k: string) => k.startsWith('b:') ? batchKeyTs(k) : isDateKey(k) ? dateKeyTs(k) : 0
    const sorted = Array.from(keys).sort((a, b) => sortTs(b) - sortTs(a))
    return [
      ...(pendingBatch ? [{ value: pendingBatch.key, label: pendingBatch.name + '（未保存）' }] : []),
      ...sorted.map(k => ({ value: k, label: batchKeyLabel(k, batchNames) })),
    ]
  })()

  /** 确认新建分组：先在本地生成键，等第一次加词时把名字落盘 */
  function confirmNewBatch() {
    const name = newBatchName.trim()
    if (!name) return
    const key = 'b:' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)
    setPendingBatch({ key, name })
    setBatchChoice(key)
    setAddingBatch(false)
    setNewBatchName('')
  }
  function closeNewBatch() {
    setAddingBatch(false)
    setNewBatchName('')
  }

  async function handleAddToList(translationIds: string[], customTranslations: string[]) {
    if (!entry) return
    if (targetItem) {
      const mergedIds = Array.from(new Set([
        ...(targetItem.translationIds ?? []),
        ...translationIds,
      ]))
      const mergedCustoms = Array.from(new Set([
        ...(targetItem.customTranslations ?? []),
        ...customTranslations,
      ]))
      const translation = formatTranslationWithCustom(
        selectedTranslationOptions(entry.translations ?? [], mergedIds),
        mergedCustoms,
      ) || targetItem.translation || entry.translation || ''
      const updated = await updateItemTranslations(
        targetList, entry.word, mergedIds, translation, mergedCustoms,
      )
      if (updated) {
        setTargetItem(updated)
        markAdded(entry.word, targetList)
      }
      return
    }
    const translation = formatTranslationWithCustom(
      selectedTranslationOptions(entry.translations ?? [], translationIds),
      customTranslations,
    ) || entry.translation || ''
    const text = entry.displayText || entry.word
    const result = await addItem(
      targetList, text, sourceIds, undefined, translationIds, translation, entry.phonetic,
      customTranslations,
      batchChoice || undefined,
      pendingBatch && pendingBatch.key === batchChoice ? pendingBatch.name : undefined,
    )
    if (result.ok) {
      markAdded(entry.word, targetList)
      // 分组名已随这次加词落盘；清掉未保存标记并重新拉取分组列表
      if (batchChoice) { setPendingBatch(null); setBatchRefresh(n => n + 1) }
      setTargetItem(result.item ?? {
        word: entry.word.trim().toLowerCase(),
        ...(sourceIds.length === 0 && /\s/.test(entry.word)
          ? { displayText: capitalizeSentence(entry.displayText || entry.word) }
          : {}),
        type: sourceIds.length === 0 && /\s/.test(entry.word) ? 'sentence' : 'word',
        sourceIds,
        addedAt: Date.now(),
        phonetic: entry.phonetic,
        translation: translation || undefined,
        translationIds,
        customTranslations,
        batchKey: batchChoice || undefined,
      })
    }
  }

  // 分组选择器：挪进词卡里，点「+ 学习」前先挑分组（和学习列表的分组一致）
  const batchPicker = (
    <div className="word-card__batch">
      <span className="field-label">加入分组</span>
      <Select aria-label="选择分组" size="small" block={false} value={batchChoice} options={batchOptions} onChange={setBatchChoice} />
      {!addingBatch ? (
        <Button size="small" onClick={() => setAddingBatch(true)}>+ 新建分组</Button>
      ) : (
        <span className="word-card__batch-new">
          <Input className="word-card__batch-input" size="small" placeholder="分组名称..." value={newBatchName} autoFocus aria-label="新建分组名称" onChange={e => setNewBatchName(e.target.value)} onPressEnter={confirmNewBatch} onKeyDown={e => { if (e.key === 'Escape') closeNewBatch() }} />
          <Button type="primary" size="small" disabled={!newBatchName.trim()} onClick={confirmNewBatch}>确定</Button>
          <Button type="text" size="small" onClick={closeNewBatch}>取消</Button>
        </span>
      )}
    </div>
  )

  return (
    <div className="page search-page">
      <div className="search-hero">
        <button
          type="button"
          className="search-hero__toggle"
          aria-label={mode === 'search' ? '切换到批量导入' : '返回查词'}
          onClick={() => setMode(mode === 'search' ? 'import' : 'search')}
        >
          {mode === 'search' ? '批量导入' : '← 返回查询'}
        </button>
        <h1 className="search-hero__title">{mode === 'search' ? '查询' : '批量导入'}</h1>
        {mode === 'search' && (
          <div className="search-target">
              <Select
                aria-label="选择学习列表"
                size="small"
                value={targetList}
                options={listOptions}
                onChange={setTargetList}
              />
          </div>
        )}
      </div>

      {mode === 'search' ? (
        <div className="search-main">
      <div className="search-bar">
        <Input
          size="large"
          block
          type="text"
          prefix={searchIcon}
          placeholder="输入单词..."
          aria-label="搜索单词"
          value={input}
          onChange={(e) => updateInput(e.target.value)}
          allowClear
          onClear={() => updateInput('')}
          autoFocus
          spellCheck={false}
        />
      </div>

      {!input.trim() && (
        <div className="search-hints">
          <span className="search-hints__label">试试</span>
          {EXAMPLES.map((word) => (
            <Tag key={word} onClick={() => updateInput(word)}>{word}</Tag>
          ))}
        </div>
      )}

      {input.trim() && (
        <WordCard
          entry={entry}
          status={status}
          sourceIds={sourceIds}
          getLabelById={getLabelById}
          studyStatus={studyStatus}
          studyListIds={studyListIds}
          targetListId={targetList}
          lists={lists}
          targetItemExists={targetItem !== null}
          existingTranslationIds={targetItem?.translationIds ?? []}
          existingAllTranslations={targetItem !== null && !targetItem.translationIds?.length}
          existingCustomTranslations={targetItem?.customTranslations ?? []}
          onCheckStudy={checkWord}
         onAddToList={handleAddToList}
         batchPicker={batchPicker}
       />
     )}
        </div>
      ) : (
        <ImportPage
          embedded
          libraries={libraries}
          getLabelById={getLabelById}
          study={study}
          onManageLists={onManageLists}
        />
      )}
    </div>
  )
}
