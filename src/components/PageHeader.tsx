import type { ReactNode } from 'react'

interface PageHeaderProps {
  title: string
  subtitle?: string
  /** 标题右侧的操作区 */
  actions?: ReactNode
}

/** 各页面共用的标题区，样式在 App.css 的 .page-header 里 */
export function PageHeader({ title, subtitle, actions }: PageHeaderProps) {
  return (
    <header className="page-header">
      <div className="page-header__text">
        <h1 className="page-header__title">{title}</h1>
        {subtitle != null && <p className="page-header__subtitle">{subtitle}</p>}
      </div>
      {actions != null && <div className="page-header__actions">{actions}</div>}
    </header>
  )
}
