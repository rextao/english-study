import { useEffect, useMemo, useState } from 'react'

import { useGameConfig } from '../hooks/useGameConfig'
import type { StudyList, StudyWordItem } from '../types/vocab'
import type { SelectOption } from '../ui'
import { ENGLISH_WORD_INPUT_PROPS, Button, Checkbox, Input, Modal, Select, Tag } from '../ui'
import { groupStudyWords } from '../utils/studyWordGroups'
import { WordSelectionGroups } from './WordSelectionGroups'

interface GameSettingsProps {
  lists: StudyList[]
  fetchListWords: (listId: string) => Promise<StudyWordItem[]>
  fetchBatches: (listId: string) => Promise<Record<string, string>>
}

/**
 * 设置页「单词游戏」分区：无尽模式的取词范围，两层。
 * 1. 学习列表：勾选若干列表，一个不勾 = 全部学习列表（默认）。
 * 2. 具体单词：可选地从这些列表里挑一批词，挑了就只在这些词里抽。
 * 常规模式用本周背词任务的单词，不受这里影响。
 */
export function GameSettings({ lists, fetchListWords, fetchBatches }: GameSettingsProps) {
  const { config, loading, offline, save } = useGameConfig()
  const [selected, setSelected] = useState<string[]>([])
  const [words, setWords] = useState<string[]>([])
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [pickerOpen, setPickerOpen] = useState(false)

  // 配置读回来后回填；保存成功后 config 换了一份，这里同步成服务端的最终结果
  useEffect(() => {
    if (loading) return
    setSelected(config.endlessListIds)
    setWords(config.endlessWords)
    setDirty(false)
  }, [loading, config.endlessListIds, config.endlessWords])

  const scopedLists = selected.length > 0 ? lists.filter(list => selected.includes(list.id)) : lists
  const scopeListOptions: SelectOption[] = scopedLists.map(list => ({
    value: list.id,
    label: list.name,
    extra: list.wordCount + ' 词',
  }))

  const scopeText = selected.length === 0 ? '全部学习列表' : selected.length + ' 个学习列表'
  const wordText = words.length === 0 ? '范围内全部单词' : words.length + ' 个指定单词'

  function toggle(listId: string, checked: boolean) {
    setSelected(prev => checked ? [...prev, listId] : prev.filter(id => id !== listId))
    setDirty(true)
    setMessage('')
  }

  async function handleSave() {
    setSaving(true)
    const ok = await save({ endlessListIds: selected, endlessWords: words })
    setSaving(false)
    if (ok) {
      setDirty(false)
      setMessage('已保存，下一回合开始生效。')
    } else {
      setMessage('保存失败，请检查云端服务是否可用。')
    }
  }

  return (
    <div className="game-settings">
      <p className="hint">
        无尽模式每回合从这个范围里随机抽 20 个单词，一批一批换着玩。
        先选学习列表（不选就是全部），要的话再从这些列表里挑一批具体的词；常规模式用本周背词任务的单词，不受这里影响。
      </p>

      {offline && (
        <div className="callout callout--warn">无法读取单词游戏配置，请确认云端 Worker 已部署且访问令牌正确。</div>
      )}

      <div className="game-settings__head">
        <span className="game-settings__title">学习列表范围</span>
        <Tag color={selected.length === 0 ? 'default' : 'green'}>{scopeText}</Tag>
        {selected.length > 0 && (
          <Button
            size="small"
            onClick={() => { setSelected([]); setDirty(true); setMessage('') }}
          >
            改成全部学习列表
          </Button>
        )}
      </div>

      {loading ? (
        <p className="hint">正在读取配置…</p>
      ) : lists.length === 0 ? (
        <p className="empty">还没有学习列表，先去查词页加几个单词吧。</p>
      ) : (
        <div className="game-settings__lists">
          {lists.map(list => (
            <Checkbox
              key={list.id}
              checked={selected.includes(list.id)}
              onChange={event => toggle(list.id, event.target.checked)}
            >
              {list.name}
              <span className="game-settings__count">{list.wordCount} 个词</span>
            </Checkbox>
          ))}
        </div>
      )}

      <div className="game-settings__head">
        <span className="game-settings__title">单词范围</span>
        <Tag color={words.length === 0 ? 'default' : 'green'}>{wordText}</Tag>
        <Button
          size="small"
          disabled={scopeListOptions.length === 0}
          onClick={() => setPickerOpen(true)}
        >
          {words.length > 0 ? '重新挑选单词' : '挑选单词'}
        </Button>
        {words.length > 0 && (
          <Button
            size="small"
            onClick={() => { setWords([]); setDirty(true); setMessage('') }}
          >
            清空指定单词
          </Button>
        )}
      </div>

      <div className="game-settings__foot">
        <Button type="primary" disabled={!dirty || saving} onClick={handleSave}>
          {saving ? '保存中…' : '保存'}
        </Button>
        {message && <span className="game-settings__message">{message}</span>}
      </div>

      {pickerOpen && (
        <GameWordPicker
          listOptions={scopeListOptions}
          initialListId={scopeListOptions[0]?.value ?? ''}
          selectedWords={words}
          fetchListWords={fetchListWords}
          fetchBatches={fetchBatches}
          onClose={() => setPickerOpen(false)}
          onConfirm={next => {
            setWords(next)
            setDirty(true)
            setMessage('')
            setPickerOpen(false)
          }}
        />
      )}
    </div>
  )
}

interface GameWordPickerProps {
  listOptions: SelectOption[]
  initialListId: string
  selectedWords: string[]
  fetchListWords: GameSettingsProps['fetchListWords']
  fetchBatches: GameSettingsProps['fetchBatches']
  onClose: () => void
  onConfirm: (words: string[]) => void
}

/**
 * 挑选游戏单词弹窗：和学习页「挑选单词打印」同一个分组选择区（WordSelectionGroups），
 * 只是不打印、改成把选中的词当成游戏取词范围。句子不进游戏，这里不列出来。
 */
function GameWordPicker({
  listOptions, initialListId, selectedWords, fetchListWords, fetchBatches, onClose, onConfirm,
}: GameWordPickerProps) {
  const [listId, setListId] = useState(initialListId)
  const [words, setWords] = useState<StudyWordItem[]>([])
  const [loading, setLoading] = useState(true)
  const [batchNames, setBatchNames] = useState<Record<string, string>>({})
  const [search, setSearch] = useState('')
  const [draft, setDraft] = useState<string[]>(selectedWords)

  useEffect(() => {
    let alive = true
    setLoading(true)
    fetchListWords(listId).then(items => {
      if (!alive) return
      setWords(items)
      setLoading(false)
    })
    fetchBatches(listId).then(names => {
      if (alive) setBatchNames(names)
    })
    return () => { alive = false }
  }, [listId, fetchListWords, fetchBatches])

  /** 只有单词能进游戏：句子卡和不带中文释义的词都不给选 */
  const gameWords = useMemo(
    () => words.filter(item => item.type === 'word' && (item.translation ?? '').trim() !== ''),
    [words],
  )

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) return gameWords
    return gameWords.filter(item => item.word.toLowerCase().includes(query))
  }, [gameWords, search])

  const groups = useMemo(() => groupStudyWords(filtered, batchNames, Date.now()), [filtered, batchNames])
  const draftSet = useMemo(() => new Set(draft), [draft])
  const listName = listOptions.find(item => item.value === listId)?.label ?? '学习列表'

  function toggleWord(word: string) {
    setDraft(prev => prev.includes(word) ? prev.filter(item => item !== word) : prev.concat(word))
  }

  function toggleGroup(items: StudyWordItem[]) {
    const groupWords = items.map(item => item.word)
    setDraft(prev => groupWords.every(word => prev.includes(word))
      ? prev.filter(word => !groupWords.includes(word))
      : prev.concat(groupWords.filter(word => !prev.includes(word))))
  }

  function selectAllFiltered() {
    setDraft(prev => Array.from(new Set(prev.concat(filtered.map(item => item.word)))))
  }

  return (
    <Modal
      open
      width="wide"
      title={'挑选游戏单词 · ' + listName}
      description="只选单词（句子不进游戏）。挑好的词会作为无尽模式的取词范围。"
      onClose={onClose}
      footer={
        <>
          <span className="pick-modal__count">已选 {draft.length} 个</span>
          <Button type="text" onClick={onClose}>取消</Button>
          <Button type="primary" disabled={draft.length === 0} onClick={() => onConfirm(draft)}>
            确定
          </Button>
        </>
      }
    >
      {listOptions.length > 1 && (
        <div className="pick-modal__history">
          <label className="field-label" htmlFor="game-word-list">学习列表</label>
          <Select
            id="game-word-list"
            aria-label="挑选单词的学习列表"
            value={listId}
            options={listOptions}
            onChange={setListId}
          />
        </div>
      )}

      <Input
        {...ENGLISH_WORD_INPUT_PROPS}
        block
        allowClear
        value={search}
        placeholder="搜索单词"
        aria-label="搜索要加入游戏范围的单词"
        onChange={event => setSearch(event.target.value)}
        onClear={() => setSearch('')}
      />

      <div className="pick-modal__quick pick-modal__quick--search">
        <Button type="link" size="small" disabled={filtered.length === 0} onClick={selectAllFiltered}>
          全选当前结果
        </Button>
        <Button type="link" size="small" disabled={draft.length === 0} onClick={() => setDraft([])}>清空</Button>
        <span className="pick-modal__result">找到 {filtered.length} 个</span>
      </div>

      {loading ? (
        <p className="hint">正在读取词条…</p>
      ) : filtered.length === 0 ? (
        <p className="empty empty--inline">这个列表里还没有能进游戏的单词。</p>
      ) : (
        <WordSelectionGroups
          groups={groups}
          selectedWords={draftSet}
          onToggleWord={toggleWord}
          onToggleGroup={toggleGroup}
        />
      )}
    </Modal>
  )
}
