/** 把毫秒时间戳格式化成「YYYY-MM-DD HH:mm」，给同步时间 / 打卡时间用 */
export function formatTime(ms: number | null | undefined): string {
  const value = Number(ms)
  if (!Number.isFinite(value) || value <= 0) return ''
  const date = new Date(value)
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    date.getFullYear()
    + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
    + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
  )
}
