import type { ReactNode } from 'react'
import { Button, Checkbox, Input, Tag } from '../ui'
import type { DictionaryEntry } from '../types/vocab'
import { translationOptions, translationPosLabel } from '../utils/translations'
import './TranslationChoices.css'

// 批量导入的中文词义选择弹窗和列表页「改词义」共用这一块，
// 上限常量只在这里定义，别在两处各写一遍。

/** 一个词最多选 12 条中文词义 */
export const MAX_PICKED_TRANSLATIONS = 12
/** 与服务端 MAX_CUSTOM_TRANSLATIONS 一致：一个词最多 6 条自定义词义 */
export const MAX_CUSTOM_TRANSLATIONS = 6
/** 与服务端 MAX_CUSTOM_TRANSLATION_LEN 一致：单条自定义词义最多 60 字 */
export const MAX_CUSTOM_TRANSLATION_LEN = 60

interface TranslationChoicesProps {
  entry: DictionaryEntry | null
  /** 已勾选的中文词义 id */
  selected: string[]
  /** 已添加的自定义词义 */
  customs: string[]
  /** 自定义输入框里的草稿 */
  customDraft: string
  /** 查词失败的提示；有值时只显示这行提示，不再给选项 */
  failed?: string
  /** 失败提示后面补的话（导入要说明这一条不会导入） */
  failedText?: string
  /** 拿不到任何中文词义时的提示语（导入和改词义说法不一样） */
  emptyText?: ReactNode
  onToggle: (id: string) => void
  onCustomDraftChange: (value: string) => void
  onAddCustom: () => void
  onRemoveCustom: (index: number) => void
}

/** 按词性分组的词义勾选 + 自定义词义输入，导入弹窗与列表页改词义共用 */
export function TranslationChoices({
  entry, selected, customs, customDraft, failed, failedText, emptyText, onToggle,
  onCustomDraftChange, onAddCustom, onRemoveCustom,
}: TranslationChoicesProps) {
  const translations = translationOptions(entry?.translations ?? [])
  // 按词性分组：同一词性的词义排在一起，词性标签只出现一次
  const groups = new Map<string, ReturnType<typeof translationOptions>>()
  for (const item of translations) {
    const key = item.pos ?? ''
    const group = groups.get(key) ?? []
    group.push(item)
    groups.set(key, group)
  }
  return (
    <>
      {failed ? (
        <span className="translation-choices__error">查询失败：{failed}{failedText}</span>
      ) : translations.length > 0 ? (
        <div className="translation-choices__groups">
          {Array.from(groups.entries()).map(([pos, items]) => (
            <div className="translation-choices__group" key={pos || 'other'}>
              {pos && <span className="translation-choices__pos">{translationPosLabel(pos)}</span>}
              <div className="translation-choices__choices">
                {items.map(item => (
                  <Checkbox
                    key={item.id}
                    checked={selected.includes(item.id)}
                    disabled={!selected.includes(item.id) && selected.length >= MAX_PICKED_TRANSLATIONS}
                    onChange={() => onToggle(item.id)}
                  >
                    {item.text}
                  </Checkbox>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <span className="translation-choices__error">
          {emptyText ?? '未获取到中文词义；可在下面自定义一个'}
        </span>
      )}

      {!failed && (
        <div className="translation-choices__custom">
          {customs.map((text, index) => (
            <Tag
              key={index}
              color="green"
              title="点击移除这条自定义词义"
              onClick={() => onRemoveCustom(index)}
            >
              {text}
            </Tag>
          ))}
          <span className="translation-choices__custom-input">
            <Input
              size="small"
              value={customDraft}
              placeholder="自定义词义：词典里没有的也能自己加"
              maxLength={MAX_CUSTOM_TRANSLATION_LEN}
              onChange={e => onCustomDraftChange(e.target.value)}
              onPressEnter={onAddCustom}
            />
            <Button
              size="small"
              disabled={!customDraft.trim() || customs.length >= MAX_CUSTOM_TRANSLATIONS}
              onClick={onAddCustom}
            >
              添加
            </Button>
          </span>
        </div>
      )}
    </>
  )
}
