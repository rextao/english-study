import { useEffect, useState } from 'react'
import { useEndlessGameWords, useGameWords } from './data'
import { GamesHome } from './GamesHome'
import { findGame } from './registry'
import type { GameMode } from './types'
import './games.css'

interface GameRoute {
  slug: string
  mode: GameMode
}

/**
 * 从地址栏读路由：
 *   #/games/home           → slug=home（游戏汇总页）
 *   #/games/monster        → slug=monster，常规模式
 *   #/games/monster/endless → slug=monster，无尽模式
 */
function readRoute(): GameRoute {
  const raw = window.location.hash.replace(/^#\/?/, '')
  const parts = raw.split('/').filter(Boolean)
  if (parts[0] !== 'games') return { slug: '', mode: 'normal' }
  return { slug: parts[1] ?? '', mode: parts[2] === 'endless' ? 'endless' : 'normal' }
}

function useGameRoute(): GameRoute {
  const [route, setRoute] = useState(readRoute)
  useEffect(() => {
    const sync = () => setRoute(readRoute())
    window.addEventListener('hashchange', sync)
    return () => window.removeEventListener('hashchange', sync)
  }, [])
  return route
}

/**
 * 游戏外壳：没有 slug（或 slug=home）时显示游戏汇总页，否则按 #/games/<id> 找游戏，
 * 取好单词后交给游戏组件。单词统一来自 src/games/data.ts，游戏组件自己不请求接口。
 * 无尽模式每玩完一局就换一批：round +1 会重新随机 20 个学习列表里的单词。
 */
export function GamesPage() {
  const { slug, mode } = useGameRoute()
  const atHome = !slug || slug === 'home'
  const game = atHome ? null : findGame(slug)
  const [round, setRound] = useState(0)

  // 换游戏 / 换模式都从第一回合重新开始
  useEffect(() => {
    setRound(0)
  }, [slug, mode])

  const normal = useGameWords(Boolean(game) && mode === 'normal')
  const endless = useEndlessGameWords(Boolean(game) && mode === 'endless', round)
  const { words, loading, error } = mode === 'endless' ? endless : normal

  if (atHome) return <GamesHome />

  const tooFew = !loading && !error && words.length < 3

  return (
    <div className="games">
      {!game && (
        <div className="games__notice">
          <p>没有找到这个游戏。</p>
          <p className="games__notice-sub">去 <a href="#/games/home">游戏列表</a> 看看有哪些能玩</p>
        </div>
      )}

      {game && loading && (
        <div className="games__notice">
          <span className="ui-spin" aria-hidden="true" />
          {mode === 'endless' ? '正在随机挑选 20 个单词…' : '正在准备本周的单词…'}
        </div>
      )}

      {game && !loading && error && (
        <div className="games__notice">
          <p>{error}</p>
          <p className="games__notice-sub">去 <a href="#/games/home">游戏列表</a> 换个玩法</p>
        </div>
      )}

      {game && tooFew && (
        <div className="games__notice">
          <p>
            {mode === 'endless'
              ? '学习列表里带中文释义的单词太少，至少要有 3 个才能开始。'
              : '本周可用的单词太少，至少要有 3 个带中文释义的单词才能开始。'}
          </p>
          <p className="games__notice-sub">去 <a href="#/games/home">游戏列表</a> 换个玩法</p>
        </div>
      )}

      {game && !loading && !error && !tooFew && (
        <game.Component
          key={game.id + ':' + mode + ':' + round}
          words={words}
          onNextRound={mode === 'endless' ? () => setRound(value => value + 1) : undefined}
        />
      )}
    </div>
  )
}
