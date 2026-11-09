// The weeks and stages of a season, in the order they're played, and how
// they read on screen (fmbt-design-system, "Numbers and words").
//
// football-data files every match under one of these. The Premier League has
// matchweeks MW1 to MW38. The Champions League has matchdays MD1 to MD8 in its
// league phase, then the knockout play-offs and the rounds after them.
import type { Competition } from './bets/week-record.ts'

export const PERIODS: readonly string[] = [
  ...Array.from({ length: 38 }, (_, i) => `MW${i + 1}`),
  ...Array.from({ length: 8 }, (_, i) => `MD${i + 1}`),
  'KPO', 'R16', 'QF', 'SF', 'F',
]

const STAGES = new Map([
  ['KPO', 'Knockout play-offs'],
  ['R16', 'Round of 16'],
  ['QF', 'Quarter-finals'],
  ['SF', 'Semi-finals'],
  ['F', 'Final'],
])

export const COMPETITION_NAMES: Readonly<Record<Competition, string>> = { PL: 'Premier League', UCL: 'Champions League' }

// Where a period comes in the season, for sorting. -1 for one that isn't real.
export function periodIndex(period: string): number {
  return PERIODS.indexOf(period)
}

// "Matchweek 12", "Matchday 3" or "Round of 16".
export function periodName(period: string): string {
  if (/^MW\d{1,2}$/.test(period)) return `Matchweek ${period.slice(2)}`
  if (/^MD\d$/.test(period)) return `Matchday ${period.slice(2)}`
  return STAGES.get(period) ?? period
}

// The season a time falls in, by its first year: 2026 is the 2026/27 season,
// which runs from July 2026 to the end of June 2027.
export function seasonOf(time: Date): number {
  return time.getUTCMonth() >= 6 ? time.getUTCFullYear() : time.getUTCFullYear() - 1
}

// "2026/27".
export function seasonLabel(season: number): string {
  return `${season}/${String((season + 1) % 100).padStart(2, '0')}`
}
