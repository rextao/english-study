import { useEffect, useState } from 'react'
import { useChallengeGameLevels, useEndlessGameWords, useGameWords } from './data'
import { GamesHome } from './GamesHome'
import { GameModePage } from './GameModePage'
import { findGame } from './registry'
import { useGameRecorder } from './record'
import { GameSoundProvider, GameSoundToggle } from './sound'
import type { GameMode } from './types'
import './games.css'

interface GameRoute {
  slug: string
  /** null = 还没选模式，停在该游戏的模式选择页 */
  mode: GameMode | null
}

/** 从地址栏读模式段 */
function readMode(raw: string | undefined): GameMode | null {
  if (raw === 'normal') return 'normal'
  if (raw === 'endless') return 'endless'
  if (raw === 'challenge') return 'challenge'
  return null
}

/**
 * 从地址栏读路由：
 *   #/games/home               → slug=home（游戏汇总页）
 *   #/games/monster            → slug=monster，mode=null（模式选择页）
 *   #/games/monster/normal     → 常规模式
 *   #/games/monster/endless    → 无尽模式
 *   #/games/monster/challenge  → 闯关模式
 */
function readRoute(): GameRoute {
  const raw = window.location.hash.replace(/^#\/?/, '')
  const parts = raw.split('/').filter(Boolean)
  if (parts[0] !== 'games') return { slug: '', mode: null }
  return { slug: parts[1] ?? '', mode: readMode(parts[2]) }
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
 * 闯关模式按设置里配好的关卡数 × 每关单词数分关，level +1 进下一关（取词范围与无尽模式相同）。
 */
export function GamesPage() {
  const { slug, mode } = useGameRoute()
  const atHome = !slug || slug === 'home'
  const found = atHome ? null : findGame(slug)
  // 还没开发完的游戏（ready: false）不展示也不可进，当作没找到
  const game = found && found.ready !== false ? found : null
  const [round, setRound] = useState(0)
  const [level, setLevel] = useState(0)

  // 换游戏 / 换模式都从第一回合、第一关重新开始
  useEffect(() => {
    setRound(0)
    setLevel(0)
  }, [slug, mode])

  const normal = useGameWords(Boolean(game) && mode === 'normal')
  const endless = useEndlessGameWords(Boolean(game) && mode === 'endless', round)
  const challenge = useChallengeGameLevels(Boolean(game) && mode === 'challenge')
  // 统一错词统计：所有游戏共用这一份上报队列（换游戏 / 换模式 / 离开页面时自动提交）
  const recorder = useGameRecorder(game?.id ?? '', mode ?? 'normal')

  // 闯关模式只把当前这一关的单词交给游戏
  const lastLevel = Math.max(0, challenge.levels.length - 1)
  const atLastLevel = level >= lastLevel
  const words = mode === 'endless'
    ? endless.words
    : mode === 'challenge'
      ? challenge.levels[level] ?? []
      : normal.words
  const loading = mode === 'endless' ? endless.loading : mode === 'challenge' ? challenge.loading : normal.loading
  const error = mode === 'endless' ? endless.error : mode === 'challenge' ? challenge.error : normal.error

  /** 结束面板上的「下一批」：无尽换回合、闯关进下一关；闯关最后一关不给，让游戏自己重玩这一关 */
  const onNextRound = mode === 'endless'
    ? () => setRound(value => value + 1)
    : mode === 'challenge' && !atLastLevel
      ? () => setLevel(value => value + 1)
      : undefined
  const nextLabel = mode === 'challenge' ? '下一关' : mode === 'endless' ? '再玩一次' : undefined

  if (atHome) return <GameSoundProvider><GamesHome /></GameSoundProvider>
  if (game && mode === null) return <GameSoundProvider><GameModePage game={game} /></GameSoundProvider>

  const tooFew = !loading && !error && words.length < 3
  const levelNo = mode === 'challenge' ? Math.min(level + 1, Math.max(1, challenge.levelCount)) : 0

  return (
    <GameSoundProvider>
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
          {mode === 'endless'
            ? '正在随机挑选 20 个单词…'
            : mode === 'challenge' ? '正在准备闯关的单词…' : '正在准备本周的单词…'}
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
            {mode === 'endless' || mode === 'challenge'
              ? '学习列表里带中文释义的单词太少，至少要有 3 个才能开始。'
              : '本周可用的单词太少，至少要有 3 个带中文释义的单词才能开始。'}
          </p>
          <p className="games__notice-sub">去 <a href="#/games/home">游戏列表</a> 换个玩法</p>
        </div>
      )}

      {/* 闯关模式的小角标：第几关 / 一共几关，不占游戏排版 */}
      {mode === 'challenge' && game && !loading && !error && (
        <div className="games__level">第 {levelNo} / {challenge.levelCount} 关</div>
      )}

      {game && !loading && !error && !tooFew && (
        <game.Component
          key={game.id + ':' + mode + ':' + (mode === 'challenge' ? 'L' + level : round)}
          words={words}
          onNextRound={onNextRound}
          nextLabel={nextLabel}
          recordWord={recorder.record}
        />
      )}

      {/* 右上角发音开关：所有游戏共用，默认开启 */}
      <GameSoundToggle />
    </div>
    </GameSoundProvider>
  )
}
