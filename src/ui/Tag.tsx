import type { ReactNode } from 'react'

export type TagColor = 'default' | 'blue' | 'green' | 'gold' | 'purple'

export interface TagProps {
  color?: TagColor
  children: ReactNode
  className?: string
  title?: string
  /** 传了 onClick 就渲染成真正的 button，键盘也能触发 */
  onClick?: () => void
  /** 当成开关按钮用时的选中态，会映射成 aria-pressed */
  pressed?: boolean
}

export function Tag({ color = 'default', children, className, title, onClick, pressed }: TagProps) {
  const classes = [
    'ui-tag',
    'ui-tag--' + color,
    onClick ? 'ui-tag--clickable' : '',
    className ?? '',
  ].filter(Boolean).join(' ')

  if (onClick) {
    return (
      <button type="button" className={classes} title={title} aria-pressed={pressed} onClick={onClick}>
        {children}
      </button>
    )
  }
  return <span className={classes} title={title}>{children}</span>
}
