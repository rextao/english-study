/**
 * 英语学习 · 合并部署的 Cloudflare Worker（静态站点 + 云端同步 API + D1）
 *
 * 一个 Worker 同时做两件事，让手机端页面和同步接口同源，彻底消除跨域：
 *   - 静态资源：非 /sync/* 的请求回落到 env.ASSETS（mobile/dist，见仓库根 wrangler.toml）；
 *   - 同步 API：/sync/* 的路由在下面处理，只存数据、不逐行合并。
 * 桌面 / 手机端把整库快照推上来，另一台再拉下去。
 * 快照的哈希计算全在本地服务（server/sync.mjs）做，Worker 只当「带令牌鉴权的存储」，
 * 存什么哈希就回什么哈希，不在云端重算——免得两边的哈希算法分叉后互相认不出。
 *
 * 路由（除 /sync/health 外都要 Bearer 令牌）：
 *   GET    /sync/status   云端当前快照的摘要（哈希 + 行数 + 谁推的 + 时间）
 *   GET    /sync/snapshot 完整快照
 *   POST   /sync/snapshot { snapshot, snapshotHash } 覆盖云端快照，返回上一个哈希
 *   DELETE /sync/snapshot 清空云端快照
 *   GET    /sync/health   不用令牌，探活用
 *
 * 令牌用 wrangler secret 设置：npx wrangler secret put SYNC_TOKEN
 * 客户端请求头带 Authorization: Bearer <令牌>。
 */

const CURRENT_ID = 'current'

/** 从快照里数几个给用户看的行数（纯数组长度，不涉及哈希） */
function summarize(snapshot, hash) {
  const tables = (snapshot && typeof snapshot === 'object' ? snapshot.tables : null) || {}
  const count = (name) => {
    const table = tables[name]
    return table && Array.isArray(table.rows) ? table.rows.length : 0
  }
  const listCount = count('lists')
  const wordCount = count('list_words')
  const eventCount = count('learning_events')
  return {
    hash,
    exportedAt: Number(snapshot?.exportedAt) || 0,
    deviceLabel: typeof snapshot?.deviceLabel === 'string' ? snapshot.deviceLabel : '',
    listCount,
    wordCount,
    eventCount,
    totalRows: wordCount + eventCount,
    empty: hash.length === 0,
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/** 恒定时间比较令牌，避免按响应快慢猜令牌 */
async function authorized(request, env) {
  const token = env.SYNC_TOKEN
  if (typeof token !== 'string' || token.length === 0) return false
  const header = request.headers.get('authorization') || ''
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  if (!match) return false
  const got = match[1]
  const expected = token
  if (got.length !== expected.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i++) diff |= got.charCodeAt(i) ^ expected.charCodeAt(i)
  return diff === 0
}

async function readCurrent(env) {
  const row = await env.DB.prepare(
    'SELECT snapshot_json, snapshot_hash FROM sync_snapshot WHERE id = ?'
  ).bind(CURRENT_ID).first()
  if (!row) return null
  try {
    return { snapshot: JSON.parse(row.snapshot_json), hash: String(row.snapshot_hash || '') }
  } catch {
    return null
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const pathname = url.pathname.replace(/\/+$/, '') || '/'
    const method = request.method.toUpperCase()

    // 非 /sync/* 的请求交给静态资源（env.ASSETS）：手机端页面与同步 API 合并在同一个
    // Worker、同一个域名，浏览器同源请求不会触发 CORS 预检，跨域问题从根上消失。
    if (!pathname.startsWith('/sync/')) {
      return env.ASSETS.fetch(request)
    }

    if (method === 'GET' && pathname === '/sync/health') {
      return json({ ok: true, time: Date.now() })
    }

    if (!await authorized(request, env)) {
      return json({ ok: false, error: '未授权：需要正确的同步令牌' }, 401)
    }

    // GET /sync/status — 摘要，不传整份快照，省流量
    if (method === 'GET' && pathname === '/sync/status') {
      const current = await readCurrent(env)
      if (!current) return json({ ...summarize(null, ''), empty: true })
      return json(summarize(current.snapshot, current.hash))
    }

    // GET /sync/snapshot — 完整快照
    if (method === 'GET' && pathname === '/sync/snapshot') {
      const current = await readCurrent(env)
      if (!current) return json({ ok: false, error: '云端还没有数据' }, 404)
      return json(current.snapshot)
    }

    // POST /sync/snapshot — 覆盖云端快照（整份替换，最后推的为准）
    if (method === 'POST' && pathname === '/sync/snapshot') {
      let body
      try { body = await request.json() } catch { return json({ ok: false, error: '请求体不是有效 JSON' }, 400) }
      const snapshot = body?.snapshot
      const hash = typeof body?.snapshotHash === 'string' ? body.snapshotHash : ''
      if (!snapshot || typeof snapshot !== 'object') {
        return json({ ok: false, error: '缺少 snapshot 字段' }, 400)
      }
      if (snapshot.version !== 1 || !snapshot.tables || typeof snapshot.tables !== 'object') {
        return json({ ok: false, error: '快照格式不兼容（期望 version=1 且带 tables）' }, 400)
      }
      const prev = await readCurrent(env)
      const now = Date.now()
      await env.DB.prepare(
        'INSERT INTO sync_snapshot (id, snapshot_json, snapshot_hash, exported_at, device_label, updated_at)'
        + ' VALUES (?, ?, ?, ?, ?, ?)'
        + ' ON CONFLICT(id) DO UPDATE SET'
        + ' snapshot_json = excluded.snapshot_json, snapshot_hash = excluded.snapshot_hash,'
        + ' exported_at = excluded.exported_at, device_label = excluded.device_label,'
        + ' updated_at = excluded.updated_at'
      ).bind(
        CURRENT_ID,
        JSON.stringify(snapshot),
        hash,
        Number(snapshot.exportedAt) || now,
        typeof snapshot.deviceLabel === 'string' ? snapshot.deviceLabel : '',
        now,
      ).run()
      return json({ ok: true, hash, prevHash: prev ? prev.hash : '' })
    }

    // DELETE /sync/snapshot — 清空云端快照（慎用，另一台会拉到空数据）
    if (method === 'DELETE' && pathname === '/sync/snapshot') {
      await env.DB.prepare('DELETE FROM sync_snapshot WHERE id = ?').bind(CURRENT_ID).run()
      return json({ ok: true })
    }

    return json({ ok: false, error: 'not found' }, 404)
  },
}
