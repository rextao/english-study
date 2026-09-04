import { useEffect, useMemo, useState } from 'react'
import { useVocabMatch } from '../hooks/useSearch'
import { useDictPrefetch } from '../hooks/useDictPrefetch'
import type { StudyListApi, ImportItem } from '../hooks/useStudyList'
import type { VocabLibrary } from '../types/vocab'
import { PageHeader } from '../components/PageHeader'
import { Button, Checkbox, Input, Select, Tag, TextArea } from '../ui'
import type { SelectOption } from '../ui'
import './ImportPage.css'

/** 词库筛选的特殊取值 */
const NO_FILTER = ''
const ANY_LIB   = '__any__'

/** 预览最多渲染多少行，避免粘贴几千行时卡住 */
const PREVIEW_LIMIT = 200

type RowState = 'keep' | 'filtered' | 'dup-text' | 'dup-list'

interface Row {
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

/** 与服务端保持一致的归一化规则：去首尾空白 + 压缩空白 + 小写 */
function normalize(input: string): string {
  return input.trim().replace(/\s+/g, ' ').toLowerCase()
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
}

export function ImportPage({ libraries, getLabelById, study }: ImportPageProps) {
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
  const [result, setResult]             = useState<{ added: number; skipped: number; queued: number } | null>(null)
  const [error, setError]               = useState('')
  const [existing, setExisting]         = useState<Set<string>>(new Set())
  const [reloadToken, setReloadToken]   = useState(0)

  // 导入接口是立即返回的，音标 / 释义在服务端后台补，这里只盯进度
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

  // getSourceIds 内部的索引只依赖 libraries，所以这里跟 libraries 走
  const rows = useMemo<Row[]>(() => {
    const seen = new Set<string>()
    const out: Row[] = []
    for (const line of text.split('\n')) {
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
      out.push({ raw: line.trim(), key, type, sourceIds, hitIds, state })
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, filterLibId, keepSentences, existing, libraries])

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

  async function handleImport() {
    if (stats.keep === 0) return
    setImporting(true)
    setResult(null)
    setError('')
    const items: ImportItem[] = rows
      .filter(r => r.state === 'keep')
      .map(r => ({ text: r.raw, sourceIds: r.sourceIds }))
    const res = await importItems(targetList, items)
    if (res) {
      setResult(res)
      setText('')
      setReloadToken(t => t + 1)
      if (res.queued > 0) prefetch.watch()
    } else {
      setError('导入失败，请确认本地服务已启动（npm run dev:all）')
    }
    setImporting(false)
  }

  const filterActive = filterLibId !== NO_FILTER
  const shown = rows.slice(0, PREVIEW_LIMIT)

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

  return (
    <div className="page import-page">
      <PageHeader
        title="批量导入"
        subtitle="每行一个单词或句子，导入前会标出所属词库、重复项和被筛掉的行"
        actions={
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
        }
      />

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
              {importing ? '导入中...' : '导入 ' + stats.keep + ' 条'}
            </Button>
            {result && (
              <div className="callout callout--success import-actions__msg">
                ✓ 成功导入 <strong>{result.added}</strong> 条，跳过重复 <strong>{result.skipped}</strong> 条
                {result.queued > 0 && <> · 音标和释义正在后台补齐</>}
              </div>
            )}
            {prefetch.busy && (
              <div className="callout callout--warn import-actions__msg">
                {prefetch.state.total > 0
                  ? '正在补齐音标和释义 ' + prefetch.state.done + '/' + prefetch.state.total
                  : '正在补齐音标和释义...'}
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
    </div>
  )
}
