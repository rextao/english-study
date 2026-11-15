import type { ComponentType } from 'react'

/** 游戏里用到的一对内容：英文单词 + 它的中文释义（都来自游戏数据层，与背词页当期单词一致） */
export interface GameWord {
  word: string
  translation: string
}

/** 玩法模式：常规模式用本周背词任务的单词，无尽模式每回合随机 20 个学习列表里的单词 */
export type GameMode = 'normal' | 'endless'

/**
 * 所有游戏共用的入参：外壳从 src/games/data.ts 取好当期单词再下发。
 * words 已去重（每个词只出现一次），游戏自己拿它分关 / 发牌，用完即这一局结束。
 * onNextRound 只有无尽模式会给：玩完一局不再重洗同一批词，而是让外壳换一批新单词。
 */
export interface GameProps {
  words: GameWord[]
  onNextRound?: () => void
}

/**
 * 游戏清单项。新增一个游戏 = 在 src/games/<id>/ 里写好组件，
 * 再在 src/games/registry.ts 的 GAMES 里加一条，不改其它文件。
 */
export interface GameManifest {
  /** URL 里的游戏标识：#/games/<id> */
  id: string
  /** 页面上显示的名字 */
  title: string
  /** 一句话玩法说明 */
  subtitle: string
  /** 汇总页卡片上的图标（emoji），不填给个默认手柄 */
  emoji?: string
  /** 还没开发完的游戏给 false：汇总页上置灰、不可点进 */
  ready?: boolean
  Component: ComponentType<GameProps>
}
