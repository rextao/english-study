import { useState } from 'react'
import { PageHeader } from '../components/PageHeader'
import { StudyGoal } from '../components/StudyGoal'
import type { StudyPlanApi } from '../hooks/useStudyPlan'
import type { GoalCycleConfig, GoalPhaseConfig, GoalGradeConfig } from '../config/goalMilestones'
import { GOAL_FINAL_TARGET, GOAL_GRADE_CONFIG, GOAL_MILESTONE_CONFIG } from '../config/goalMilestones'
import type { VocabLibraryInfo } from '../types/vocab'
import './GoalPage.css'

type CycleStatus = 'completed' | 'current' | 'upcoming'
type PhaseStatus = 'completed' | 'current' | 'upcoming' | 'transition'

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

function phaseStatus(cycles: CycleView[]): PhaseStatus {
  if (cycles.some(cycle => cycle.status === 'current')) return 'current'
  if (cycles.length > 0 && cycles.every(cycle => cycle.status === 'completed')) return 'completed'
  if (cycles.length > 0 && cycles.every(cycle => cycle.status === 'upcoming')) return 'upcoming'
  return 'transition'
}

function statusText(status: CycleStatus): string {
  if (status === 'completed') return '已完成'
  if (status === 'current') return '进行中'
  return '待开始'
}

function phaseStatusText(status: PhaseStatus): string {
  if (status === 'completed') return '阶段完成'
  if (status === 'current') return '当前阶段'
  if (status === 'transition') return '阶段衔接'
  return '即将开始'
}

function cycleProgress(cycle: CycleView, now: number): number {
  if (cycle.status === 'completed') return 100
  if (cycle.status === 'upcoming') return 0
  const start = dateAtStart(cycle.start)
  const end = dateAtStart(cycle.end)
  return Math.max(0, Math.min(100, ((now - start) / (end - start)) * 100))
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
  return date.getFullYear() + ' 年 ' + (date.getMonth() + 1) + ' 月 ' + date.getDate() + ' 日'
}

/** 目标总览页：先看长期里程碑，再看词库目标的实际完成情况。 */
export function GoalPage({ libraries, getLabelById, plan }: GoalPageProps) {
  const now = Date.now()
  const cycles = buildCycleViews(now)
  const currentCycle = cycles.find(cycle => cycle.status === 'current')
  const firstUpcoming = cycles.find(cycle => cycle.status === 'upcoming')
  const completedCount = cycles.filter(cycle => cycle.status === 'completed').length
  const defaultCycle = currentCycle ?? firstUpcoming ?? cycles[cycles.length - 1]
  const [selectedCycleId, setSelectedCycleId] = useState(defaultCycle?.id ?? '')
  const selectedCycle = cycles.find(cycle => cycle.id === selectedCycleId) ?? defaultCycle

  const timelineStart = cycles.length > 0 ? dateAtStart(cycles[0].start) : now
  const cycleEnd = cycles.length > 0 ? dateAtStart(cycles[cycles.length - 1].end) : timelineStart + 1
  const timelineEnd = Math.max(cycleEnd, dateAtStart(GOAL_FINAL_TARGET.date))
  const todayPosition = timelinePosition(now, timelineStart, timelineEnd)
  const overallPercent = Math.round(todayPosition)

  let overallStageText = '目标尚未开始'
  if (currentCycle) overallStageText = currentCycle.phase.label + ' · ' + currentCycle.phase.title
  else if (firstUpcoming && completedCount > 0) overallStageText = '阶段衔接期'
  else if (!firstUpcoming && cycles.length > 0) overallStageText = '全部周期已完成'

  const progressHint = currentCycle
    ? '当前周期已进行 ' + Math.round(cycleProgress(currentCycle, now)) + '%'
    : firstUpcoming
      ? '下一节点：' + firstUpcoming.label + ' · ' + firstUpcoming.period
      : '所有里程碑已完成'

  return (
    <div className="page page--wide goal-page">
      <PageHeader
        title="目标与里程碑"
        subtitle="从长期阶段到当前词库目标，随时确认现在在哪里、下一步要到哪里。"
      />

      <section className="goal-milestone" aria-labelledby="goal-milestone-title">
        <div className="goal-milestone__header">
          <div className="goal-milestone__intro">
            <span className="goal-milestone__eyebrow">总体里程碑</span>
            <h2 id="goal-milestone-title">长期目标路线图</h2>
            <p>阶段和周期统一由配置文件维护，未来可以在每个节点下继续接入对应的 OKR。</p>
          </div>
          <div className="goal-milestone__summary" aria-label={'总体进度 ' + overallPercent + '%'}>
            <strong>{overallPercent}<small>%</small></strong>
            <span>{completedCount} / {cycles.length} 个周期完成</span>
          </div>
        </div>

        <div className="goal-milestone__overview">
          <div className="goal-milestone__current">
            <span className="goal-milestone__label">当前所处阶段</span>
            <strong>{overallStageText}</strong>
            <span>
              {currentCycle
                ? currentCycle.label + ' · ' + currentCycle.period
                : progressHint}
            </span>
          </div>
          <div className="goal-milestone__progress">
            <div className="goal-milestone__progress-head">
              <span>整体周期进度</span>
              <b>{overallPercent}%</b>
            </div>
            <div className="goal-milestone__progress-bar" role="progressbar" aria-valuenow={overallPercent} aria-valuemin={0} aria-valuemax={100}>
              <span style={{ width: overallPercent + '%' }} />
            </div>
            <span className="goal-milestone__progress-hint">{progressHint}</span>
          </div>
        </div>

        <div className="goal-timeline-overview" aria-labelledby="goal-timeline-title">
          <div className="goal-timeline-overview__head">
            <div>
              <span className="goal-milestone__label">时间轴总览</span>
              <h3 id="goal-timeline-title">从现在到 KET 冲刺</h3>
            </div>
            <span className="goal-timeline-overview__today-label">今天 · {dateText(now)}</span>
          </div>

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
                </span>
                <span className="goal-timeline-overview__today" style={{ left: todayPosition + '%' }}>
                  <span className="goal-timeline-overview__today-dot" />
                  <span>今天</span>
                </span>
                {cycles.map((cycle, cycleIndex) => {
                  const position = timelinePosition(dateAtStart(cycle.start), timelineStart, timelineEnd)
                  const selected = cycle.id === selectedCycle?.id
                  const edgeClass = cycleIndex === 0
                    ? ' goal-timeline-overview__node--start'
                    : cycleIndex === cycles.length - 1
                      ? ' goal-timeline-overview__node--end'
                      : ''
                  return (
                    <button
                      key={cycle.id}
                      type="button"
                      className={'goal-timeline-overview__node goal-timeline-overview__node--' + cycle.status + edgeClass + (selected ? ' goal-timeline-overview__node--selected' : '')}
                      style={{ left: position + '%' }}
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

        <div className="goal-milestone__phases">
          {GOAL_MILESTONE_CONFIG.map((phase, phaseIndex) => {
            const phaseCycles = cycles.filter(cycle => cycle.phase.id === phase.id)
            const state = phaseStatus(phaseCycles)
            return (
              <section className="goal-phase" key={phase.id} aria-labelledby={'goal-phase-' + phase.id}>
                <div className="goal-phase__header">
                  <div className="goal-phase__title-wrap">
                    <span className="goal-phase__number">阶段 {phaseIndex + 1}</span>
                    <div>
                      <h3 id={'goal-phase-' + phase.id}>{phase.title}</h3>
                      <p>{phase.description}</p>
                    </div>
                  </div>
                  <span className={'goal-phase__status goal-phase__status--' + state}>{phaseStatusText(state)}</span>
                </div>

                <div className="goal-timeline" role="list" aria-label={phase.title + '周期节点'}>
                  {phaseCycles.map(cycle => {
                    const selected = cycle.id === selectedCycle?.id
                    return (
                      <button
                        key={cycle.id}
                        type="button"
                        className={'goal-node goal-node--' + cycle.status + (selected ? ' goal-node--selected' : '')}
                        aria-pressed={selected}
                        aria-label={phase.title + '，' + cycle.label + '，' + cycle.period + '，' + statusText(cycle.status)}
                        onClick={() => setSelectedCycleId(cycle.id)}
                      >
                        <span className="goal-node__dot" aria-hidden="true" />
                        <span className="goal-node__body">
                          <span className="goal-node__label">{cycle.label}</span>
                          <strong>{cycle.period}</strong>
                          <span className="goal-node__note">{cycle.note}</span>
                          <span className="goal-node__status">{statusText(cycle.status)}</span>
                        </span>
                      </button>
                    )
                  })}
                </div>
              </section>
            )
          })}
        </div>

        {selectedCycle && (
          <div className="goal-milestone__selected">
            <div>
              <span className="goal-milestone__label">已选节点</span>
              <strong>{selectedCycle.phase.label} · {selectedCycle.label}</strong>
            </div>
            <p>{selectedCycle.period} · {selectedCycle.note}</p>
            <span className="goal-milestone__selected-hint">后续可在此节点查看具体 OKR，目前先用它确认阶段位置。</span>
          </div>
        )}
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
