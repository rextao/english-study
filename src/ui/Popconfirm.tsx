import { useCallback, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useDismiss } from './useDismiss'
import { Button } from './Button'

export interface PopconfirmProps {
  title: ReactNode
  description?: ReactNode
  okText?: string
  cancelText?: string
  /** 确认按钮用危险色 */
  danger?: boolean
  disabled?: boolean
  placement?: 'top' | 'bottomRight'
  onConfirm: () => void
  children: ReactNode
}

export function Popconfirm({
  title,
  description,
  okText = '确定',
  cancelText = '取消',
  danger = false,
  disabled = false,
  placement = 'top',
  onConfirm,
  children,
}: PopconfirmProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLSpanElement | null>(null)
  const close = useCallback(() => setOpen(false), [])
  useDismiss(open, rootRef, close)

  return (
    <span className="ui-popconfirm" ref={rootRef}>
      <span
        className="ui-popconfirm__trigger"
        onClick={() => {
          if (!disabled) setOpen((prev) => !prev)
        }}
      >
        {children}
      </span>

      {open && (
        <div className={'ui-popover' + (placement === 'top' ? ' ui-popover--top' : '')} role="dialog">
          <div className="ui-popover__title">{title}</div>
          {description != null && <div className="ui-popover__desc">{description}</div>}
          <div className="ui-popover__actions">
            <Button size="small" onClick={() => setOpen(false)}>{cancelText}</Button>
            <Button
              size="small"
              type="primary"
              danger={danger}
              onClick={() => {
                setOpen(false)
                onConfirm()
              }}
            >
              {okText}
            </Button>
          </div>
        </div>
      )}
    </span>
  )
}
