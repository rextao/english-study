import { useEffect, useMemo, useState } from 'react'
import { useVocabMatch } from '../hooks/useSearch'
import { useDictPrefetch } from '../hooks/useDictPrefetch'
import type { StudyListApi, ImportItem } from '../hooks/useStudyList'
import type { DictionaryEntry, VocabLibrary } from '../types/vocab'
import {
  formatTranslationWithCustom, selectedTranslationOptions,
  translationOptions, translationPosLabel,
} from '../utils/translations'
import { PageHeader } from '../components/PageHeader'
import { Button, Checkbox, Input, Modal, Select, Tag, TextArea } from '../ui'
import type { SelectOption } from '../ui'
import './ImportPage.css'

/** 词库筛选的特殊取值 */
const NO_FILTER = ''
const ANY_LIB   = '__any__'

/** 预览最多渲染多少行，避免粘贴几千行时卡住 */
const PREVIEW_LIMIT = 200
/** 与服务端单次批量查询上限一致；超过时自动分批，用户仍只操作一次。 */
const SEARCH_BATCH_SIZE = 200
const MAX_PICKED_TRANSLATIONS = 12
/** 与服务端 MAX_CUSTOM_TRANSLATIONS 一致：一个词最多 6 条自定义词义 */
const MAX_CUSTOM_TRANSLATIONS = 6

const SERVER = 'http://127.0.0.1:3456'

type RowState = 'keep' | 'filtered' | 'dup-text' | 'dup-list'

interface Row {
  /** 在原始输入中的行号，用于导入后只移除真正成功的那一次输入 */
  inputIndex: number
  raw: string
  key: string
  type: 'word' | 'sentence'
  sourceIds: string[]
  /** 命中的词库：整行本身收录它的词库，句子则是「句中出现过其词条」的词库 */
  hitIds: string[]
  state: RowState
}

/** 词库筛选标签行里的一档 */
interface FilterTag {
  value: string
  label: string
  title: string
  count?: number
}

interface BatchSearchResult {
  word: string
  ok: boolean
  entry?: DictionaryEntry
  error?: { message?: string }
}

/** 与服务端保持一致的归一化规则：去首尾空白 + 压缩空白 + 小写 */
function normalize(input: string): string {
  return input.trim().replace(/\s+/g, ' ').toLowerCase()
}

function capitalizeSentence(input: string): string {
  return input.trim().replace(/\s+/g, ' ').replace(/[A-Za-z]/, letter => letter.toUpperCase())
}

/** 把句子拆成单词，用来判断句子里有没有某个词库的词 */
function tokenize(key: string): string[] {
  return key
    .split(/[^a-z'-]+/)
    .map(token => token.replace(/^[-']+/, '').replace(/[-']+$/, ''))
    .filter(Boolean)
}

/** 句中取词时的宽松回退：连字符两侧的词 + 最常见的复数/时态形式，免得 apples 匹配不到 apple */
function wordForms(token: string): string[] {
  const forms = [token]
  if (token.includes('-')) forms.push(...token.split('-').filter(Boolean))
  for (const base of [...forms]) {
    if (base.length < 4) continue
    if (base.endsWith('ies')) forms.push(base.slice(0, -3) + 'y')
    else if (base.endsWith('es')) forms.push(base.slice(0, -2), base.slice(0, -1))
    else if (base.endsWith('s')) forms.push(base.slice(0, -1))
    if (base.endsWith('ed')) forms.push(base.slice(0, -2), base.slice(0, -1))
    if (base.endsWith('ing')) forms.push(base.slice(0, -3), base.slice(0, -3) + 'e')
  }
  return forms
}

const STATE_LABEL: Record<RowState, string> = {
  'keep':     '将导入',
  'filtered': '不在所选词库',
  'dup-text': '本次重复',
  'dup-list': '列表已有',
}

interface ImportPageProps {
  libraries: VocabLibrary[]
  getLabelById: (id: string) => string
  study: StudyListApi
  /** 嵌入查词页时不画自己的 .page 容器和标题，由查词页提供版式 */
  embedded?: boolean
}

export function ImportPage({ libraries, getLabelById, study, embedded }: ImportPageProps) {
  const { lists, createList, importItems, fetchListWords } = study
  const { getSourceIds } = useVocabMatch(libraries)

  const [text, setText]                 = useState('')
  const [filterLibId, setFilterLibId]   = useState<string>(NO_FILTER)
  const [keepSentences, setKeepSentences] = useState(false)
  const [targetList, setTargetList]     = useState('default')
  const [adding, setAdding]             = useState(false)
  const [newListName, setNewListName]   = useState('')
  const [creating, setCreating]         = useState(false)
  const [importing, setImporting]       = useState(false)
  const [result, setResult]             = useState<{ added: number; skipped: number; queued: number; suspect: number } | null>(null)
  const [error, setError]               = useState('')
  const [existing, setExisting]         = useState<Set<string>>(new Set())
  const [reloadToken, setReloadToken]   = useState(0)
  const [pickerRows, setPickerRows]     = useState<Row[]>([])
  const [pickerEntries, setPickerEntries] = useState<Map<string, DictionaryEntry>>(new Map())
  const [pickerErrors, setPickerErrors]   = useState<Map<string, string>>(new Map())
  const [pickerSelected, setPickerSelected] = useState<Map<string, string[]>>(new Map())
  const [pickerTargetList, setPickerTargetList] = useState('default')
  const [pickerOpen, setPickerOpen]     = useState(false)
  const [pickerSaving, setPickerSaving] = useState(false)
  const [pickerCustoms, setPickerCustoms] = useState<Map<string, string[]>>(new Map())
  const [pickerCustomDraft, setPickerCustomDraft] = useState<Map<string, string>>(new Map())

  // 导入接口立即返回；中文已在查询阶段确定，这里只盯后台补音标的进度。
  const prefetch = useDictPrefetch()

  // 目标列表已有的词条，用于预览时标出「列表已有」
  useEffect(() => {
    let alive = true
    fetchListWords(targetList).then(items => {
      if (alive) setExisting(new Set(items.map(i => i.word)))
    })
    return () => { alive = false }
  }, [targetList, fetchListWords, reloadToken])

  // 目标列表被删掉时回退到默认列表
  useEffect(() => {
    if (lists.length > 0 && !lists.some(l => l.id === targetList)) setTargetList('default')
  }, [lists, targetList])

  /** 句子里出现过的词库 id（去重）：句子的筛选按「含该词库的词」判断 */
  function tokenSourceIds(key: string): string[] {
    const ids = new Set<string>()
    for (const token of tokenize(key)) {
      for (const form of wordForms(token)) {
        for (const id of getSourceIds(form)) ids.add(id)
      }
    }
    return Array.from(ids)
  }

  const rows = useMemo<Row[]>(() => {
    const seen = new Set<string>()
    const out: Row[] = []
    for (const [inputIndex, line] of text.split('\n').entries()) {
      const key = normalize(line)
      if (!key) continue
      const sourceIds = getSourceIds(key)
      // 与服务端一致：命中词库的条目算 word（含 "a few" 这类固定短语），否则含空白即句子
      const type: Row['type'] = sourceIds.length > 0 || !/\s/.test(key) ? 'word' : 'sentence'
      // 单词看自己属不属于词库，句子看里面有没有该词库的词
      const hitIds = type === 'sentence' ? tokenSourceIds(key) : sourceIds

      let state: RowState = 'keep'
      const skipFilter = filterLibId === NO_FILTER || (keepSentences && type === 'sentence')
      if (!skipFilter) {
        const hit = filterLibId === ANY_LIB
          ? hitIds.length > 0
          : hitIds.includes(filterLibId)
        if (!hit) state = 'filtered'
      }
      if (state === 'keep' && seen.has(key)) state = 'dup-text'
      if (state === 'keep' && existing.has(key)) state = 'dup-list'

      seen.add(key)
      const raw = type === 'sentence' ? capitalizeSentence(line) : line.trim()
      out.push({ inputIndex, raw, key, type, sourceIds, hitIds, state })
    }
    return out
  }, [text, filterLibId, keepSentences, existing, getSourceIds])

  const stats = useMemo(() => {
    let keep = 0, filtered = 0, dup = 0, sentences = 0
    for (const r of rows) {
      if (r.state === 'keep') keep++
      else if (r.state === 'filtered') filtered++
      else dup++
      if (r.type === 'sentence') sentences++
    }
    return { total: rows.length, keep, filtered, dup, sentences }
  }, [rows])

  function closeCreate() {
    setAdding(false)
    setNewListName('')
  }

  async function handleCreateList() {
    const name = newListName.trim()
    if (!name) return
    setCreating(true)
    setError('')
    const res = await createList(name)
    if (res.ok) { setTargetList(res.id); closeCreate() }
    else setError(res.error)
    setCreating(false)
  }

  /** 批量执行与首页一致的完整查词链路；单项失败不会阻塞其他项目。 */
  async function loadTranslationEntries(targetRows: Row[]) {
    const words = targetRows.map(row => row.type === 'sentence' ? row.raw : row.key)
    const next = new Map<string, DictionaryEntry>()
    const errors = new Map<string, string>()
    for (let start = 0; start < words.length; start += SEARCH_BATCH_SIZE) {
      const response = await fetch(SERVER + '/api/dict/search-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ words: words.slice(start, start + SEARCH_BATCH_SIZE) }),
      })
      if (!response.ok) throw new Error('词义批量查询失败')
      const batch = await response.json() as { results?: BatchSearchResult[] }
      for (const result of batch.results ?? []) {
        const key = normalize(result.word)
        if (result.entry) next.set(key, result.entry)
        if (!result.ok) errors.set(key, result.error?.message || '未获取到中文翻译')
      }
    }
    return { entries: next, errors }
  }

  function openTranslationPicker(
    targetRows: Row[], entries: Map<string, DictionaryEntry>, errors: Map<string, string>,
  ) {
    const selected = new Map<string, string[]>()
    for (const row of targetRows) {
      const choices = translationOptions(entries.get(row.key)?.translations ?? [])
      selected.set(row.key, row.type === 'sentence' && choices.length === 1 ? [choices[0].id] : [])
    }
    setPickerRows(targetRows)
    setPickerEntries(entries)
    setPickerErrors(errors)
    setPickerSelected(selected)
    setPickerCustoms(new Map())
    setPickerCustomDraft(new Map())
    setPickerTargetList(targetList)
    setPickerOpen(true)
  }

  function toggleTranslation(word: string, id: string) {
    setPickerSelected(prev => {
      const next = new Map(prev)
      const current = next.get(word) ?? []
      if (current.includes(id)) next.set(word, current.filter(item => item !== id))
      else if (current.length < MAX_PICKED_TRANSLATIONS) next.set(word, current.concat(id))
      return next
    })
  }

  function toggleAllTranslations(word: string, entry?: DictionaryEntry) {
    const available = translationOptions(entry?.translations ?? []).slice(0, MAX_PICKED_TRANSLATIONS)
    setPickerSelected(prev => {
      const next = new Map(prev)
      const current = next.get(word) ?? []
      const allSelected = available.length > 0 && available.every(item => current.includes(item.id))
      next.set(word, allSelected ? [] : available.map(item => item.id))
      return next
    })
  }

  function customDraftOf(word: string): string {
    return pickerCustomDraft.get(word) ?? ''
  }

  function setCustomDraft(word: string, value: string) {
    setPickerCustomDraft(prev => {
      const next = new Map(prev)
      next.set(word, value)
      return next
    })
  }

  function addCustomTranslation(word: string) {
    const text = (pickerCustomDraft.get(word) ?? '').trim()
    if (!text) return
    setPickerCustoms(prev => {
      const current = prev.get(word) ?? []
      if (current.includes(text) || current.length >= MAX_CUSTOM_TRANSLATIONS) return prev
      const next = new Map(prev)
      next.set(word, current.concat(text))
      return next
    })
    setPickerCustomDraft(prev => {
      const next = new Map(prev)
      next.set(word, '')
      return next
    })
  }

  function removeCustomTranslation(word: string, index: number) {
    setPickerCustoms(prev => {
      const current = prev.get(word) ?? []
      const next = new Map(prev)
      next.set(word, current.filter((_, i) => i !== index))
      return next
    })
  }

  function isSpellingSuspect(row: Row, entry?: DictionaryEntry): boolean {
    return !/\s/.test(row.key)
      && row.sourceIds.length === 0
      && entry?.spellingStatus === 'suspect'
  }

  async function handleImport() {
    if (stats.keep === 0) return
    setImporting(true)
    setResult(null)
    setError('')
    try {
      const targetRows = rows.filter(r => r.state === 'keep')
      const { entries, errors } = await loadTranslationEntries(targetRows)
      openTranslationPicker(targetRows, entries, errors)
    } catch {
      setError('词义查询失败，请确认本地服务已启动（npm run dev:all）')
    }
    setImporting(false)
  }

  async function confirmImport() {
    if (pickerRows.length === 0) return
    setPickerSaving(true)
    const candidates: { row: Row; item: ImportItem }[] = pickerRows.flatMap(row => {
      const entry = pickerEntries.get(row.key)
      if (!entry || pickerErrors.has(row.key) || isSpellingSuspect(row, entry)) return []
      const customs = pickerCustoms.get(row.key) ?? []
      // 词典没有中文但用户自己填了词义，也允许导入；否则保持「缺中文不导入」
      if (!entry.translation && customs.length === 0) return []
      const translationIds = pickerSelected.get(row.key) ?? []
      const translation = formatTranslationWithCustom(
        selectedTranslationOptions(entry.translations ?? [], translationIds),
        customs,
      ) || entry.translation
      return [{
        row,
        item: {
          text: row.raw,
          sourceIds: row.sourceIds,
          phonetic: entry.phonetic,
          translationIds,
          translation,
          customTranslations: customs.length > 0 ? customs : undefined,
        },
      }]
    })
    if (candidates.length === 0) {
      setError('没有成功获取中文词义的项目，暂时无法导入')
      setPickerSaving(false)
      return
    }

    // 弹窗打开后列表可能已在别处发生变化；提交前再确认一次，已有项不提交并继续留在输入框。
    const latestItems = await fetchListWords(pickerTargetList)
    const latestKeys = new Set(latestItems.map(item => normalize(item.word)))
    const pendingCandidates = candidates.filter(({ row }) => !latestKeys.has(row.key))
    const alreadyExistingCount = candidates.length - pendingCandidates.length
    const res = pendingCandidates.length > 0
      ? await importItems(pickerTargetList, pendingCandidates.map(({ item }) => item))
      : { added: 0, skipped: 0, queued: 0 }
    if (res) {
      const suspect = pickerRows.filter(row => isSpellingSuspect(row, pickerEntries.get(row.key))).length
      setResult({ ...res, skipped: res.skipped + alreadyExistingCount, suspect })

      // 服务端按提交顺序处理；正常情况下 pendingCandidates 都会成功。若并发产生跳过，
      // 只按返回的 added 数量移除前面的成功项，其余输入（含重复、筛选项和查询失败项）全部保留。
      const addedInputIndexes = new Set(
        pendingCandidates.slice(0, res.added).map(({ row }) => row.inputIndex),
      )
      setText(rows
        .filter(row => !addedInputIndexes.has(row.inputIndex))
        .map(row => row.raw)
        .join('\n'))
      setReloadToken(t => t + 1)
      if (res.queued > 0) prefetch.watch()
      setPickerOpen(false)
    } else {
      setError('导入失败，请确认本地服务已启动（npm run dev:all）')
    }
    setPickerSaving(false)
  }

  const filterActive = filterLibId !== NO_FILTER
  const shown = rows.slice(0, PREVIEW_LIMIT)
  const pickerImportableCount = pickerRows.filter(row => (
    !pickerErrors.has(row.key)
    && !isSpellingSuspect(row, pickerEntries.get(row.key))
    && (Boolean(pickerEntries.get(row.key)?.translation)
      || (pickerCustoms.get(row.key) ?? []).length > 0)
  )).length
  const pickerSuspectCount = pickerRows.filter(row => (
    isSpellingSuspect(row, pickerEntries.get(row.key))
  )).length
  const pickerFailedCount = pickerRows.length - pickerImportableCount - pickerSuspectCount

  const filterTags: FilterTag[] = [
    { value: NO_FILTER, label: '全部', title: '不筛选，粘贴的内容全部导入' },
    { value: ANY_LIB, label: '任一词库', title: '只保留任一词库收录的词，以及含这些词的句子' },
    ...libraries.map(lib => ({
      value: lib.id,
      label: getLabelById(lib.id),
      count: lib.words.length,
      title: '只保留「' + getLabelById(lib.id) + '」收录的词，以及含这些词的句子',
    })),
  ]

  const listOptions: SelectOption[] = lists.length > 0
    ? lists.map(l => ({ value: l.id, label: l.name, extra: l.wordCount + ' 条' }))
    : [{ value: 'default', label: '默认列表' }]

const targetControls = (
  <>
    <div className="import-target">
              <label className="field-label" htmlFor="import-target">导入到</label>
              <Select
                id="import-target"
                aria-label="导入到"
                size="small"
                block={false}
                className="import-target__select"
                value={targetList}
                options={listOptions}
                onChange={value => { setTargetList(value); setResult(null) }}
              />
            </div>
            {adding ? (
              <div className="import-new">
                <Input
                  className="import-new__input"
                  size="small"
                  placeholder="列表名称..."
                  value={newListName}
                  autoFocus
                  aria-label="新建列表名称"
                  onChange={e => setNewListName(e.target.value)}
                  onPressEnter={handleCreateList}
                  onKeyDown={e => { if (e.key === 'Escape') closeCreate() }}
                />
                <Button
                  type="primary"
                  size="small"
                  disabled={!newListName.trim()}
                  loading={creating}
                  onClick={handleCreateList}
                >
                  确定
                </Button>
                <Button type="text" size="small" onClick={closeCreate}>取消</Button>
              </div>
            ) : (
              <Button size="small" onClick={() => setAdding(true)}>+ 新建列表</Button>
          )}

          </>
  )

  // 嵌入搜索页时没有 PageHeader，导入到 / 新建列表单独占一行
  const body = (
    <>
      {embedded && <div className="import-target-row">{targetControls}</div>}
      <div className="import-page__body">
        <div className="import-col">
          <div className="import-section">
            <div className="import-filter">
              <span className="field-label" id="import-filter-label">词库筛选</span>
              <div className="import-filter__tags" role="group" aria-labelledby="import-filter-label">
                {filterTags.map(tag => {
                  const active = tag.value === filterLibId
                  return (
                    <Tag
                      key={tag.value || 'all'}
                      className={'import-filter__tag' + (active ? ' import-filter__tag--active' : '')}
                      title={tag.title}
                      pressed={active}
                      onClick={() => { setFilterLibId(tag.value); setResult(null) }}
                    >
                      {tag.label}
                      {tag.count != null && <span className="import-filter__count">{tag.count}</span>}
                    </Tag>
                  )
                })}
              </div>
            </div>
            {filterActive && (
              <Checkbox
                className="import-check"
                checked={keepSentences}
                onChange={e => setKeepSentences(e.target.checked)}
              >
                句子不参与筛选，始终保留
              </Checkbox>
            )}
          </div>

          <div className="import-section">
            <div className="import-label-row">
              <label className="field-label" htmlFor="import-textarea">粘贴内容</label>
              {text && (
                <Button type="link" size="small" onClick={() => { setText(''); setResult(null) }}>
                  清空
                </Button>
              )}
            </div>
            <TextArea
              id="import-textarea"
              placeholder={'apple\nbanana\nHow are you doing today?\n...'}
              value={text}
              onChange={e => { setText(e.target.value); setResult(null) }}
              rows={14}
              spellCheck={false}
            />
            <p className="hint">
              共 {stats.total} 行（其中句子 {stats.sentences} 条）
              {stats.total > 0 && <> · 将导入 <strong>{stats.keep}</strong> 条 · 重复 {stats.dup} 条 · 筛掉 {stats.filtered} 条</>}
            </p>
          </div>

          <div className="import-actions">
            <Button
              type="primary"
              size="large"
              disabled={stats.keep === 0}
              loading={importing}
              onClick={handleImport}
            >
              {importing ? '查询中...' : '查询 ' + stats.keep + ' 条'}
            </Button>
            {result && (
              <div className="callout callout--success import-actions__msg">
                ✓ 成功导入 <strong>{result.added}</strong> 条，跳过重复 <strong>{result.skipped}</strong> 条
                {result.suspect > 0 && <> · 疑似错误 <strong>{result.suspect}</strong> 条未导入</>}
                {result.queued > 0 && <> · 缺失音标正在后台补齐</>}
              </div>
            )}
            {prefetch.busy && (
              <div className="callout callout--warn import-actions__msg">
                {prefetch.state.total > 0
                  ? '正在补齐音标 ' + prefetch.state.done + '/' + prefetch.state.total
                  : '正在补齐音标...'}
                {prefetch.state.failed > 0 && <> · 失败 {prefetch.state.failed} 条</>}
              </div>
            )}
            {prefetch.error && (
              <div className="callout callout--error import-actions__msg">{prefetch.error}</div>
            )}
            {error && <div className="callout callout--error import-actions__msg">{error}</div>}
          </div>

          {rows.length > 0 && (
            <div className="import-section">
              <span className="field-label">预览</span>
              <ul className="import-preview">
                {shown.map((row, i) => (
                  <li key={i} className={'import-row import-row--' + row.state}>
                    <span className="import-row__text">{row.raw}</span>
                    {row.type === 'sentence' && <Tag color="default">句子</Tag>}
                    {row.hitIds.map(id => (
                      <Tag key={id} color="blue">
                        {row.type === 'sentence' ? '含 ' + getLabelById(id) : getLabelById(id)}
                      </Tag>
                    ))}
                    <span className={'import-state import-state--' + row.state}>{STATE_LABEL[row.state]}</span>
                  </li>
                ))}
              </ul>
              {rows.length > PREVIEW_LIMIT && (
                <p className="hint">仅显示前 {PREVIEW_LIMIT} 行，剩余 {rows.length - PREVIEW_LIMIT} 行仍会按同样规则导入</p>
              )}
            </div>
          )}
        </div>
      </div>

      {pickerOpen && (
        <Modal
          open
          width="wide"
          title="选择要背的中文词义"
          description={'导入到「' + (lists.find(list => list.id === pickerTargetList)?.name ?? pickerTargetList)
            + '」；查询成功 ' + pickerImportableCount + ' 条'
            + (pickerSuspectCount > 0 ? '，疑似错误 ' + pickerSuspectCount + ' 条默认不导入' : '')
            + (pickerFailedCount > 0 ? '，查询失败 ' + pickerFailedCount + ' 条将保留以便重试' : '')}
          onClose={() => setPickerOpen(false)}
          footer={
            <div className="import-translation-picker__footer">
              <span className="hint">每个词最多选择 {MAX_PICKED_TRANSLATIONS} 条</span>
              <div className="import-translation-picker__buttons">
                <Button size="small" onClick={() => setPickerOpen(false)}>取消</Button>
                <Button type="primary" size="small" loading={pickerSaving} disabled={pickerImportableCount === 0} onClick={() => { void confirmImport() }}>
                  确认导入 {pickerImportableCount} 条
                </Button>
              </div>
            </div>
          }
        >
          <div className="import-translation-picker">
            {pickerRows.map(row => {
              const entry = pickerEntries.get(row.key)
              const translations = entry?.translations ?? []
              const selected = pickerSelected.get(row.key) ?? []
              const failed = pickerErrors.get(row.key)
              const spellingSuspect = isSpellingSuspect(row, entry)
              const available = translationOptions(translations).slice(0, MAX_PICKED_TRANSLATIONS)
              const allSelected = available.length > 0 && available.every(item => selected.includes(item.id))
              return (
                <div className="import-translation-row" key={row.key}>
                  <div className="import-translation-row__word">
                    <span>{row.raw}</span>
                    {row.type === 'sentence' && <Tag color="default">句子</Tag>}
                    {spellingSuspect && <Tag color="gold">疑似错误</Tag>}
                    {row.type === 'word' && entry?.phonetic && <span className="import-translation-row__phonetic">{entry.phonetic}</span>}
                    {!failed && !spellingSuspect && available.length > 0 && (
                      <Button type="link" size="small" className="import-translation-row__select-all" onClick={() => toggleAllTranslations(row.key, entry)}>
                        {allSelected ? '取消全选' : '全选'}
                      </Button>
                    )}
                  </div>
                  {spellingSuspect ? (
                    <span className="import-translation-row__suspect">可能拼写错误：本地词典、免费词典和词库均未命中，本条默认不导入</span>
                  ) : failed ? (
                    <span className="import-translation-row__error">查询失败：{failed}，本条不会导入</span>
                  ) : translations.length > 0 ? (
                    <div className="import-translation-row__groups">
                      {(() => {
                        const groups = new Map<string, ReturnType<typeof translationOptions>>()
                        for (const item of translationOptions(translations)) {
                          const key = item.pos ?? ''
                          const group = groups.get(key) ?? []
                          group.push(item)
                          groups.set(key, group)
                        }
                        return Array.from(groups.entries()).map(([pos, items]) => (
                          <div className="import-translation-row__group" key={pos || 'other'}>
                            {pos && <span className="import-translation-row__pos">{translationPosLabel(pos)}</span>}
                            <div className="import-translation-row__choices">
                              {items.map(item => (
                                <Checkbox
                                  key={item.id}
                                  checked={selected.includes(item.id)}
                                  disabled={!selected.includes(item.id) && selected.length >= MAX_PICKED_TRANSLATIONS}
                                  onChange={() => toggleTranslation(row.key, item.id)}
                                >
                                  {item.text}
                                </Checkbox>
                              ))}
                            </div>
                          </div>
                        ))
                      })()}
                    </div>
                  ) : (
                    <span className="import-translation-row__error">未获取到中文词义；可在下面自定义，否则本条不会导入</span>
                  )}

                  {!spellingSuspect && !failed && (
                    <div className="import-translation-row__custom">
                      {(pickerCustoms.get(row.key) ?? []).map((text, index) => (
                        <Tag
                          key={index}
                          color="green"
                          title="点击移除这条自定义词义"
                          onClick={() => removeCustomTranslation(row.key, index)}
                        >
                          {text}
                        </Tag>
                      ))}
                      <span className="import-translation-row__custom-input">
                        <Input
                          size="small"
                          value={customDraftOf(row.key)}
                          placeholder="自定义词义：词典里没有的也能自己加"
                          maxLength={60}
                          onChange={e => setCustomDraft(row.key, e.target.value)}
                          onPressEnter={() => addCustomTranslation(row.key)}
                        />
                        <Button
                          size="small"
                          disabled={
                            !customDraftOf(row.key).trim()
                            || (pickerCustoms.get(row.key) ?? []).length >= MAX_CUSTOM_TRANSLATIONS
                          }
                          onClick={() => addCustomTranslation(row.key)}
                        >
                          添加
                        </Button>
                      </span>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
       </Modal>
     )}
    </>
  )

  if (embedded) {
    return body
  }

  return (
    <div className="page import-page">
      <PageHeader
        title="批量导入"
        subtitle="每行一个单词或句子，导入前会标出所属词库、重复项和被筛掉的行"
        actions={targetControls}
      />
      {body}
    </div>
  )
 }
