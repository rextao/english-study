/**
 * app.js — 每请求的应用上下文
 *
 * 本地版是模块级单例（服务进程常驻）；Workers 里每个请求构造一份轻量上下文，
 * store 全部挂在同一份 db 适配层上，跨表操作（如 purge）共享事务适配能力。
 * waitUntil 由入口注入：生产接 ctx.waitUntil，测试收进数组由测试驱动。
 */

import { createDb } from './db.js'
import { createKvStore } from './kv.js'
import { createStudyHistoryStore } from './study-history.js'
import { createAppServices } from './lists.js'

export function createApp(env, waitUntilFn) {
  const db = createDb(env.DB)
  return {
    env,
    db,
    kv: createKvStore(db),
    history: createStudyHistoryStore(db),
    ...createAppServices(db),
    config: {
      noNetwork: env.DICT_NO_NETWORK === '1',
    },
    waitUntil: typeof waitUntilFn === 'function' ? waitUntilFn : () => {},
  }
}
