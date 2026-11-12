/**
 * reciteRecordings.ts — 课堂录音的「同一次学习」归组与拼接顺序判定。
 *
 * 一次学习可能因为关页面 / 切后台录成好几段（每段单独上传），在任务页要当一条音频听：
 *   - 先按会话（sessionId，退化为「周 + 第几次」）分组，绝不把不同次数的混在一起；
 *   - 组内按片段序号排，序号缺失就按录制时间；
 *   - 只有「每段都有序号、都有录制时间、序号不重复、序号顺序与时间顺序一致」才判定可拼接，
 *     否则不合并——宁可分开听，也不让时间顺序错乱。
 */

import type { ReciteRecordingSummary } from '../hooks/useRecite'

export interface RecordingGroup {
  /** 组内片段，已按时间顺序排好；无法判定顺序时按上传时间排，仅用于展示 */
  segments: ReciteRecordingSummary[]
  /** 能不能当成一条音频顺序播放（顺序不可疑才算 true） */
  merged: boolean
  /** 总时长（服务端记录的时长之和，播放时可能按实际元数据微调） */
  durationMs: number
}

function orderKey(item: ReciteRecordingSummary): number {
  return item.recordedAt ?? item.createdAt
}

/** 组内排序：有片段的序号就按序号，没有就按录制时间 */
function sortSegments(items: ReciteRecordingSummary[]): ReciteRecordingSummary[] {
  return items.slice().sort((left, right) => {
    if (left.segmentIndex != null && right.segmentIndex != null && left.segmentIndex !== right.segmentIndex) {
      return left.segmentIndex - right.segmentIndex
    }
    return orderKey(left) - orderKey(right)
  })
}

/** 顺序是否可信：全部带序号 + 录制时间，序号不重，且序号顺序与时间顺序一致 */
function isOrderSafe(segments: ReciteRecordingSummary[]): boolean {
  if (segments.length < 2) return true
  const sessionIds = new Set(segments.map(item => item.sessionId ?? ''))
  // 不同会话 / 老数据没绑会话：不知道是不是同一次学习，不合并
  if (sessionIds.size !== 1) return false
  if (!Array.from(sessionIds)[0]) return false
  const seen = new Set<number>()
  let lastAt = -Infinity
  for (const item of segments) {
    const index = item.segmentIndex
    const at = item.recordedAt
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) return false
    if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) return false
    if (seen.has(index)) return false
    seen.add(index)
    if (at < lastAt) return false
    lastAt = at
  }
  return true
}

/** 把若干段录音打成一个组：可拼接就按时间顺序拼，不可拼接也保持一个稳定展示顺序 */
export function buildRecordingGroup(items: ReciteRecordingSummary[]): RecordingGroup {
  const segments = sortSegments(items)
  return {
    segments,
    merged: isOrderSafe(segments),
    durationMs: segments.reduce((sum, item) => sum + Math.max(0, item.durationMs || 0), 0),
  }
}

/** 录音列表按「周 + 第几次」归组；没绑会话的老数据不归组（key 用 id） */
export function groupReciteRecordings(
  items: ReciteRecordingSummary[],
): Map<string, RecordingGroup> {
  const buckets = new Map<string, ReciteRecordingSummary[]>()
  for (const item of items) {
    const key = item.weekStart != null && item.sessionIndex != null
      ? item.weekStart + ':' + item.sessionIndex
      : 'recording:' + item.id
    const bucket = buckets.get(key)
    if (bucket) bucket.push(item)
    else buckets.set(key, [item])
  }
  const groups = new Map<string, RecordingGroup>()
  for (const [key, bucket] of buckets) groups.set(key, buildRecordingGroup(bucket))
  return groups
}

/** 组的总时长文案用得上：把毫秒换成「N 分 N 秒」 */
export function fmtRecordingDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return minutes > 0 ? minutes + ' 分 ' + seconds + ' 秒' : seconds + ' 秒'
}
