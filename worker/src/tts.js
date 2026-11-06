/**
 * tts.js — 单词发音：Google Cloud Text-to-Speech（REST v1）+ D1 缓存
 *
 * 链路：前端点喇叭 → GET /api/tts?text=word → 这里 → Google 合成 MP3
 * → base64 回给前端（前端转成 Blob URL 播放）。
 *
 * 只有 Worker secret `GOOGLE_TTS_API_KEY` 配了才可用；没配 / 断网时接口回 503 并带原因，
 * 前端喇叭按钮始终显示，点下去失败时把 503 的 error 翻成中文提示写在页面上。
 *
 * 合成结果按「音色 + 文本」缓存在 tts_cache 表：同一个词反复点不再走外网。
 * 老库没有这张表时按未命中处理，发音照常可用（只是不缓存）。
 */

const DEFAULT_TTS_URL = 'https://texttospeech.googleapis.com/v1/text:synthesize'
const DEFAULT_VOICE = 'en-US-Neural2-F'
const DEFAULT_LANGUAGE = 'en-US'
const DEFAULT_TIMEOUT_MS = 10_000
/** 背单词只念单词 / 短语，长文本没必要合成 */
export const MAX_TTS_TEXT_LENGTH = 160
/** 缓存表保留条数上限：超过就丢最久没念的 */
const TTS_CACHE_LIMIT = 2000
/** 命中概率触发的惰性清理，避免每次合成都跑一条 DELETE */
const TTS_PRUNE_RATE = 0.05

export function ttsConfigured(env) {
  return Boolean(String(env?.GOOGLE_TTS_API_KEY ?? '').trim())
}

function voiceOf(env) {
  return String(env?.GOOGLE_TTS_VOICE ?? '').trim() || DEFAULT_VOICE
}

function languageOf(env) {
  return String(env?.GOOGLE_TTS_LANGUAGE ?? '').trim() || DEFAULT_LANGUAGE
}

/** 缓存键带上音色：换音色后旧音频不会被错用 */
function cacheKeyOf(text, env) {
  return voiceOf(env) + '|' + text
}

export function ttsStatus(app) {
  const configured = ttsConfigured(app.env)
  return {
    available: configured && !app.config.noNetwork,
    configured,
    voice: voiceOf(app.env),
    language: languageOf(app.env),
  }
}

async function readCachedAudio(app, key) {
  try {
    const row = await app.db.first('SELECT mime, audio_base64 FROM tts_cache WHERE cache_key = ?', key)
    if (!row || !row.audio_base64) return null
    return { mime: row.mime || 'audio/mpeg', audio: row.audio_base64 }
  } catch {
    return null
  }
}

async function writeCachedAudio(app, key, text, mime, audio) {
  try {
    await app.db.run(
      'INSERT INTO tts_cache (cache_key, text, mime, audio_base64, cached_at) VALUES (?, ?, ?, ?, ?)'
      + ' ON CONFLICT(cache_key) DO UPDATE SET mime = excluded.mime,'
      + ' audio_base64 = excluded.audio_base64, cached_at = excluded.cached_at',
      key, text, mime, audio, Date.now(),
    )
    if (Math.random() < TTS_PRUNE_RATE) {
      await app.db.run(
        'DELETE FROM tts_cache WHERE cache_key IN ('
        + 'SELECT cache_key FROM tts_cache ORDER BY cached_at DESC LIMIT -1 OFFSET ?)',
        TTS_CACHE_LIMIT,
      )
    }
  } catch {
    // 缓存写失败不影响这次发音
  }
}

/**
 * 合成一个词 / 短语的 MP3。返回 { status, body }，与 routes.js 其他处理器一致。
 * body.audio 是 base64（Google 原样返回的内容），前端解成 Blob 再播放。
 */
export async function synthesizeSpeech(app, rawText) {
  const env = app.env
  const text = String(rawText ?? '').trim().replace(/\s+/g, ' ')
  if (!text) return { status: 400, body: { error: 'missing text' } }
  if (text.length > MAX_TTS_TEXT_LENGTH) {
    return { status: 400, body: { error: 'text too long', limit: MAX_TTS_TEXT_LENGTH } }
  }
  if (!ttsConfigured(env)) {
    return { status: 503, body: { error: 'tts not configured: GOOGLE_TTS_API_KEY missing' } }
  }
  if (app.config.noNetwork) return { status: 503, body: { error: 'network disabled' } }

  const key = cacheKeyOf(text, env)
  const cached = await readCachedAudio(app, key)
  if (cached) return { status: 200, body: { text, mime: cached.mime, audio: cached.audio, cached: true } }

  const endpoint = String(env.GOOGLE_TTS_API_URL ?? '').trim() || DEFAULT_TTS_URL
  const url = endpoint + (endpoint.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(env.GOOGLE_TTS_API_KEY)
  const timeout = Number(env.TTS_NETWORK_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: { text },
        voice: { languageCode: languageOf(env), name: voiceOf(env) },
        audioConfig: { audioEncoding: 'MP3', speakingRate: 0.9, pitch: 0 },
      }),
      signal: controller.signal,
    })
    let payload = null
    try { payload = await response.json() } catch { payload = null }
    if (!response.ok) {
      const message = payload?.error?.message || ('HTTP ' + response.status)
      return { status: 502, body: { error: 'tts upstream failed: ' + message } }
    }
    const audio = typeof payload?.audioContent === 'string' ? payload.audioContent : ''
    if (!audio) return { status: 502, body: { error: 'tts returned no audio' } }
    const mime = 'audio/mpeg'
    await writeCachedAudio(app, key, text, mime, audio)
    return { status: 200, body: { text, mime, audio, cached: false } }
  } catch (error) {
    const aborted = error?.name === 'AbortError'
    return {
      status: 502,
      body: { error: aborted ? 'tts timeout' : 'tts request failed: ' + (error?.message || String(error)) },
    }
  } finally {
    clearTimeout(timer)
  }
}
