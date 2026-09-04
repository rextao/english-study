import { useMemo } from 'react'
import { Select, Tag } from '../ui'
import type { SelectOption } from '../ui'
import { useStudyGoal } from '../hooks/useStudyGoal'
import type { StudyPlanItem, VocabLibraryInfo } from '../types/vocab'
import './StudyGoal.css'

/** 目标外的获得最多平铺几个词，多出来的收进「还有 N 个」 */
const EXTRA_LIMIT = 12

/** 与服务端 normalizeText 一致，作为词条与学习记录的匹配主键 */
const norm = (input: string) => input.trim().replace(/\s+/g, ' ').toLowerCase()

interface GoalStats {
  /** 词库里的词条总数 */
  total: number
  mastered: number
  learning: number
  untouched: number
  percent: string
  ratioMastered: number
  ratioLearning: number
  /** 已掌握但不在目标词库里的数量（含句子） */
  extraCount: number
  extraLearning: number
  extraSentences: number
  extraWords: string[]
}

/**
 * 词条有 a/an、at / @ 这类多写法，要拆出各个变体，否则学了 an 匹配不到 a/an。
 * 先登记完整词条再登记变体，让独立词条 you 优先于 poor thing/you 拆出来的 you。
 */
function buildFormIndex(entries: { word: string }[]): Map<string, number> {
  const index = new Map<string, number>()
  entries.forEach((entry, i) => {
    const key = norm(entry.word)
    if (key && !index.has(key)) index.set(key, i)
  })
  entries.forEach((entry, i) => {
    if (!entry.word.includes('/')) return
    for (const part of entry.word.split('/')) {
      const key = norm(part)
      if (key && !index.has(key)) index.set(key, i)
    }
  })
  return index
}

/** 词库动辄上千词，头尾保留一位小数，不然刚起步永远显示 0% */
function fmtPercent(part: number, total: number): string {
  if (total <= 0 || part <= 0) return '0'
  if (part >= total) return '100'
  const value = (part / total) * 100
  if (value < 10 || value > 99) return value.toFixed(1)
  return String(Math.round(value))
}

interface StudyGoalProps {
  libraries: VocabLibraryInfo[]
  /** 已经开始学的词（含已毕业的），来自复习计划 */
  items: StudyPlanItem[]
  /** 复习轮次总数，用于说明「毕业」是怎么算的 */
  totalRounds: number
  getLabelById: (id: string) => string
}

/** 目标模块：目标 = 一个词库，拿「已经会的词」和词库词条对比给出达成度 */
export function StudyGoal({ libraries, items, totalRounds, getLabelById }: StudyGoalProps) {
  const { libraryId, setGoal } = useStudyGoal()

  // 没设过目标、或目标词库被删了，就先按第一个词库看，但不写回服务端
  const goalLib = libraries.find(l => l.id === libraryId) ?? libraries[0]

  const stats = useMemo<GoalStats | null>(() => {
    if (!goalLib) return null
    const entries   = goalLib.words
    const formIndex = buildFormIndex(entries)

    // 同一个词可能同时在多个学习列表里，取最好的状态
    const known = new Map<string, { mastered: boolean; sentence: boolean }>()
    for (const item of items) {
      const key = norm(item.word)
      if (!key) continue
      const prev = known.get(key)
      known.set(key, {
        mastered: (prev?.mastered ?? false) || item.state === 'mastered',
        sentence: (prev?.sentence ?? true) && item.type === 'sentence',
      })
    }

    const masteredIdx = new Set<number>()
    const learningIdx = new Set<number>()
    const extraWords: string[] = []
    let extraCount = 0
    let extraLearning = 0
    let extraSentences = 0

    for (const [word, info] of known) {
      const hit = formIndex.get(word)
      if (hit === undefined) {
        // 不在目标词库里：背下来了算目标外的获得，还在学的只报个数
        if (!info.mastered) { extraLearning++; continue }
        extraCount++
        if (info.sentence) extraSentences++
        else extraWords.push(word)
        continue
      }
      if (info.mastered) masteredIdx.add(hit)
      else learningIdx.add(hit)
    }
    // 一个词条只算一次，已掌握优先
    for (const hit of masteredIdx) learningIdx.delete(hit)

    const total = entries.length
    extraWords.sort((a, b) => a.localeCompare(b))
    return {
      total,
      mastered:   masteredIdx.size,
      learning:   learningIdx.size,
      untouched:  Math.max(0, total - masteredIdx.size - learningIdx.size),
      percent:    fmtPercent(masteredIdx.size, total),
      ratioMastered: total > 0 ? (masteredIdx.size / total) * 100 : 0,
      ratioLearning: total > 0 ? (learningIdx.size / total) * 100 : 0,
      extraCount,
      extraLearning,
      extraSentences,
      extraWords,
    }
  }, [goalLib, items])

  const options: SelectOption[] = libraries.map(lib => ({
    value: lib.id,
    label: getLabelById(lib.id),
    extra: lib.words.length + ' 词条',
  }))

  if (!goalLib || !stats) {
    return (
      <section className="study-goal">
        <h2 className="study-goal__title">目标</h2>
        <p className="empty empty--inline">还没有词库，往 vocab 目录放一个词库 json 就能设目标了。</p>
      </section>
    )
  }

  const goalName = getLabelById(goalLib.id)
  const done     = stats.total > 0 && stats.mastered >= stats.total

  return (
    <section className="study-goal">
      <div className="study-goal__head">
        <div className="study-goal__intro">
          <h2 className="study-goal__title">目标：背完一个词库</h2>
          <p className="hint">走完 {totalRounds} 轮复习毕业的词算达成，词库外背下来的算目标外的获得</p>
        </div>
        <div className="study-goal__picker">
          <label className="field-label" htmlFor="study-goal-lib">目标词库</label>
          <Select
            id="study-goal-lib"
            aria-label="目标词库"
            value={goalLib.id}
            options={options}
            onChange={setGoal}
          />
        </div>
      </div>

      <div className="study-goal__hero">
        <span className="study-goal__percent">
          {stats.percent}
          <span className="study-goal__percent-unit">%</span>
        </span>
        <div className="study-goal__hero-meta">
          <p className="study-goal__hero-title">{goalName} · 已毕业 {stats.mastered} / {stats.total} 词条</p>
          <div
            className="study-goal__bar"
            role="img"
            aria-label={'已毕业 ' + stats.mastered + ' 词，学习中 ' + stats.learning + ' 词，共 ' + stats.total + ' 词条'}
          >
            <span className="study-goal__seg study-goal__seg--mastered" style={{ width: stats.ratioMastered + '%' }} />
            <span className="study-goal__seg study-goal__seg--learning" style={{ width: stats.ratioLearning + '%' }} />
          </div>
          <ul className="study-goal__stats">
            <li className="study-goal__stat">
              <span className="study-goal__dot study-goal__dot--mastered" aria-hidden="true" />
              已毕业 <b className="study-goal__stat-num">{stats.mastered}</b>
            </li>
            <li className="study-goal__stat">
              <span className="study-goal__dot study-goal__dot--learning" aria-hidden="true" />
              学习中 <b className="study-goal__stat-num">{stats.learning}</b>
            </li>
            <li className="study-goal__stat">
              <span className="study-goal__dot study-goal__dot--rest" aria-hidden="true" />
              还没开始 <b className="study-goal__stat-num">{stats.untouched}</b>
            </li>
          </ul>
        </div>
      </div>

      {done && (
        <p className="callout callout--success study-goal__done">
          目标达成，{goalName} 里的词都毕业了，换一个词库继续吧。
        </p>
      )}

      {(stats.extraCount > 0 || stats.extraLearning > 0) && (
        <div className="study-goal__extra">
          <p className="study-goal__extra-title">
            目标外的获得 {stats.extraCount} 个
            {stats.extraSentences > 0 && '（含 ' + stats.extraSentences + ' 个句子）'}
            {stats.extraLearning > 0 && ' · 另有 ' + stats.extraLearning + ' 个在学'}
          </p>
          {stats.extraWords.length > 0 && (
            <div className="study-goal__extra-tags">
              {stats.extraWords.slice(0, EXTRA_LIMIT).map(word => (
                <Tag key={word} color="purple">{word}</Tag>
              ))}
              {stats.extraWords.length > EXTRA_LIMIT && (
                <span className="study-goal__extra-more">还有 {stats.extraWords.length - EXTRA_LIMIT} 个</span>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  )
}
