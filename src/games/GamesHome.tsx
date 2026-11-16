import { GAMES } from './registry'

/** 汇总页只列可玩的游戏：还没开发完的（ready: false）先不展示 */
const PLAYABLE = GAMES.filter(game => game.ready !== false)

/**
 * 游戏汇总页（#/games/home）：第一步先选游戏，点卡片进模式选择页（#/games/<id>），
 * 选好模式才真正开始玩。页面没有返回按钮（游戏 PWA 从桌面独立进来，没有上一页可回）。
 */
export function GamesHome() {
  return (
    <div className="games games--home">
      <header className="gh__header">
        <h1 className="gh__title">单词小游戏</h1>
        <p className="gh__sub">选一个玩法，用背过的单词玩一局</p>
      </header>

      <div className="gh__grid">
        {PLAYABLE.map(game => (
          <button
            key={game.id}
            type="button"
            className="gh__card"
            onClick={() => { window.location.hash = '#/games/' + game.id }}
          >
            <span className="gh__emoji" aria-hidden="true">{game.emoji ?? '🎮'}</span>
            <span className="gh__card-titles">
              <span className="gh__card-title">{game.title}</span>
              <span className="gh__card-sub">{game.subtitle}</span>
            </span>
            <span className="gh__go" aria-hidden="true">→</span>
          </button>
        ))}
      </div>
    </div>
  )
}
