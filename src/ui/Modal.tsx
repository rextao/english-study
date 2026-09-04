import { useEffect, useId, useRef } from 'react'
import type { ReactNode } from 'react'
import { useDismiss } from './useDismiss'

export interface ModalProps {
  open: boolean
  /** 弹窗标题 */
  title?: ReactNode
  /** 标题下面一行说明 */
  description?: ReactNode
  /** 底部操作区，不传就不渲染 */
  footer?: ReactNode
  /** default 520px，wide 720px */
  width?: 'default' | 'wide'
  onClose: () => void
  children: ReactNode
}

/** 居中弹窗：点遮罩或按 Esc 关闭，打开时锁住页面滚动 */
export function Modal({
  open,
  title,
  description,
  footer,
  width = 'default',
  onClose,
  children,
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement | null>(null)
  const titleId = useId()

  // 点面板外面（也就是遮罩）或按 Esc 关闭
  useDismiss(open, panelRef, onClose)

  // 弹窗打开期间禁掉页面滚动，关掉再还原
  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [open])

  // 打开后把焦点移进面板，键盘操作才落在弹窗里
  useEffect(() => {
    if (open) panelRef.current?.focus()
  }, [open])

  if (!open) return null

  return (
    <div className="ui-modal-mask">
      <div
        ref={panelRef}
        className={'ui-modal' + (width === 'wide' ? ' ui-modal--wide' : '')}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title != null ? titleId : undefined}
        tabIndex={-1}
      >
        <div className="ui-modal__head">
          <div className="ui-modal__heading">
            {title != null && <h2 className="ui-modal__title" id={titleId}>{title}</h2>}
            {description != null && <p className="ui-modal__desc">{description}</p>}
          </div>
          <button type="button" className="ui-modal__close" aria-label="关闭" onClick={onClose}>×</button>
        </div>

        <div className="ui-modal__body">{children}</div>

        {footer != null && <div className="ui-modal__foot">{footer}</div>}
      </div>
    </div>
  )
}
