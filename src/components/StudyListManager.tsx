import { useState } from 'react'
import type { StudyListApi } from '../hooks/useStudyList'
import { Button, Input, Popconfirm, Tag } from '../ui'
import './StudyListManager.css'

const DEFAULT_LIST_ID = 'default'

interface StudyListManagerProps {
  study: StudyListApi
}

/**
 * 设置页「学习列表」分区：统一新建 / 重命名 / 删除学习列表。
 * 复用 useStudyList 的 createList / renameList / deleteList，和学习列表页同一套逻辑与约束
 * （默认列表不可删除、重名由服务端拦截）。
 */
export function StudyListManager({ study }: StudyListManagerProps) {
  const { lists, loading, offline, createList, renameList, deleteList } = study

  // 新建：平时只有按钮，点开后原地展开名称输入
  const [adding, setAdding]       = useState(false)
  const [newName, setNewName]     = useState('')
  const [creating, setCreating]   = useState(false)
  // 重命名：一次只改一个，草稿和保存状态都按 id 记
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draftName, setDraftName] = useState('')
  const [savingId, setSavingId]   = useState<string | null>(null)
  const [error, setError]         = useState('')

  function closeCreate() {
    setAdding(false)
    setNewName('')
  }

  async function handleCreate() {
    const name = newName.trim()
    if (!name) return
    setCreating(true)
    setError('')
    const res = await createList(name)
    setCreating(false)
    if (!res.ok) { setError(res.error); return }
    closeCreate()
  }

  function startEdit(id: string, current: string) {
    setError('')
    setEditingId(id)
    setDraftName(current)
  }

  async function handleRename(id: string, current: string) {
    const name = draftName.trim()
    setEditingId(null)
    if (!name || name === current) return
    setSavingId(id)
    setError('')
    const res = await renameList(id, name)
    setSavingId(null)
    if (!res.ok) setError(res.error)
  }

  async function handleDelete(id: string) {
    setError('')
    const res = await deleteList(id)
    if (!res.ok) setError(res.error)
  }

  return (
    <div className="list-manager">
      <div className="list-manager__bar">
        <p className="hint">
          新建、重命名、删除学习列表都在这里；和「学习列表」页用的是同一份数据。默认列表不可删除；
          按日期分出来的分组改名仍在「学习列表」页展开分组后进行。
        </p>
        {adding ? (
          <div className="list-manager__new">
            <Input
              className="list-manager__new-input"
              size="small"
              placeholder="列表名称..."
              value={newName}
              autoFocus
              aria-label="新建列表名称"
              onChange={e => setNewName(e.target.value)}
              onPressEnter={handleCreate}
              onKeyDown={e => { if (e.key === 'Escape') closeCreate() }}
            />
            <Button
              type="primary"
              size="small"
              disabled={!newName.trim()}
              loading={creating}
              onClick={handleCreate}
            >
              确定
            </Button>
            <Button type="text" size="small" onClick={closeCreate}>取消</Button>
          </div>
        ) : (
          <Button size="small" disabled={offline} onClick={() => setAdding(true)}>+ 新增列表</Button>
        )}
      </div>

      {error && <div className="callout callout--error list-manager__alert">{error}</div>}

      {loading && <p className="empty">加载中...</p>}
      {!loading && lists.length === 0 && <p className="empty">还没有任何学习列表</p>}

      <ul className="list-manager__items">
        {lists.map(list => {
          const isDefault = list.id === DEFAULT_LIST_ID
          const editing   = editingId === list.id
          return (
            <li key={list.id} className="list-manager__item">
              {editing ? (
                <Input
                  className="list-manager__rename"
                  size="small"
                  value={draftName}
                  autoFocus
                  aria-label={'重命名 ' + list.name}
                  onFocus={e => e.currentTarget.select()}
                  onChange={e => setDraftName(e.target.value)}
                  onBlur={() => handleRename(list.id, list.name)}
                  onPressEnter={() => handleRename(list.id, list.name)}
                  onKeyDown={e => { if (e.key === 'Escape') setEditingId(null) }}
                />
              ) : (
                <div className="list-manager__info">
                  <span className="list-manager__name">{list.name}</span>
                  {isDefault && <Tag color="blue">默认</Tag>}
                  <span className="list-manager__count">{list.wordCount} 条</span>
                </div>
              )}

              {!editing && (
                <div className="list-manager__actions">
                  <Button
                    size="small"
                    loading={savingId === list.id}
                    onClick={() => startEdit(list.id, list.name)}
                  >
                    重命名
                  </Button>
                  <Popconfirm
                    title="删除这个列表？"
                    description="列表里的词条会一起删除，且不可恢复"
                    okText="删除"
                    danger
                    disabled={isDefault}
                    placement="bottomRight"
                    onConfirm={() => handleDelete(list.id)}
                  >
                    <Button
                      type="text"
                      danger
                      size="small"
                      disabled={isDefault}
                      title={isDefault ? '默认列表不可删除' : undefined}
                    >
                      删除
                    </Button>
                  </Popconfirm>
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
