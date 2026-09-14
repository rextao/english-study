import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, Checkbox, Modal, Tag } from '../ui'
import type { DictionaryEntry } from '../types/vocab'
import { translationOptions, translationPosLabel } from '../utils/translations'
import './TranslationPicker.css'

const MAX_PICKED = 12

interface TranslationPickerProps {
  entry: DictionaryEntry | null
  value: string[]
  title?: ReactNode
  extra?: ReactNode
  okText?: string
  okDisabled?: boolean
  onSubmit: (translationIds: string[]) => void | Promise<void>
  onCancel: () => void
}

export function TranslationPicker({
  entry, value, title = '选择要背的中文词义', extra, okText = '加入学习',
  okDisabled = false, onSubmit, onCancel,
}: TranslationPickerProps) {
  const initial = useMemo(() => {
    const available = translationOptions(entry?.translations ?? [])
    const valid = value.filter(id => available.some(item => item.id === id))
    return valid.length > 0 ? valid : available.slice(0, MAX_PICKED).map(item => item.id)
  }, [entry, value])
  const [picked, setPicked] = useState(initial)
  const [saving, setSaving] = useState(false)
        const translations = translationOptions(entry?.translations ?? [])

  function toggle(id: string) {
    setPicked(prev => {
      if (prev.includes(id)) return prev.filter(item => item !== id)
      if (prev.length >= MAX_PICKED) return prev
      return prev.concat(id)
    })
  }

  async function submit() {
    setSaving(true)
    try { await onSubmit(picked) } finally { setSaving(false) }
  }

  return (
    <Modal
      open
      width="wide"
      title={title}
      description={entry?.word}
      onClose={onCancel}
      footer={
        <div className="translation-picker__footer">
          <Button type="link" size="small" disabled={picked.length === 0} onClick={() => setPicked([])}>
            清空
          </Button>
          <span className="translation-picker__buttons">
            <Button size="small" onClick={onCancel}>取消</Button>
            <Button type="primary" size="small" loading={saving} disabled={okDisabled} onClick={() => { void submit() }}>
              {okText}
            </Button>
          </span>
        </div>
      }
    >
      <div className="translation-picker">
        <div className="translation-picker__head">
          {entry?.phonetic && <span className="translation-picker__phonetic">{entry.phonetic}</span>}
          {entry?.source && <Tag color={entry.source === 'ecdict' ? 'green' : 'blue'}>{entry.source === 'ecdict' ? '本地词典' : '在线翻译'}</Tag>}
          <span className="translation-picker__count">已选 {picked.length} / {MAX_PICKED}</span>
        </div>
        {translations.length === 0 ? (
          <p className="hint">暂时没有中文词义，仍可加入；词典补齐后会自动显示。</p>
        ) : (
          <div className="translation-picker__list">
            {translations.map(item => (
              <Checkbox
                key={item.id}
                checked={picked.includes(item.id)}
                disabled={!picked.includes(item.id) && picked.length >= MAX_PICKED}
                onChange={() => toggle(item.id)}
              >
                <span>{item.text}</span>
                {item.pos && <span className="translation-picker__pos">{translationPosLabel(item.pos)}</span>}
              </Checkbox>
            ))}
          </div>
        )}
        <p className="hint translation-picker__tip">
          {translations.length > 0
            ? '默认全选已有中文词义；只勾选这一阶段需要背的内容。'
            : '没有中文词义时可以先加入，之后会自动补齐。'}
        </p>
        {extra}
      </div>
    </Modal>
  )
}
