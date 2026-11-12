import { MONSTER } from './monster'
import { XIAOXIAOLE } from './xiaoxiaole'
import type { GameManifest } from './types'

/**
 * 游戏清单：页面上暂时没有入口，只能直接打开 #/games/<id>。
 * 加新游戏时在 src/games/<id>/ 里建独立子文件夹，然后往这里加一条。
 */
export const GAMES: GameManifest[] = [XIAOXIAOLE, MONSTER]

export function findGame(id: string): GameManifest | null {
  return GAMES.find(game => game.id === id) ?? null
}
