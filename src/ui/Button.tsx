import type { ButtonHTMLAttributes, ReactNode } from 'react'

export type ButtonType = 'default' | 'primary' | 'text' | 'link'
export type ComponentSize = 'small' | 'middle' | 'large'

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> {
  /** 与 antd 一致：default / primary / text / link */
  type?: ButtonType
  size?: ComponentSize
  danger?: boolean
  loading?: boolean
  block?: boolean
  icon?: ReactNode
  htmlType?: 'button' | 'submit' | 'reset'
}

export function Button({
  type = 'default',
  size = 'middle',
  danger = false,
  loading = false,
  block = false,
  icon,
  htmlType = 'button',
  className,
  disabled,
  children,
  ...rest
}: ButtonProps) {
  const classes = [
    'ui-btn',
    'ui-btn--' + type,
    'ui-btn--' + size,
    danger ? 'ui-btn--danger' : '',
    block ? 'ui-btn--block' : '',
    className ?? '',
  ].filter(Boolean).join(' ')

  return (
    <button type={htmlType} className={classes} disabled={disabled || loading} {...rest}>
      {loading ? <span className="ui-spin" aria-hidden="true" /> : icon}
      {children}
    </button>
  )
}
