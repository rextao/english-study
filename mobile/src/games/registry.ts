/**
 * registry.ts — 游戏注册表
 *
 * 所有 H5 小游戏在这里登记。列表页（GamesTab）和入口都只读这份数组，
 * 以后加新游戏：实现一个 GameProps 组件，再往 GAMES 里加一条即可，别处不用改。
 */
import type { GameMeta } from './types'
import BlackHoleGame from './blackhole/BlackHoleGame'

export const GAMES: GameMeta[] = [
  {
    id: 'blackhole',
    name: '黑洞吞噬',
    tagline: '滑动操控黑洞，吞掉整座城市',
    emoji: '🌀',
    accent: '#38bdf8',
    status: 'ready',
    component: BlackHoleGame,
  },
]

export function getGame(id: string): GameMeta | undefined {
  return GAMES.find(g => g.id === id)
}
