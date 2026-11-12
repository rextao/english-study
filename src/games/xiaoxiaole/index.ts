import { XiaoxiaoleGame } from './XiaoxiaoleGame'
import type { GameManifest } from '../types'

/**
 * 单词消消乐：当期单词的英文和中文混在一张牌桌上，先点英文再点它的中文，
 * 连对就画一条线把这两张牌消掉。一关 6 对，全部消完过关。
 */
export const XIAOXIAOLE: GameManifest = {
  id: 'xiaoxiaole',
  title: '单词消消乐',
  subtitle: '把英文和它的中文连起来',
  Component: XiaoxiaoleGame,
}
