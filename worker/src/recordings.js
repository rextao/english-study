/**
 * recordings.js — 背单词页的课堂录音。
 *
 * 音频由浏览器 MediaRecorder 录成一整段，前端按 400KB 一片上传：
 *   1. POST   /api/recite/recordings                 建一条 uploading 记录（给好分片数）
 *   2. PUT    /api/recite/recordings/:id/parts/:i    逐片上传（幂等，可重试）
 *   3. POST   /api/recite/recordings/:id/complete    分片齐了才变成 ready
 * 这样断网 / 超时只会影响某一片，重传那一片即可，不会整条录音全丢。
 *
 * 音频按片存在 recite_recording_chunks（D1 单行有大小上限，整段落一行会写不进去），
 * 元数据在 recite_recordings。只保留最近 15 天（上传中的临时记录 1 天），
 * 没有 cron，每次读写顺带清过期数据。
 */

const RETENTION_MS = 15 * 86400000
/** 分片上传中断（关页面 / 断网）留下的半成品，留 1 天就够 */
const UPLOAD_TTL_MS = 86400000
/** 单条录音最多 16MB（24kbps 语音约 90 分钟，留足余量） */
const MAX_RECORDING_BYTES = 16 * 1024 * 1024
/** 分片数上限：16MB / 400KB ≈ 42 片，留点余量 */
const MAX_PARTS = 60
/** 单片的 base64 长度上限（400KB 原文件约 533KB base64） */
const MAX_PART_BASE64 = 620000
const DEFAULT_LIMIT = 20
const MAX_LIMIT = 60
/** 每次清理最多删多少条，避免单次请求做太多写 */
const PURGE_BATCH = 20

function createRecordingId() {
  return 'recite-rec-' + crypto.randomUUID()
}

function recordingResponse(row) {
  return {
    id: row.id,
    status: row.status || 'ready',
    createdAt: Number(row.created_at),
    durationMs: Number(row.duration_ms || 0),
    mime: row.mime,
    size: Number(row.size_bytes || 0),
    partCount: Number(row.chunk_count || 0),
    sessionIndex: row.session_index == null ? undefined : Number(row.session_index),
    sessionId: row.session_id || undefined,
    weekStart: row.week_start == null ? undefined : Number(row.week_start),
    /** 片段开始录制的时间（客户端毫秒）与它在这次学习里的序号：同一个会话的多段按它排序 */
    recordedAt: row.recorded_at == null ? undefined : Number(row.recorded_at),
    segmentIndex: row.segment_index == null ? undefined : Number(row.segment_index),
  }
}

function badRequest(message, code) {
  const error = new Error(message)
  if (code) error.code = code
  return error
}

export function createReciteRecordingStore(db) {
  /** 删掉过期录音（成品 15 天、半成品 1 天）：先删分片再删主记录 */
  async function purgeExpired(now = Date.now()) {
    const expired = await db.all(
      `SELECT id FROM recite_recordings
       WHERE (status = 'ready' AND created_at < ?)
          OR (status <> 'ready' AND created_at < ?)
       ORDER BY created_at LIMIT ?`,
      now - RETENTION_MS, now - UPLOAD_TTL_MS, PURGE_BATCH,
    )
    for (const row of expired) {
      await db.run('DELETE FROM recite_recording_chunks WHERE recording_id = ?', row.id)
      await db.run('DELETE FROM recite_recordings WHERE id = ?', row.id)
    }
    return expired.length
  }

  /**
   * 开始上传：先落一条 uploading 记录，之后逐片往里塞。
   * clientKey 是客户端生成的片段幂等键：本地缓存补传时带着同一个键，
   * 已经入库过就直接把原记录返回（客户端接着补分片 / 补 complete），不会多出一条。
   */
  async function createUpload({
    sessionId, mime, durationMs, sizeBytes, partCount, clientKey, recordedAt, segmentIndex, now = Date.now(),
  }) {
    const key = String(clientKey ?? '').trim()
    if (key) {
      const existing = await db.first('SELECT * FROM recite_recordings WHERE client_key = ?', key)
      if (existing) return recordingResponse(existing)
    }
    const segment = segmentIndex == null ? null : Math.round(Number(segmentIndex))
    if (segment != null && (!Number.isInteger(segment) || segment < 0)) {
      throw badRequest('录音片段序号无效', 'RECORDING_SEGMENT')
    }
    const recorded = recordedAt == null ? null : Math.round(Number(recordedAt))
    if (recorded != null && (!Number.isFinite(recorded) || recorded <= 0)) {
      throw badRequest('录音时间无效', 'RECORDING_TIME')
    }
    const type = String(mime ?? '').trim() || 'audio/mp4'
    if (!/^audio\//i.test(type)) throw badRequest('录音格式不支持', 'RECORDING_MIME')
    const size = Math.round(Number(sizeBytes) || 0)
    if (size <= 0) throw badRequest('录音内容为空', 'RECORDING_EMPTY')
    if (size > MAX_RECORDING_BYTES) throw badRequest('录音太长了，一次最多 16MB', 'RECORDING_TOO_LARGE')
    const parts = Math.round(Number(partCount) || 0)
    if (!Number.isInteger(parts) || parts < 1 || parts > MAX_PARTS) {
      throw badRequest('录音分片数量无效', 'RECORDING_PARTS')
    }

    let sessionRow = null
    const asked = String(sessionId ?? '').trim()
    if (asked) {
      sessionRow = await db.first(
        `SELECT s.id, s.session_index, t.week_start
         FROM recite_sessions s LEFT JOIN recite_tasks t ON t.id = s.task_id
         WHERE s.id = ?`,
        asked,
      )
      if (!sessionRow) throw badRequest('这次学习记录不存在，录音没有保存', 'RECORDING_SESSION')
    }

    const id = createRecordingId()
    await db.run(
      `INSERT INTO recite_recordings
        (id, session_id, week_start, session_index, mime, duration_ms, size_bytes, chunk_count,
         client_key, recorded_at, segment_index, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'uploading', ?)`,
      id,
      sessionRow ? sessionRow.id : null,
      sessionRow?.week_start == null ? null : Number(sessionRow.week_start),
      sessionRow ? Number(sessionRow.session_index) : null,
      type,
      Math.max(0, Math.round(Number(durationMs) || 0)),
      size,
      parts,
      key || null,
      recorded,
      segment,
      now,
    )
    await purgeExpired(now)
    return recordingResponse({
      id,
      status: 'uploading',
      session_id: sessionRow ? sessionRow.id : null,
      week_start: sessionRow?.week_start ?? null,
      session_index: sessionRow ? Number(sessionRow.session_index) : null,
      mime: type,
      duration_ms: Math.max(0, Math.round(Number(durationMs) || 0)),
      size_bytes: size,
      chunk_count: parts,
      client_key: key || null,
      recorded_at: recorded,
      segment_index: segment,
      created_at: now,
    })
  }

  /** 上传一片：同一片重复上传直接覆盖，重试不会产生重复数据 */
  async function savePart(id, index, audio) {
    const row = await db.first('SELECT * FROM recite_recordings WHERE id = ?', String(id))
    if (!row) throw badRequest('录音上传已失效，请重新上传', 'RECORDING_NOT_FOUND')
    if (row.status !== 'uploading') throw badRequest('这段录音已经上传完成', 'RECORDING_DONE')
    const at = Number(index)
    if (!Number.isInteger(at) || at < 0 || at >= Number(row.chunk_count || 0)) {
      throw badRequest('录音分片序号无效', 'RECORDING_PART_INDEX')
    }
    const data = String(audio ?? '').replace(/^data:[^,]*,/, '').trim()
    if (!data) throw badRequest('录音分片为空', 'RECORDING_PART_EMPTY')
    if (data.length > MAX_PART_BASE64) throw badRequest('录音分片太大', 'RECORDING_PART_LARGE')
    await db.run(
      `INSERT INTO recite_recording_chunks (recording_id, idx, data_base64) VALUES (?, ?, ?)
       ON CONFLICT(recording_id, idx) DO UPDATE SET data_base64 = excluded.data_base64`,
      row.id, at, data,
    )
    return { id: row.id, index: at }
  }

  /** 所有分片都到齐才把这条录音标成可播放 */
  async function complete(id, now = Date.now()) {
    const row = await db.first('SELECT * FROM recite_recordings WHERE id = ?', String(id))
    if (!row) throw badRequest('录音上传已失效，请重新上传', 'RECORDING_NOT_FOUND')
    if (row.status === 'ready') return recordingResponse(row)
    const stored = await db.first(
      'SELECT COUNT(*) AS count FROM recite_recording_chunks WHERE recording_id = ?', row.id,
    )
    const count = Number(stored?.count || 0)
    const expected = Number(row.chunk_count || 0)
    if (count < expected) {
      throw badRequest('还有 ' + (expected - count) + ' 段录音没上传完', 'RECORDING_INCOMPLETE')
    }
    await db.run("UPDATE recite_recordings SET status = 'ready', chunk_count = ? WHERE id = ?", count, row.id)
    await purgeExpired(now)
    return recordingResponse({ ...row, status: 'ready', chunk_count: count })
  }

  /** 最近 15 天已上传完成的录音，新的在前 */
  async function list(limit) {
    await purgeExpired()
    const asked = Number(limit)
    const size = Number.isFinite(asked) && asked > 0 ? Math.min(Math.floor(asked), MAX_LIMIT) : DEFAULT_LIMIT
    const rows = await db.all(
      `SELECT id, session_id, week_start, session_index, mime, duration_ms, size_bytes, chunk_count,
              recorded_at, segment_index, status, created_at
       FROM recite_recordings WHERE status = 'ready' ORDER BY created_at DESC LIMIT ?`,
      size,
    )
    return rows.map(recordingResponse)
  }

  /**
   * 取整段音频供前端转 Blob URL 播放；过期即当不存在。
   * 先把每一片解码成字节再整段重新编码：base64 直接首尾相接只在不跨 3 字节边界时才等价，
   * 按字节拼才能保证任意切片尺寸都能原样还原。
   */
  async function getAudio(id) {
    await purgeExpired()
    const row = await db.first("SELECT * FROM recite_recordings WHERE id = ? AND status = 'ready'", String(id))
    if (!row) return null
    const chunks = await db.all(
      'SELECT data_base64 FROM recite_recording_chunks WHERE recording_id = ? ORDER BY idx',
      row.id,
    )
    const binaries = chunks.map(chunk => atob(String(chunk.data_base64 || '')))
    const total = binaries.reduce((sum, binary) => sum + binary.length, 0)
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const binary of binaries) {
      for (let index = 0; index < binary.length; index += 1) bytes[offset + index] = binary.charCodeAt(index)
      offset += binary.length
    }
    let joined = ''
    const step = 0x8000
    for (let index = 0; index < bytes.length; index += step) {
      joined += String.fromCharCode(...bytes.subarray(index, index + step))
    }
    return {
      mime: row.mime,
      durationMs: Number(row.duration_ms || 0),
      audio: btoa(joined),
    }
  }

  /** 设置页的统一删除：按 id 批量清掉录音和它的所有分片，返回实际删掉几条 */
  async function remove(ids) {
    const wanted = (Array.isArray(ids) ? ids : [])
      .map(id => String(id ?? '').trim())
      .filter(Boolean)
    const unique = Array.from(new Set(wanted)).slice(0, 200)
    let deleted = 0
    for (const id of unique) {
      const row = await db.first('SELECT id FROM recite_recordings WHERE id = ?', id)
      if (!row) continue
      await db.run('DELETE FROM recite_recording_chunks WHERE recording_id = ?', id)
      await db.run('DELETE FROM recite_recordings WHERE id = ?', id)
      deleted += 1
    }
    return { deleted }
  }

  return { createUpload, savePart, complete, list, getAudio, remove, purgeExpired }
}
