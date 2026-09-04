import type { ChangeEvent, ReactNode } from 'react'

export interface CheckboxProps {
  checked: boolean
  /** 与 antd 一致，从 event.target.checked 取值 */
  onChange: (event: ChangeEvent<HTMLInputElement>) => void
  children?: ReactNode
  disabled?: boolean
  className?: string
}

export function Checkbox({ checked, onChange, children, disabled = false, className }: CheckboxProps) {
  const classes = [
    'ui-checkbox',
    disabled ? 'ui-checkbox--disabled' : '',
    className ?? '',
  ].filter(Boolean).join(' ')

  return (
    <label className={classes}>
      <input
        type="checkbox"
        className="ui-checkbox__input"
        checked={checked}
        disabled={disabled}
        onChange={onChange}
      />
      <span className="ui-checkbox__box" aria-hidden="true" />
      {children != null && <span className="ui-checkbox__label">{children}</span>}
    </label>
  )
}
