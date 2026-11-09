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

// Money, odds and match times (step 10). Money is always whole cents until
// it's written out here, and negatives use the real minus sign, U+2212.
export const MINUS = '−'
const SHORT_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const LONG_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

// "$1,234.56", with no sign.
export function money(cents: number): string {
  const size = Math.abs(cents)
  return `$${Math.floor(size / 100).toLocaleString('en-US')}.${String(size % 100).padStart(2, '0')}`
}

// "+$12.34", "−$12.34" or "$0.00", for results.
export function signedMoney(cents: number): string {
  if (cents > 0) return `+${money(cents)}`
  if (cents < 0) return `${MINUS}${money(cents)}`
  return money(0)
}

// American odds: "+150" or "−110".
export function oddsText(odds: number): string {
  return odds > 0 ? `+${odds}` : `${MINUS}${Math.abs(odds)}`
}

// A boost in basis points as a percent: 500 is "5%", 250 is "2.5%", 1 is "0.01%".
export function percentText(bps: number): string {
  const whole = Math.floor(bps / 100)
  const part = bps % 100
  if (part === 0) return `${whole}%`
  return `${whole}.${String(part).padStart(2, '0').replace(/0$/, '')}%`
}

// "7:30 am", in this computer's time zone.
export function clockTime(iso: string): string {
  const time = new Date(iso)
  const hours = time.getHours()
  return `${hours % 12 === 0 ? 12 : hours % 12}:${String(time.getMinutes()).padStart(2, '0')} ${hours < 12 ? 'am' : 'pm'}`
}

// "Sat 7:30 am".
export function dayAndTime(iso: string): string {
  return `${SHORT_DAYS[new Date(iso).getDay()]} ${clockTime(iso)}`
}

// "Saturday 21 Nov".
export function longDay(iso: string): string {
  const time = new Date(iso)
  return `${LONG_DAYS[time.getDay()]} ${time.getDate()} ${MONTHS[time.getMonth()]}`
}

// The days a week's games are played: "Sat 21 to Mon 23 Nov", "Sat 28 Nov
// to Tue 1 Dec", or "Tue 1 Dec" when they're all on one day.
export function dayRange(firstIso: string, lastIso: string): string {
  const first = new Date(firstIso)
  const last = new Date(lastIso)
  const day = (time: Date) => `${SHORT_DAYS[time.getDay()]} ${time.getDate()}`
  const end = `${day(last)} ${MONTHS[last.getMonth()]}`
  if (first.toDateString() === last.toDateString()) return end
  if (first.getMonth() === last.getMonth() && first.getFullYear() === last.getFullYear()) return `${day(first)} to ${end}`
  return `${day(first)} ${MONTHS[first.getMonth()]} to ${end}`
}

// How long ago something happened: "just now", "1 min ago", "25 min ago",
// "2 hours ago" or the day it happened.
export function timeAgo(iso: string, now: number): string {
  const minutes = Math.floor((now - Date.parse(iso)) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return hours === 1 ? '1 hour ago' : `${hours} hours ago`
  return `on ${formatDay(iso)}`
}

// Rates and returns on the Dashboard (step 10.3).

// A rate as a whole percent: .563 is "56%".
export function wholePercent(rate: number): string {
  return `${Math.round(rate * 100)}%`
}

// A difference in percentage points: "+6 pts", "−3 pts" or "0 pts".
export function pointsText(difference: number): string {
  const points = Math.round(difference * 100)
  return `${points > 0 ? '+' : points < 0 ? MINUS : ''}${Math.abs(points)} pts`
}

// Return on stake, to one decimal: "+12.5%" or "−8.9%".
export function returnText(rate: number): string {
  const tenths = Math.round(rate * 1000)
  return `${tenths > 0 ? '+' : tenths < 0 ? MINUS : ''}${(Math.abs(tenths) / 10).toFixed(1)}%`
}

// A whole-dollar axis label: "+$200", "−$50" or "$0".
export function axisDollars(dollars: number): string {
  if (dollars === 0) return '$0'
  return `${dollars > 0 ? '+' : MINUS}$${Math.abs(dollars).toLocaleString('en-US')}`
}
