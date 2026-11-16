import { GAMES } from './registry'
import type { GameMode } from './types'

/** 去某个游戏的某个模式：常规模式 #/games/<id>，无尽模式 #/games/<id>/endless */
function openGame(id: string, mode: GameMode) {
  window.location.hash = '#/games/' + id + (mode === 'endless' ? '/endless' : '')
}

/**
 * 游戏汇总页（#/games/home）：所有小游戏都从这里进，后续新增游戏只往 registry 里加一条。
 * 每个游戏给两个模式：常规模式用本周背词任务的单词（和原来一样），
 * 无尽模式每次从学习列表随机抽 20 个单词当一回合，玩完可以再来一批。
 * 还没开发完的游戏卡片置灰，按钮不可点。
 */
/** 游戏 PWA 的独立入口（/games.html）里没有上一页可回，不显示「返回」 */
const isGamesEntry = /\/games\.html$/.test(window.location.pathname)

export function GamesHome() {
  return (
    <div className="games games--home">
      <header className="gh__header">
        {!isGamesEntry && <a className="gh__back" href="#/search">← 返回</a>}
        <h1 className="gh__title">单词小游戏</h1>
        <p className="gh__sub">选一个玩法，用背过的单词玩一局</p>
      </header>

      <div className="gh__grid">
        {GAMES.map(game => {
          const locked = game.ready === false
          return (
            <article key={game.id} className={'gh__card' + (locked ? ' is-locked' : '')}>
              <div className="gh__card-head">
                <span className="gh__emoji" aria-hidden="true">{game.emoji ?? '🎮'}</span>
                <div className="gh__card-titles">
                  <h2 className="gh__card-title">{game.title}</h2>
                  <p className="gh__card-sub">{game.subtitle}</p>
                </div>
                {locked && <span className="gh__tag">开发中</span>}
              </div>

              <div className="gh__modes">
                <button
                  type="button"
                  className="gh__mode"
                  disabled={locked}
                  onClick={() => openGame(game.id, 'normal')}
                >
                  <strong>常规模式</strong>
                  <span>用本周背词任务的单词</span>
                </button>
                <button
                  type="button"
                  className="gh__mode gh__mode--endless"
                  disabled={locked}
                  onClick={() => openGame(game.id, 'endless')}
                >
                  <strong>无尽模式</strong>
                  <span>每回合随机 20 个单词</span>
                </button>
              </div>

              {locked && <p className="gh__locked-hint">这个游戏还没开发完，先玩别的吧。</p>}
            </article>
          )
        })}
      </div>
    </div>
  )
}
