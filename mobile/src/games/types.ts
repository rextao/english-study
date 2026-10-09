/**
 * types.ts — 游戏合集的公共类型
 *
 * 游戏是手机端里相互独立的 H5 小游戏：每个游戏自带一个全屏 React 组件，
 * 通过 onExit 回到游戏列表。注册表（registry.ts）按这里的 GameMeta 描述每个游戏，
 * 以后加新游戏只要往注册表里再塞一条即可，列表页和入口都不用改。
 */
import type { ComponentType } from 'react'

/** 每个游戏组件都收到的 props：目前只有「退出回列表」一个回调 */
export interface GameProps {
  onExit: () => void
}

/** 游戏在列表里的展示信息 + 真正的游戏组件 */
export interface GameMeta {
  /** 稳定 id，用于列表选中与路由 */
  id: string
  /** 游戏名 */
  name: string
  /** 一句话玩法说明，显示在列表卡片上 */
  tagline: string
  /** 列表卡片左侧的 emoji 图标 */
  emoji: string
  /** 主题色（卡片描边 / 开始按钮），用 CSS 颜色字符串 */
  accent: string
  /** ready = 能玩；coming-soon = 占位，列表里显示「敬请期待」 */
  status: 'ready' | 'coming-soon'
  /** 全屏游戏组件；coming-soon 可以不填 */
  component?: ComponentType<GameProps>
}
