import { useMemo, useState } from 'react'
import type { UpdateLabelResult } from '../hooks/useVocabLibraries'
import type { VocabLibraryInfo } from '../types/vocab'
import { PageHeader } from '../components/PageHeader'
import { Button, Input } from '../ui'
import './LibrariesPage.css'

interface LibrariesPageProps {
  libraries: VocabLibraryInfo[]
  getLabelById: (id: string) => string
  hasCustomLabel: (id: string) => boolean
  onRename: (id: string, label: string) => Promise<UpdateLabelResult>
  onReset: (id: string) => void
  offline: boolean
}

export function LibrariesPage({
  libraries,
  getLabelById,
  hasCustomLabel,
  onRename,
  onReset,
  offline,
}: LibrariesPageProps) {
  const [keyword, setKeyword]   = useState('')
  // 只存「改过的」草稿，没草稿就直接显示已保存的标签，省掉一套同步逻辑
  const [drafts, setDrafts]     = useState<Record<string, string>>({})
  const [errors, setErrors]     = useState<Record<string, string>>({})
  const [savingId, setSavingId] = useState<string | null>(null)

  const visible = useMemo(() => {
    const k = keyword.trim().toLowerCase()
    if (!k) return libraries
    return libraries.filter(lib =>
      lib.id.toLowerCase().includes(k) ||
      lib.name.toLowerCase().includes(k) ||
      getLabelById(lib.id).toLowerCase().includes(k),
    )
  }, [libraries, keyword, getLabelById])

  function clearDraft(id: string) {
    setDrafts(prev => { const next = { ...prev }; delete next[id]; return next })
    setErrors(prev => { const next = { ...prev }; delete next[id]; return next })
  }

  async function handleSave(id: string, saved: string) {
    const value = (drafts[id] ?? saved).trim()
    if (!value) {
      setErrors(prev => ({ ...prev, [id]: '标签不能为空' }))
      return
    }
    setSavingId(id)
    const res = await onRename(id, value)
    setSavingId(null)
    if (res.ok) clearDraft(id)
    else setErrors(prev => ({ ...prev, [id]: res.error }))
  }

  function handleReset(id: string) {
    onReset(id)
    clearDraft(id)
  }

  return (
    <div className="page libs-page">
      <PageHeader
        title="词库"
        subtitle="标签就是查词结果上显示的那个名字。默认用词库 id，改完所有页面都会跟着变。"
      />

      {offline && (
        <div className="callout callout--warn libs-notice">
          本地服务未启动，标签改动先记在浏览器里，服务起来后会自动同步到 cache/vocab-labels.json。
        </div>
      )}

      {libraries.length > 1 && (
        <div className="libs-filter">
          <Input
            block
            placeholder="按 id / 名称 / 标签筛选"
            aria-label="筛选词库"
            value={keyword}
            onChange={event => setKeyword(event.target.value)}
            allowClear
            onClear={() => setKeyword('')}
          />
        </div>
      )}

      {visible.length === 0 && (
        <p className="empty">
          {libraries.length === 0
            ? '还没有词库。把词库 JSON 放进 vocab/ 目录即可，字段说明见 vocab/format.md。'
            : '没有匹配的词库。'}
        </p>
      )}

      <ul className="libs">
        {visible.map(lib => {
          const saved  = getLabelById(lib.id)
          const draft  = drafts[lib.id] ?? saved
          const dirty  = draft.trim() !== saved
          const error  = errors[lib.id]
          const custom = hasCustomLabel(lib.id)
          return (
            <li key={lib.id} className="card lib-card">
              <div className="lib-card__top">
                <h2 className="lib-card__name">{lib.name}</h2>
                <code className="lib-card__file">{lib.file}</code>
              </div>

              <div className="lib-card__label">
                <span className="lib-card__label-title">显示标签</span>
                <Input
                  className="lib-card__input"
                  size="small"
                  maxLength={40}
                  aria-label={'修改 ' + lib.name + ' 的显示标签'}
                  value={draft}
                  onChange={event => setDrafts(prev => ({ ...prev, [lib.id]: event.target.value }))}
                  onPressEnter={() => { if (dirty) handleSave(lib.id, saved) }}
                />
                <Button
                  type="primary"
                  size="small"
                  disabled={!dirty}
                  loading={savingId === lib.id}
                  onClick={() => handleSave(lib.id, saved)}
                >
                  保存
                </Button>
                {dirty && (
                  <Button size="small" onClick={() => clearDraft(lib.id)}>撤销</Button>
                )}
                {custom && !dirty && (
                  <Button size="small" onClick={() => handleReset(lib.id)}>重置为默认</Button>
                )}
              </div>

              {error != null && <p className="lib-card__error">{error}</p>}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
