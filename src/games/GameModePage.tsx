import type { GameManifest, GameMode } from './types'

/** 选好模式才真正进游戏：#/games/<id>/normal 或 #/games/<id>/endless */
function startGame(id: string, mode: GameMode) {
  window.location.hash = '#/games/' + id + '/' + mode
}

/**
 * 模式选择页（#/games/<id>）：汇总页点某个游戏后先到这一页，再选常规 / 无尽模式。
 * 「换个游戏」回汇总页——这是游戏内部的返回，不是退出游戏。
 */
export function GameModePage({ game }: { game: GameManifest }) {
  return (
    <div className="games games--mode">
      <header className="gh__header">
        <a className="gh__back" href="#/games/home">← 换个游戏</a>
        <h1 className="gh__title">
          <span className="gm__emoji" aria-hidden="true">{game.emoji ?? '🎮'}</span>
          {game.title}
        </h1>
        <p className="gh__sub">{game.subtitle}</p>
      </header>

      <div className="gm__modes">
        <button
          type="button"
          className="gh__mode gm__mode"
          onClick={() => startGame(game.id, 'normal')}
        >
          <strong>常规模式</strong>
          <span>用本周背词任务的单词</span>
        </button>
        <button
          type="button"
          className="gh__mode gm__mode gh__mode--endless"
          onClick={() => startGame(game.id, 'endless')}
        >
          <strong>无尽模式</strong>
          <span>每回合随机 20 个学习列表里的单词</span>
        </button>
      </div>
    </div>
  )
}
