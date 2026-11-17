import { useEffect, useState } from 'react'

import type { StudyList } from '../types/vocab'
import { useGameConfig } from '../hooks/useGameConfig'
import { Button, Checkbox, Tag } from '../ui'

/**
 * 设置页「单词游戏」分区：无尽模式的取词范围。
 * 勾选的列表 = 从这个范围里随机抽词；一个都不勾 = 全部学习列表（默认）。
 * 常规模式用本周背词任务的单词，不受这里影响。
 */
export function GameSettings({ lists }: { lists: StudyList[] }) {
  const { config, loading, offline, save } = useGameConfig()
  const [selected, setSelected] = useState<string[]>([])
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')

  // 配置读回来后回填；再次保存成功后 config 换了一份数组，这里会同步成服务端的最终结果
  useEffect(() => {
    if (loading) return
    setSelected(config.endlessListIds)
    setDirty(false)
  }, [loading, config.endlessListIds])

  const scopeText = selected.length === 0
    ? '全部学习列表'
    : selected.length + ' 个学习列表'

  function toggle(listId: string, checked: boolean) {
    setSelected(prev => checked ? [...prev, listId] : prev.filter(id => id !== listId))
    setDirty(true)
    setMessage('')
  }

  async function handleSave() {
    setSaving(true)
    const ok = await save(selected)
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
        无尽模式每回合从这个范围里随机抽 20 个单词，一批一批换着玩；一个都不勾就是全部学习列表。
        常规模式用本周背词任务的单词，不受这里影响。
      </p>

      {offline && (
        <div className="callout callout--warn">无法读取单词游戏配置，请确认云端 Worker 已部署且访问令牌正确。</div>
      )}

      <div className="game-settings__head">
        <span className="game-settings__title">当前范围</span>
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

      <div className="game-settings__foot">
        <Button type="primary" disabled={!dirty || saving} onClick={handleSave}>
          {saving ? '保存中…' : '保存'}
        </Button>
        {message && <span className="game-settings__message">{message}</span>}
      </div>
    </div>
  )
}
