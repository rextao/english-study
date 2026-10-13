/**
 * db.js — 数据访问的最小适配层
 *
 * 生产环境包着 D1（异步、prepare/bind/all|first|run|batch）；
 * 测试环境用 node:sqlite 实现同一份接口（worker/test/d1-shim.mjs）。
 * 业务代码只依赖这里暴露的四个方法，换存储只动这一个文件。
 */

export function createDb(d1) {
  return {
    /** 查多行：返回行数组（D1 的 results，空结果为 []） */
    async all(sql, ...params) {
      const result = await d1.prepare(sql).bind(...params).all()
      return result.results ?? []
    },

    /** 查单行：没有就返回 null */
    async first(sql, ...params) {
      return await d1.prepare(sql).bind(...params).first()
    },

    /** 执行写语句，返回 changes 行数 */
    async run(sql, ...params) {
      const result = await d1.prepare(sql).bind(...params).run()
      return Number(result.meta?.changes ?? 0)
    },

    /**
     * 原子批量：语句数组（每项 [sql, ...params]），等价一个事务，
     * 中途失败整体回滚。本地版用 BEGIN IMMEDIATE / COMMIT 包住的多条写
     * 一律改写成这里的一次 batch。
     */
    async batch(statements) {
      const stmts = statements.map(([sql, ...params]) => d1.prepare(sql).bind(...params))
      const results = await d1.batch(stmts)
      return results.map(result => Number(result.meta?.changes ?? 0))
    },
  }
}
