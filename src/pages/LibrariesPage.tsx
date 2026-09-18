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
  getPrintLabelById: (id: string) => string
  hasCustomPrintLabel: (id: string) => boolean
  onRenamePrintLabel: (id: string, label: string) => Promise<UpdateLabelResult>
  onResetPrintLabel: (id: string) => void
  offline: boolean
  /** 嵌入设置页时不画自己的 .page 容器和标题，由设置页提供版式 */
  embedded?: boolean
 }

export function LibrariesPage({
  libraries,
  getLabelById,
  hasCustomLabel,
  onRename,
  onReset,
  getPrintLabelById,
  hasCustomPrintLabel,
  onRenamePrintLabel,
  onResetPrintLabel,
  offline,
  embedded,
}: LibrariesPageProps) {
  const [keyword, setKeyword]   = useState('')
  // 只存「改过的」草稿，没草稿就直接显示已保存的标签，省掉一套同步逻辑
  const [drafts, setDrafts]     = useState<Record<string, string>>({})
  const [errors, setErrors]     = useState<Record<string, string>>({})
  const [printDrafts, setPrintDrafts] = useState<Record<string, string>>({})
  const [printErrors, setPrintErrors] = useState<Record<string, string>>({})
  const [savingKey, setSavingKey] = useState<string | null>(null)

  const visible = useMemo(() => {
    const k = keyword.trim().toLowerCase()
    if (!k) return libraries
    return libraries.filter(lib =>
      lib.id.toLowerCase().includes(k) ||
      lib.name.toLowerCase().includes(k) ||
      getLabelById(lib.id).toLowerCase().includes(k) ||
      getPrintLabelById(lib.id).toLowerCase().includes(k),
    )
  }, [libraries, keyword, getLabelById, getPrintLabelById])

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
    setSavingKey('display:' + id)
    const res = await onRename(id, value)
    setSavingKey(null)
    if (res.ok) clearDraft(id)
    else setErrors(prev => ({ ...prev, [id]: res.error }))
  }

  function handleReset(id: string) {
    onReset(id)
    clearDraft(id)
  }

  function clearPrintDraft(id: string) {
    setPrintDrafts(prev => { const next = { ...prev }; delete next[id]; return next })
    setPrintErrors(prev => { const next = { ...prev }; delete next[id]; return next })
  }

  async function handlePrintSave(id: string, saved: string) {
    const value = (printDrafts[id] ?? saved).trim()
    if (!value) {
      setPrintErrors(prev => ({ ...prev, [id]: '打印标签不能为空' }))
      return
    }
    setSavingKey('print:' + id)
    const res = await onRenamePrintLabel(id, value)
    setSavingKey(null)
    if (res.ok) clearPrintDraft(id)
    else setPrintErrors(prev => ({ ...prev, [id]: res.error }))
  }

  function handlePrintReset(id: string) {
    onResetPrintLabel(id)
    clearPrintDraft(id)
  }

const content = (
    <>
      {offline && (
        <div className="callout callout--warn libs-notice">
         本地服务未启动，标签改动先记在浏览器里，服务起来后会自动同步到 cache/vocab-labels.json。
          本地服务未启动，标签改动先记在浏览器里，服务起来后会自动同步到服务端。
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
          const savedPrint = getPrintLabelById(lib.id)
          const printDraft = printDrafts[lib.id] ?? savedPrint
          const printDirty = printDraft.trim() !== savedPrint
          const printError = printErrors[lib.id]
          const customPrint = hasCustomPrintLabel(lib.id)
          return (
            <li key={lib.id} className="card lib-card">
              <div className="lib-card__top">
                <h2 className="lib-card__name">{lib.name}</h2>
                <code className="lib-card__file">{lib.file}</code>
              </div>

              <div className="lib-card__labels">
                <div className="lib-card__label-group">
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
                      loading={savingKey === 'display:' + lib.id}
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
                </div>

                <div className="lib-card__label-group">
                  <div className="lib-card__label lib-card__label--print">
                    <span className="lib-card__label-title">打印标签</span>
                    <Input
                      className="lib-card__input"
                      size="small"
                      maxLength={40}
                      aria-label={'修改 ' + lib.name + ' 的打印标签'}
                      value={printDraft}
                      onChange={event => setPrintDrafts(prev => ({ ...prev, [lib.id]: event.target.value }))}
                      onPressEnter={() => { if (printDirty) handlePrintSave(lib.id, savedPrint) }}
                    />
                    <Button
                      type="primary"
                      size="small"
                      disabled={!printDirty}
                      loading={savingKey === 'print:' + lib.id}
                      onClick={() => handlePrintSave(lib.id, savedPrint)}
                    >
                      保存
                    </Button>
                    {printDirty && (
                      <Button size="small" onClick={() => clearPrintDraft(lib.id)}>撤销</Button>
                    )}
                    {customPrint && !printDirty && (
                      <Button size="small" onClick={() => handlePrintReset(lib.id)}>沿用显示标签</Button>
                    )}
                    <span className="lib-card__label-hint">显示在打印卡片右上角</span>
                  </div>
                  {printError != null && <p className="lib-card__error">{printError}</p>}
                </div>
              </div>
            </li>
          )
        })}
     </ul>
    </>
  )

  if (embedded) {
    return content
  }

  return (
    <div className="page libs-page">
      <PageHeader
        title="词库"
        subtitle="显示标签用于页面展示；打印标签用于卡片右上角，未设置时沿用显示标签。"
      />
      {content}
    </div>
  )
 }
