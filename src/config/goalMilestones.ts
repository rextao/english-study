/**
 * 目标里程碑配置。
 *
 * 时间统一使用「包含 start、不包含 end」的日期区间。新增阶段或周期时只需要
 * 在这里增删配置，页面会自动重新计算当前节点、进度和时间线，不要在页面里
 * 写死阶段数量。
 */
export interface GoalCycleConfig {
  id: string
  /** 节点短名称，例如「周期 1」 */
  label: string
  /** 页面上展示的时间范围 */
  period: string
  /** YYYY-MM-DD，包含当天 */
  start: string
  /** YYYY-MM-DD，结束日不包含在周期内 */
  end: string
  /** 对这一周期的补充说明 */
  note: string
}

export interface GoalPhaseConfig {
  id: string
  label: string
  title: string
  description: string
  cycles: GoalCycleConfig[]
}

export interface GoalGradeConfig {
  id: string
  label: string
  start: string
  end: string
}

export interface GoalFinalTargetConfig {
  id: string
  label: string
  date: string
  note: string
}

export const GOAL_MILESTONE_CONFIG: GoalPhaseConfig[] = [
  {
    id: 'foundation',
    label: '第一阶段',
    title: '基础积累期',
    description: '建立词汇基础与稳定的英语学习节奏。',
    cycles: [
      {
        id: 'cycle-1',
        label: '周期 1',
        period: '2026 年 9 月 – 2027 年 2 月',
        start: '2026-09-01',
        end: '2027-03-01',
        note: '一年级上学期',
      },
      {
        id: 'cycle-2',
        label: '周期 2',
        period: '2027 年 3 月 – 2027 年 8 月',
        start: '2027-03-01',
        end: '2027-09-01',
        note: '一年级下学期',
      },
      {
        id: 'cycle-3',
        label: '周期 3',
        period: '2027 年 9 月 – 2028 年 1 月',
        start: '2027-09-01',
        end: '2028-02-01',
        note: '二年级上学期',
      },
    ],
  },
  {
    id: 'ket-sprint',
    label: '第二阶段',
    title: 'KET 专项冲刺期',
    description: '围绕 KET 考试目标集中训练，完成多轮冲刺与强化。',
    cycles: [
      {
        id: 'cycle-4',
        label: '周期 4',
        period: '2028 年 3 月 – 2028 年 6 月',
        start: '2028-03-01',
        end: '2028-07-01',
        note: '二年级下学期 · 第一轮冲刺',
      },
      {
        id: 'cycle-5',
        label: '周期 5',
        period: '2028 年 7 月 – 2028 年 8 月',
        start: '2028-07-01',
        end: '2028-09-01',
        note: '暑假 · 第二轮强化',
      },
      {
        id: 'cycle-6',
        label: '周期 6',
        period: '2028 年 9 月 – 2028 年 10 月',
        start: '2028-09-01',
        end: '2028-11-01',
        note: '三年级上学期 · 终极冲刺',
      },
    ],
  },
]

/** 时间轴第二层的年级区间，和阶段区间分开配置，避免周期调整时改页面。 */
export const GOAL_GRADE_CONFIG: GoalGradeConfig[] = [
  { id: 'grade-1', label: '一年级', start: '2026-09-01', end: '2027-09-01' },
  { id: 'grade-2', label: '二年级', start: '2027-09-01', end: '2028-09-01' },
  { id: 'grade-3', label: '三年级', start: '2028-09-01', end: '2028-11-01' },
]

/** 时间轴终点的结果目标；达到该节点表示进入考试结果阶段。 */
export const GOAL_FINAL_TARGET: GoalFinalTargetConfig = {
  id: 'ket-exam',
  label: 'KET 考试',
  date: '2028-11-01',
  note: '达到最终目标',
}
