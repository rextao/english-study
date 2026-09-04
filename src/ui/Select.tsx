import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { useDismiss } from './useDismiss'
import type { ComponentSize } from './Button'

export interface SelectOption {
  value: string
  label: ReactNode
  /** 选项右侧的次要信息，例如数量 */
  extra?: ReactNode
  disabled?: boolean
}

export interface SelectProps {
  value: string
  onChange: (value: string) => void
  options: SelectOption[]
  placeholder?: string
  size?: ComponentSize
  disabled?: boolean
  block?: boolean
  className?: string
  id?: string
  'aria-label'?: string
}

/** 单选下拉。键盘与 ARIA 行为对齐 select-only combobox（WAI-ARIA 1.2）。 */
export function Select({
  value,
  onChange,
  options,
  placeholder = '请选择',
  size = 'middle',
  disabled = false,
  block = true,
  className,
  id,
  'aria-label': ariaLabel,
}: SelectProps) {
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const listRef = useRef<HTMLUListElement | null>(null)
  const listId = useId()

  const selectedIndex = options.findIndex((option) => option.value === value)
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined

  const close = useCallback(() => setOpen(false), [])
  useDismiss(open, rootRef, close)

  // 打开时把高亮放在当前选中项上
  useEffect(() => {
    if (!open) return
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : options.findIndex((option) => !option.disabled))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // 高亮项滚动进可视区域
  useEffect(() => {
    if (!open || activeIndex < 0) return
    const node = listRef.current?.children[activeIndex]
    if (node instanceof HTMLElement) node.scrollIntoView({ block: 'nearest' })
  }, [open, activeIndex])

  function firstEnabled() {
    return options.findIndex((option) => !option.disabled)
  }

  function lastEnabled() {
    for (let i = options.length - 1; i >= 0; i -= 1) {
      if (!options[i].disabled) return i
    }
    return -1
  }

  function move(step: number) {
    if (options.length === 0) return
    let cursor = activeIndex
    if (cursor < 0) cursor = step > 0 ? -1 : 0
    for (let i = 0; i < options.length; i += 1) {
      cursor = (cursor + step + options.length) % options.length
      if (!options[cursor].disabled) {
        setActiveIndex(cursor)
        return
      }
    }
  }

  function pick(index: number) {
    const option = options[index]
    if (!option || option.disabled) return
    onChange(option.value)
    setOpen(false)
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (disabled) return
    if (!open) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        setOpen(true)
      }
      return
    }
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        move(1)
        break
      case 'ArrowUp':
        event.preventDefault()
        move(-1)
        break
      case 'Home':
        event.preventDefault()
        setActiveIndex(firstEnabled())
        break
      case 'End':
        event.preventDefault()
        setActiveIndex(lastEnabled())
        break
      case 'Enter':
      case ' ':
        event.preventDefault()
        pick(activeIndex)
        break
      case 'Tab':
        setOpen(false)
        break
      default:
        break
    }
  }

  const classes = [
    'ui-select',
    'ui-select--' + size,
    block ? 'ui-select--block' : '',
    open ? 'ui-select--open' : '',
    disabled ? 'ui-select--disabled' : '',
    className ?? '',
  ].filter(Boolean).join(' ')

  return (
    <div className={classes} ref={rootRef}>
      <button
        type="button"
        id={id}
        className="ui-select__control"
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={listId}
        aria-activedescendant={open && activeIndex >= 0 ? listId + '-' + activeIndex : undefined}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => setOpen((prev) => !prev)}
        onKeyDown={handleKeyDown}
      >
        <span className={'ui-select__value' + (selected ? '' : ' ui-select__value--placeholder')}>
          {selected ? selected.label : placeholder}
        </span>
        <span className="ui-select__arrow" aria-hidden="true">▾</span>
      </button>

      {open && (
        <ul className="ui-select__list" id={listId} role="listbox" ref={listRef} aria-label={ariaLabel}>
          {options.length === 0 && <li className="ui-select__empty">暂无选项</li>}
          {options.map((option, index) => (
            <li
              key={option.value}
              id={listId + '-' + index}
              role="option"
              aria-selected={option.value === value}
              aria-disabled={option.disabled || undefined}
              className={[
                'ui-select__option',
                index === activeIndex ? 'ui-select__option--active' : '',
                option.value === value ? 'ui-select__option--selected' : '',
                option.disabled ? 'ui-select__option--disabled' : '',
              ].filter(Boolean).join(' ')}
              onMouseEnter={() => {
                if (!option.disabled) setActiveIndex(index)
              }}
              onClick={() => pick(index)}
            >
              <span className="ui-select__opt-label">{option.label}</span>
              {option.extra != null && <span className="ui-select__opt-extra">{option.extra}</span>}
              {option.value === value && <span className="ui-select__check" aria-hidden="true">✓</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
