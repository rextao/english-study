/**
 * GamesTab.tsx — 游戏 tab
 *
 * 没选中游戏时渲染游戏列表；选中某个「可玩」游戏后，直接渲染它的全屏组件
 * （游戏自带 fixed 覆盖层盖住头部与 tab 栏），退出回到列表。
 */
import { useState, type CSSProperties } from 'react'
import { GAMES, getGame } from './registry'
import './games.css'

/** 把主题色塞进 CSS 变量；自定义属性需要绕过 CSSProperties 的类型约束 */
function accentStyle(accent: string): CSSProperties {
  return { ['--game-accent']: accent } as CSSProperties
}

export default function GamesTab() {
  const [activeId, setActiveId] = useState<string | null>(null)
  const active = activeId ? getGame(activeId) : undefined

  if (active && active.component) {
    const Game = active.component
    return <Game onExit={() => setActiveId(null)} />
  }

  return (
    <div className="games">
      <p className="games__hint">H5 小游戏合集，随玩随走。更多游戏陆续加入。</p>
      <ul className="games__list">
        {GAMES.map(game => {
          const ready = game.status === 'ready'
          return (
            <li
              key={game.id}
              className={'game-card' + (ready ? '' : ' game-card--soon')}
              style={accentStyle(game.accent)}
            >
              <span className="game-card__icon">{game.emoji}</span>
              <span className="game-card__body">
                <span className="game-card__name">{game.name}</span>
                <span className="game-card__tag">{game.tagline}</span>
              </span>
              {ready ? (
                <button className="game-card__play" type="button" onClick={() => setActiveId(game.id)}>
                  开始
                </button>
              ) : (
                <span className="game-card__soon">敬请期待</span>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
