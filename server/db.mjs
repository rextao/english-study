import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/**
 * study-history.sqlite 的共享连接层。
 *
 * 同一个库被两处 store 共用（学习事件表 + 学习列表表），共用一条 DatabaseSync 连接：
 *  - 跨表的整库操作（比如 purge：删事件 + 回退列表里的累计计数）可以在同一个事务里完成，
 *    不会出现「事件删了、计数没回退」的半截状态；
 *  - 也不会出现「一个 store 把另一个 store 还在用的句柄关掉」的问题。
 *
 * 连接按解析后的绝对路径缓存，随进程生命周期常驻、不主动关闭：
 * DELETE 日志模式下每次事务都直接写主库，进程退出时文件本身就是完整的。
 *
 * 需要临时只读快照（测试断言）时用 openStudyDbSnapshot，它另开一条短连接，
 * 绝不碰缓存里那条——关了会影响正在跑的服务。
 */
const cache = new Map()

export function openStudyDb(dataDir) {
  const dir = path.resolve(String(dataDir || '.'))
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'study-history.sqlite')
  let db = cache.get(file)
  if (db) return db
  db = new DatabaseSync(file)
  // DELETE 模式：每次事务直接写主库，不产生 -wal / -shm 侧车文件，
  // 这样单个 study-history.sqlite 就是完整数据，可以安全提交到 git 给别的设备拉取
  db.exec('PRAGMA journal_mode = DELETE')
  db.exec('PRAGMA synchronous = FULL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA busy_timeout = 5000')
  cache.set(file, db)
  return db
}

/** 临时只读连接：测试断言用。调用方负责 close()。 */
export function openStudyDbSnapshot(dataDir) {
  const dir = path.resolve(String(dataDir || '.'))
  const file = path.join(dir, 'study-history.sqlite')
  const db = new DatabaseSync(file)
  db.exec('PRAGMA busy_timeout = 5000')
  return db
}
