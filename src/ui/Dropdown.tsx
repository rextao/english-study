import { useCallback, useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { useDismiss } from './useDismiss'

export interface MenuItemType {
  key: string
  label: ReactNode
  extra?: ReactNode
  icon?: ReactNode
  disabled?: boolean
  danger?: boolean
}

export interface DropdownProps {
  /** 与 antd 一致：menu={{ items, onClick }} */
  menu: {
    items: MenuItemType[]
    onClick?: (info: { key: string }) => void
  }
  children: ReactNode
  placement?: 'bottomLeft' | 'bottomRight'
  disabled?: boolean
  /** 菜单顶部的分组标题 */
  title?: ReactNode
  emptyText?: string
}

export function Dropdown({
  menu,
  children,
  placement = 'bottomLeft',
  disabled = false,
  title,
  emptyText = '暂无选项',
}: DropdownProps) {
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const rootRef = useRef<HTMLSpanElement | null>(null)
  const triggerRef = useRef<HTMLSpanElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const itemsRef = useRef(menu.items)
  itemsRef.current = menu.items

  const close = useCallback(() => setOpen(false), [])
  useDismiss(open, rootRef, close)

  useEffect(() => {
    if (!open) return
    setActiveIndex(itemsRef.current.findIndex((item) => !item.disabled))
    menuRef.current?.focus()
  }, [open])

  function focusTrigger() {
    const node = triggerRef.current?.querySelector('button, [tabindex], a')
    if (node instanceof HTMLElement) node.focus()
  }

  function closeAndRestore() {
    setOpen(false)
    focusTrigger()
  }

  function moveMenu(step: number) {
    const items = menu.items
    if (items.length === 0) return
    let cursor = activeIndex
    if (cursor < 0) cursor = step > 0 ? -1 : 0
    for (let i = 0; i < items.length; i += 1) {
      cursor = (cursor + step + items.length) % items.length
      if (!items[cursor].disabled) {
        setActiveIndex(cursor)
        return
      }
    }
  }

  function activate(index: number) {
    const item = menu.items[index]
    if (!item || item.disabled) return
    setOpen(false)
    focusTrigger()
    menu.onClick?.({ key: item.key })
  }

  function handleMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        moveMenu(1)
        break
      case 'ArrowUp':
        event.preventDefault()
        moveMenu(-1)
        break
      case 'Home':
        event.preventDefault()
        setActiveIndex(menu.items.findIndex((item) => !item.disabled))
        break
      case 'End': {
        event.preventDefault()
        let last = -1
        menu.items.forEach((item, index) => {
          if (!item.disabled) last = index
        })
        setActiveIndex(last)
        break
      }
      case 'Enter':
      case ' ':
        event.preventDefault()
        activate(activeIndex)
        break
      case 'Escape':
        event.preventDefault()
        closeAndRestore()
        break
      case 'Tab':
        setOpen(false)
        break
      default:
        break
    }
  }

  return (
    <span className="ui-dropdown" ref={rootRef}>
      <span
        className="ui-dropdown__trigger"
        ref={triggerRef}
        onClick={() => {
          if (!disabled) setOpen((prev) => !prev)
        }}
        onKeyDown={(event) => {
          if (disabled || open) return
          if (event.key === 'ArrowDown') {
            event.preventDefault()
            setOpen(true)
          }
        }}
      >
        {children}
      </span>

      {open && (
        <div
          className={'ui-menu ui-menu--' + placement}
          role="menu"
          tabIndex={-1}
          ref={menuRef}
          onKeyDown={handleMenuKeyDown}
          aria-label={typeof title === 'string' ? title : undefined}
        >
          {title != null && <div className="ui-menu__title">{title}</div>}
          {menu.items.length === 0 && <div className="ui-menu__empty">{emptyText}</div>}
          {menu.items.map((item, index) => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              tabIndex={-1}
              disabled={item.disabled}
              className={[
                'ui-menu__item',
                index === activeIndex ? 'ui-menu__item--active' : '',
                item.danger ? 'ui-menu__item--danger' : '',
              ].filter(Boolean).join(' ')}
              onMouseEnter={() => {
                if (!item.disabled) setActiveIndex(index)
              }}
              onClick={() => activate(index)}
            >
              {item.icon}
              <span className="ui-menu__label">{item.label}</span>
              {item.extra != null && <span className="ui-menu__extra">{item.extra}</span>}
            </button>
          ))}
        </div>
      )}
    </span>
  )
}
