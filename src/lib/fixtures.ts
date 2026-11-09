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
  const teams = new Map<number, Team>()
  for (const row of await api.teams()) teams.set(row.id, { id: row.id, name: row.name, shortName: row.short_name, code: row.code })
  const fixtures = (await api.fixtures(season)).map(row => toFixture(row, teams, season))
  return { fixtures, teams }
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
