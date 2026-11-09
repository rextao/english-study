import { useEffect, useMemo, useState } from 'react'
import {
  completeReciteRecording,
  createReciteRecording,
  uploadReciteRecordingPart,
} from './useRecite'

/**
 * useReciteRecording — 背词页的课堂录音。
 *
 * 家长的开关在首页左下角（默认开启）；开始学习后自动用 MediaRecorder 录音，
 * 学完（或离开页面）立刻停下，然后把整段音频分片上传：
 *   POST 建记录 → PUT 一片一片传 → POST complete
 * 分片是为了不让一次超时 / 断网把整段录音报废——同一片可重复上传，失败只补那几片。
 * 浏览器不支持、没给麦克风权限、上传失败都不影响背单词，只把原因写在页面上。
 */

/** Safari 只给 audio/mp4，Chrome 用 webm/opus；按顺序挑第一个能用的 */
const MIME_CANDIDATES = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']
/** 语音不需要高码率：24kbps 听得清（6MB ≈ 33 分钟），也不会一分钟录出几 MB */
const AUDIO_BITS_PER_SECOND = 24000
/** 单片原始字节数（384KB，3 的倍数让 base64 边界对齐）：转 base64 约 524KB，远低于服务端单片上限 */
const PART_BYTES = 393_216
/** 单片重试次数（含首次）+ 每轮等 400ms × 次数 */
const PART_ATTEMPTS = 3
/** 单条上限，与服务端一致（16MB ≈ 24kbps 语音 90 分钟） */
const MAX_RECORDING_BYTES = 16 * 1024 * 1024
/** 录满自动停：不让小朋友开着页面录一小时把上限撞穿 */
const MAX_RECORD_MS = 30 * 60 * 1000
/** 录音开关的偏好：家长关掉后下次进来还是关的，默认开启 */
const PREF_KEY = 'es-recite-record'

export function canRecord(): boolean {
  return typeof window !== 'undefined'
    && typeof window.MediaRecorder !== 'undefined'
    && Boolean(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)
}

export function readRecordPref(): boolean {
  try { return localStorage.getItem(PREF_KEY) !== 'off' } catch { return true }
}

export function writeRecordPref(enabled: boolean) {
  try { localStorage.setItem(PREF_KEY, enabled ? 'on' : 'off') } catch { /* 隐私模式下只影响本次会话 */ }
}

function pickMime(): string {
  for (const type of MIME_CANDIDATES) {
    try { if (MediaRecorder.isTypeSupported(type)) return type } catch { /* 忽略不认识的支持查询 */ }
  }
  return ''
}

/** 一段字节转 base64：一次转 32KB，避免 String.fromCharCode 参数过多爆栈 */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const step = 0x8000
  for (let index = 0; index < bytes.length; index += step) {
    binary += String.fromCharCode(...bytes.subarray(index, index + step))
  }
  return btoa(binary)
}

function recordErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? '')
  const text = raw.toLowerCase()
  if (text.includes('permission') || text.includes('denied') || text.includes('not allowed')) {
    return '没法录音：浏览器没给麦克风权限，允许之后再进背词页就会自动录'
  }
  if (text.includes('notfound') || text.includes('no device') || text.includes('device not found')) {
    return '没法录音：没找到麦克风'
  }
  if (text.includes('secure') || text.includes('https')) return '没法录音：页面不是 HTTPS，浏览器不允许用麦克风'
  return '没法录音：' + (raw || '未知错误')
}

/** 单片失败重试：网络抖一下不用家长重录整段 */
async function withRetry<T>(task: () => Promise<T>, attempts = PART_ATTEMPTS): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await task()
    } catch (error) {
      lastError = error
      if (attempt < attempts - 1) {
        await new Promise(resolve => { window.setTimeout(resolve, 400 * (attempt + 1)) })
      }
    }
  }
  throw lastError
}

/**
 * 整段音频分片上传：先建记录，再按 400KB 一片传，最后 complete。
 * 第一轮失败的片再补一轮；还有片没上去就报错（服务端也不会把这条当成可播放录音）。
 */
async function uploadRecording(input: {
  sessionId?: string
  mime: string
  durationMs: number
  bytes: Uint8Array
}) {
  const { sessionId, mime, durationMs, bytes } = input
  const partCount = Math.max(1, Math.ceil(bytes.length / PART_BYTES))
  const created = await withRetry(() => createReciteRecording({
    sessionId,
    mime,
    durationMs,
    sizeBytes: bytes.length,
    partCount,
  }))
  const send = (index: number) => uploadReciteRecordingPart(
    created.id,
    index,
    bytesToBase64(bytes.subarray(index * PART_BYTES, (index + 1) * PART_BYTES)),
  )

  const failed: number[] = []
  for (let index = 0; index < partCount; index += 1) {
    try {
      await withRetry(() => send(index))
    } catch {
      failed.push(index)
    }
  }
  for (const index of failed.splice(0)) {
    try {
      await withRetry(() => send(index))
    } catch {
      failed.push(index)
    }
  }
  if (failed.length > 0) {
    throw new Error('有 ' + failed.length + ' 段没传上去，这段录音没有保存')
  }
  await withRetry(() => completeReciteRecording(created.id))
}

interface ReciteRecordingOptions {
  /** 家长在首页的开关 */
  enabled: boolean
  /** 正在背词（会话 active 且还没进完成页）才录 */
  active: boolean
  sessionId?: string | null
}

export function useReciteRecording({ enabled, active, sessionId }: ReciteRecordingOptions) {
  const supported = useMemo(canRecord, [])
  const [recording, setRecording] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!enabled || !active || !sessionId || !supported) return
    let recorder: MediaRecorder | null = null
    let stream: MediaStream | null = null
    let chunks: Blob[] = []
    let buffered = 0
    let finished = false
    let disposed = false
    let stopTimer = 0
    const startedAt = Date.now()
    const session = sessionId

    /** 录完把整段传上去；失败只提示，不挡住别的功能 */
    const finish = () => {
      if (finished) return
      finished = true
      if (stopTimer) {
        window.clearTimeout(stopTimer)
        stopTimer = 0
      }
      const type = recorder?.mimeType || 'audio/mp4'
      const blob = new Blob(chunks, { type })
      chunks = []
      setRecording(false)
      if (blob.size === 0) return
      if (blob.size > MAX_RECORDING_BYTES) {
        setError('这段录音太长了（超过 16MB），没有保存')
        return
      }
      void blob.arrayBuffer()
        .then(buffer => uploadRecording({
          sessionId: session,
          mime: type,
          durationMs: Date.now() - startedAt,
          bytes: new Uint8Array(buffer),
        }))
        .catch(uploadError => {
          setError('录音上传失败：' + (uploadError instanceof Error ? uploadError.message : '网络异常'))
        })
    }

    /** 主动停：录满 30 分钟 / 超过大小上限 / 离开页面都走这里，停下后自动上传 */
    const stopRecorder = () => {
      const current = recorder
      if (!current) {
        finish()
        return
      }
      if (current.state === 'inactive') finish()
      else {
        try {
          current.stop()
        } catch {
          finish()
        }
      }
    }

    void (async () => {
      try {
        const nextStream = await navigator.mediaDevices.getUserMedia({ audio: true })
        if (disposed) {
          nextStream.getTracks().forEach(track => track.stop())
          return
        }
        stream = nextStream
        const mime = pickMime()
        recorder = mime
          ? new MediaRecorder(nextStream, { mimeType: mime, audioBitsPerSecond: AUDIO_BITS_PER_SECOND })
          : new MediaRecorder(nextStream)
        recorder.ondataavailable = event => {
          if (!event.data || event.data.size === 0) return
          chunks.push(event.data)
          buffered += event.data.size
          // 到了上限就收尾，别等录完才发现传不上去
          if (buffered >= MAX_RECORDING_BYTES) stopRecorder()
        }
        recorder.onstop = finish
        // 每 10 秒切一块：长录音不用等到最后才拿到数据
        recorder.start(10_000)
        setRecording(true)
        setError('')
        stopTimer = window.setTimeout(stopRecorder, MAX_RECORD_MS)
      } catch (recordError) {
        setError(recordErrorMessage(recordError))
      }
    })()

    return () => {
      disposed = true
      stopRecorder()
      if (stream) {
        stream.getTracks().forEach(track => track.stop())
        stream = null
      }
    }
  }, [enabled, active, sessionId, supported])

  return { supported, recording, error }
}
