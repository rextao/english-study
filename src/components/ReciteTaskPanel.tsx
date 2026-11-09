import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, Checkbox, Input, Modal, Select } from '../ui'
import type { SelectOption } from '../ui'
import type { StudyListApi } from '../hooks/useStudyList'
import { fetchReciteTask, previewReciteTask, saveReciteTask } from '../hooks/useRecite'
import type { RecitePreview, ReciteTask, ReciteTaskWord } from '../hooks/useRecite'
import { groupStudyWords } from '../utils/studyWordGroups'
import type { StudyWordItem } from '../types/vocab'
import './ReciteTaskPanel.css'

const DAY = 86400000
/** 打开弹窗时的默认配置：每次 15 词、学习 3 次 */
const DEFAULT_PER_SESSION = 15
const DEFAULT_SESSION_COUNT = 3

interface ReciteTaskPanelProps {
  /** 弹窗是否打开 */
  open: boolean
  study: StudyListApi
  /** 要配置的周（周一 0 点），由点开弹窗的那一行任务决定 */
  weekStart: number
  /** 只改某一行时传 1-based 的第几次；不传 = 改整周 */
  focusSession?: number | null
  onClose: () => void
  /** 保存成功后通知学习页刷新复习计划里的任务标记 */
  onSaved: (task: ReciteTask, weekStart: number) => void
}

interface Selection {
  listId: string
  word: string
  sourceGroup?: string
}

function keyOf(word: string) { return word.trim().replace(/\s+/g, ' ').toLowerCase() }

function selectionKey(item: Selection) { return item.listId + '|' + keyOf(item.word) }

/** 一周的日期区间，如 11.9—11.15，与任务列表的日期写法一致 */
function fmtWeek(week: number): string {
  const a = new Date(week)
  const b = new Date(week + 6 * DAY)
  return (a.getMonth() + 1) + '.' + a.getDate() + '—' + (b.getMonth() + 1) + '.' + b.getDate()
}

function displayText(item: StudyWordItem) {
  return item.type === 'sentence' && item.displayText?.trim() ? item.displayText.trim() : item.word
}

function taskWordLabel(item: ReciteTaskWord) {
  return item.type === 'sentence' && item.displayText ? item.displayText : item.word
}

/** 任务是否已经开始学习：只要有一次会话记录（完成或进行中）就不能再改配置 */
function isStarted(task: ReciteTask | null): boolean {
  return Boolean(task && (task.completedSessions > 0 || task.activeSessionIndex != null))
}

/** 第 N 次是否已经学过：只有已完成的次数锁定；正在学习中的那一次可以改词（改完重置会话重新学） */
function sessionLocked(task: ReciteTask | null, session: number | null): boolean {
  if (!task || !session) return false
  return session <= task.completedSessions
}

export function ReciteTaskPanel({ open, study, weekStart, focusSession = null, onClose, onSaved }: ReciteTaskPanelProps) {
  const [existing, setExisting] = useState<ReciteTask | null>(null)
  const [taskLoading, setTaskLoading] = useState(false)
  const [perSessionCount, setPerSessionCount] = useState(DEFAULT_PER_SESSION)
  const [sessionCount, setSessionCount] = useState(DEFAULT_SESSION_COUNT)
  const [activeListId, setActiveListId] = useState(study.lists[0]?.id || '')
  const [listWords, setListWords] = useState<Record<string, StudyWordItem[]>>({})
  const [batchNames, setBatchNames] = useState<Record<string, Record<string, string>>>({})
  const [selected, setSelected] = useState<Selection[]>([])
  const [pickerOpen, setPickerOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [draftKeys, setDraftKeys] = useState<Set<string>>(new Set())
  const [taskPreview, setTaskPreview] = useState<RecitePreview | null>(null)
  const [spellingWords, setSpellingWords] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState<'preview' | 'save' | ''>('')
  const [error, setError] = useState('')
  /** 弹窗重新打开时作废上一次还没回来的读取请求 */
  const loadSeq = useRef(0)

  const options = useMemo<SelectOption[]>(() => study.lists.map(list => ({
    value: list.id, label: list.name, extra: list.wordCount + ' 词',
  })), [study.lists])

  /** 每周学习次数下拉：最多 7 次；已有任务配得更多时保留那一档，不至于显示成空值 */
  const sessionOptions = useMemo<SelectOption[]>(() => (
    Array.from({ length: Math.max(7, sessionCount) }, (_, index) => ({
      value: String(index + 1), label: String(index + 1),
    }))
  ), [sessionCount])

  const activeWords = listWords[activeListId] || []
  const activeGroups = useMemo(() => {
    const query = keyOf(search)
    const filtered = activeWords.filter(item => !query || keyOf(displayText(item)).includes(query))
    return groupStudyWords(filtered, batchNames[activeListId] || {}, Date.now())
  }, [activeWords, batchNames, activeListId, search])

  const started = isStarted(existing)

  /** 点某一行进来时只改那一次的词（1-based）；没传就是改整周 */
  const rowSession = focusSession && focusSession > 0 ? focusSession : null
  /** 正在改的是「学习中」的那一次：保存会作废这次会话，这一批单词要重新学 */
  const editingActive = Boolean(existing && rowSession != null && existing.activeSessionIndex === rowSession)
  /** 这一行按任务里的每次词数切分，改单行时不能改每次词数和次数（改了整周的行会重排） */
  const rowPer = Math.max(1, existing?.perSessionCount ?? perSessionCount)
  const rowScope = useMemo(() => {
    if (!rowSession || !existing) return null
    const per = Math.max(1, existing.perSessionCount)
    const start = (rowSession - 1) * per
    return { start, before: existing.words.slice(0, start), after: existing.words.slice(start + per) }
  }, [rowSession, existing])
  /** 本周其他次数用到的词 → 次数：选词时在单词后标成（N），不禁选 */
  const otherRowCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const item of rowScope ? [...rowScope.before, ...rowScope.after] : []) {
      const wordKey = keyOf(item.word)
      counts.set(wordKey, (counts.get(wordKey) ?? 0) + 1)
    }
    return counts
  }, [rowScope])
  /** 整周任务已开始、但这一次还没开始时，仍然可以改这一行的词 */
  const canEdit = !started || (rowSession != null && existing != null && !sessionLocked(existing, rowSession))
  const scopePer = rowSession ? rowPer : perSessionCount
  const scopeSessions = rowSession ? 1 : sessionCount
  const capacity = Math.max(1, scopePer) * Math.max(1, scopeSessions)

  // 选中的列表被删掉后回退到第一个列表
  useEffect(() => {
    if (!study.lists.some(list => list.id === activeListId)) setActiveListId(study.lists[0]?.id || '')
  }, [activeListId, study.lists])

  function resetForm() {
    setPerSessionCount(DEFAULT_PER_SESSION)
    setSessionCount(DEFAULT_SESSION_COUNT)
    setSelected([])
    setSpellingWords(new Set())
    setTaskPreview(null)
    setError('')
    setPickerOpen(false)
  }

  function applyExisting(task: ReciteTask | null) {
    setExisting(task)
    const editable = !task ? false : !isStarted(task) || (rowSession != null && !sessionLocked(task, rowSession))
    if (task && editable) {
      // 还没开始的任务直接回填表单，保存就等于修改这一周的任务；改单行时只回填这一行的词
      setPerSessionCount(task.perSessionCount)
      setSessionCount(task.sessionCount)
      const per = Math.max(1, task.perSessionCount)
      const pool = rowSession ? task.words.slice((rowSession - 1) * per, rowSession * per) : task.words
      if (rowSession && pool[0]?.listId) setActiveListId(pool[0].listId)
      setSelected(pool.map(word => ({
        listId: word.listId, word: word.word, sourceGroup: word.sourceGroup,
      })))
      setSpellingWords(new Set(task.words.filter(word => word.spellingEnabled).map(word => keyOf(word.word))))
    }
  }

  /** 读取这一周已存在的任务 */
  async function loadExisting(week: number) {
    const seq = ++loadSeq.current
    setTaskLoading(true)
    try {
      const task = await fetchReciteTask(week)
      if (seq !== loadSeq.current) return
      applyExisting(task)
      setError('')
    } catch (loadError) {
      if (seq !== loadSeq.current) return
      setExisting(null)
      setError(loadError instanceof Error ? loadError.message : '背词任务读取失败')
    } finally {
      if (seq === loadSeq.current) setTaskLoading(false)
    }
  }

  // 弹窗每次打开都按点开的这一周重置表单，再读这一周的任务
  useEffect(() => {
    if (!open) return
    resetForm()
    void loadExisting(weekStart)
  }, [open, weekStart])

  async function loadList(listId: string) {
    setActiveListId(listId)
    if (listWords[listId]) return
    const [words, names] = await Promise.all([study.fetchListWords(listId), study.fetchBatches(listId)])
    setListWords(current => ({ ...current, [listId]: words }))
    setBatchNames(current => ({ ...current, [listId]: names }))
  }

  async function openPicker() {
    setError('')
    await loadList(activeListId)
    setDraftKeys(new Set(selected.filter(item => item.listId === activeListId).map(selectionKey)))
    setSearch('')
    setPickerOpen(true)
  }

  function toggleDraft(item: StudyWordItem) {
    const selection = { listId: activeListId, word: item.word, sourceGroup: item.batchKey }
    const itemKey = selectionKey(selection)
    setDraftKeys(current => {
      const next = new Set(current)
      if (next.has(itemKey)) next.delete(itemKey)
      else next.add(itemKey)
      return next
    })
  }

  /** 这一组的词是否已全部勾上：是则再点一次就是取消全选 */
  function groupAllSelected(items: StudyWordItem[]) {
    return items.length > 0
      && items.every(item => draftKeys.has(selectionKey({ listId: activeListId, word: item.word })))
  }

  function toggleDraftGroup(items: StudyWordItem[]) {
    const allSelected = groupAllSelected(items)
    setDraftKeys(current => {
      const next = new Set(current)
      for (const item of items) {
        const itemKey = selectionKey({ listId: activeListId, word: item.word })
        if (allSelected) next.delete(itemKey)
        else next.add(itemKey)
      }
      return next
    })
  }

  function commitDraft() {
    const current = activeWords
      .filter(item => draftKeys.has(selectionKey({ listId: activeListId, word: item.word })))
      .map(item => ({ listId: activeListId, word: item.word, sourceGroup: item.batchKey }))
    const picked = new Set(current.map(item => keyOf(item.word)))
    // 这次在别的列表里重新选中同一个词时，以当前列表为准
    const other = selected.filter(item => item.listId !== activeListId && !picked.has(keyOf(item.word)))
    const seen = new Set(other.map(item => keyOf(item.word)))
    const merged = [...other]
    for (const item of current) {
      if (!seen.has(keyOf(item.word))) { merged.push(item); seen.add(keyOf(item.word)) }
    }
    setSelected(merged)
    setTaskPreview(null)
    setPickerOpen(false)
  }

  // 选了词、或改了每次词数 / 次数后自动生成任务预览（弹窗里不再放「预览任务」按钮）
  useEffect(() => {
    if (pickerOpen || !canEdit || selected.length === 0) return
    const timer = setTimeout(() => { void runPreview(selected, weekStart, scopePer, scopeSessions) }, 300)
    return () => clearTimeout(timer)
  }, [selected, scopePer, scopeSessions, pickerOpen, canEdit, weekStart])

  /** 生成任务预览：周 / 词数 / 次数显式传入，避免 setState 异步拿到旧值 */
  async function runPreview(selections: Selection[], week: number, perSession: number, sessions: number) {
    setBusy('preview')
    setError('')
    try {
      const result = await previewReciteTask({
        weekStart: week,
        perSessionCount: perSession,
        sessionCount: sessions,
        selections,
        // 改单行时自动填充要避开其他次数已用的词
        excludeWords: rowSession ? [...otherRowCounts.keys()] : undefined,
      })
      setTaskPreview(result)
      // 改整周时按预览收口拼写词；改单行时保留其他次数的拼写设置
      if (!rowSession) {
        setSpellingWords(current => new Set([...current].filter(word => result.words.some(item => keyOf(item.word) === word) || result.autoFilled.some(item => keyOf(item.word) === word))))
      }
    } catch (previewError) {
      setError(previewError instanceof Error ? previewError.message : '任务预览失败')
    } finally { setBusy('') }
  }

  /** 改单行时只提交这一行的词：服务端只替换这一行，其他次数原样保留 */
  function rowSelections(): Selection[] {
    const rowItems = taskPreview ? [...taskPreview.words, ...taskPreview.autoFilled] : []
    return (rowItems.length > 0 ? rowItems : selected).map(item => ({
      listId: item.listId, word: item.word, sourceGroup: item.sourceGroup,
    }))
  }

  async function saveTask() {
    if (!taskPreview) return
    setBusy('save')
    setError('')
    try {
      const current = existing
      const rowMode = Boolean(rowSession && current)
      const selections = rowMode ? rowSelections() : selected
      const used = selections.filter(item => otherRowCounts.has(keyOf(item.word)))
      if (used.length > 0) {
        setError('第 ' + rowSession + ' 次的 ' + used.slice(0, 3).map(item => item.word).join('、')
          + ' 本周其他次数也在用，先从那里去掉再选。')
        return
      }
      const task = await saveReciteTask({
        weekStart,
        perSessionCount: rowMode && current ? current.perSessionCount : perSessionCount,
        sessionCount: rowMode && current ? current.sessionCount : sessionCount,
        selections,
        spellingWords: [...spellingWords],
        session: rowMode ? rowSession ?? undefined : undefined,
      })
      onSaved(task, weekStart)
      onClose()
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '任务保存失败')
      // 保存失败时配置可能已经过期（例如任务已被开始），重读一次这一周的任务
      void loadExisting(weekStart)
    } finally { setBusy('') }
  }

  function handleClose() {
    if (busy !== '') return
    // 选词视图里点遮罩 / Esc 只退出选词，不关整个弹窗，草稿保留
    if (pickerOpen) setPickerOpen(false)
    else onClose()
  }

  const finalWords = taskPreview ? [...taskPreview.words, ...taskPreview.autoFilled] : []
  const modalTitle = pickerOpen ? '选择要学习的单词' : fmtWeek(weekStart)

  return (
    <Modal
      open={open}
      width="wide"
      title={modalTitle}
      description={pickerOpen
        ? '当前列表共 ' + activeWords.length + ' 个词；单词后的（N）表示本周有 N 次学习也选了它。'
        : undefined}
      onClose={handleClose}
      footer={
        <>
          {pickerOpen ? (
            <>
              <span className="recite-task__selected">当前列表已选 {draftKeys.size} 个</span>
              <Button type="text" disabled={busy !== ''} onClick={() => setPickerOpen(false)}>取消</Button>
              <Button type="primary" onClick={commitDraft}>确定</Button>
            </>
          ) : (
            <>
              <Button disabled={busy !== ''} onClick={onClose}>关闭</Button>
              {canEdit && (
                <Button
                  type="primary"
                  disabled={!taskPreview || busy !== ''}
                  onClick={() => { void saveTask() }}
                >
                  {busy === 'save' ? '保存中...' : '保存任务'}
                </Button>
              )}
            </>
          )}
        </>
      }
    >
      {pickerOpen ? (
        <>
          <Input block allowClear value={search} placeholder="搜索单词或句子" aria-label="搜索单词或句子" onChange={event => setSearch(event.target.value)} onClear={() => setSearch('')} />
          <div className="recite-task__groups">
            {activeGroups.map(group => {
              const all = groupAllSelected(group.items)
              return <div key={group.key} className="recite-task__group">
                <div className="recite-task__group-head"><b>{group.label || '未分组'}</b><Checkbox checked={all} onChange={() => toggleDraftGroup(group.items)}>全选</Checkbox></div>
                <div className="recite-task__grid">{group.items.map(item => {
                  const itemKey = selectionKey({ listId: activeListId, word: item.word })
                  const used = otherRowCounts.get(keyOf(item.word)) ?? 0
                  return <Checkbox key={itemKey} checked={draftKeys.has(itemKey)} onChange={() => toggleDraft(item)}>
                    {displayText(item)}
                    {used > 0 && <span className="recite-task__used">（{used}）</span>}
                  </Checkbox>
                })}</div>
              </div>
            })}
          </div>
        </>
      ) : taskLoading ? (
        <p className="recite-task__loading">正在读取这一周的任务…</p>
      ) : (
        !canEdit ? (
          <section className="recite-task__section">
            <h3 className="recite-task__section-title">任务状态</h3>
            <div className="recite-task__status">
              <p><b>每次 {existing?.perSessionCount} 词 · 共 {existing?.sessionCount} 次</b></p>
              <p className="hint">已完成 {existing?.completedSessions} / {existing?.sessionCount} 次学习，任务已开始，配置锁定不能修改。</p>
            </div>
          </section>
        ) : (
          <>
            <section className="recite-task__section">
              <div className="recite-task__row">
                {!rowSession && (
                  <>
                    <div className="recite-task__field recite-task__field--count">
                      <label className="field-label" htmlFor="recite-per-session">每次学习单词数</label>
                      <Input id="recite-per-session" type="number" min={1} max={200} value={String(perSessionCount)} onChange={event => { setPerSessionCount(Math.max(1, Number(event.target.value) || 1)); setTaskPreview(null) }} />
                    </div>
                    <div className="recite-task__field recite-task__field--sessions">
                      <label className="field-label" htmlFor="recite-session-count">每周学习次数</label>
                      <Select
                        id="recite-session-count"
                        block={false}
                        value={String(sessionCount)}
                        options={sessionOptions}
                        aria-label="每周学习次数"
                        onChange={value => { setSessionCount(Number(value) || 1); setTaskPreview(null) }}
                      />
                    </div>
                  </>
                )}
                <div className="recite-task__field recite-task__field--list">
                  <label className="field-label" htmlFor="recite-list">学习列表</label>
                  <Select
                    id="recite-list"
                    block={false}
                    value={activeListId}
                    options={options}
                    aria-label="选择学习列表"
                    onChange={value => { void loadList(value) }}
                  />
                </div>
                <div className="recite-task__pick">
                  <Button onClick={() => { void openPicker() }} disabled={!activeListId}>选择单词</Button>
                  <span className="recite-task__selected">已选择 {selected.length} 个</span>
                </div>
              </div>

              {rowSession
                ? <p className="hint">只改第 {rowSession} 次的单词（每次 {Math.max(1, scopePer)} 个），其他次数保持不动。</p>
                : existing && <p className="hint">这一周已有任务，保存会覆盖现有配置。</p>}
              {editingActive && (
                <p className="callout callout--warn">这一次正在学习中：保存后已学的判定会清空，需要重新学这一批单词。</p>
              )}
              {selected.length > capacity && <p className="callout callout--warn">已选择 {selected.length} 个，超出容量的 {selected.length - capacity} 个将被忽略。</p>}
              {selected.length < capacity && <p className="hint">还缺少 {capacity - selected.length} 个，预览时将从学习成果的最近学习逆序自动填充。</p>}

              {error && <p className="callout callout--error">{error}</p>}
              {taskPreview && (
                <div className="recite-task__preview">
                  <div className="recite-task__preview-head"><b>任务预览</b><span>普通卡 {finalWords.length} 个 · 拼写词 {spellingWords.size} 个</span></div>
                  <div className="recite-task__word-list">
                    {finalWords.map(item => {
                      const wordKey = keyOf(item.word)
                      return <label key={item.listId + '|' + wordKey} className="recite-task__word">
                        <Checkbox checked={spellingWords.has(wordKey)} onChange={() => setSpellingWords(current => { const next = new Set(current); if (next.has(wordKey)) next.delete(wordKey); else next.add(wordKey); return next })}>
                          {taskWordLabel(item)}
                        </Checkbox>
                        <span>{item.sourceType === 'achievement' ? '自动填充 · 学习成果' : item.listId}</span>
                      </label>
                    })}
                  </div>
                  {taskPreview.ignored.length > 0 && <p className="hint">容量忽略 {taskPreview.ignored.length} 个，未从学习列表删除。</p>}
                </div>
              )}
            </section>
          </>
        )
      )}
    </Modal>
  )
}

