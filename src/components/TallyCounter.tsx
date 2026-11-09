import type { ReactNode } from 'react'
import { Button, Popconfirm } from '../ui'
import './TallyCounter.css'

/** 计次维度：会拼 / 会读 / 知意，与学习成果页的列、服务端 tally 维度一致 */
export type TallyKind = 'spelling' | 'reading' | 'meaning'

export const TALLY_KIND_LABEL: Record<TallyKind, string> = {
  spelling: '会拼',
  reading: '会读',
  meaning: '知意',
}

export interface TallyCounterProps {
  kind: TallyKind
  value: number
  /** 加到这个值后禁用加号；不传则不设上限 */
  max?: number
  /** 整个控件禁用（数据写入中之类的） */
  disabled?: boolean
  /** 加一次确认弹窗的说明；不传用学习成果页的默认口径 */
  addDescription?: ReactNode
  /** 减一次确认弹窗的说明；不传用学习成果页的默认口径 */
  reduceDescription?: ReactNode
  onAdjust: (kind: TallyKind, delta: 1 | -1) => void
}

/**
 * 「维度 次数 / −」计次控件：加和减都走 Popconfirm 二次确认。
 * 学习成果页的编辑次数与背词保存抽屉共用这一份，两边口径不会走偏。
 */
export function TallyCounter({
  kind,
  value,
  max,
  disabled,
  addDescription,
  reduceDescription,
  onAdjust,
}: TallyCounterProps) {
  const label = TALLY_KIND_LABEL[kind]
  const atMax = max != null && value >= max
  return (
    <span className="tally-counter">
      <Popconfirm
        title={'增加一次' + label + '？'}
        description={addDescription ?? '这会新增一条永久学习记录。'}
        okText="确认修改"
        cancelText="取消"
        disabled={disabled || atMax}
        onConfirm={() => onAdjust(kind, 1)}
      >
        <Button
          size="small"
          className="tally-counter__tally"
          aria-label={'增加一次' + label}
          disabled={disabled || atMax}
        >
          {label} {value}
        </Button>
      </Popconfirm>
      <Popconfirm
        title={'减少一次' + label + '？'}
        description={reduceDescription ?? '这会同步修改永久学习成果，操作不可撤销。'}
        okText="确认修改"
        cancelText="取消"
        danger
        disabled={disabled || value <= 0}
        onConfirm={() => onAdjust(kind, -1)}
      >
        <Button
          size="small"
          className="tally-counter__tally"
          aria-label={'减少一次' + label}
          disabled={disabled || value <= 0}
        >
          −
        </Button>
      </Popconfirm>
    </span>
  )
}
