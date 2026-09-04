import { useState, useEffect, useRef } from 'react'
import { useDictionary } from '../hooks/useDictionary'
import { useDictSources } from '../hooks/useDictSources'
import { useVocabMatch } from '../hooks/useSearch'
import { useStudy } from '../hooks/useStudy'
import type { StudyListApi } from '../hooks/useStudyList'
import { WordCard } from '../components/WordCard'
import { Input, Tag } from '../ui'
import type { VocabLibrary } from '../types/vocab'
import './SearchPage.css'

/** 空状态下给的示例词，点一下直接查 */
const EXAMPLES = ['apple', 'weather', 'promise', 'decide', 'journey']

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
  const { entry, status, lookup } = useDictionary()
  const { sources } = useDictSources()
  const { getSourceIds } = useVocabMatch(libraries)
  const { getStatus, getListIds, checkWord, markAdded } = useStudy()
  const { lists, addItem } = study
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    const trimmed = input.trim()
    if (!trimmed) return
    timerRef.current = setTimeout(() => { lookup(trimmed) }, 400)
    return () => { if (timerRef.current) clearTimeout(timerRef.current) }
  }, [input, lookup])

  const sourceIds   = entry ? getSourceIds(entry.word) : []
  const studyStatus = entry ? getStatus(entry.word) : 'unknown'
  const studyListIds = entry ? getListIds(entry.word) : []

  async function handleAddToList(listId: string, senseIds: string[]) {
    if (!entry) return
    const result = await addItem(listId, entry.word, sourceIds, senseIds)
    if (result.ok) markAdded(entry.word, listId)
  }

  return (
    <div className="page page--narrow search-page">
      <div className="search-hero">
        <h1 className="search-hero__title">查一个词</h1>
        <p className="search-hero__subtitle">看本地词典给的中文释义和音标，并顺手确认它属于哪个词库</p>
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
          onChange={(e) => setInput(e.target.value)}
          allowClear
          onClear={() => setInput('')}
          autoFocus
          spellCheck={false}
        />
      </div>

      {/* 本地词典状态：装上了就不用等外部接口，没装给一句怎么装 */}
      {sources && !sources.local.disabled && (
        <p className="hint search-source">
          {sources.local.ready
            ? '本地词典 ECDICT · ' + sources.local.count.toLocaleString('zh-CN') + ' 词条 · 查词优先用它'
            : '还没装本地词典：跑一次 npm run ecdict:fetch 装上 ECDICT，之后查词不用等外部接口'}
        </p>
      )}

      {!input.trim() && (
        <div className="search-hints">
          <span className="search-hints__label">试试</span>
          {EXAMPLES.map((word) => (
            <Tag key={word} onClick={() => setInput(word)}>{word}</Tag>
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
          lists={lists}
          onCheckStudy={checkWord}
          onAddToList={handleAddToList}
        />
      )}
    </div>
  )
}
