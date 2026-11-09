// Team names for the pages: the feed's short names by team code, such as
// MUN for Man United. A code the feed doesn't know shows as itself.
import type { Pick as Choice } from './bets/week-record.ts'
import type { Team } from './fixtures.ts'

export type Names = ReadonlyMap<string, string>

export function teamNames(teams: ReadonlyMap<number, Team>): Names {
  const names = new Map<string, string>()
  for (const team of teams.values()) if (!names.has(team.code)) names.set(team.code, team.shortName)
  return names
}

export function nameOf(names: Names, code: string): string {
  return names.get(code) ?? code
}

// "Man City to win" or "Draw".
export function pickWords(pick: Choice, home: string, away: string, names: Names): string {
  if (pick === 'D') return 'Draw'
  return `${nameOf(names, pick === 'H' ? home : away)} to win`
}
