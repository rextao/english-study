import { MonsterGame } from './MonsterGame'
import type { GameManifest } from '../types'

/**
 * 单词打怪兽：小怪兽在上面往下扔中英文小球，球受重力下落、顺着球堆滚到空位停稳；
 * 开局先把 5 个单词（每个词两张球）落到场地底部，之后拖一张球盖到它的配对上，
 * 配对成功就从合并点打出一颗魔法飞弹，命中后打掉小怪兽一格血。
 * 球堆高到小怪兽面前时暂停扔球，清出空间后继续，没有判输。
 */
export const MONSTER: GameManifest = {
  id: 'monster',
  title: '单词打怪兽',
  subtitle: '把英文球和中文球拖到一起，用魔法飞弹打小怪兽',
  Component: MonsterGame,
}
