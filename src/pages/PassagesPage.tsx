import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Passage, PassageGroup, PassageRule, PassageWord, StudyWordItem, VocabLibraryInfo } from '../types/vocab'
import type { StudyListApi as StudyListHookApi } from '../hooks/useStudyList'
import { useLearningAchievements } from '../hooks/useLearningRecords'
import { usePassages } from '../hooks/usePassages'
import { PageHeader } from '../components/PageHeader'
import { Button, Checkbox, Drawer, Input, Modal, Select, Tag, TextArea } from '../ui'
import './PassagesPage.css'

const DAY = 86_400_000
const WORD_PATTERN = /^[a-z]+(?:[-'][a-z]+)*$/i
const TOKEN_PATTERN = /[a-z]+(?:[-'][a-z]+)*/gi
/** 服务端标题上限，自动标题同样按这个长度收口 */
const MAX_TITLE_LENGTH = 120
/** 没有匹配到单词时的兜底标题 */
const FALLBACK_TITLE = '短文内容'

const RULE_OPTIONS = [
  { value: 'stale', label: '很久没复习' },
  { value: 'low-meaning', label: '知意次数较少' },
  { value: 'low-reading', label: '会读次数较少' },
  { value: 'never-meaning', label: '从未知意' },
  { value: 'never-reading', label: '从未会读' },
  { value: 'list-batch', label: '学习列表分组' },
]

interface StudyBatchOption {
  listId: string
  listName: string
  batchKey: string
  batchName: string
  words: StudyWordItem[]
}

interface PassageCandidate {
  word: string
  sourceIds: string[]
  readingCount: number
  rememberedCount: number
  lastAt?: number
}

interface ResolvedSelection {
  groups: PassageGroup[]
  words: PassageCandidate[]
}

const batchKeyOf = (ts: number) => {
  const date = new Date(ts)
  return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0')
}

function defaultBatchName(key: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return '自定义分组'
  const [year, month, day] = key.split('-').map(Number)
  return year === new Date().getFullYear() ? month + ' 月 ' + day + ' 日' : year + ' 年 ' + month + ' 月 ' + day + ' 日'
}

function newGroup(index = 1): PassageGroup {
  return {
    id: 'group-' + Date.now() + '-' + index,
    name: '第 ' + index + ' 组',
    enabled: true,
    rule: 'stale',
    days: 14,
    count: 5,
    words: [],
  }
}

function displayWord(word: string) {
  return /\s/.test(word)
    ? word.trim().replace(/\s+/g, ' ').replace(/[A-Za-z]/, letter => letter.toUpperCase())
    : word
}

/** 匹配池 = 所有学习列表里的单词；同一个词只留一个词形，来源合并 */
function buildStudyWordPool(batches: StudyBatchOption[]) {
  const pool = new Map<string, PassageWord>()
  for (const batch of batches) {
    for (const item of batch.words) {
      if (item.type !== 'word' || !WORD_PATTERN.test(item.word)) continue
      const key = item.word.toLowerCase()
      const current = pool.get(key)
      if (current) {
        current.sourceIds = Array.from(new Set(current.sourceIds.concat(item.sourceIds)))
      } else {
        pool.set(key, { word: item.word, sourceIds: [...item.sourceIds] })
      }
    }
  }
  return pool
}

/** 按短文里出现的顺序匹配所有学习列表里的单词；与抽屉里的选词规则完全无关 */
function matchStudyWords(content: string, pool: Map<string, PassageWord>) {
  const seen = new Set<string>()
  const out: PassageWord[] = []
  for (const token of content.match(TOKEN_PATTERN) ?? []) {
    const key = token.toLowerCase()
    if (seen.has(key)) continue
    const hit = pool.get(key)
    if (!hit) continue
    seen.add(key)
    out.push(hit)
  }
  return out
}

/** 只比单词集合，顺序不影响判断 */
function sameWordSet(left: PassageWord[], right: PassageWord[]) {
  const a = left.map(item => item.word.toLowerCase()).sort()
  const b = right.map(item => item.word.toLowerCase()).sort()
  return a.length === b.length && a.every((word, index) => word === b[index])
}

/** 保存用的标题 = 严格匹配到的单词排成一行；截断只发生在超出长度上限时，且不会切到单词中间 */
function passageTitleFromWords(words: PassageWord[]) {
  let title = ''
  for (const item of words) {
    const next = title ? title + ', ' + item.word : item.word
    if (next.length > MAX_TITLE_LENGTH) break
    title = next
  }
  return title || FALLBACK_TITLE
}

function ruleDescription(group: PassageGroup) {
  if (group.rule === 'stale') return '超过 ' + (group.days || 14) + ' 天未学习'
  if (group.rule === 'low-meaning') return '知意次数 ≤ ' + (group.threshold ?? 1)
  if (group.rule === 'low-reading') return '会读次数 ≤ ' + (group.threshold ?? 1)
  if (group.rule === 'list-batch') return '学习列表分组'
  return group.rule === 'never-meaning' ? '知意次数 = 0' : '会读次数 = 0'
}

interface PassagesPageProps {
  libraries: VocabLibraryInfo[]
  getLabelById: (id: string) => string
  study: StudyListHookApi
  onBack: () => void
}

export function PassagesPage({ libraries, getLabelById, study, onBack }: PassagesPageProps) {
  const achievements = useLearningAchievements('')
  const passages = usePassages()
  const [groups, setGroups] = useState<PassageGroup[]>([newGroup()])
  const [draftGroups, setDraftGroups] = useState<PassageGroup[]>([])
  const [content, setContent] = useState('')
  const [savedId, setSavedId] = useState('')
  const [notice, setNotice] = useState('')
  const [localError, setLocalError] = useState('')
  const [studyBatches, setStudyBatches] = useState<StudyBatchOption[]>([])
  const [pickerOpen, setPickerOpen] = useState(false)
  const [preview, setPreview] = useState<Passage | null>(null)

  useEffect(() => {
    let active = true
    async function loadStudyBatches() {
      const loaded = await Promise.all(study.lists.map(async list => {
        const [words, meta] = await Promise.all([
          study.fetchListWords(list.id),
          study.fetchBatchMeta(list.id),
        ])
        const grouped = new Map<string, StudyWordItem[]>()
        for (const word of words) {
          const key = word.batchKey || batchKeyOf(word.addedAt)
          const current = grouped.get(key) ?? []
          current.push(word)
          grouped.set(key, current)
        }
        const order = meta.order.length > 0 ? meta.order : Array.from(grouped.keys())
        return order
          .filter(key => grouped.has(key))
          .map(batchKey => ({
            listId: list.id,
            listName: list.name,
            batchKey,
            batchName: meta.names[batchKey] || defaultBatchName(batchKey),
            words: grouped.get(batchKey) ?? [],
          }))
      }))
      if (active) setStudyBatches(loaded.flat())
    }
    void loadStudyBatches()
    return () => { active = false }
  }, [study.lists, study.fetchBatchMeta, study.fetchListWords])

  const candidates = useMemo<PassageCandidate[]>(() => {
    const byWord = new Map<string, PassageCandidate>()
    for (const item of achievements.items) {
      if (!WORD_PATTERN.test(item.word)) continue
      byWord.set(item.word.toLowerCase(), {
        word: item.word,
        sourceIds: item.sourceIds,
        readingCount: item.readingCount,
        rememberedCount: item.rememberedCount,
        lastAt: item.lastAt,
      })
    }
    for (const batch of studyBatches) {
      for (const item of batch.words) {
        if (item.type !== 'word' || !WORD_PATTERN.test(item.word)) continue
        const key = item.word.toLowerCase()
        const current = byWord.get(key)
        if (current) {
          current.sourceIds = Array.from(new Set(current.sourceIds.concat(item.sourceIds)))
        } else {
          byWord.set(key, {
            word: item.word,
            sourceIds: item.sourceIds,
            readingCount: item.readingCount ?? 0,
            rememberedCount: item.rememberedCount ?? 0,
            lastAt: item.lastDoneAt,
          })
        }
      }
    }
    return Array.from(byWord.values())
  }, [achievements.items, studyBatches])

  /** 按分组顺序挑词，同一个单词命中多组时只保留第一次出现的位置 */
  const resolveSelection = useCallback((groupList: PassageGroup[]): ResolvedSelection => {
    const used = new Set<string>()
    const byWord = new Map(candidates.map(item => [item.word.toLowerCase(), item]))
    const resolvedGroups = groupList.map(group => {
      if (group.enabled === false) return { ...group, words: [] }
      const batch = group.rule === 'list-batch'
        ? studyBatches.find(item => item.listId === group.listId && item.batchKey === group.batchKey)
        : undefined
      const batchWords = new Set((batch?.words ?? []).map(item => item.word.toLowerCase()))
      const eligible = candidates
        .filter(item => group.rule !== 'list-batch' || batchWords.has(item.word.toLowerCase()))
        .filter(item => !group.libraryId || item.sourceIds.includes(group.libraryId))
        .filter(item => {
          if (group.rule === 'list-batch') return true
          if (group.rule === 'stale') return !item.lastAt || Date.now() - item.lastAt >= (group.days || 14) * DAY
          if (group.rule === 'low-meaning') return item.rememberedCount <= (group.threshold ?? 1)
          if (group.rule === 'low-reading') return item.readingCount <= (group.threshold ?? 1)
          if (group.rule === 'never-meaning') return item.rememberedCount === 0
          return item.readingCount === 0
        })
        .sort((a, b) => {
          if (group.rule === 'low-meaning') return a.rememberedCount - b.rememberedCount || (a.lastAt ?? 0) - (b.lastAt ?? 0)
          if (group.rule === 'low-reading' || group.rule === 'never-reading') return a.readingCount - b.readingCount || (a.lastAt ?? 0) - (b.lastAt ?? 0)
          return (a.lastAt ?? 0) - (b.lastAt ?? 0)
        })
        .filter(item => !used.has(item.word.toLowerCase()))
        .slice(0, Math.max(0, group.count))
      const words = eligible.map(item => item.word)
      words.forEach(word => used.add(word.toLowerCase()))
      return { ...group, words }
    })
    return {
      groups: resolvedGroups,
      words: [...used].map(word => byWord.get(word)).filter((item): item is PassageCandidate => item != null),
    }
  }, [candidates, studyBatches])

  const draftSelected = useMemo(() => resolveSelection(draftGroups), [resolveSelection, draftGroups])

  /** 匹配池是全部学习列表，跟抽屉里选了什么完全无关 */
  const studyWordPool = useMemo(() => buildStudyWordPool(studyBatches), [studyBatches])
  const matchedWords = useMemo(() => matchStudyWords(content, studyWordPool), [content, studyWordPool])
  const currentPassage = passages.passages.find(item => item.id === savedId)
  const isDirty = Boolean(currentPassage && (
    currentPassage.content !== content.trim()
    || !sameWordSet(currentPassage.sourceWords, matchedWords)
  ))
  const canMark = matchedWords.length > 0
  const hasContent = content.trim().length > 0

  const pickerWords = draftSelected.words.map(item => item.word)

  /** 抽屉里改的是草稿：点「复制」才把规则留在页面上并复制清单，点「取消」直接丢弃 */
  function updateDraftGroup(id: string, patch: Partial<PassageGroup>) {
    setDraftGroups(current => current.map(group => group.id === id ? { ...group, ...patch } : group))
  }

  function addDraftGroup() {
    setDraftGroups(current => [...current, newGroup(current.length + 1)])
  }

  function removeDraftGroup(id: string) {
    setDraftGroups(current => current.filter(item => item.id !== id))
  }

  function openPicker() {
    setDraftGroups(groups)
    setPickerOpen(true)
  }

  async function confirmPicker() {
    if (pickerWords.length === 0) return
    setGroups(draftGroups)
    setPickerOpen(false)
    setLocalError('')
    try {
      await navigator.clipboard.writeText(pickerWords.join(', '))
      setNotice('已复制 ' + pickerWords.length + ' 个单词')
    } catch { setLocalError('复制失败，请检查浏览器剪贴板权限') }
  }

  function viewPassage(passage: Passage) {
    setPreview(passage)
    setLocalError('')
  }

  async function copyPreview() {
    if (!preview) return
    try {
      await navigator.clipboard.writeText(preview.content)
      setNotice('已复制短文内容')
      setLocalError('')
    } catch { setLocalError('复制失败，请检查浏览器剪贴板权限') }
  }

  async function copyContent() {
    if (!content.trim()) return
    try {
      await navigator.clipboard.writeText(content.trim())
      setNotice('已复制短文内容')
      setLocalError('')
    } catch { setLocalError('复制失败，请检查浏览器剪贴板权限') }
  }

  /** 保存当前内容，返回可用来标记的短文 id；内容没变时直接复用已保存的那篇 */
  async function ensureSaved() {
    if (!content.trim()) { setLocalError('请先粘贴短文内容'); return '' }
    if (currentPassage && !isDirty) return currentPassage.id
    setLocalError('')
    const result = await passages.save({
      id: savedId || undefined,
      title: passageTitleFromWords(matchedWords),
      content,
      // 匹配结果就是这批单词的快照，服务端再用它算一次 matchedWords
      sourceWords: matchedWords,
      groups: [],
    })
    if (!result.ok) return ''
    setSavedId(result.passage.id)
    setContent(result.passage.content)
    return result.passage.id
  }

  async function savePassage() {
    const id = await ensureSaved()
    if (!id) return
    setNotice('短文已保存，标题取自匹配到的单词，共匹配 ' + matchedWords.length + ' 个单词')
  }

  async function markAction(action: 'reading' | 'meaning') {
    if (matchedWords.length === 0 || passages.mutating) return
    // 没保存过或改过内容时先自动保存，标记不要求手动保存
    const id = await ensureSaved()
    if (!id) return
    const result = await passages.mark(id, action)
    if (!result.ok) return
    void achievements.reload()
    setNotice('已为 ' + result.marked + ' 个匹配单词增加' + (action === 'reading' ? '会读' : '知意') + '次数')
  }

  return (
    <div className="page page--wide passages-page">
      <PageHeader
        title="短文"
        subtitle="粘贴短文后自动匹配所有学习列表里的单词；右上角只用来复制选词清单。"
        actions={(
          <div className="passages-page__actions">
            <Button size="small" onClick={onBack}>返回</Button>
            <Button type="primary" size="small" onClick={openPicker}>选择单词</Button>
          </div>
        )}
      />

      {(localError || passages.error || achievements.error) && (
        <div className="callout callout--warn passages-page__notice">
          {localError || passages.error || achievements.error}
        </div>
      )}
      {notice && <div className="callout callout--success passages-page__notice">{notice}</div>}

      <section className="card card--pad passage-editor">
        <TextArea
          id="passage-content"
          value={content}
          rows={10}
          placeholder="把英文短文粘贴到这里"
          aria-label={FALLBACK_TITLE}
          onChange={event => setContent(event.target.value)}
        />
        <div className="passage-editor__actions">
          <Button type="primary" disabled={!hasContent || passages.mutating} loading={passages.mutating} onClick={() => void savePassage()}>保存短文</Button>
          <Button disabled={!hasContent} onClick={() => void copyContent()}>复制正文</Button>
          <span className="passage-editor__match">已匹配 {matchedWords.length} 个学习列表单词</span>
        </div>
      </section>

      {hasContent && (
        <section className="card card--pad passage-match">
          <div className="passages-page__section-head">
            <h2>匹配结果</h2>
          </div>
          {matchedWords.length === 0 ? (
            <p className="empty empty--inline">短文里还没有出现学习列表里的单词。</p>
          ) : (
            <>
              <div className="passage-match__summary">已匹配 {matchedWords.length} 个单词</div>
              <div className="passage-match__words">{matchedWords.map(item => <Tag key={item.word} color="blue">{displayWord(item.word)}</Tag>)}</div>
              <div className="passage-match__actions">
                <Button type="primary" disabled={!canMark || (!isDirty && currentPassage?.markedActions.includes('reading') === true) || passages.mutating} loading={passages.mutating} onClick={() => void markAction('reading')}>会读 +1（{matchedWords.length} 个）</Button>
                <Button type="primary" disabled={!canMark || (!isDirty && currentPassage?.markedActions.includes('meaning') === true) || passages.mutating} loading={passages.mutating} onClick={() => void markAction('meaning')}>知意 +1（{matchedWords.length} 个）</Button>
                {!isDirty && currentPassage?.markedActions.includes('reading') && <Tag color="green">已标记会读</Tag>}
                {!isDirty && currentPassage?.markedActions.includes('meaning') && <Tag color="green">已标记知意</Tag>}
              </div>
            </>
          )}
        </section>
      )}

      <section className="card card--pad passage-history">
        <div className="passages-page__section-head"><div><h2>已保存短文</h2><p>标题就是保存时匹配到的单词；点「打开」可以在弹窗里查看并复制原文。</p></div></div>
        {passages.loading ? <p className="empty"><span className="ui-spin" aria-hidden="true" />正在读取短文...</p> : passages.passages.length === 0 ? <p className="empty">还没有保存的短文。</p> : <div className="passage-history__list">{passages.passages.map(passage => <div className={'passage-history__item' + (passage.id === savedId ? ' passage-history__item--active' : '')} key={passage.id}><div className="passage-history__main"><strong className="passage-history__title" title={passage.title}>{passage.title}</strong><p>匹配 {passage.matchedWords.length} 个单词 · {new Date(passage.updatedAt).toLocaleDateString()}</p></div><Button size="small" onClick={() => viewPassage(passage)}>打开</Button></div>)}</div>}
      </section>

      <Modal
        open={preview != null}
        title="已保存短文"
        description={preview ? '匹配 ' + preview.matchedWords.length + ' 个单词 · ' + new Date(preview.updatedAt).toLocaleDateString() : undefined}
        width="wide"
        onClose={() => setPreview(null)}
        footer={(
          <>
            <Button onClick={() => setPreview(null)}>关闭</Button>
            <Button type="primary" onClick={() => void copyPreview()}>复制</Button>
          </>
        )}
      >
        {preview && <div className="passage-preview">{preview.content}</div>}
      </Modal>

      <Drawer
        open={pickerOpen}
        title="选择目标单词"
        description="按规则挑要复制的单词；抽屉只负责复制清单，不影响短文匹配。"
        width="wide"
        onClose={() => setPickerOpen(false)}
        footer={
          <>
            <span className="passage-picker__count">已选 {pickerWords.length} 个单词</span>
            <Button onClick={() => setPickerOpen(false)}>取消</Button>
            <Button type="primary" disabled={pickerWords.length === 0} onClick={() => void confirmPicker()}>复制</Button>
          </>
        }
      >
        <div className="passage-picker__toolbar">
          <span className="hint">同一个单词命中多组时只保留一次；复制出去的清单和短文匹配互不影响。</span>
          <Button size="small" onClick={addDraftGroup}>＋ 添加一组</Button>
        </div>
        {draftSelected.groups.map((group, index) => (
          <div className="passage-rule" key={group.id}>
            <div className="passage-rule__head">
              <Checkbox
                checked={group.enabled !== false}
                onChange={event => updateDraftGroup(group.id, { enabled: event.target.checked })}
              >
                纳入目标词
              </Checkbox>
              <Input value={group.name} aria-label={'第 ' + (index + 1) + ' 组名称'} onChange={event => updateDraftGroup(group.id, { name: event.target.value })} />
              <Button type="text" size="small" danger disabled={draftGroups.length === 1} onClick={() => removeDraftGroup(group.id)}>删除</Button>
            </div>
            <div className="passage-rule__fields">
              <div className="passage-rule__field passage-rule__field--rule">
                <label>选词规则</label>
                <Select aria-label="选择短文选词规则" value={group.rule} options={RULE_OPTIONS} onChange={value => updateDraftGroup(group.id, { rule: value as PassageRule })} />
              </div>
              {group.rule === 'stale' ? (
                <div className="passage-rule__field">
                  <label>未学习天数</label>
                  <Input type="number" min={1} max={3650} value={String(group.days ?? 14)} aria-label="超过多少天未学习" onChange={event => updateDraftGroup(group.id, { days: Math.max(1, Number(event.target.value) || 1) })} />
                  <span>距最近一次学习达到这个天数，才会进入本组候选。</span>
                </div>
              ) : group.rule === 'list-batch' ? (
                <>
                  <div className="passage-rule__field passage-rule__field--library">
                    <label>学习列表</label>
                    <Select
                      aria-label="选择学习列表"
                      value={group.listId ?? ''}
                      options={[{ value: '', label: study.lists.length > 0 ? '请选择学习列表' : '暂无学习列表' }, ...study.lists.map(list => ({ value: list.id, label: list.name }))]}
                      onChange={value => updateDraftGroup(group.id, { listId: value || undefined, batchKey: undefined })}
                    />
                  </div>
                  <div className="passage-rule__field passage-rule__field--library">
                    <label>列表分组</label>
                    <Select
                      aria-label="选择学习列表分组"
                      value={group.batchKey ?? ''}
                      options={[
                        { value: '', label: group.listId ? '请选择分组' : '先选择学习列表' },
                        ...studyBatches.filter(batch => batch.listId === group.listId).map(batch => ({
                          value: batch.batchKey,
                          label: batch.batchName + ' · ' + batch.words.length + ' 个词',
                        })),
                      ]}
                      disabled={!group.listId}
                      onChange={value => updateDraftGroup(group.id, { batchKey: value || undefined })}
                    />
                    <span>直接使用之前学习列表中的这一组单词。</span>
                  </div>
                </>
              ) : !group.rule.startsWith('never') ? (
                <div className="passage-rule__field">
                  <label>次数上限</label>
                  <Input type="number" min={0} max={1000} value={String(group.threshold ?? 1)} aria-label="次数阈值" onChange={event => updateDraftGroup(group.id, { threshold: Math.max(0, Number(event.target.value) || 0) })} />
                  <span>只选择该熟悉度次数不超过此值的单词。</span>
                </div>
              ) : <span className="passage-rule__fixed">固定为 0 次</span>}
              <div className="passage-rule__field">
                <label>选择数量</label>
                <Input type="number" min={1} max={300} value={String(group.count)} aria-label="复制数量" onChange={event => updateDraftGroup(group.id, { count: Math.max(1, Number(event.target.value) || 1) })} />
                <span>本组最多选出多少个单词。</span>
              </div>
              <div className="passage-rule__field passage-rule__field--library">
                <label>词库范围</label>
                <Select aria-label="按词库筛选目标单词" value={group.libraryId ?? ''} options={[{ value: '', label: '全部词库' }, ...libraries.map(library => ({ value: library.id, label: getLabelById(library.id) }))]} onChange={value => updateDraftGroup(group.id, { libraryId: value || undefined })} />
              </div>
            </div>
            <div className="passage-rule__meta">{group.enabled === false ? '本组未纳入本次目标词' : ruleDescription(group) + ' · 选择 ' + group.words.length + ' 个'}</div>
            {group.words.length > 0 && <div className="passage-rule__words">{group.words.map(word => <Tag key={word} color="blue">{displayWord(word)}</Tag>)}</div>}
          </div>
        ))}

        <div className="passage-picker__selected">
          <div className="passage-picker__selected-head">
            <h3>当前选择的单词</h3>
            <span className="passage-picker__count">共 {pickerWords.length} 个</span>
          </div>
          {pickerWords.length === 0
            ? <p className="empty empty--inline">还没有选出单词，调整上面的规则试试。</p>
            : <div className="passage-picker__words">{pickerWords.map(word => <Tag key={word} color="blue">{displayWord(word)}</Tag>)}</div>}
        </div>
      </Drawer>
    </div>
  )
}
