import { useMemo } from 'react'

import { findGame } from '../games/registry'
import { useGameResults } from '../hooks/useGameResults'
import type { GameResultWord } from '../hooks/useGameResults'
import { Button, Tag } from '../ui'

interface DayGroup {
  day: string
  rows: GameResultWord[]
}

/** 服务端已经按「日期 ↓、错得多 ↓」排好，这里只切组，不重排 */
function groupByDay(rows: GameResultWord[]): DayGroup[] {
  const days: DayGroup[] = []
  for (const row of rows) {
    const last = days[days.length - 1]
    if (last && last.day === row.day) last.rows.push(row)
    else days.push({ day: row.day, rows: [row] })
  }
  return days
}

function gameTitles(ids: string[]) {
  return ids.map(id => findGame(id)?.title ?? id).join(' / ')
}

/** 最近 30 天的游戏记录：每天一组，单词后面标错 / 对的次数 */
const DAYS = 30

export function GameResults() {
  const { rows, loading, error, reload } = useGameResults(DAYS)
  const days = useMemo(() => groupByDay(rows), [rows])

  return (
    <div className="game-results">
      <div className="game-results__head">
        <p className="hint">
          玩游戏时每个单词配对成功 / 配错都会记一笔，按日期汇总在下面（最近 {DAYS} 天）。
          错得多的排在每天最前面。
        </p>
        <Button size="small" onClick={reload} disabled={loading}>刷新</Button>
      </div>

      {error && <div className="callout callout--warn">{error}</div>}

      {loading ? (
        <p className="hint">正在读取游戏记录…</p>
      ) : days.length === 0 ? (
        <p className="empty">还没有游戏记录，去玩一局单词游戏吧。</p>
      ) : (
        <div className="game-results__days">
          {days.map(group => {
            const wrongWords = group.rows.filter(row => row.wrong > 0).length
            const wrongCount = group.rows.reduce((sum, row) => sum + row.wrong, 0)
            return (
              <section key={group.day} className="game-results__day">
                <header className="game-results__day-head">
                  <span className="game-results__date">{group.day}</span>
                  <span className="game-results__day-stat">
                    错 {wrongWords} 词 · 共 {wrongCount} 次失误
                  </span>
                </header>
                <ul className="game-results__list">
                  {group.rows.map(row => (
                    <li key={row.word} className="game-results__row">
                      <span className="game-results__word">{row.display}</span>
                      {row.translation && (
                        <span className="game-results__trans">{row.translation}</span>
                      )}
                      <span className="game-results__badges">
                        {row.wrong > 0 && <Tag color="gold">错 {row.wrong}</Tag>}
                        {row.correct > 0 && <Tag color="green">对 {row.correct}</Tag>}
                        <span className="game-results__games">{gameTitles(row.games)}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )
          })}
        </div>
      )}
    </div>
  )
}
