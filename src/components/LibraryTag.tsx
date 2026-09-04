import { useEffect, useState } from 'react'
import { Input, Tag } from '../ui'
import './LibraryTag.css'

interface LibraryTagProps {
  label: string
  onRename: (newLabel: string) => void
}

/** 词库标签：点一下就能改名 */
export function LibraryTag({ label, onRename }: LibraryTagProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(label)

  useEffect(() => { setDraft(label) }, [label])

  function commit() {
    const trimmed = draft.trim()
    if (trimmed && trimmed !== label) onRename(trimmed)
    setEditing(false)
  }

  if (editing) {
    return (
      <Input
        size="small"
        className="library-tag__input"
        aria-label="重命名词库标签"
        value={draft}
        autoFocus
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onPressEnter={commit}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            setDraft(label)
            setEditing(false)
          }
        }}
      />
    )
  }

  return (
    <Tag color="blue" title="点击重命名标签" onClick={() => setEditing(true)}>{label}</Tag>
  )
}
