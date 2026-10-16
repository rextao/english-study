import { useState } from 'react'
import { StudyGoal } from '../components/StudyGoal'
import type { StudyPlanApi } from '../hooks/useStudyPlan'
import type { GoalCycleConfig, GoalPhaseConfig, GoalGradeConfig } from '../config/goalMilestones'
import { GOAL_FINAL_TARGET, GOAL_GRADE_CONFIG, GOAL_MILESTONE_CONFIG, GOAL_WORD_TARGET_CONFIG } from '../config/goalMilestones'
import type { StudyPlanItem, VocabLibraryInfo } from '../types/vocab'
import './GoalPage.css'

type CycleStatus = 'completed' | 'current' | 'upcoming'

interface CycleView extends GoalCycleConfig {
  phase: GoalPhaseConfig
  status: CycleStatus
}

interface GoalPageProps {
  libraries: VocabLibraryInfo[]
  getLabelById: (id: string) => string
  plan: StudyPlanApi
}

function dateAtStart(value: string): number {
  const [year, month, day] = value.split('-').map(Number)
  return new Date(year, month - 1, day).getTime()
}

function cycleStatus(cycle: GoalCycleConfig, now: number): CycleStatus {
  if (now >= dateAtStart(cycle.end)) return 'completed'
  if (now >= dateAtStart(cycle.start)) return 'current'
  return 'upcoming'
}

function buildCycleViews(now: number): CycleView[] {
  return GOAL_MILESTONE_CONFIG.flatMap(phase => phase.cycles.map(cycle => ({
    ...cycle,
    phase,
    status: cycleStatus(cycle, now),
  })))
}

function statusText(status: CycleStatus): string {
  if (status === 'completed') return '已完成'
  if (status === 'current') return '进行中'
  return '待开始'
}

function timelinePosition(ts: number, start: number, end: number): number {
  if (end <= start) return 0
  return Math.max(0, Math.min(100, ((ts - start) / (end - start)) * 100))
}

function timelineDate(value: string): string {
  const [year, month] = value.split('-')
  return year + '.' + month
}

function dateText(ts: number): string {
  const date = new Date(ts)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return date.getFullYear() + '.' + month + '.' + day
}

function daysUntil(ts: number, now: number): number {
  return Math.max(0, Math.ceil((ts - now) / (24 * 60 * 60 * 1000)))
}

interface GoalWordStats {
  total: number
  spelling: number
  reading: number
  meaning: number
}

function wordKey(word: string): string {
  return word.trim().toLowerCase().replace(/\s+/g, ' ')
}

function buildGoalWordStats(items: StudyPlanItem[]): GoalWordStats {
  const words = new Map<string, { spelling: number; reading: number; meaning: number }>()
  for (const item of items) {
    const key = wordKey(item.word)
    if (!key) continue
    const previous = words.get(key)
    const current = {
      spelling: Math.max(previous?.spelling ?? 0, item.spellingCount ?? 0),
      reading: Math.max(previous?.reading ?? 0, item.readingCount ?? 0),
      meaning: Math.max(previous?.meaning ?? 0, item.rememberedCount ?? 0),
    }
    words.set(key, current)
  }
  const values = [...words.values()]
  return {
    total: values.filter(value => value.spelling > 0 || value.reading > 0 || value.meaning > 0).length,
    spelling: values.filter(value => value.spelling > 0).length,
    reading: values.filter(value => value.reading > 0).length,
    meaning: values.filter(value => value.meaning > 0).length,
  }
}

function progressPercent(value: number, target: number): number {
  return Math.round((value / target) * 100)
}

/** 目标总览页：先看长期里程碑，再看词库目标的实际完成情况。 */
export function GoalPage({ libraries, getLabelById, plan }: GoalPageProps) {
  const now = Date.now()
  const cycles = buildCycleViews(now)
  const currentCycle = cycles.find(cycle => cycle.status === 'current')
  const firstUpcoming = cycles.find(cycle => cycle.status === 'upcoming')
  const defaultCycle = currentCycle ?? firstUpcoming ?? cycles[cycles.length - 1]
  const [selectedCycleId, setSelectedCycleId] = useState(defaultCycle?.id ?? '')
  const selectedCycle = cycles.find(cycle => cycle.id === selectedCycleId) ?? defaultCycle
  const nextCycle = cycles.find(cycle => cycle.status === 'upcoming')

  const timelineStart = cycles.length > 0 ? dateAtStart(cycles[0].start) : now
  const cycleEnd = cycles.length > 0 ? dateAtStart(cycles[cycles.length - 1].end) : timelineStart + 1
  const timelineEnd = Math.max(cycleEnd, dateAtStart(GOAL_FINAL_TARGET.date))
  const todayPosition = timelinePosition(now, timelineStart, timelineEnd)
  const overallPercent = Math.round(todayPosition)
  const remainingDays = daysUntil(timelineEnd, now)

  const nextNodeDate = nextCycle ? dateAtStart(nextCycle.start) : dateAtStart(GOAL_FINAL_TARGET.date)
  const nextNodeDateText = nextCycle ? timelineDate(nextCycle.start) : timelineDate(GOAL_FINAL_TARGET.date)
  const nextNodeStart = currentCycle ? dateAtStart(currentCycle.start) : timelineStart
  const nextNodeProgress = timelinePosition(now, nextNodeStart, nextNodeDate)
  const goalWordStats = buildGoalWordStats(plan.plan.items)
  const selectedTargetIndex = selectedCycle ? cycles.findIndex(cycle => cycle.id === selectedCycle.id) : 0
  const selectedTarget = GOAL_WORD_TARGET_CONFIG[selectedTargetIndex] ?? GOAL_WORD_TARGET_CONFIG[0]
  const overallTarget = GOAL_WORD_TARGET_CONFIG[GOAL_WORD_TARGET_CONFIG.length - 1].count
  const wordProgressRows = [
    { label: '总进度', value: goalWordStats.total, color: 'blue' },
    { label: '会拼', value: goalWordStats.spelling, color: 'purple' },
    { label: '会读', value: goalWordStats.reading, color: 'orange' },
    { label: '知意', value: goalWordStats.meaning, color: 'green' },
  ]

  return (
    <div className="page page--wide goal-page">
      <div className="goal-progress-board">
        <div>
          <div className="goal-progress-board__head">
            <span>整体周期进度</span>
            <b className="goal-progress-board__value">{overallPercent}% <small>还剩 {remainingDays} 天</small></b>
          </div>
          <div className="goal-milestone__progress-bar" role="progressbar" aria-label="整体周期进度" aria-valuenow={overallPercent} aria-valuemin={0} aria-valuemax={100}>
            <span style={{ width: overallPercent + '%' }} />
          </div>
        </div>
        <div>
          <div className="goal-progress-board__head">
            <span>下一节点：{nextNodeDateText}</span>
            <b className="goal-progress-board__value">{Math.round(nextNodeProgress)}% <small>还剩 {daysUntil(nextNodeDate, now)} 天</small></b>
          </div>
          <div className="goal-milestone__progress-bar goal-milestone__progress-bar--next" role="progressbar" aria-label="距离下一个时间节点的进度" aria-valuenow={Math.round(nextNodeProgress)} aria-valuemin={0} aria-valuemax={100}>
            <span style={{ width: nextNodeProgress + '%' }} />
          </div>
        </div>
      </div>

      <div className="goal-timeline-overview" aria-label="目标阶段时间轴">
        <div className="goal-timeline-overview__scroll">
          <div className="goal-timeline-overview__canvas">
            <div className="goal-timeline-overview__phases" aria-hidden="true">
              {GOAL_MILESTONE_CONFIG.map((phase, phaseIndex) => {
                const phaseStart = dateAtStart(phase.cycles[0].start)
                const phaseEnd = dateAtStart(phase.cycles[phase.cycles.length - 1].end)
                const left = timelinePosition(phaseStart, timelineStart, timelineEnd)
                const right = timelinePosition(phaseEnd, timelineStart, timelineEnd)
                return (
                  <div
                    className={'goal-timeline-overview__phase goal-timeline-overview__phase--' + phaseIndex}
                    key={phase.id}
                    style={{ left: left + '%', width: (right - left) + '%' }}
                  >
                    <span>{phase.label}</span>
                    <strong>{phase.title}</strong>
                  </div>
                )
              })}
            </div>

            <div className="goal-timeline-overview__grades" aria-hidden="true">
              {GOAL_GRADE_CONFIG.map((grade: GoalGradeConfig, gradeIndex) => {
                const left = timelinePosition(dateAtStart(grade.start), timelineStart, timelineEnd)
                const right = timelinePosition(dateAtStart(grade.end), timelineStart, timelineEnd)
                return (
                  <div
                    className={'goal-timeline-overview__grade goal-timeline-overview__grade--' + gradeIndex}
                    key={grade.id}
                    style={{ left: left + '%', width: (right - left) + '%' }}
                  >
                    {grade.label}
                  </div>
                )
              })}
            </div>

            <div className="goal-timeline-overview__axis" aria-label="目标阶段时间轴">
              <span className="goal-timeline-overview__axis-line" aria-hidden="true" />
              <span
                className="goal-timeline-overview__goal"
                style={{ left: timelinePosition(dateAtStart(GOAL_FINAL_TARGET.date), timelineStart, timelineEnd) + '%' }}
                aria-label={GOAL_FINAL_TARGET.label + '，' + GOAL_FINAL_TARGET.note}
              >
                <span className="goal-timeline-overview__goal-icon" aria-hidden="true">
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none">
                    <path d="M7 4h10v4a5 5 0 0 1-10 0V4Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
                    <path d="M9 19h6M12 13v6M7 6H4v2a4 4 0 0 0 4 4M17 6h3v2a4 4 0 0 1-4 4M8 21h8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>
                <strong>{GOAL_FINAL_TARGET.label}</strong>
                <span className="goal-timeline-overview__goal-date">{timelineDate(GOAL_FINAL_TARGET.date)}</span>
              </span>
              <span className="goal-timeline-overview__today" style={{ left: todayPosition + '%' }}>
                <span className="goal-timeline-overview__today-dot" />
                <span className="goal-timeline-overview__today-label">{dateText(now)}</span>
              </span>
              {cycles.map((cycle, cycleIndex) => {
                const position = timelinePosition(dateAtStart(cycle.start), timelineStart, timelineEnd)
                const nextPosition = cycleIndex < cycles.length - 1
                  ? timelinePosition(dateAtStart(cycles[cycleIndex + 1].start), timelineStart, timelineEnd)
                  : 100
                const selected = cycle.id === selectedCycle?.id
                const edgeClass = cycleIndex === 0
                  ? ' goal-timeline-overview__node--start'
                  : cycleIndex === cycles.length - 1
                    ? ' goal-timeline-overview__node--end'
                    : ''
                const sideClass = cycleIndex % 2 === 0
                  ? ' goal-timeline-overview__node--above'
                  : ' goal-timeline-overview__node--below'
                return (
                  <button
                    key={cycle.id}
                    type="button"
                    className={'goal-timeline-overview__node goal-timeline-overview__node--' + cycle.status + edgeClass + sideClass + (selected ? ' goal-timeline-overview__node--selected' : '')}
                    style={{ left: position + '%', width: (nextPosition - position) + '%' }}
                    aria-pressed={selected}
                    aria-label={cycle.label + '，开始于 ' + cycle.period + '，' + statusText(cycle.status)}
                    onClick={() => setSelectedCycleId(cycle.id)}
                  >
                    <span className="goal-timeline-overview__node-dot" />
                    <span className="goal-timeline-overview__node-label">{timelineDate(cycle.start)}</span>
                  </button>
                )
              })}
            </div>
          </div>
        </div>
      </div>

      <section className="goal-details" aria-labelledby="goal-details-title">
        <div className="goal-details__header">
          <h2 id="goal-details-title">单词目标</h2>
        </div>
        <div className="goal-details__overview">
          <div className="goal-details__overview-head">
            <div>
              <span className="goal-milestone__label">总目标</span>
            </div>
            <b>{progressPercent(goalWordStats.total, overallTarget)}% <small>({goalWordStats.total} / {overallTarget})</small></b>
          </div>
          <div className="goal-details__overall-labels">
            <div className="goal-details__target-markers" aria-hidden="true">
              {GOAL_WORD_TARGET_CONFIG.slice(0, -1).map(target => (
                <i className="goal-details__target-marker" key={target.label} style={{ left: (target.count / overallTarget * 100) + '%' }}>
                  <b>{target.count}</b>
                </i>
              ))}
            </div>
            {wordProgressRows.map(row => {
              const percent = progressPercent(row.value, overallTarget)
              const isMain = row.color === 'blue'
              return (
                <div className={'goal-details__overall-label' + (isMain ? ' goal-details__overall-label--main' : '')} key={row.label}>
                  <span className="goal-details__overall-label-name">{row.label}</span>
                  <div className={'goal-details__progress-bar goal-details__progress-bar--' + row.color} role="progressbar" aria-label={'总目标' + row.label} aria-valuenow={Math.min(100, percent)} aria-valuemin={0} aria-valuemax={100}>
                    <span style={{ width: Math.min(100, percent) + '%' }} />
                    <b>{row.value} · {percent}%</b>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
        <div className="goal-details__word-card">
          <div className="goal-details__word-heading">
            <div>
              <span className="goal-milestone__label">当前周期</span>
            </div>
            <span className="goal-details__word-target">{progressPercent(goalWordStats.total, selectedTarget.count)}% <small>({goalWordStats.total} / {selectedTarget.count})</small></span>
          </div>
          <div className="goal-details__progress-list">
            {wordProgressRows.map(row => {
              const percent = progressPercent(row.value, selectedTarget.count)
              const barPercent = Math.min(100, percent)
              const isMain = row.color === 'blue'
              return (
                <div className="goal-details__progress-row" key={row.label}>
                  <div className="goal-details__progress-meta">
                    <span>{row.label}</span>
                  </div>
                  <div className={'goal-details__progress-bar goal-details__progress-bar--' + row.color} role="progressbar" aria-label={row.label} aria-valuenow={barPercent} aria-valuemin={0} aria-valuemax={100}>
                    <span style={{ width: barPercent + '%' }} />
                    <b>{isMain ? row.value + ' / ' + selectedTarget.count + ' · ' + percent + '%' : row.value + ' · ' + percent + '%'}</b>
                  </div>
                  {percent > 100 && <small className="goal-details__overage">超额完成 +{row.value - selectedTarget.count} 词</small>}
                </div>
              )
            })}
          </div>
        </div>
      </section>

      <section className="goal-page__target" aria-labelledby="goal-target-title">
        <div className="goal-page__section-head">
          <div>
            <span className="goal-milestone__eyebrow">当前执行目标</span>
            <h2 id="goal-target-title">目标词库进度</h2>
            <p>把当前阶段拆成可执行的词库目标，已毕业、学习中和未开始一目了然。</p>
          </div>
        </div>
        {plan.offline && (
          <div className="callout callout--warn goal-page__notice">
            云端连接失败，词库目标进度暂时可能不是最新数据。
          </div>
        )}
        {plan.loading && (
          <p className="hint goal-page__loading"><span className="ui-spin" aria-hidden="true" />正在同步目标进度...</p>
        )}
        <StudyGoal libraries={libraries} items={plan.plan.items} getLabelById={getLabelById} />
      </section>
    </div>
  )
}
