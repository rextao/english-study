import { useCallback, useEffect, useMemo, useState } from 'react'
import { PageHeader } from '../components/PageHeader'
import { Button } from '../ui'
import { commitReciteSession, fetchReciteActiveSession, fetchReciteHistory } from '../hooks/useRecite'
import type { ReciteDraft, ReciteHistoryCard, ReciteHistoryRecord, ReciteSessionPayload } from '../hooks/useRecite'
import './ReciteParentPage.css'

interface ReciteParentPageProps {
  onBack: () => void
  /** 保存成功后刷新复习计划角标 */
  onSaved?: () => void
}

/** 一次保存按 30 张一批提交，服务端单请求最多 60 张 */
const COMMIT_CHUNK = 30

const RESULT_LABEL: Record<string, string> = {
  known: '会',
  unknown: '不会',
  correct: '拼写正确',
  skipped: '拼写跳过',
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

function formatDay(ts: number) {
  const date = new Date(ts)
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${WEEKDAYS[date.getDay()]}`
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
    const row = rows.get(card.word) ?? {
      key: card.word,
      word: card.word,
      translation: card.translation || '',
    }
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
    return <i className="parent-recite__mark parent-recite__mark--pending">未判定</i>
  }
  return (
    <>
      {row.meaning && (
        <i className={'parent-recite__mark parent-recite__mark--' + row.meaning}>
          {RESULT_LABEL[row.meaning] || row.meaning}
        </i>
      )}
      {row.spelling && (
        <i className={'parent-recite__mark parent-recite__mark--' + row.spelling}>
          {RESULT_LABEL[row.spelling] || row.spelling}
        </i>
      )}
    </>
  )
}

export function ReciteParentPage({ onBack, onSaved }: ReciteParentPageProps) {
  const [active, setActive] = useState<ReciteSessionPayload | null>(null)
  const [records, setRecords] = useState<ReciteHistoryRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState('')

  const reload = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [session, history] = await Promise.all([
        fetchReciteActiveSession(),
        fetchReciteHistory(20),
      ])
      setActive(session)
      setRecords(history.records || [])
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '读取背诵记录失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void reload() }, [reload])

  const session = active?.session ?? null
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
  const canSave = Boolean(session) && pendingCards.length > 0 && missing === 0 && !saving

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

  function historyRows(record: ReciteHistoryRecord): WordRow[] {
    return buildRows(record.cards as ReciteHistoryCard[], new Map())
  }

  return (
    <div className="page page--wide parent-recite">
      <PageHeader
        title="家长确认"
        subtitle="核对孩子背过的单词，保存后统一写入学习进度"
        actions={<Button onClick={onBack}>返回英语学习</Button>}
      />

      {loading ? (
        <p className="parent-recite__state">正在读取背诵记录…</p>
      ) : (
        <>
          <section className="card card--pad parent-recite__card">
            <div className="parent-recite__head">
              <div>
                <h2 className="parent-recite__title">待保存记录</h2>
                <p className="hint">
                  {session ? formatDay(session.startedAt || Date.now()) : '当前没有进行中的背诵'}
                </p>
              </div>
              {session && (
                <span className="parent-recite__count">
                  已判定 {draftMap.size} / {pendingCards.length} 张
                </span>
              )}
            </div>

            {session ? (
              <>
                <ul className="parent-recite__words">
                  {rows.map(row => (
                    <li key={row.key} className="parent-recite__row">
                      <div className="parent-recite__word">
                        <b>{row.word}</b>
                        <span>{row.translation || '暂无中文含义'}</span>
                      </div>
                      <div className="parent-recite__marks"><WordMarks row={row} /></div>
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
                <div className="parent-recite__actions">
                  <Button type="primary" onClick={() => { void save() }} disabled={!canSave}>
                    {saving ? '保存中…' : '保存记录'}
                  </Button>
                  <span className="hint">保存后才会推进复习轮次、累计会 / 不会次数。</span>
                </div>
              </>
            ) : (
              <p className="empty empty--inline">还没有待保存的背诵记录。</p>
            )}
          </section>

          <section className="card card--pad parent-recite__card">
            <div className="parent-recite__head">
              <div>
                <h2 className="parent-recite__title">已保存记录</h2>
                <p className="hint">按保存时间倒序，最多显示最近 20 次</p>
              </div>
            </div>

            {records.length === 0 ? (
              <p className="empty empty--inline">还没有保存过背诵记录。</p>
            ) : (
              <div className="parent-recite__records">
                {records.map(record => {
                  const recordRows = historyRows(record)
                  return (
                    <article key={record.sessionId} className="parent-recite__record">
                      <header className="parent-recite__record-head">
                        <b>{formatDay(record.date)}</b>
                        <span>第 {record.sessionIndex} 次 · {record.cards.length} 张卡片</span>
                      </header>
                      <ul className="parent-recite__words">
                        {recordRows.map(row => (
                          <li key={row.key} className="parent-recite__row">
                            <div className="parent-recite__word">
                              <b>{row.word}</b>
                              <span>{row.translation || '暂无中文含义'}</span>
                            </div>
                            <div className="parent-recite__marks"><WordMarks row={row} /></div>
                          </li>
                        ))}
                      </ul>
                    </article>
                  )
                })}
              </div>
            )}
          </section>

          {error && !session && <p className="callout callout--error">{error}</p>}
        </>
      )}
    </div>
  )
}
