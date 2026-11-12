/**
 * reciteRecordingUpload.ts — 背词课堂录音的分片上传（背词页与本地补传共用）。
 *
 * 一次片段的上传固定三步：
 *   POST 建记录（带 clientKey 幂等键）→ PUT 逐片上传（同序号幂等）→ POST complete。
 * 分片是为了不让一次超时 / 断网把整段录音报废：失败的那几片补一轮，还有没上去的就整段算失败，
 * 由调用方把原始字节留在本地，下次再传。
 */

import {
  completeReciteRecording,
  createReciteRecording,
  uploadReciteRecordingPart,
} from '../hooks/useRecite'
import { dropQueuedRecordingSegment, listQueuedRecordingSegments } from './reciteRecordingQueue'

/** 单片原始字节数（384KB，3 的倍数让 base64 边界对齐）：转 base64 约 524KB，远低于服务端单片上限 */
export const PART_BYTES = 393_216
/** 单片重试次数（含首次）+ 每轮等 400ms × 次数 */
const PART_ATTEMPTS = 3
/** 单条上限，与服务端一致（16MB ≈ 24kbps 语音 90 分钟） */
export const MAX_RECORDING_BYTES = 16 * 1024 * 1024

export interface RecordingSegmentUpload {
  /** 会话 id：片段必须绑在当前这次学习上，补传时也一样 */
  sessionId?: string | null
  mime: string
  durationMs: number
  /** 开始录制的时间（客户端毫秒） */
  recordedAt: number
  /** 片段在这次学习里的序号（从 0 起） */
  segmentIndex: number
  /** 幂等键：同一个片段重传不会多出一条记录 */
  clientKey: string
  bytes: Uint8Array
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

/** 单片失败重试：网络抖一下不用家长重录整段 */
async function withRetry<T>(task: () => Promise<T>, attempts = PART_ATTEMPTS): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await task()
    } catch (error) {
      lastError = error
      if (attempt < attempts - 1) {
        await new Promise<void>(resolve => { window.setTimeout(resolve, 400 * (attempt + 1)) })
      }
    }
  }
  throw lastError
}

/**
 * 上传一段录音；失败直接抛错（调用方据此保留本地副本）。
 * 已经传完（服务端返回 ready）就直接算成功，方便幂等重试。
 */
export async function uploadRecordingSegment(input: RecordingSegmentUpload): Promise<void> {
  const { sessionId, mime, durationMs, recordedAt, segmentIndex, clientKey, bytes } = input
  if (bytes.length === 0) return
  if (bytes.length > MAX_RECORDING_BYTES) throw new Error('这段录音太长了（超过 16MB），没有保存')

  const partCount = Math.max(1, Math.ceil(bytes.length / PART_BYTES))
  const created = await withRetry(() => createReciteRecording({
    sessionId: sessionId ?? undefined,
    mime,
    durationMs,
    sizeBytes: bytes.length,
    partCount,
    clientKey,
    recordedAt,
    segmentIndex,
  }))
  if (created.status === 'ready') return

  const send = (index: number) => uploadReciteRecordingPart(
    created.id,
    index,
    bytesToBase64(bytes.subarray(index * PART_BYTES, (index + 1) * PART_BYTES)),
  )
  const count = created.partCount > 0 ? created.partCount : partCount

  const failed: number[] = []
  for (let index = 0; index < count; index += 1) {
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
    throw new Error('有 ' + failed.length + ' 段没传上去，这段录音先存在本机')
  }
  await withRetry(() => completeReciteRecording(created.id))
}

let flushing: Promise<{ uploaded: number; failed: number }> | null = null

/**
 * 把本地待传的片段依次补传（按录制时间先后），传成功一条就从本地删一条。
 * 同一个时间只跑一轮：页面打开、网络恢复、刚传完一段都会触发，不能互相打架。
 */
export function flushQueuedRecordings(): Promise<{ uploaded: number; failed: number }> {
  if (flushing) return flushing
  flushing = (async () => {
    const rows = await listQueuedRecordingSegments()
    let uploaded = 0
    let failed = 0
    for (const row of rows) {
      try {
        await uploadRecordingSegment({
          sessionId: row.sessionId,
          mime: row.mime,
          durationMs: row.durationMs,
          recordedAt: row.recordedAt,
          segmentIndex: row.segmentIndex,
          clientKey: row.key,
          bytes: new Uint8Array(row.bytes),
        })
        await dropQueuedRecordingSegment(row.key)
        uploaded += 1
      } catch (error) {
        const message = error instanceof Error ? error.message : ''
        // 这次学习已经不存在（任务被重新配置过）：这份音频再也传不上去，清掉本地副本
        if (message.includes('学习记录不存在')) {
          await dropQueuedRecordingSegment(row.key)
          continue
        }
        // 其他情况（断网 / 超时 / 服务端抽风）留着下次再试
        failed += 1
      }
    }
    return { uploaded, failed }
  })().finally(() => { flushing = null })
  return flushing
}
