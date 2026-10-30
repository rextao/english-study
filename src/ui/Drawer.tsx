import { useEffect, useId, useRef } from 'react'
import type { ReactNode } from 'react'
import { useDismiss } from './useDismiss'

export interface DrawerProps {
  open: boolean
  /** 抽屉标题 */
  title?: ReactNode
  /** 标题下面一行说明 */
  description?: ReactNode
  /** 底部操作区，不传就不渲染 */
  footer?: ReactNode
  /** default 460px，wide 640px；窄屏一律占满整屏 */
  width?: 'default' | 'wide'
  onClose: () => void
  children: ReactNode
}

/** 右侧抽屉：点遮罩或按 Esc 关闭，打开时锁住页面滚动 */
export function Drawer({
  open,
  title,
  description,
  footer,
  width = 'default',
  onClose,
  children,
}: DrawerProps) {
  const panelRef = useRef<HTMLDivElement | null>(null)
  const titleId = useId()

  // 点面板外面（也就是遮罩）或按 Esc 关闭
  useDismiss(open, panelRef, onClose)

  // 抽屉打开期间禁掉页面滚动，关掉再还原
  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [open])

  // 打开后把焦点移进面板，键盘操作才落在抽屉里
  useEffect(() => {
    if (open) panelRef.current?.focus()
  }, [open])

  if (!open) return null

  return (
    <div className="ui-drawer-mask">
      <div
        ref={panelRef}
        className={'ui-drawer' + (width === 'wide' ? ' ui-drawer--wide' : '')}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title != null ? titleId : undefined}
        tabIndex={-1}
      >
        <div className="ui-drawer__head">
          <div className="ui-drawer__heading">
            {title != null && <h2 className="ui-drawer__title" id={titleId}>{title}</h2>}
            {description != null && <p className="ui-drawer__desc">{description}</p>}
          </div>
          <button type="button" className="ui-drawer__close" aria-label="关闭" onClick={onClose}>×</button>
        </div>

        <div className="ui-drawer__body">{children}</div>

        {footer != null && <div className="ui-drawer__foot">{footer}</div>}
      </div>
    </div>
  )
}
