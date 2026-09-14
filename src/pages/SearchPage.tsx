import { useState, useEffect, useRef } from 'react'
import { useDictionary } from '../hooks/useDictionary'
import { useVocabMatch } from '../hooks/useSearch'
import { useStudy } from '../hooks/useStudy'
import type { StudyListApi } from '../hooks/useStudyList'
import { WordCard } from '../components/WordCard'
import { Input, Select, Tag } from '../ui'
import type { SelectOption } from '../ui'
import type { VocabLibrary } from '../types/vocab'
import type { StudyWordItem } from '../types/vocab'
import { formatTranslationOptions, selectedTranslationOptions } from '../utils/translations'
import './SearchPage.css'

/** 空状态下给的示例词，点一下直接查 */
const EXAMPLES = ['apple', 'weather', 'promise', 'decide', 'journey']

function capitalizeSentence(input: string): string {
  return input.trim().replace(/\s+/g, ' ').replace(/[A-Za-z]/, letter => letter.toUpperCase())
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
}

export function SearchPage({ libraries, getLabelById, study }: SearchPageProps) {
  const [input, setInput] = useState('')
  const { entry, status, lookup, cancelLookup } = useDictionary()
  const { getSourceIds } = useVocabMatch(libraries)
  const { getStatus, getListIds, checkWord, markAdded } = useStudy()
  const { lists, addItem, fetchListWords, updateItemTranslations } = study
  const [targetList, setTargetList] = useState('default')
  const [targetItem, setTargetItem] = useState<StudyWordItem | null>(null)
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

  const listOptions: SelectOption[] = lists.length > 0
    ? lists.map(list => ({ value: list.id, label: list.name, extra: list.wordCount + ' 条' }))
    : [{ value: 'default', label: '默认列表' }]

  async function handleAddToList(translationIds: string[]) {
    if (!entry) return
    if (targetItem) {
      const mergedIds = Array.from(new Set([
        ...(targetItem.translationIds ?? []),
        ...translationIds,
      ]))
      const selected = formatTranslationOptions(
        selectedTranslationOptions(entry.translations ?? [], mergedIds),
      )
      const translation = selected || targetItem.translation || entry.translation || ''
      const updated = await updateItemTranslations(targetList, entry.word, mergedIds, translation)
      if (updated) {
        setTargetItem(updated)
        markAdded(entry.word, targetList)
      }
      return
    }
    const selected = formatTranslationOptions(
      selectedTranslationOptions(entry.translations ?? [], translationIds),
    )
    const translation = selected || entry.translation || ''
    const text = entry.displayText || entry.word
    const result = await addItem(
      targetList, text, sourceIds, undefined, translationIds, translation, entry.phonetic,
    )
    if (result.ok) {
      markAdded(entry.word, targetList)
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
      })
    }
  }

  return (
    <div className="page page--narrow search-page">
      <div className="search-hero">
        <h1 className="search-hero__title">查询</h1>
        <div className="search-target">
          <span className="field-label">学习列表</span>
          <Select
            aria-label="选择学习列表"
            size="small"
            value={targetList}
            options={listOptions}
            onChange={setTargetList}
          />
        </div>
      </div>

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
          onCheckStudy={checkWord}
          onAddToList={handleAddToList}
        />
      )}
    </div>
  )
}
