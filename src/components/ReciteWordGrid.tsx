import { useMemo, useState } from 'react'
import { Checkbox, Input } from '../ui'
import { groupStudyWords } from '../utils/studyWordGroups'
import type { StudyWordItem } from '../types/vocab'
import './ReciteTaskPanel.css'

/** 词形归一化：比较 / 去重都用它（与任务接口一致） */
export function wordKey(word: string): string {
  return word.trim().replace(/\s+/g, ' ').toLowerCase()
}

/** 选词的唯一键：同一个词在不同学习列表里算两个 */
export function selectionKeyOf(listId: string, word: string): string {
  return listId + '|' + wordKey(word)
}

/** 单词在选词网格里显示的文字：句子优先显示原文 */
export function wordLabelOf(item: StudyWordItem): string {
  return item.type === 'sentence' && item.displayText?.trim() ? item.displayText.trim() : item.word
}

interface ReciteWordGridProps {
  /** 当前学习列表 id：勾选键按它拼 */
  listId: string
  words: StudyWordItem[]
  batchNames: Record<string, string>
  selectedKeys: Set<string>
  onToggle: (item: StudyWordItem) => void
  /** 分组表头的「全选」：已全选时再点就是取消这一组 */
  onToggleGroup: (items: StudyWordItem[]) => void
  /** 词 → 本周还有几次也选了它，显示成（N），不禁选 */
  usedCounts?: Map<string, number>
  /** 超出容量、不会进最终任务的选择键：这些词的文字上直接划上横线 */
  overflowKeys?: Set<string>
  emptyText?: string
}

/**
 * 背词选词网格：搜索 + 按批次分组 + 每组「全选」。
 * 任务配置弹窗和主动推送弹窗共用，两边勾选手感完全一致。
 */
export function ReciteWordGrid({
  listId, words, batchNames, selectedKeys, onToggle, onToggleGroup, usedCounts, overflowKeys, emptyText,
}: ReciteWordGridProps) {
  const [search, setSearch] = useState('')

  const groups = useMemo(() => {
    const query = wordKey(search)
    const filtered = words.filter(item => !query || wordKey(wordLabelOf(item)).includes(query))
    return groupStudyWords(filtered, batchNames, Date.now())
  }, [words, batchNames, search])

  const keyOfItem = (item: StudyWordItem) => selectionKeyOf(listId, item.word)

  return (
    <>
      <Input
        block
        allowClear
        value={search}
        placeholder="搜索单词或句子"
        aria-label="搜索单词或句子"
        onChange={event => setSearch(event.target.value)}
        onClear={() => setSearch('')}
      />
      <div className="recite-task__groups">
        {groups.map(group => {
          const all = group.items.length > 0 && group.items.every(item => selectedKeys.has(keyOfItem(item)))
          return (
            <div key={group.key} className="recite-task__group">
              <div className="recite-task__group-head">
                <b>{group.label || '未分组'}</b>
                <Checkbox checked={all} onChange={() => onToggleGroup(group.items)}>全选</Checkbox>
              </div>
              <div className="recite-task__grid">
                {group.items.map(item => {
                  const used = usedCounts?.get(wordKey(item.word)) ?? 0
                  const itemKey = keyOfItem(item)
                  const overflow = overflowKeys?.has(itemKey) ?? false
                  return (
                    <Checkbox key={itemKey} checked={selectedKeys.has(itemKey)} onChange={() => onToggle(item)}>
                      <span
                        className={'recite-task__grid-word' + (overflow ? ' recite-task__grid-word--overflow' : '')}
                        title={overflow ? '已超出这次学习的词数上限，不会加入任务' : undefined}
                      >
                        {wordLabelOf(item)}
                      </span>
                      {used > 0 && <span className="recite-task__used">（{used}）</span>}
                    </Checkbox>
                  )
                })}
              </div>
            </div>
          )
        })}
        {groups.length === 0 && emptyText && <p className="hint">{emptyText}</p>}
      </div>
    </>
  )
}
