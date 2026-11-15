import { MONSTER } from './monster'
import { XIAOXIAOLE } from './xiaoxiaole'
import type { GameManifest } from './types'

/**
 * 游戏清单：汇总页 #/games/home 也读这一份。加新游戏时在 src/games/<id>/ 里
 * 建独立子文件夹，然后往这里加一条（没开发完的给 ready: false，汇总页会置灰）。
 */
export const GAMES: GameManifest[] = [XIAOXIAOLE, MONSTER]

export function findGame(id: string): GameManifest | null {
  return GAMES.find(game => game.id === id) ?? null
}
