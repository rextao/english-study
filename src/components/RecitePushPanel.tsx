import { useEffect, useMemo, useState } from 'react'
import { Button, Checkbox, Modal, Select } from '../ui'
import type { SelectOption } from '../ui'
import type { StudyListApi } from '../hooks/useStudyList'
import { pushReciteWords } from '../hooks/useRecite'
import type { ReciteTask } from '../hooks/useRecite'
import { ReciteWordGrid, selectionKeyOf, wordKey } from './ReciteWordGrid'
import type { StudyWordItem } from '../types/vocab'
import './ReciteTaskPanel.css'

const DAY = 86400000

interface RecitePushPanelProps {
  open: boolean
  study: StudyListApi
  /** 要推送到的周（周一 0 点） */
  weekStart: number
  /** 有进行中的会话时不能推送，原因直接写在弹窗里 */
  blockedReason?: string
  onClose: () => void
  onPushed: (task: ReciteTask) => void
}

/** 选中的词：带上类型和释义，才能判断这个词能不能出拼写卡 */
interface Pick {
  listId: string
  word: string
  type: string
  translation: string
}

/** 一周的日期区间，如 11.9—11.15，与任务列表的日期写法一致 */
function fmtWeek(week: number): string {
  const a = new Date(week)
  const b = new Date(week + 6 * DAY)
  return (a.getMonth() + 1) + '.' + a.getDate() + '—' + (b.getMonth() + 1) + '.' + b.getDate()
}

/**
 * 主动推送一批单词：没有进行中的会话时才能推。
 * 先选词、再确认（和行内配置弹窗一样在这一步勾拼写），推送后本周新增一次学习（次数 +1）。
 */
export function RecitePushPanel({ open, study, weekStart, blockedReason, onClose, onPushed }: RecitePushPanelProps) {
  const [activeListId, setActiveListId] = useState(study.lists[0]?.id || '')
  const [listWords, setListWords] = useState<Record<string, StudyWordItem[]>>({})
  const [batchNames, setBatchNames] = useState<Record<string, Record<string, string>>>({})
  const [selected, setSelected] = useState<Pick[]>([])
  const [spelling, setSpelling] = useState<Set<string>>(new Set())
  const [step, setStep] = useState<'pick' | 'confirm'>('pick')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const options = useMemo<SelectOption[]>(() => study.lists.map(list => ({
    value: list.id, label: list.name, extra: list.wordCount + ' 词',
  })), [study.lists])

  const selectedKeys = useMemo(
    () => new Set(selected.map(item => selectionKeyOf(item.listId, item.word))),
    [selected],
  )

  const activeWords = listWords[activeListId] || []
  /** 推送的会话里只有词（不含句子）且有释义的才出拼写卡，和计划里的一次同一套规则 */
  const spellingReady = selected.filter(item => item.type === 'word' && Boolean(item.translation))

  // 选中的列表被删掉后回退到第一个列表
  useEffect(() => {
    if (!study.lists.some(list => list.id === activeListId)) setActiveListId(study.lists[0]?.id || '')
  }, [activeListId, study.lists])

  async function loadList(listId: string) {
    setActiveListId(listId)
    if (!listId || listWords[listId]) return
    try {
      const [words, names] = await Promise.all([study.fetchListWords(listId), study.fetchBatches(listId)])
      setListWords(current => ({ ...current, [listId]: words }))
      setBatchNames(current => ({ ...current, [listId]: names }))
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '学习列表读取失败')
    }
  }

  // 每次打开都从「选词」开始，清空上一次的选择
  useEffect(() => {
    if (!open) return
    setSelected([])
    setSpelling(new Set())
    setStep('pick')
    setError('')
  }, [open])

  // 打开期间保证当前列表的词已经读过（列表数据晚到也能补上）
  useEffect(() => {
    if (open && activeListId) void loadList(activeListId)
  }, [open, activeListId])

  function toggleWord(item: StudyWordItem) {
    const pick: Pick = {
      listId: activeListId,
      word: item.word,
      type: item.type,
      translation: typeof item.translation === 'string' ? item.translation : '',
    }
    const key = selectionKeyOf(pick.listId, pick.word)
    setSelected(current => (
      current.some(entry => selectionKeyOf(entry.listId, entry.word) === key)
        ? current.filter(entry => selectionKeyOf(entry.listId, entry.word) !== key)
        : [...current, pick]
    ))
  }

  function toggleGroup(items: StudyWordItem[]) {
    const keys = new Set(items.map(item => selectionKeyOf(activeListId, item.word)))
    const all = items.length > 0 && items.every(item => selectedKeys.has(selectionKeyOf(activeListId, item.word)))
    setSelected(current => (
      all
        ? current.filter(entry => !keys.has(selectionKeyOf(entry.listId, entry.word)))
        : [
            ...current,
            ...items
              .filter(item => !selectedKeys.has(selectionKeyOf(activeListId, item.word)))
              .map(item => ({
                listId: activeListId,
                word: item.word,
                type: item.type,
                translation: typeof item.translation === 'string' ? item.translation : '',
              })),
          ]
    ))
  }

  function toggleSpelling(item: Pick) {
    const key = wordKey(item.word)
    setSpelling(current => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  async function push() {
    if (blockedReason || busy) return
    if (selected.length === 0) {
      setError('先选要推送的单词')
      return
    }
    setBusy(true)
    setError('')
    try {
      const result = await pushReciteWords({
        weekStart,
        selections: selected.map(item => ({ listId: item.listId, word: item.word })),
        spellingWords: [...spelling],
      })
      onPushed(result.task)
      onClose()
    } catch (pushError) {
      setError(pushError instanceof Error ? pushError.message : '推送失败，请重试')
    } finally {
      setBusy(false)
    }
  }

  const title = step === 'pick' ? '推送一批单词 · ' + fmtWeek(weekStart) : '确认推送 · ' + fmtWeek(weekStart)
  const description = step === 'pick'
    ? '推送会在本周新增一次学习（次数 +1）并直接开始，孩子下次打开背词页就是这批词。'
    : '勾上要出拼写卡的词（和配置任务时一样）；当天没学完的，第二天按「不会」收尾。'

  return (
    <Modal
      open={open}
      width="wide"
      title={title}
      description={description}
      onClose={onClose}
      footer={step === 'pick' ? (
        <>
          <span className="recite-task__selected">已选择 {selected.length} 个</span>
          <Button disabled={busy} onClick={onClose}>取消</Button>
          <Button type="primary" disabled={selected.length === 0 || Boolean(blockedReason)} onClick={() => setStep('confirm')}>
            下一步
          </Button>
        </>
      ) : (
        <>
          <span className="recite-task__selected">
            普通卡 {selected.length} 个 · 拼写词 {spelling.size} 个
          </span>
          <Button type="text" disabled={busy} onClick={() => setStep('pick')}>返回选词</Button>
          <Button disabled={busy} onClick={onClose}>取消</Button>
          <Button type="primary" disabled={busy || Boolean(blockedReason)} onClick={() => { void push() }}>
            {busy ? '推送中...' : '推送'}
          </Button>
        </>
      )}
    >
      {blockedReason && <p className="callout callout--warn">{blockedReason}</p>}

      {step === 'pick' ? (
        <section className="recite-task__section">
          <div className="recite-task__row">
            <div className="recite-task__field recite-task__field--list">
              <label className="field-label" htmlFor="recite-push-list">学习列表</label>
              <Select
                id="recite-push-list"
                block={false}
                value={activeListId}
                options={options}
                aria-label="选择学习列表"
                onChange={value => { void loadList(value) }}
              />
            </div>
            <div className="recite-task__pick">
              <span className="recite-task__selected">当前列表共 {activeWords.length} 个词</span>
            </div>
          </div>

          {error && <p className="callout callout--error">{error}</p>}

          <ReciteWordGrid
            listId={activeListId}
            words={activeWords}
            batchNames={batchNames[activeListId] || {}}
            selectedKeys={selectedKeys}
            onToggle={toggleWord}
            onToggleGroup={toggleGroup}
            emptyText="这个学习列表还没有单词。"
          />
        </section>
      ) : (
        <section className="recite-task__section">
          {error && <p className="callout callout--error">{error}</p>}
          <div className="recite-task__preview">
            <div className="recite-task__preview-head">
              <b>这次推送的单词</b>
              <span>普通卡 {selected.length} 个 · 拼写词 {spelling.size} 个</span>
            </div>
            <div className="recite-task__word-list">
              {selected.map(item => {
                const key = wordKey(item.word)
                const canSpell = spellingReady.some(entry => wordKey(entry.word) === key)
                return (
                  <label key={selectionKeyOf(item.listId, item.word)} className="recite-task__word">
                    <Checkbox
                      checked={spelling.has(key)}
                      disabled={!canSpell}
                      onChange={() => toggleSpelling(item)}
                    >
                      {item.word}
                    </Checkbox>
                    <span>{canSpell ? '会拼 / 知意' : '只有知意卡'}</span>
                  </label>
                )
              })}
            </div>
            {selected.length === 0 && <p className="empty empty--inline">还没有选词，返回上一步选几个。</p>}
          </div>
        </section>
      )}
    </Modal>
  )
}
