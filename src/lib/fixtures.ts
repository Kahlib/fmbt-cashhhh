// Reading the football tables that the sync function fills (step 8): the
// teams, the fixtures and when the sync last worked, in the shapes the bets
// code and the pages use.
//
// Every row was checked on its way in, by supabase-api.ts. This joins each
// fixture to its teams' codes and writes its kick-off the way toISOString()
// does, which is the form the week record keeps.
import { ServerError, type AccountApi, type FixtureRow } from './account/api.ts'
import { fromDatabaseTime, type FIXTURE_STATUSES } from './account/rows.ts'
import type { Competition } from './bets/week-record.ts'

export type Team = { id: number; name: string; shortName: string; code: string }

export type FixtureStatus = (typeof FIXTURE_STATUSES)[number]

// One match, with the database's column names. It works as a WeekFixture for
// adding parlays, and as a FixtureScore for settling.
export type Fixture = Omit<FixtureRow, 'competition' | 'status' | 'tie_leg'> & {
  competition: Competition
  status: FixtureStatus
  tie_leg: 1 | 2 | null   // which leg of a two-legged tie, if it's one
  home: string            // the home team's code, such as MCI
  away: string
}

export type LoadedFixtures = { fixtures: Fixture[]; teams: Map<number, Team> }

// Every team, and every fixture of one season in both competitions.
export async function loadFixtures(api: AccountApi, season: number): Promise<LoadedFixtures> {
  const read = new Map<number, Team>()
  for (const row of await api.teams()) read.set(row.id, { id: row.id, name: row.name, shortName: row.short_name, code: row.code })
  const teams = withUniqueCodes(read)
  const fixtures = (await api.fixtures(season)).map(row => toFixture(row, teams, season))
  return { fixtures, teams }
}

// football-data gives a few teams the same three-letter code: Barcelona and
// Bayern are both FCB. The app tells teams apart by their codes, so each
// team that shares one gets its own instead, made from its name the way the
// sync makes a code for a team without one: Bayern becomes BAY, and
// Barcelona BAR (step 11 plan, 11.4). A code only one team has stays as it
// is, and the database keeps football-data's codes.
export function withUniqueCodes(teams: ReadonlyMap<number, Team>): Map<number, Team> {
  const count = new Map<string, number>()
  for (const team of teams.values()) count.set(team.code, (count.get(team.code) ?? 0) + 1)
  const taken = new Set([...count].filter(([, teamsWithIt]) => teamsWithIt === 1).map(([code]) => code))
  const result = new Map(teams)
  // In order of football-data's ID, so every tab gives each team the same code.
  const sharing = [...teams.values()].filter(team => (count.get(team.code) ?? 0) > 1).sort((a, b) => a.id - b.id)
  for (const team of sharing) {
    const code = madeCodes(team).find(each => !taken.has(each))
    // No real pair of names comes near running out of codes. If one ever
    // did, the team would keep the code it shares.
    if (code === undefined) continue
    taken.add(code)
    result.set(team.id, { ...team, code })
  }
  return result
}

// The codes a team's names can make, best first: from its short name, then
// its full name, the first letter from A to Z with any two that come after
// it, in order. "Bayern" makes BAY, then BAE, BAR and so on.
function madeCodes(team: Team): string[] {
  const codes: string[] = []
  for (const name of [team.shortName, team.name]) {
    const letters = name.toUpperCase().replace(/[^A-Z]/g, '')
    for (let second = 1; second < letters.length; second++) {
      for (let third = second + 1; third < letters.length; third++) codes.push(letters[0] + letters[second] + letters[third])
    }
  }
  return codes
}

// The season's fixtures kicking off from `from` up to, but not including,
// `to`: the matches in their live window, for the once-a-minute refresh.
export async function loadFixturesBetween(api: AccountApi, teams: ReadonlyMap<number, Team>, season: number, from: string, to: string): Promise<Fixture[]> {
  // A span can reach into another season's matches, which stay out.
  return (await api.fixturesBetween(from, to)).filter(row => row.season === season).map(row => toFixture(row, teams, season))
}

function toFixture(row: FixtureRow, teams: ReadonlyMap<number, Team>, season: number): Fixture {
  const home = teams.get(row.home_team_id)
  const away = teams.get(row.away_team_id)
  const kickoff = fromDatabaseTime(row.kickoff)
  // The database never holds a fixture without its teams, so a missing one
  // means the answers don't fit together.
  if (home === undefined || away === undefined || kickoff === null || row.season !== season) throw new ServerError()
  return {
    ...row, kickoff, home: home.code, away: away.code,
    competition: row.competition as Competition, status: row.status as FixtureStatus, tie_leg: row.tie_leg as 1 | 2 | null,
  }
}

// The fixtures by football-data's ID, the way settling looks them up.
export function byId(fixtures: readonly Fixture[]): Map<number, Fixture> {
  return new Map(fixtures.map(fixture => [fixture.id, fixture]))
}

// When the sync last started a run and when one last worked, for the pages'
// "Synced 1 min ago". Null until it has.
export type SyncStatus = { lastAttemptAt: string | null; lastSuccessAt: string | null }

export async function loadSyncStatus(api: AccountApi): Promise<SyncStatus> {
  const row = await api.syncStatus()
  return { lastAttemptAt: fromDatabaseTime(row.last_attempt_at), lastSuccessAt: fromDatabaseTime(row.last_success_at) }
}
