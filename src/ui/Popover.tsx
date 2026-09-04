import { useCallback, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useDismiss } from './useDismiss'

export interface PopoverProps {
  /** 面板标题，不传就不渲染标题行 */
  title?: ReactNode
  placement?: 'top' | 'bottomRight'
  /** 释义勾选这类内容比确认框宽不少 */
  wide?: boolean
  disabled?: boolean
  className?: string
  /** 面板内容；参数 close 用来在保存完自己收起来 */
  render: (close: () => void) => ReactNode
  children: ReactNode
}

/** 通用浮层：点触发器展开，点外面或按 Esc 收起，内容由调用方自己画 */
export function Popover({
  title,
  placement = 'bottomRight',
  wide = false,
  disabled = false,
  className,
  render,
  children,
}: PopoverProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLSpanElement | null>(null)
  const close = useCallback(() => setOpen(false), [])
  useDismiss(open, rootRef, close)

  const panelClass = [
    'ui-popover',
    placement === 'top' ? 'ui-popover--top' : '',
    wide ? 'ui-popover--wide' : '',
  ].filter(Boolean).join(' ')

  return (
    <span className={'ui-popover-host' + (className ? ' ' + className : '')} ref={rootRef}>
      <span
        className="ui-popover-host__trigger"
        onClick={() => { if (!disabled) setOpen(prev => !prev) }}
      >
        {children}
      </span>

      {open && (
        <div className={panelClass} role="dialog">
          {title != null && <div className="ui-popover__title">{title}</div>}
          {render(close)}
        </div>
      )}
    </span>
  )
}
