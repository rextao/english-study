import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, Checkbox } from '../ui'
import type { DictionaryEntry, DictionarySense } from '../types/vocab'
import './SensePicker.css'

/** 与服务端 MAX_PICKED_SENSES 保持一致 */
const MAX_PICKED = 12

export interface SensePickerProps {
  entry: DictionaryEntry | null
  /** 已经勾上的释义 id */
  value: string[]
  /** 插在按钮上方的额外内容，例如「加到哪个列表」 */
  extra?: ReactNode
  okText?: string
  okDisabled?: boolean
  onSubmit: (senseIds: string[]) => void | Promise<void>
  onCancel?: () => void
}

/** 挑这一阶段要背的释义：词典缓存里存全集，这里只勾要背的子集 */
export function SensePicker({
  entry,
  value,
  extra,
  okText = '保存',
  okDisabled = false,
  onSubmit,
  onCancel,
}: SensePickerProps) {
  // Popover 收起时整个面板会卸载，所以草稿直接拿初值就够，不用同步 props
  const [picked, setPicked] = useState<string[]>(value)
  const [saving, setSaving] = useState(false)

  // 按词性归组，保持缓存里的原始顺序
  const groups = useMemo(() => {
    const order: string[] = []
    const byPos = new Map<string, DictionarySense[]>()
    for (const sense of entry?.senses ?? []) {
      const bucket = byPos.get(sense.pos)
      if (bucket) {
        bucket.push(sense)
        continue
      }
      byPos.set(sense.pos, [sense])
      order.push(sense.pos)
    }
    return order.map((pos) => ({ pos, items: byPos.get(pos) ?? [] }))
  }, [entry])

  function toggle(id: string) {
    setPicked((prev) => {
      if (prev.includes(id)) return prev.filter((item) => item !== id)
      if (prev.length >= MAX_PICKED) return prev
      return prev.concat(id)
    })
  }

  async function handleSubmit() {
    setSaving(true)
    await onSubmit(picked)
    setSaving(false)
  }

  const full = picked.length >= MAX_PICKED

  return (
    <div className="sense-picker">
      <div className="sense-picker__head">
        {entry?.phonetic
          ? <span className="sense-picker__phonetic">{entry.phonetic}</span>
          : <span className="sense-picker__phonetic sense-picker__phonetic--none">音标待补齐</span>}
        <span className="sense-picker__cn">{entry?.translation || '暂无中文释义'}</span>
      </div>

      {groups.length === 0 ? (
        <p className="hint sense-picker__empty">
          还没有英文释义，保存后会自动去补一次。
        </p>
      ) : (
        <div className="sense-picker__groups">
          {groups.map((group) => (
            <div key={group.pos} className="sense-picker__group">
              <span className="sense-picker__pos">{group.pos}</span>
              {group.items.map((sense) => {
                const on = picked.includes(sense.id)
                return (
                  <Checkbox
                    key={sense.id}
                    className="sense-picker__item"
                    checked={on}
                    disabled={!on && full}
                    onChange={() => toggle(sense.id)}
                  >
                    {sense.definition}
                  </Checkbox>
                )
              })}
            </div>
          ))}
        </div>
      )}

      <p className="hint sense-picker__tip">
        {picked.length > 0
          ? '这一阶段只背勾选的 ' + picked.length + ' 条释义（卡片反面只印中文）'
          : '不勾选 = 自动（中文 + 每个词性的第一条，最多 3 条）'}
      </p>

      {extra}

      <div className="sense-picker__actions">
        <Button type="link" size="small" disabled={picked.length === 0} onClick={() => setPicked([])}>
          清空勾选
        </Button>
        <span className="sense-picker__buttons">
          {onCancel && <Button size="small" onClick={onCancel}>取消</Button>}
          <Button
            type="primary"
            size="small"
            loading={saving}
            disabled={okDisabled}
            onClick={() => { void handleSubmit() }}
          >
            {okText}
          </Button>
        </span>
      </div>
    </div>
  )
}
