import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
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

/** 下拉层与控件的间距、最大 / 最小高度 */
const LIST_GAP = 6
const LIST_MAX_HEIGHT = 260
const LIST_MIN_HEIGHT = 120

interface ListRect {
  top: number
  left: number
  width: number
  maxHeight: number
}

/**
 * 下拉层的视口坐标：下方放不下就向上展开，横向夹在视口里。
 * 因为层固定按视口定位，放进弹窗 / 滚动容器也不会把容器撑出滚动条或被裁掉。
 */
function measureList(control: HTMLElement | null): ListRect | null {
  if (!control) return null
  const rect = control.getBoundingClientRect()
  const below = window.innerHeight - rect.bottom - LIST_GAP - 8
  const above = rect.top - LIST_GAP - 8
  const openUp = below < Math.min(LIST_MAX_HEIGHT, LIST_MIN_HEIGHT) && above > below
  const maxHeight = Math.max(LIST_MIN_HEIGHT / 2, Math.min(LIST_MAX_HEIGHT, openUp ? above : below))
  return {
    top: openUp ? rect.top - LIST_GAP - maxHeight : rect.bottom + LIST_GAP,
    left: Math.max(8, Math.min(rect.left, window.innerWidth - rect.width - 8)),
    width: rect.width,
    maxHeight,
  }
}

function sameRect(a: ListRect | null, b: ListRect | null) {
  if (a === b) return true
  if (!a || !b) return false
  return a.top === b.top && a.left === b.left && a.width === b.width && a.maxHeight === b.maxHeight
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
  const controlRef = useRef<HTMLButtonElement | null>(null)
  const listRef = useRef<HTMLUListElement | null>(null)
  const listId = useId()
  /** 展开时按视口算出的下拉层坐标，没算好之前先藏起来，避免闪一下错位 */
  const [listRect, setListRect] = useState<ListRect | null>(null)

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

  // 展开期间跟着滚动 / 缩放重新定位（捕获阶段监听，容器内部滚动也算）
  useLayoutEffect(() => {
    if (!open) { setListRect(null); return }
    function update() {
      const next = measureList(controlRef.current)
      setListRect(current => (sameRect(current, next) ? current : next))
    }
    update()
    window.addEventListener('scroll', update, true)
    window.addEventListener('resize', update)
    return () => {
      window.removeEventListener('scroll', update, true)
      window.removeEventListener('resize', update)
    }
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
        ref={controlRef}
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
        <ul
          className="ui-select__list"
          id={listId}
          role="listbox"
          ref={listRef}
          aria-label={ariaLabel}
          style={{
            top: listRect?.top ?? 0,
            left: listRect?.left ?? 0,
            width: listRect?.width,
            maxHeight: listRect?.maxHeight,
            visibility: listRect ? 'visible' : 'hidden',
          }}
        >
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
