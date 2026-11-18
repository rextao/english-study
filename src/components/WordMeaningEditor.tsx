import { useMemo, useState } from 'react'
import { Button, Modal } from '../ui'
import type { DictionaryEntry, StudyWordItem } from '../types/vocab'
import { formatTranslationWithCustom, translationOptions } from '../utils/translations'
import { MAX_PICKED_TRANSLATIONS, TranslationChoices } from './TranslationChoices'
import './WordMeaningEditor.css'

/** 保存时回给列表页的三样东西：选中的词义 id、拼好的快照串、自定义词义 */
export interface WordMeaningPayload {
  translationIds: string[]
  translation: string
  customTranslations: string[]
}

interface WordMeaningEditorProps {
  /** 要改词义的那个词条 */
  item: StudyWordItem
  /** 词典缓存条目；没缓存时为 null，只能改自定义词义 */
  entry: DictionaryEntry | null
  onSave: (payload: WordMeaningPayload) => Promise<void>
  onCancel: () => void
}

/** 单词行「改词义」弹窗：复用批量导入那套按词性分组的词义勾选 + 自定义词义 */
export function WordMeaningEditor({ item, entry, onSave, onCancel }: WordMeaningEditorProps) {
  const available = useMemo(() => translationOptions(entry?.translations ?? []), [entry])
  // 打开时按已保存的选择回填；没有显式选择（= 自动全选）时把候选都勾上，和列表里显示的摘要一致
  const [picked, setPicked] = useState<string[]>(() => {
    const valid = (item.translationIds ?? []).filter(id => available.some(option => option.id === id))
    if (valid.length > 0) return valid.slice(0, MAX_PICKED_TRANSLATIONS)
    return available.slice(0, MAX_PICKED_TRANSLATIONS).map(option => option.id)
  })
  const [customs, setCustoms] = useState<string[]>(() => item.customTranslations ?? [])
  const [draft, setDraft]     = useState('')
  const [saving, setSaving]   = useState(false)

  const text = item.type === 'sentence' && item.displayText?.trim()
    ? item.displayText.trim()
    : item.word

  function toggle(id: string) {
    setPicked(prev => {
      if (prev.includes(id)) return prev.filter(optionId => optionId !== id)
      if (prev.length >= MAX_PICKED_TRANSLATIONS) return prev
      return prev.concat(id)
    })
  }

  function addCustom() {
    const value = draft.trim()
    if (!value) return
    setCustoms(prev => (prev.includes(value) ? prev : prev.concat(value)))
    setDraft('')
  }

  function removeCustom(index: number) {
    setCustoms(prev => prev.filter((_, i) => i !== index))
  }

  /** 清空 = 回到自动模式：不勾任何词义、不留自定义，服务端会退回词典默认摘要 */
  function clearAll() {
    setPicked([])
    setCustoms([])
    setDraft('')
  }

  async function submit() {
    // 词典缓存里还没这个词条时（离线 / 没补齐）只换自定义词义，保住原来的快照不被清掉
    const translation = entry
      ? formatTranslationWithCustom(available.filter(option => picked.includes(option.id)), customs)
      : (customs.length > 0 ? formatTranslationWithCustom([], customs) : (item.translation ?? ''))
    const translationIds = entry ? picked : (item.translationIds ?? [])
    setSaving(true)
    try {
      await onSave({ translationIds, translation, customTranslations: customs })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open
      width="wide"
      title="修改中文词义"
      description={text}
      onClose={onCancel}
      footer={
        <div className="word-meaning__footer">
          <Button
            type="link"
            size="small"
            title="清空选择并恢复成词典默认摘要"
            onClick={clearAll}
          >
            恢复默认
          </Button>
          <span className="word-meaning__buttons">
            <Button size="small" onClick={onCancel}>取消</Button>
            <Button
              type="primary"
              size="small"
              loading={saving}
              onClick={() => { void submit() }}
            >
              保存
            </Button>
          </span>
        </div>
      }
    >
      <div className="word-meaning">
        <div className="word-meaning__head">
          {item.phonetic && <span className="word-meaning__phonetic">{item.phonetic}</span>}
          <span className="word-meaning__count">已选 {picked.length} / {MAX_PICKED_TRANSLATIONS}</span>
        </div>
        <p className="hint word-meaning__current">
          {item.translation
            ? '当前：' + item.translation
            : '这个词还没有中文词义，可以直接从下面选或自己加'}
        </p>
        <TranslationChoices
          entry={entry}
          selected={picked}
          customs={customs}
          customDraft={draft}
          emptyText="词典缓存里还没有中文词义（可能还没补齐），可在下面自定义"
          onToggle={toggle}
          onCustomDraftChange={setDraft}
          onAddCustom={addCustom}
          onRemoveCustom={removeCustom}
        />
      </div>
    </Modal>
  )
}
