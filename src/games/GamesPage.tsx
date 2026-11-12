import { useEffect, useState } from 'react'
import { useGameWords } from './data'
import { findGame } from './registry'
import './games.css'

/** 从 #/games/xiaoxiaole 里取出 xiaoxiaole；不是游戏地址就返回空串 */
function readSlug() {
  const raw = window.location.hash.replace(/^#\/?/, '')
  const parts = raw.split('/').filter(Boolean)
  return parts[0] === 'games' ? (parts[1] ?? '') : ''
}

function useGameSlug() {
  const [slug, setSlug] = useState(readSlug)
  useEffect(() => {
    const sync = () => setSlug(readSlug())
    window.addEventListener('hashchange', sync)
    return () => window.removeEventListener('hashchange', sync)
  }, [])
  return slug
}

/**
 * 游戏外壳：按地址栏里的 #/games/<id> 找游戏，取好当期单词后交给游戏组件。
 * 单词统一来自 src/games/data.ts（与背词页同一份词表，已去重），游戏组件自己不请求接口。
 */
export function GamesPage() {
  const slug = useGameSlug()
  const game = slug ? findGame(slug) : null
  const { words, loading, error } = useGameWords(Boolean(game))

  return (
    <div className="games">
      {!game && (
        <div className="games__notice">
          <p>没有找到这个游戏。</p>
          <p className="games__notice-sub">地址应形如 <code>#/games/xiaoxiaole</code></p>
        </div>
      )}

      {game && loading && (
        <div className="games__notice">
          <span className="ui-spin" aria-hidden="true" />
          正在准备本周的单词…
        </div>
      )}

      {game && !loading && error && (
        <div className="games__notice">
          <p>{error}</p>
        </div>
      )}

      {game && !loading && !error && words.length < 3 && (
        <div className="games__notice">
          <p>本周可用的单词太少，至少要有 3 个带中文释义的单词才能开始。</p>
        </div>
      )}

      {game && !loading && !error && words.length >= 3 && (
        <>
          <game.Component words={words} />
        </>
      )}
    </div>
  )
}
