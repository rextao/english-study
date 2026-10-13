/**
 * d1-shim.mjs — 用 node:sqlite 模拟 D1 的最小接口（仅测试用）
 *
 * 模拟的是 D1 的真实形态：prepare(sql) → bind(...params) → all/first/run，
 * 外加 batch（按事务执行：BEGIN/COMMIT，出错 ROLLBACK）。
 * worker/src/db.js 依赖的正是这一层；测试还借 __sqlite 直接跑 schema、数行数。
 */
import { DatabaseSync } from 'node:sqlite'

export function createShimDb(file) {
  const sqlite = new DatabaseSync(file)

  function makeStatement(sql, params = []) {
    const runOne = () => sqlite.prepare(sql).run(...params)
    return {
      bind: (...next) => makeStatement(sql, next),
      async all() {
        return { results: sqlite.prepare(sql).all(...params) }
      },
      async first() {
        return sqlite.prepare(sql).get(...params) ?? null
      },
      async run() {
        const result = runOne()
        return { meta: { changes: Number(result.changes ?? 0) } }
      },
      // 供 batch 内部直接执行
      __exec: runOne,
    }
  }

  return {
    prepare(sql) {
      return makeStatement(sql)
    },
    async batch(statements) {
      sqlite.exec('BEGIN')
      try {
        const out = statements.map(stmt => ({ meta: { changes: Number(stmt.__exec().changes ?? 0) } }))
        sqlite.exec('COMMIT')
        return out
      } catch (error) {
        sqlite.exec('ROLLBACK')
        throw error
      }
    },
    __sqlite: sqlite,
  }
}

/** 在 shim 库上执行整份 schema（D1 侧用 wrangler d1 execute 跑同一份文件） */
export function applySchema(db, sqlText) {
  db.__sqlite.exec(sqlText)
}

/** 测试断言用：直接数某张表的行数（接受原始 shim 或 db.js 适配层） */
export async function countRows(db, table) {
  const row = await db.first('SELECT COUNT(*) AS count FROM ' + table)
  return Number(row?.count || 0)
}
