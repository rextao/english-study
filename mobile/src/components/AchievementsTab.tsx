/**
 * AchievementsTab.tsx — 学习成果 tab
 *
 * 顶部一个单词筛选框 + 一排排序按钮（复习 / 会拼 / 会读 / 知意），
 * 下面逐词列出各类打卡计数与词义小计。
 * 计数含义和桌面端一致：会拼 / 会读 / 知意各算各的，复习只数 done / again。
 */
import { useMemo, useState } from 'react'
import type { Achievement, VocabLabels } from '../lib/snapshot'
import type { SuccessKind } from '../lib/tally'

interface Props {
  achievements: Achievement[]
  labels: VocabLabels
  /** 对某个词的会拼 / 会读 / 知意加减；delta = +1 | -1 */
  onTally: (wordKey: string, kind: SuccessKind, delta: number) => void
}

interface RowProps {
  item: Achievement
  labels: VocabLabels
  onTally: (wordKey: string, kind: SuccessKind, delta: number) => void
}

/** 排序维度：对应 Achievement 上的计数字段 */
type SortKey = 'review' | 'spelling' | 'reading' | 'meaning'

const SORT_OPTIONS: { key: SortKey; label: string; field: keyof Achievement }[] = [
  { key: 'review', label: '复习', field: 'reviewCount' },
  { key: 'spelling', label: '会拼', field: 'spellingCount' },
  { key: 'reading', label: '会读', field: 'readingCount' },
  { key: 'meaning', label: '知意', field: 'rememberedCount' },
]

/** 可加减的三项：动作 kind + 文案 + 取值字段 */
const EDITABLE: { kind: SuccessKind; label: string; field: keyof Achievement }[] = [
  { kind: 'spelling', label: '会拼', field: 'spellingCount' },
  { kind: 'reading', label: '会读', field: 'readingCount' },
  { kind: 'meaning', label: '知意', field: 'rememberedCount' },
]

/** 按单词 / 词义模糊匹配，大小写无关；空关键词原样返回 */
function filterAchievements(items: Achievement[], query: string): Achievement[] {
  const keyword = query.trim().toLowerCase()
  if (!keyword) return items
  return items.filter(item =>
    item.word.toLowerCase().includes(keyword) ||
    item.meanings.some(meaning => meaning.text.toLowerCase().includes(keyword)),
  )
}

export default function AchievementsTab({ achievements, labels, onTally }: Props) {
  const [query, setQuery] = useState('')
  const [sortKey, setSortKey] = useState<SortKey>('review')

  const field = SORT_OPTIONS.find(option => option.key === sortKey)!.field
  const visible = useMemo(() => {
    const filtered = filterAchievements(achievements, query)
    // 选中维度降序，计数相同按单词字母序兜底，排序稳定
    return [...filtered].sort((a, b) => {
      const diff = Number(b[field]) - Number(a[field])
      return diff !== 0 ? diff : a.word.localeCompare(b.word, 'en')
    })
  }, [achievements, query, field])

  if (achievements.length === 0) {
    return <p className="empty">还没有学习记录，先在桌面版打卡</p>
  }

  return (
    <>
      <div className="ach-toolbar">
        <input
          className="field__input"
          type="text"
          inputMode="search"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder="筛选单词或释义"
          value={query}
          onChange={event => setQuery(event.target.value)}
        />
        <div className="ach-sort">
          {SORT_OPTIONS.map(option => (
            <button
              key={option.key}
              type="button"
              className={'ach-sort__btn' + (sortKey === option.key ? ' ach-sort__btn--active' : '')}
              onClick={() => setSortKey(option.key)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
      {visible.length === 0 ? (
        <p className="empty">没有匹配的单词</p>
      ) : (
        visible.map(item => (
          <AchievementRow key={item.wordKey} item={item} labels={labels} onTally={onTally} />
        ))
      )}
    </>
  )
}

function AchievementRow({ item, labels, onTally }: RowProps) {
  const tags = item.sourceIds.map(id => labels[id] || id)
  // 只读小结：复习次数、没记住次数（不可改）
  const readonly = [
    { label: '复习', value: item.reviewCount, warn: false },
    ...(item.forgottenCount > 0
      ? [{ label: '没记住', value: item.forgottenCount, warn: true }]
      : []),
  ].filter(count => count.value > 0)

  return (
    <article className="ach">
      <div className="ach__top">
        <span className="ach__word">{item.word}</span>
        {tags.length ? (
          <div className="ach__tags">
            {tags.map(tag => <span className="tag" key={tag}>{tag}</span>)}
          </div>
        ) : null}
      </div>
      <div className="ach__steppers">
        {EDITABLE.map(edit => {
          const value = Number(item[edit.field]) || 0
          return (
            <div className="ach__stepper" key={edit.kind}>
              <span className="ach__stepper-label">{edit.label}</span>
              <button
                type="button"
                className="ach__step"
                aria-label={'减少' + edit.label}
                disabled={value <= 0}
                onClick={() => onTally(item.wordKey, edit.kind, -1)}
              >
                −
              </button>
              <span className="ach__stepper-value">{value}</span>
              <button
                type="button"
                className="ach__step"
                aria-label={'增加' + edit.label}
                onClick={() => onTally(item.wordKey, edit.kind, 1)}
              >
                ＋
              </button>
            </div>
          )
        })}
      </div>
      {readonly.length ? (
        <div className="ach__counts">
          {readonly.map(count => (
            <span
              className={'ach__count' + (count.warn ? ' ach__count--warn' : '')}
              key={count.label}
            >
              {count.label} {count.value}
            </span>
          ))}
        </div>
      ) : null}
      {item.meanings.length ? (
        <div className="ach__meanings">
          {item.meanings.map(meaning => (
            <span className="ach__meaning" key={meaning.pos + '|' + meaning.text}>
              {meaning.pos ? meaning.pos + '. ' : ''}{meaning.text}
            </span>
          ))}
        </div>
      ) : null}
    </article>
  )
}
