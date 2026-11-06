import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button, Modal } from '../ui'
import { commitReciteSession, fetchReciteActiveSession } from '../hooks/useRecite'
import type { ReciteDraft, ReciteSessionPayload } from '../hooks/useRecite'
import './ReciteTaskConfirm.css'

const DAY = 86400000
/** 一次保存按 30 张一批提交，服务端单请求最多 60 张 */
const COMMIT_CHUNK = 30

const RESULT_LABEL: Record<string, string> = {
  known: '会',
  unknown: '不会',
  correct: '拼写正确',
  skipped: '拼写跳过',
}

/** 一周的日期区间，周一开始，如 11.4—11.10 */
function fmtWeek(week: number): string {
  const a = new Date(week)
  const b = new Date(week + 6 * DAY)
  return (a.getMonth() + 1) + '.' + a.getDate() + '—' + (b.getMonth() + 1) + '.' + b.getDate()
}

interface RowCard {
  id?: string
  word: string
  cardType: string
  displayText?: string
  translation?: string
  result?: string
}

interface WordRow {
  key: string
  word: string
  translation: string
  meaning?: string
  spelling?: string
}

/** 同一个词的普通卡 / 拼写卡合并成一行，分别显示知意和拼写结果 */
function buildRows(cards: RowCard[], drafts: Map<string, ReciteDraft>): WordRow[] {
  const rows = new Map<string, WordRow>()
  for (const card of cards) {
    const row = rows.get(card.word) ?? { key: card.word, word: card.word, translation: '' }
    const result = (card.id ? drafts.get(card.id)?.result : undefined) ?? card.result
    if (card.cardType === 'spelling') row.spelling = result
    else row.meaning = result
    if (!row.translation && card.translation) row.translation = card.translation
    rows.set(card.word, row)
  }
  return [...rows.values()]
}

function WordMarks({ row }: { row: WordRow }) {
  if (!row.meaning && !row.spelling) {
    return <i className="recite-confirm__mark recite-confirm__mark--pending">未判定</i>
  }
  return (
    <>
      {row.meaning && (
        <i className={'recite-confirm__mark recite-confirm__mark--' + row.meaning}>
          {RESULT_LABEL[row.meaning] || row.meaning}
        </i>
      )}
      {row.spelling && (
        <i className={'recite-confirm__mark recite-confirm__mark--' + row.spelling}>
          {RESULT_LABEL[row.spelling] || row.spelling}
        </i>
      )}
    </>
  )
}

interface ReciteTaskConfirmProps {
  open: boolean
  /** 目标周（周一 0 点） */
  weekStart: number
  /** 这一次是第几次（1-based），只在标题里标明 */
  sessionIndex?: number
  onClose: () => void
  /** 保存成功后通知外层刷新这一周的任务状态 */
  onSaved?: () => void
}

/**
 * 家长确认弹窗：在背词任务列表里点某一行（进行中的那一次）打开，只看这一次。
 * 进行中的会话（只有本周会有）逐词显示草稿判定，确认后保存；
 * 已保存的记录在任务列表行内展开查看，弹窗里不再重复。
 */
export function ReciteTaskConfirm({ open, weekStart, sessionIndex, onClose, onSaved }: ReciteTaskConfirmProps) {
  const [active, setActive] = useState<ReciteSessionPayload | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState('')

  const reload = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setActive(await fetchReciteActiveSession())
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '读取背诵记录失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (open) {
      setNotice('')
      void reload()
    }
  }, [open, reload])

  const session = active?.session ?? null
  const activeWeek = active?.task?.weekStart ?? null
  const pendingCards = useMemo(
    () => (active?.cards ?? []).filter(card => card.status === 'pending'),
    [active],
  )
  const draftMap = useMemo(
    () => new Map((active?.drafts ?? []).map(draft => [draft.cardId, draft])),
    [active],
  )
  const rows = useMemo(() => buildRows(pendingCards, draftMap), [pendingCards, draftMap])
  const missing = pendingCards.filter(card => !draftMap.has(card.id)).length
  const canSave = Boolean(session) && activeWeek === weekStart
    && pendingCards.length > 0 && missing === 0 && !saving

  async function save() {
    if (!session || !canSave) return
    setSaving(true)
    setError('')
    setNotice('')
    try {
      const answers = pendingCards.map(card => {
        const draft = draftMap.get(card.id) as ReciteDraft
        return {
          cardId: card.id,
          result: draft.result,
          answer: draft.answer,
          attempts: draft.attempts,
          // 幂等键固定为会话 + 卡片，重复保存不会重复推进轮次
          requestId: 'recite|' + session.sessionId + '|' + card.id,
        }
      })
      for (let start = 0; start < answers.length; start += COMMIT_CHUNK) {
        await commitReciteSession(session.sessionId, answers.slice(start, start + COMMIT_CHUNK))
      }
      setNotice('记录已保存，学习进度已更新。')
      onSaved?.()
      await reload()
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '保存失败，请重试')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      width="wide"
      title={fmtWeek(weekStart) + (sessionIndex ? ' · 第 ' + sessionIndex + ' 次' : '') + ' · 家长确认'}
      description="核对这一次孩子背的单词，保存后统一写入学习进度"
      onClose={onClose}
      footer={<Button disabled={saving} onClick={onClose}>关闭</Button>}
    >
      {loading ? (
        <p className="recite-confirm__state">正在读取背诵记录…</p>
      ) : (
        <>
          <section className="recite-confirm__card">
            <div className="recite-confirm__head">
              <h3 className="recite-confirm__title">待保存记录</h3>
              {session && activeWeek === weekStart && (
                <span className="recite-confirm__count">
                  第 {session.sessionIndex} 次 · 已判定 {draftMap.size} / {pendingCards.length} 张
                </span>
              )}
            </div>
            {session && activeWeek === weekStart ? (
              <>
                <ul className="recite-confirm__words">
                  {rows.map(row => (
                    <li key={row.key} className="recite-confirm__row">
                      <div className="recite-confirm__word">
                        <b>{row.word}</b>
                        <span>{row.translation || '暂无中文含义'}</span>
                      </div>
                      <div className="recite-confirm__marks"><WordMarks row={row} /></div>
                    </li>
                  ))}
                </ul>
                {missing > 0 && (
                  <p className="callout callout--warn">
                    还有 {missing} 张卡片没有判定，等孩子背完再保存。
                  </p>
                )}
                {notice && <p className="callout callout--success">{notice}</p>}
                {error && <p className="callout callout--error">{error}</p>}
                <div className="recite-confirm__actions">
                  <Button type="primary" onClick={() => { void save() }} disabled={!canSave}>
                    {saving ? '保存中…' : '保存记录'}
                  </Button>
                  <span className="hint">保存后才会推进复习轮次、累计会 / 不会次数。</span>
                </div>
              </>
            ) : (
              <p className="empty empty--inline">这一次还没有待保存的背诵记录。</p>
            )}
          </section>

          {error && !(session && activeWeek === weekStart) && (
            <p className="callout callout--error">{error}</p>
          )}
        </>
      )}
    </Modal>
  )
}
