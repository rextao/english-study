import type { InputHTMLAttributes, KeyboardEvent, ReactNode, TextareaHTMLAttributes } from 'react'
import type { ComponentSize } from './Button'

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size' | 'prefix'> {
  size?: ComponentSize
  block?: boolean
  prefix?: ReactNode
  /** 需要同时传 onClear */
  allowClear?: boolean
  onClear?: () => void
  onPressEnter?: (event: KeyboardEvent<HTMLInputElement>) => void
}

export function Input({
  size = 'middle',
  block = false,
  prefix,
  allowClear = false,
  onClear,
  onPressEnter,
  className,
  onKeyDown,
  value,
  ...rest
}: InputProps) {
  const wrapperClass = [
    'ui-input',
    'ui-input--' + size,
    block ? 'ui-input--block' : '',
    className ?? '',
  ].filter(Boolean).join(' ')

  const showClear = allowClear && onClear != null && typeof value === 'string' && value.length > 0

  return (
    <span className={wrapperClass}>
      {prefix != null && <span className="ui-input__prefix" aria-hidden="true">{prefix}</span>}
      <input
        className="ui-input__inner"
        value={value}
        onKeyDown={(event) => {
          if (event.key === 'Enter') onPressEnter?.(event)
          onKeyDown?.(event)
        }}
        {...rest}
      />
      {showClear && (
        <button type="button" className="ui-input__clear" aria-label="清空" onClick={onClear}>×</button>
      )}
    </span>
  )
}

export interface TextAreaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  block?: boolean
}

export function TextArea({ block = true, className, ...rest }: TextAreaProps) {
  const classes = [
    'ui-textarea',
    block ? 'ui-textarea--block' : '',
    className ?? '',
  ].filter(Boolean).join(' ')

  return <textarea className={classes} {...rest} />
}
