import { useEffect, useMemo, useRef, useState } from 'react'
import { saveReciteDraft } from '../hooks/useRecite'
import type { ReciteSessionPayload } from '../hooks/useRecite'
import { speak, speechErrorMessage, stopSpeech } from '../utils/speech'
import './RecitePage.css'

interface RecitePageProps {
  payload: ReciteSessionPayload | null
  loading: boolean
  error: string | null
  onReload: () => void
}

type MeaningResult = 'known' | 'unknown'

interface DraftAnswer {
  cardId: string
  result: MeaningResult | 'correct' | 'skipped'
  answer?: string
  attempts: number
}

const KEYBOARD_ROWS = ['QWERTYUIOP', 'ASDFGHJKL', 'ZXCVBNM']

function normalize(value: string) {
  return value.trim().replace(/\s+/g, ' ').toLowerCase()
}

export function RecitePage({ payload, loading, error, onReload }: RecitePageProps) {
  const cards = payload?.cards ?? []
  const session = payload?.session ?? null
  const [index, setIndex] = useState(0)
  // 判定先写服务端草稿：不推进轮次，家长换设备也能读到同一份结果
  const [answers, setAnswers] = useState<Record<string, DraftAnswer>>({})
  const [stage, setStage] = useState<'cards' | 'celebrate'>('cards')
  const [flipped, setFlipped] = useState(false)
  const [input, setInput] = useState('')
  const [attempts, setAttempts] = useState(0)
  const [feedback, setFeedback] = useState<'correct' | 'wrong' | 'skipped' | null>(null)
  const [localError, setLocalError] = useState('')
  // 喇叭：任何情况都显示，点了才去请求 /api/tts，失败把原因直接写在页面上
  const [speaking, setSpeaking] = useState(false)
  const [speechError, setSpeechError] = useState('')
  // 连点喇叭时只认最后一次：旧的那次被掐掉后不会再改回「播放中」
  const playToken = useRef(0)

  useEffect(() => stopSpeech, [])

  // 换会话：草稿来自 Server，已经判完的会话直接进完成动画
  useEffect(() => {
    if (!payload?.session) return
    const list = payload.cards ?? []
    const seeded: Record<string, DraftAnswer> = {}
    for (const draft of payload.drafts ?? []) {
      seeded[draft.cardId] = {
        cardId: draft.cardId,
        result: draft.result,
        answer: draft.answer,
        attempts: draft.attempts,
      }
    }
    const pending = list.filter(card => card.status === 'pending')
    const nextCard = pending.find(card => !seeded[card.id])
    const nextIndex = nextCard ? list.findIndex(card => card.id === nextCard.id) : list.length
    setIndex(nextIndex < 0 ? list.length : nextIndex)
    setAnswers(seeded)
    setFlipped(false)
    setInput('')
    setAttempts(0)
    setFeedback(null)
    setLocalError('')
    setStage(pending.length > 0 && nextCard ? 'cards' : 'celebrate')
  }, [payload?.session?.sessionId, payload?.session?.cursor])

  // 换卡片时清掉上一张的输入和反馈
  useEffect(() => {
    setFlipped(false)
    setInput('')
    setAttempts(0)
    setFeedback(null)
    setSpeechError('')
    setSpeaking(false)
    stopSpeech()
  }, [index])

  const card = cards[index] ?? null
  const isSpelling = card?.cardType === 'spelling'
  const display = card?.displayText || card?.word || ''
  const answer = card?.word || ''
  const total = session?.cardCount || cards.length || 0
  const lastCard = index + 1 >= cards.length

  const stats = useMemo(() => {
    let known = 0
    let unknown = 0
    let correct = 0
    let skipped = 0
    for (const item of cards) {
      const draft = answers[item.id]
      if (!draft) continue
      if (draft.result === 'known') known++
      else if (draft.result === 'unknown') unknown++
      else if (draft.result === 'correct') correct++
      else skipped++
    }
    return { known, unknown, correct, skipped, total: known + unknown + correct + skipped }
  }, [answers, cards])

  function advance() {
    if (index + 1 >= cards.length) {
      setStage('celebrate')
      return
    }
    setIndex(index + 1)
  }

  /** 先更新本地界面，再把草稿写到 Server；写失败时保留本地判定，家长保存时会重新提交 */
  function persistDraft(draft: DraftAnswer) {
    setAnswers(previous => ({ ...previous, [draft.cardId]: draft }))
    if (!session) return
    setLocalError('')
    void saveReciteDraft(session.sessionId, {
      cardId: draft.cardId,
      result: draft.result,
      answer: draft.answer,
      attempts: draft.attempts,
    }).catch(() => {
      setLocalError('草稿同步失败，家长保存记录时会重新提交')
    })
  }

  function markMeaning(result: MeaningResult) {
    if (!card || card.cardType !== 'meaning') return
    persistDraft({ cardId: card.id, result, attempts: 0 })
    setFlipped(true)
  }

  function nextCard() {
    if (!card || !answers[card.id]) return
    advance()
  }

  function addKey(key: string) {
    if (feedback) return
    setInput(value => value + key)
  }

  function submitSpelling() {
    if (!card || card.cardType !== 'spelling' || feedback) return
    if (normalize(input) !== normalize(answer)) {
      setAttempts(value => value + 1)
      setFeedback('wrong')
      return
    }
    persistDraft({ cardId: card.id, result: 'correct', answer: input, attempts })
    setFeedback('correct')
  }

  function skipSpelling() {
    if (!card || card.cardType !== 'spelling' || feedback === 'correct') return
    persistDraft({ cardId: card.id, result: 'skipped', answer: input, attempts })
    setFeedback('skipped')
  }

  /** 拼写卡在「拼对 / 跳过看答案」之前不出声，否则等于把答案念出来（拼错一次也还算没判定） */
  const spellingLocked = isSpelling && feedback !== 'correct' && feedback !== 'skipped'

  function playWord() {
    if (!card || spellingLocked) return
    const token = playToken.current + 1
    playToken.current = token
    setSpeechError('')
    setSpeaking(true)
    void speak(answer)
      .catch(error => {
        if (playToken.current === token) setSpeechError(speechErrorMessage(error))
      })
      .finally(() => {
        if (playToken.current === token) setSpeaking(false)
      })
  }

  if (loading) {
    return (
      <div className="recite recite--state">
        <div className="recite__panel recite__panel--lite">
          <span className="recite__spinner" aria-hidden="true" />
          <b>正在准备今天的学习…</b>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="recite recite--state">
        <div className="recite__panel recite__panel--lite">
          <b>学习任务读取失败</b>
          <p>{error}</p>
          <button type="button" className="recite__state-btn" onClick={onReload}>重试读取</button>
        </div>
      </div>
    )
  }

  if (!payload?.task) {
    return (
      <div className="recite recite--state">
        <div className="recite__panel recite__panel--lite">
          <span className="recite__emoji">🌤️</span>
          <b>当前没有待学习内容</b>
          <p>请先在英语学习页准备本周任务。</p>
        </div>
      </div>
    )
  }

  if (payload.complete || stage === 'celebrate') {
    const weekDone = Boolean(payload.complete)
    return (
      <div className="recite recite--celebrate">
        <div className="recite__confetti" aria-hidden="true">
          {Array.from({ length: 26 }, (_, piece) => (
            <span
              key={piece}
              className={'confetti confetti--' + (piece % 6)}
              style={{ left: (piece * 3.9 + 1) + '%', animationDelay: ((piece % 9) * 0.16).toFixed(2) + 's' }}
            />
          ))}
        </div>
        <div className="recite__celebrate-card">
          <div className="recite__trophy" aria-hidden="true">🏆</div>
          <h1 className="recite__celebrate-title">太棒啦，全部完成！</h1>
          <p className="recite__celebrate-sub">
            {weekDone
              ? `本周 ${payload.task.sessionCount} 次学习全部完成`
              : `今天背了 ${stats.total} 张卡片，等家长确认后保存记录`}
          </p>
          {!weekDone && (
            <div className="recite__celebrate-stats">
              <div><b>{stats.known}</b><span>会</span></div>
              <div><b>{stats.unknown}</b><span>不会</span></div>
              <div><b>{stats.correct}</b><span>拼写正确</span></div>
              <div><b>{stats.skipped}</b><span>拼写跳过</span></div>
            </div>
          )}
          {localError && <p className="recite__error">{localError}</p>}
        </div>
      </div>
    )
  }

  // 喇叭：圆形纯图标按钮，挂在单词下面；拼写卡判定前锁定不出声，原因靠 title 说明
  const speakButton = (
    <button
      type="button"
      className={'recite-card__speak' + (speaking ? ' is-playing' : '')}
      onClick={playWord}
      disabled={spellingLocked}
      aria-label={spellingLocked ? '拼完或跳过后再听发音' : '播放单词发音'}
      title={spellingLocked ? '拼完或跳过后再听' : '播放单词发音'}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M4 9.5h3.2L12 5.6v12.8L7.2 14.5H4z" />
        <path d="M15.4 8.6a4.6 4.6 0 0 1 0 6.8" />
        <path d="M17.9 6.1a8.2 8.2 0 0 1 0 11.8" />
      </svg>
    </button>
  )

  return (
    <div className="recite">
      <div className="recite__track" role="list" aria-label={'共 ' + total + ' 张卡片的学习进度'}>
        {cards.map((item, i) => {
          const position = i + 1
          const isPrize = position === total || position % 5 === 0
          const answered = Boolean(answers[item.id])
          const isCurrent = i === index
          const nodeClass = [
            'recite__node',
            isPrize ? 'recite__node--prize' : '',
            answered ? 'recite__node--done' : '',
            isCurrent ? 'recite__node--current' : '',
          ].filter(Boolean).join(' ')
          return (
            <span
              key={item.id}
              role="listitem"
              className={nodeClass}
              aria-label={'第 ' + position + ' 张' + (isPrize ? '，宝箱节点' : '') + '，' + (answered ? '已学过' : '未学')}
            >
              {isPrize ? '🎁' : position}
            </span>
          )
        })}
      </div>

      <main className="recite__stage">
        <section className={'recite-card' + (flipped ? ' recite-card--flipped' : '')}>
          {isSpelling ? (
            <>
              <p className="recite-card__hint">看中文，拼出英文</p>
              <div className="recite-card__prompt recite-card__prompt--cn">{display || '暂无中文提示'}</div>
              {speakButton}
              <div className={'recite-card__input' + (input ? '' : ' recite-card__input--empty')}>
                {input || '点击下方键盘输入'}
              </div>
              {feedback === 'wrong' && (
                <div className="recite-card__feedback recite-card__feedback--wrong">还差一点，可以重新尝试或跳过</div>
              )}
              {feedback === 'correct' && <div className="recite-card__feedback">拼写正确：{answer}</div>}
              {feedback === 'skipped' && (
                <div className="recite-card__feedback recite-card__feedback--wrong">答案：{answer}</div>
              )}
            </>
          ) : flipped ? (
            <div className="recite-card__back">
              <span className="recite-card__back-word">{card.word}</span>
              <strong className="recite-card__back-translation">{card.translation || '暂无中文含义'}</strong>
              {speakButton}
            </div>
          ) : (
            <>
              <div className="recite-card__prompt">{display}</div>
              {speakButton}
            </>
          )}
        </section>

        {isSpelling ? (
          <div className="recite-keyboard">
            {KEYBOARD_ROWS.map(row => (
              <div className="recite-keyboard__row" key={row}>
                {[...row].map(key => (
                  <button
                    type="button"
                    key={key}
                    className="recite-keyboard__key"
                    disabled={Boolean(feedback)}
                    onClick={() => addKey(key)}
                  >{key}</button>
                ))}
              </div>
            ))}
            <div className="recite-keyboard__actions">
              <button
                type="button"
                className="recite__kbd-ghost"
                onClick={() => setInput(value => value.slice(0, -1))}
                disabled={Boolean(feedback)}
              >删除</button>
              <button
                type="button"
                className="recite__kbd-ghost"
                onClick={() => setInput('')}
                disabled={Boolean(feedback)}
              >清空</button>
              {feedback === 'wrong' ? (
                <>
                  <button type="button" className="recite__kbd-ghost" onClick={() => setFeedback(null)}>重新尝试</button>
                  <button type="button" className="recite__kbd-primary" onClick={skipSpelling}>跳过看答案</button>
                </>
              ) : feedback ? (
                <button type="button" className="recite__kbd-primary" onClick={nextCard}>
                  {lastCard ? '完成本轮' : '下一张'}
                </button>
              ) : (
                <button
                  type="button"
                  className="recite__kbd-primary"
                  onClick={submitSpelling}
                  disabled={!input}
                >提交</button>
              )}
            </div>
          </div>
        ) : (
          <div className={'recite__bar' + (flipped ? ' recite__bar--single' : '')}>
            {!flipped ? (
              <>
                <button
                  type="button"
                  className="recite__mark recite__mark--no"
                  onClick={() => markMeaning('unknown')}
                >不会</button>
                <button
                  type="button"
                  className="recite__mark recite__mark--yes"
                  onClick={() => markMeaning('known')}
                >会</button>
              </>
            ) : (
              <button type="button" className="recite__next" onClick={nextCard}>
                {lastCard ? '完成本轮' : '下一张'}
              </button>
            )}
          </div>
        )}
        {localError && <div className="recite__error">{localError}</div>}
        {speechError && <div className="recite__error" role="alert">{speechError}</div>}
      </main>
    </div>
  )
}
