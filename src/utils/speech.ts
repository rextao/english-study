/**
 * speech.ts — 背单词页的发音。
 *
 * GET /api/tts?text=word&rate=1 由 Worker 调 Google Cloud Text-to-Speech 合成 MP3，
 * 回的是 base64；这里解成 Blob URL 交给 <audio> 播放：
 *  - 同一个词只合成 / 下载一次，URL 复用到刷新页面为止；
 *  - 慢速不是把播放速度拉慢（那样音色会变），而是带上 rate（或直接给 speakingRate）
 *    让 Google 用 speakingRate 原生慢慢念，回的是慢速音频本体，<audio> 始终按 1 倍速播；
 *  - 点新词会掐掉上一个，避免两个声音叠在一起；
 *  - 全站共用一个 <audio>，并在用户手势里先「解锁」它（见 unlockSpeech）：
 *    iOS / iPadOS Safari 只允许在手势的同步调用栈里起播，而这里是先取音频（IndexedDB /
 *    网络）再 play()，await 回来手势已经失效，声音就被静默拦下——游戏里拖英文球没声音就是这个原因；
 *  - 喇叭按钮始终显示，密钥没配 / 断网 / 播放失败都由 speechErrorMessage 翻成一句中文写在页面上。
 */

import { apiFetch } from './apiBase'
import { queryApi } from './apiCache'
import { loadPersistedAudio, storePersistedAudio } from './reciteCache'

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
/** 全站共用的音频元素：解锁过一次之后，同一个元素换 src 播放就不再受手势限制 */
let sharedAudio: HTMLAudioElement | null = null
let speechUnlocked = false
/** 只尝试解锁一次：解锁失败（不在手势里、浏览器不支持）就退回「await 之后 play」的老路径 */
let unlockAttempted = false
/** 0 长度的静音 WAV：只用来在手势里把音频元素解锁，听不到任何声音 */
const SILENT_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQAAAAA='

function sharedAudioElement(): HTMLAudioElement {
  if (!sharedAudio) sharedAudio = new Audio()
  return sharedAudio
}

/**
 * 在用户手势（pointerdown / click）的同步调用栈里把共用的音频元素解锁一次。
 * speak() 一进来就会调它，所以所有调用方（喇叭按钮、游戏里拖球 / 点牌）都不用自己管；
 * 不在手势里调用也没有副作用，只是解锁可能失败，之后照旧按老路径播放。
 */
export function unlockSpeech() {
  if (speechUnlocked || unlockAttempted) return
  unlockAttempted = true
  const audio = sharedAudioElement()
  try {
    audio.src = SILENT_WAV
    const started = audio.play()
    if (started && typeof started.then === 'function') {
      // 静音片段播起来就说明这个元素已经被手势解锁，后面换 src 也能直接播
      started.then(() => { speechUnlocked = true }).catch(() => { /* 解锁失败：下次进页面再说 */ })
    } else {
      speechUnlocked = true
    }
  } catch {
    // 老浏览器 / 元素被回收：不影响正常的 await 后播放
  }
}

/** 句子整句默认让 Google 用 0.7 念：背词页档位与首页预取共用这一个值，预取拉回来的音频点喇叭才命中 */
export const SENTENCE_SPEAKING_RATE = 0.7

/**
 * 本地缓存键 = 归一化文本 + 语速：正常速（rate=1 / 不传 speakingRate）就只是文本，
 * 与背词首页预取的键一致；直接指定 Google 语速的另存一份（如 `句子@sr0.7`），两者互不覆盖。
 * 预取（useRecitePreload）也走这个函数，两边的键必须一致。
 */
export function speechCacheKey(text: string, rate = 1, speakingRate?: number) {
  const base = text.trim().replace(/\s+/g, ' ').toLowerCase()
  if (speakingRate) return base + '@sr' + speakingRate
  return rate === 1 ? base : base + '@' + rate
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

async function loadAudioUrl(text: string, rate: number, speakingRate?: number): Promise<string> {
  const key = speechCacheKey(text, rate, speakingRate)
  const cached = audioUrls.get(key)
  if (cached) return cached
  const pending = pendingAudio.get(key)
  if (pending) return pending

  const task = (async () => {
    // 先看本地缓存：背词首页打开时已经把本周单词的发音预取进 IndexedDB，
    // 命中就不必再打 /api/tts（断网也能播）
    const persisted = await loadPersistedAudio(key)
    if (persisted?.audio) {
      const cachedUrl = URL.createObjectURL(base64ToBlob(persisted.audio, persisted.mime || 'audio/mpeg'))
      rememberUrl(key, cachedUrl)
      return cachedUrl
    }

    const query = speakingRate
      ? '?text=' + encodeURIComponent(text) + '&speakingRate=' + speakingRate
      : '?text=' + encodeURIComponent(text) + '&rate=' + rate
    const response = await apiFetch('/api/tts' + query)
    let payload: { audio?: string; mime?: string; error?: string } | null = null
    try { payload = await response.json() } catch { payload = null }
    if (!response.ok || !payload?.audio) {
      throw new Error(payload?.error || '语音合成失败')
    }
    const mime = payload.mime || 'audio/mpeg'
    // 顺手落一份到本地：下次进页面 / 断网时还能播（失败不影响这次播放）
    void storePersistedAudio(key, payload.audio, mime)
    const url = URL.createObjectURL(base64ToBlob(payload.audio, mime))
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

/**
 * 朗读一个词 / 一句话；Promise 在播放结束（或失败）后 resolve / reject。
 * rate 是背词页右上角的倍速档位（正常速 1 / 0.5）：按这个档位向 Worker 要对应语速的
 * 音频（Google 自己念慢，音色不变），<audio> 固定 1 倍速播。
 * speakingRate 直接指定 Google 语速（句子整句用 0.7），传了就不看 rate；
 * 每个语速各自缓存，同一段文本同一语速只合成 / 下载一次。
 */
export async function speak(
  text: string,
  options: { rate?: number; speakingRate?: number } = {},
): Promise<void> {
  const word = text.trim()
  if (!word) return
  // 这一行还在用户手势的同步调用栈里，先解锁共用的音频元素（见 unlockSpeech）
  unlockSpeech()
  const rate = options.rate && options.rate > 0 ? options.rate : 1
  const speakingRate = options.speakingRate && options.speakingRate > 0 ? options.speakingRate : undefined
  stopSpeech()
  const generation = speechGeneration
  const url = await loadAudioUrl(word, rate, speakingRate)
  // 合成期间点了别的词 / 换了卡片：这次的结果已经过时，别再出声
  if (generation !== speechGeneration) return
  await new Promise<void>((resolve, reject) => {
    // 复用解锁过的那一个元素：新造一个 <audio> 在手势之外是播不出来的
    const audio = sharedAudioElement()
    const clear = () => { if (currentAudio === audio) currentAudio = null }
    audio.onended = () => { clear(); resolve() }
    audio.onerror = () => { clear(); reject(new Error('音频播放失败')) }
    audio.src = url
    // 复用同一个元素：src 没变时浏览器不会自动回到开头，显式倒一次
    try { audio.currentTime = 0 } catch { /* 还没解出元数据时设不了，play 自己会从头播 */ }
    currentAudio = audio
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
