// Tests for src/lib/fixtures.ts, and for the checks rows.ts makes on the
// football tables' rows. Every sample here is made up.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ServerError, type AccountApi, type FixtureRow } from '../src/lib/account/api.ts'
import { fromDatabaseTime, isFixtureRow, isSyncStatusRow, isTeamRow } from '../src/lib/account/rows.ts'
import { settleWeek } from '../src/lib/bets/settle.ts'
import { addParlay, EMPTY_WEEK } from '../src/lib/bets/week-record.ts'
import { byId, loadFixtures, loadSyncStatus } from '../src/lib/fixtures.ts'
import { finished, fixtureRow, quickAccount, tabOn, TEAM_ROWS } from './bet-samples.ts'
import { FakeServer } from './fake-api.ts'

async function start(fixtures: FixtureRow[]) {
  const server = new FakeServer()
  server.state.football.teams = structuredClone(TEAM_ROWS)
  server.state.football.fixtures = fixtures
  const account = await quickAccount(server)
  return { server, tab: await tabOn(server, account) }
}

const ARS_CHE = { home_team_id: 9003, away_team_id: 9004 }

test("fixtures come back with their teams' codes, and kick-offs in the record's form", async () => {
  const { tab } = await start([fixtureRow(1), finished(2, 3, 1, ARS_CHE), fixtureRow(3, { season: 2025, period: 'MW11' })])
  const { fixtures, teams } = await loadFixtures(tab, 2026)
  assert.deepEqual(fixtures, [
    { ...fixtureRow(1), kickoff: '2026-11-07T17:30:00.000Z', home: 'MCI', away: 'LIV' },
    { ...finished(2, 3, 1, ARS_CHE), kickoff: '2026-11-07T17:30:00.000Z', home: 'ARS', away: 'CHE' },
  ], "only 2026's, with each team's code")
  assert.equal(teams.size, TEAM_ROWS.length)
  assert.deepEqual(teams.get(9005), { id: 9005, name: 'Tottenham Hotspur FC', shortName: 'Spurs', code: 'TOT' })

  // They work for adding a parlay and for settling it.
  const week = { season: 2026, competition: 'PL' as const, period: 'MW11' }
  const added = addParlay(EMPTY_WEEK, week, fixtures, { stakeCents: 2500, boostBps: 0, legs: [{ fixtureId: 900_002, pick: 'H', odds: 150, confidence: 3 }] })
  assert.ok(added.ok)
  assert.deepEqual([added.parlay.legs[0]?.home, added.parlay.legs[0]?.kickoff], ['ARS', '2026-11-07T17:30:00.000Z'])
  const settled = settleWeek(added.record, byId(fixtures), '2026-11-07T19:30:00.000Z')
  assert.equal(settled.record.parlays[0]?.legs[0]?.settlement?.outcome, 'won')
})

test("a fixture whose team is missing, or from another season, means the answers don't fit", async () => {
  const { server, tab } = await start([fixtureRow(1)])
  server.state.football.teams = TEAM_ROWS.filter(team => team.id !== 9002)
  await assert.rejects(loadFixtures(tab, 2026), ServerError)

  const wrongSeason: AccountApi = new Proxy(tab, {
    get: (target, prop, receiver) => (prop === 'fixtures' ? async () => [fixtureRow(1, { season: 2025 })] : Reflect.get(target, prop, receiver)),
  })
  server.state.football.teams = structuredClone(TEAM_ROWS)
  await assert.rejects(loadFixtures(wrongSeason, 2026), ServerError)
})

test("the sync status, with its times in the record's form", async () => {
  const { server, tab } = await start([])
  assert.deepEqual(await loadSyncStatus(tab), { lastAttemptAt: null, lastSuccessAt: null })
  server.state.football.syncStatus = { last_attempt_at: '2026-11-07T17:31:02.123456+00:00', last_success_at: '2026-11-07T17:30:01+00:00' }
  assert.deepEqual(await loadSyncStatus(tab), { lastAttemptAt: '2026-11-07T17:31:02.123Z', lastSuccessAt: '2026-11-07T17:30:01.000Z' })
})

test('database times: any offset, and only times that exist', () => {
  const good: [string, string][] = [
    ['2026-11-07T15:00:00+00:00', '2026-11-07T15:00:00.000Z'],
    ['2026-11-07T15:00:00.5+00:00', '2026-11-07T15:00:00.500Z'],
    ['2026-11-07T15:00:00.123456+00:00', '2026-11-07T15:00:00.123Z'],
    ['2026-11-07T15:00:00Z', '2026-11-07T15:00:00.000Z'],
    ['2026-11-07T10:00:00-05:00', '2026-11-07T15:00:00.000Z'],
    ['2026-11-07T20:30:00+05:30', '2026-11-07T15:00:00.000Z'],
    ['2026-11-07T23:00:00-05:00', '2026-11-08T04:00:00.000Z'],
    ['2028-02-29T00:00:00+00:00', '2028-02-29T00:00:00.000Z'],
  ]
  for (const [text, iso] of good) assert.equal(fromDatabaseTime(text), iso, text)
  const bad: unknown[] = [
    '2026-11-07 15:00:00+00', '2026-11-07T15:00:00', '2026-11-07T15:00:00+0500', '2026-11-07T15:00:00+25:00',
    '2026-02-30T00:00:00+00:00', '2026-02-30T10:00:00-05:00', '2027-02-29T00:00:00+00:00', '2026-11-07T24:00:00+00:00',
    '2026-11-07T15:00:00.1234567+00:00', 'soon', '', 1_762_527_600_000, null,
  ]
  for (const value of bad) assert.equal(fromDatabaseTime(value), null, String(value))
})

test('team rows are checked, field by field', () => {
  const good = TEAM_ROWS[0]
  assert.ok(good !== undefined && isTeamRow(good))
  assert.equal(isTeamRow({ ...good, name: 'Bodø/Glimt'.padEnd(80, 'x') }), true, '80 characters')
  // Characters are counted the way the database counts them, so 80 of a
  // character JavaScript stores in two halves still fit.
  assert.equal(isTeamRow({ ...good, name: '𝕏'.repeat(80) }), true, '80 two-half characters')
  assert.equal(isTeamRow({ ...good, name: '𝕏'.repeat(81) }), false, '81 two-half characters')
  const bad: Record<string, unknown>[] = [
    { id: 0 }, { id: -1 }, { id: 1.5 }, { id: '9001' },
    { name: '' }, { name: ' Man City' }, { name: 'x'.repeat(81) }, { name: 'Man​City' }, { name: 'Man\u0007City' }, { name: 'Man City' },
    { short_name: 'x'.repeat(41) }, { short_name: null },
    { code: 'mci' }, { code: 'MC' }, { code: 'MCIX' }, { code: 'M1I' },
    { extra: 1 },
  ]
  for (const change of bad) assert.equal(isTeamRow({ ...good, ...change }), false, JSON.stringify(change))
  const { code: _code, ...missing } = good
  assert.equal(isTeamRow(missing), false)
})

test('fixture rows are checked, field by field, with the table checks too', () => {
  const good: FixtureRow[] = [
    fixtureRow(1), finished(2, 3, 1),
    fixtureRow(3, { competition: 'UCL', period: 'QF', tie_leg: 2, status: 'penalties', minute: 120, home_90: 1, away_90: 1,
      home_ht: 0, away_ht: 1, home_et: 0, away_et: 0, home_pens: 4, away_pens: 3 }),
  ]
  for (const row of good) assert.equal(isFixtureRow(row), true, String(row.id))
  const bad: Record<string, unknown>[] = [
    { id: 0 }, { id: 1.5 }, { competition: 'EPL' }, { season: 2019 }, { season: 2101 },
    { period: 'MW39' }, { period: 'mw11' }, { period: 'MD1' }, { competition: 'UCL' },
    { tie_leg: 0 }, { tie_leg: 3 },
    { kickoff: '2026-11-07 17:30:00+00' }, { kickoff: '2026-11-07T17:30:00' }, { kickoff: '2026-02-30T17:30:00+00:00' },
    { home_team_id: 9002 }, { away_team_id: 0 },
    { status: 'FINISHED' }, { status: 'void' }, { minute: 131 }, { minute: -1 }, { minute: 1.5 },
    { home_90: 31, away_90: 0 }, { home_90: -1, away_90: 0 }, { home_90: 1.5, away_90: 0 }, { home_90: '1', away_90: 0 },
    { home_90: 1 }, { away_ht: 0 }, { home_et: 1 }, { away_pens: 5 },
    { extra: 1 },
  ]
  for (const change of bad) assert.equal(isFixtureRow({ ...fixtureRow(1), ...change }), false, JSON.stringify(change))
  const { minute: _minute, ...missing } = fixtureRow(1)
  assert.equal(isFixtureRow(missing), false)
})

test('sync status rows are checked', () => {
  assert.equal(isSyncStatusRow({ last_attempt_at: null, last_success_at: null }), true)
  assert.equal(isSyncStatusRow({ last_attempt_at: '2026-11-07T17:31:02.123456+00:00', last_success_at: null }), true)
  for (const row of [
    { last_attempt_at: 'now', last_success_at: null }, { last_attempt_at: null }, { last_attempt_at: null, last_success_at: null, id: true },
  ]) assert.equal(isSyncStatusRow(row), false, JSON.stringify(row))
})
