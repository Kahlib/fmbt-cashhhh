// How dates and file sizes read on screen (fmbt-design-system, "Numbers
// and words"). Dates use this computer's time zone.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const DAY_MS = 86_400_000

// "1 Nov 2026". Written out by hand, because browsers disagree on short
// month names ("Sep" or "Sept").
export function formatDay(iso: string): string {
  const date = new Date(iso)
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`
}

// "today", "yesterday" or "34 days ago", counting calendar days.
export function daysAgo(iso: string, now = new Date()): string {
  const midnight = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  const days = Math.round((midnight(now) - midnight(new Date(iso))) / DAY_MS)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  return `${days} days ago`
}

// "3 KB", rounded up, so a small file never shows as 0 KB.
export function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.ceil(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// "1 saved version" or "41 saved versions".
export function count(n: number, one: string, many: string): string {
  return `${n.toLocaleString('en-GB')} ${n === 1 ? one : many}`
}
