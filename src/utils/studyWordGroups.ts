import type { StudyWordItem } from '../types/vocab'

const DAY = 86400000

export interface StudyWordGroup {
  key: string
  label: string
  items: StudyWordItem[]
}

function startOfDay(ts: number): number {
  const date = new Date(ts)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

function batchKeyOf(ts: number): string {
  const date = new Date(ts)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return date.getFullYear() + '-' + month + '-' + day
}

function batchKeyTsOf(key: string): number {
  const [year, month, day] = key.split('-').map(Number)
  return new Date(year, month - 1, day).getTime()
}

function groupDayLabel(day: number, today: number): string {
  const diff = Math.round((startOfDay(today) - startOfDay(day)) / DAY)
  const todayDate = new Date(today)
  const dayDate = new Date(day)
  const base = dayDate.getFullYear() === todayDate.getFullYear()
    ? (dayDate.getMonth() + 1) + ' 月 ' + dayDate.getDate() + ' 日'
    : dayDate.getFullYear() + ' 年 ' + (dayDate.getMonth() + 1) + ' 月 ' + dayDate.getDate() + ' 日'
  if (diff === 0) return base + ' · 今天'
  if (diff === 1) return base + ' · 昨天'
  return base
}

/** 按学习批次统一分组，供新词选择和自由打印共用。 */
export function groupStudyWords(
  items: StudyWordItem[],
  batchNames: Record<string, string>,
  today: number,
): StudyWordGroup[] {
  const groups = new Map<string, StudyWordItem[]>()
  for (const item of items) {
    const key = item.batchKey || batchKeyOf(item.addedAt)
    const bucket = groups.get(key)
    if (bucket) bucket.push(item)
    else groups.set(key, [item])
  }
  return Array.from(groups.entries())
    .sort((a, b) => Math.max(...b[1].map(item => item.addedAt)) - Math.max(...a[1].map(item => item.addedAt)))
    .map(([key, groupItems]) => {
      const isDate = /^\d{4}-\d{2}-\d{2}$/.test(key)
      const fallback = isDate ? groupDayLabel(batchKeyTsOf(key), today) : '自定义分组'
      return {
        key,
        label: batchNames[key] || fallback,
        items: groupItems,
      }
    })
}
