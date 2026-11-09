/**
 * speech.ts — 背单词页的发音。
 *
 * GET /api/tts?text=word 由 Worker 调 Google Cloud Text-to-Speech 合成 MP3，
 * 回的是 base64；这里解成 Blob URL 交给 <audio> 播放：
 *  - 同一个词只合成 / 下载一次，URL 复用到刷新页面为止；
 *  - 点新词会掐掉上一个，避免两个声音叠在一起；
 *  - 喇叭按钮始终显示，密钥没配 / 断网 / 播放失败都由 speechErrorMessage 翻成一句中文写在页面上。
 */

import { apiFetch } from './apiBase'
import { queryApi } from './apiCache'

export interface SpeechStatus {
  available: boolean
  configured: boolean
  voice: string
  language: string
  limit: number
}

/** 会话内最多留多少个音频 URL，超出丢最早的（顺手 revoke） */
const MAX_CACHED_AUDIO = 60

const audioUrls = new Map<string, string>()
const pendingAudio = new Map<string, Promise<string>>()
let currentAudio: HTMLAudioElement | null = null
/** 每次 stopSpeech / 新一次 speak 都加一：合成还没回来就被换词 / 离开页面时，回来也不再播 */
let speechGeneration = 0

function cacheKeyOf(text: string) {
  return text.trim().replace(/\s+/g, ' ').toLowerCase()
}

function base64ToBlob(base64: string, mime: string): Blob {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes.buffer as ArrayBuffer], { type: mime })
}

function rememberUrl(key: string, url: string) {
  audioUrls.set(key, url)
  while (audioUrls.size > MAX_CACHED_AUDIO) {
    const oldest = audioUrls.keys().next()
    if (oldest.done) break
    const stale = audioUrls.get(oldest.value)
    audioUrls.delete(oldest.value)
    if (stale && stale !== url) URL.revokeObjectURL(stale)
  }
}

async function loadAudioUrl(text: string): Promise<string> {
  const key = cacheKeyOf(text)
  const cached = audioUrls.get(key)
  if (cached) return cached
  const pending = pendingAudio.get(key)
  if (pending) return pending

  const task = (async () => {
    const response = await apiFetch('/api/tts?text=' + encodeURIComponent(text))
    let payload: { audio?: string; mime?: string; error?: string } | null = null
    try { payload = await response.json() } catch { payload = null }
    if (!response.ok || !payload?.audio) {
      throw new Error(payload?.error || '语音合成失败')
    }
    const url = URL.createObjectURL(base64ToBlob(payload.audio, payload.mime || 'audio/mpeg'))
    rememberUrl(key, url)
    return url
  })()

  pendingAudio.set(key, task)
  try {
    return await task
  } finally {
    pendingAudio.delete(key)
  }
}

/** 掐掉正在播的音频（换卡片 / 离开页面时调用） */
export function stopSpeech() {
  speechGeneration += 1
  if (!currentAudio) return
  currentAudio.onended = null
  currentAudio.onerror = null
  currentAudio.pause()
  currentAudio = null
}

/** 朗读一个词；Promise 在播放结束（或失败）后 resolve / reject */
export async function speak(text: string): Promise<void> {
  const word = text.trim()
  if (!word) return
  stopSpeech()
  const generation = speechGeneration
  const url = await loadAudioUrl(word)
  // 合成期间点了别的词 / 换了卡片：这次的结果已经过时，别再出声
  if (generation !== speechGeneration) return
  await new Promise<void>((resolve, reject) => {
    const audio = new Audio(url)
    currentAudio = audio
    const clear = () => { if (currentAudio === audio) currentAudio = null }
    audio.onended = () => { clear(); resolve() }
    audio.onerror = () => { clear(); reject(new Error('音频播放失败')) }
    const started = audio.play()
    if (started && typeof started.catch === 'function') {
      started.catch(() => { clear(); reject(new Error('浏览器拦下了这次播放')) })
    }
  })
}

/**
 * 把发音链路的错误翻成页面能直接显示的一句话。
 * 配置缺失、断网、上游失败、浏览器拦截分开说，家长一眼能看出是「要配密钥」还是「再点一次就好」。
 */
export function speechErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? '')
  const text = raw.toLowerCase()
  if (text.includes('not configured')) {
    return '发音服务没配置：Worker 少了 GOOGLE_TTS_API_KEY，配好密钥后重启再试'
  }
  if (text.includes('network disabled')) return '现在是断网模式（DICT_NO_NETWORK=1），听不到发音'
  if (text.includes('upstream failed')) return 'Google 语音合成失败了，稍后再点一次'
  if (text.includes('timeout')) return '发音请求超时了，检查网络后再点一次'
  if (text.includes('text too long')) return '这个词太长了，发音只支持 160 个字符以内'
  if (text.includes('unauthorized')) return '访问令牌失效了，重新输入令牌后再点一次'
  if (text.includes('播放失败')) return '音频播放失败了，再点一次喇叭试试'
  if (text.includes('浏览器拦下')) return '浏览器拦下了这次播放，点一下喇叭再试一次'
  if (text.includes('failed to fetch') || text.includes('networkerror')) {
    return '连不上发音服务，检查网络后再点一次'
  }
  return '发音失败了：' + (raw || '未知错误')
}

/** 诊断用：密钥配了没有、联网没有（页面不再据此隐藏喇叭）；结果在会话缓存里放 5 分钟 */
export function fetchSpeechStatus(): Promise<SpeechStatus> {
  return queryApi<SpeechStatus>('/api/tts/status', {}, { staleTime: 5 * 60_000, tags: ['tts-status'] })
}
