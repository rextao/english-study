import type { InputHTMLAttributes, KeyboardEvent, ReactNode, TextareaHTMLAttributes } from 'react'
import type { ComponentSize } from './Button'

/** 英文单词输入框共用的手机端键盘提示：优先弹英文键盘，并关掉首字母大写 / 自动纠错，
    回车键显示「搜索」而不是换行。用法：<Input {...ENGLISH_WORD_INPUT_PROPS} /> */
export const ENGLISH_WORD_INPUT_PROPS = {
  lang: 'en',
  inputMode: 'latin',
  autoCapitalize: 'none',
  autoCorrect: 'off',
  enterKeyHint: 'search',
} as const

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size' | 'prefix' | 'inputMode'> {
  size?: ComponentSize
  block?: boolean
  prefix?: ReactNode
  /** 需要同时传 onClear */
  allowClear?: boolean
  onClear?: () => void
  onPressEnter?: (event: KeyboardEvent<HTMLInputElement>) => void
  /** 手机端键盘类型；英文输入框传 'latin'（React 的 DOM 类型还没收录，浏览器原样透传） */
  inputMode?: InputHTMLAttributes<HTMLInputElement>['inputMode'] | 'latin'
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
  inputMode,
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
        // React 的 DOM 类型还没收录 'latin'，收口成它认识的联合类型再交给原生 input
        inputMode={inputMode as InputHTMLAttributes<HTMLInputElement>['inputMode']}
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
