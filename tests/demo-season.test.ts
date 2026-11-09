// Tests for src/lib/records/demo-season.ts, the development-only demo
// season that replaced the junk week in step 10. The fixtures here are made
// up; on dev the demo season uses dev's own finished matches.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isAmericanOdds } from '../src/lib/bets/odds.ts'
import { isWeekRecord, type Week, type WeekRecord } from '../src/lib/bets/week-record.ts'
import { loadWeeks, newWeek, saveWeek } from '../src/lib/bets/weeks.ts'
import type { Fixture } from '../src/lib/fixtures.ts'
import { chances, demoWeek, fillDemoSeason, oddsFor, seeded } from '../src/lib/records/demo-season.ts'
import { finished, fixtureRow, leg, parlay, quickAccount, tabOn, TEAM_ROWS, weekOf } from './bet-samples.ts'
import { FakeServer } from './fake-api.ts'

const NOW = new Date('2026-11-22T15:20:00.000Z')

test('The made-up numbers: seeded, so the same every time, and priced like a book', () => {
  const a = seeded(18436)
  const b = seeded(18436)
  const first = Array.from({ length: 1000 }, a)
  assert.deepEqual(first, Array.from({ length: 1000 }, b))
  assert.ok(first.every(n => n >= 0 && n < 1))
  assert.notDeepEqual(first.slice(0, 10), Array.from({ length: 10 }, seeded(18437)))

  for (const [home, away] of [['ARS', 'HUL'], ['HUL', 'ARS'], ['MCI', 'LIV'], ['XXX', 'YYY'], ['constructor', 'toString']]) {
    const c = chances(home, away)
    assert.ok(Math.abs(c.H + c.D + c.A - 1) < 1e-12, `${home} v ${away}`)
    assert.ok(c.D >= 0.2 && c.D <= 0.31, `${home} v ${away}`)
  }
  // Even clubs: home advantage. Clubs it doesn't know count as even.
  assert.ok(chances('XXX', 'YYY').H > chances('XXX', 'YYY').A)
  assert.deepEqual(chances('XXX', 'YYY'), chances('constructor', 'toString'))
  assert.ok(chances('ARS', 'HUL').H > chances('HUL', 'ARS').H)

  let last = Infinity
  for (let chance = 0.05; chance <= 0.95; chance += 0.01) {
    const odds = oddsFor(chance)
    assert.ok(isAmericanOdds(odds) && Math.abs(odds) <= 5000, `${chance}: ${odds}`)
    // A book's price always pays a little less than the chance is worth.
    const implied = odds > 0 ? 100 / (odds + 100) : -odds / (-odds + 100)
    assert.ok(implied > chance, `${chance}: ${odds}`)
    // A likelier result never pays more.
    const payout = odds > 0 ? odds : 10_000 / -odds
    assert.ok(payout <= last, `${chance}: ${odds}`)
    last = payout
  }
  assert.equal(oddsFor(0.99), -5000)
  assert.equal(oddsFor(0.001), 5000)
})

// Game n, as the pages hold it: a finished match between two clubs.
function game(n: number, home: string, away: string, period = 'MW1', competition: 'PL' | 'UCL' = 'PL'): Fixture {
  return {
    id: n, competition, season: 2026, period, tie_leg: null, kickoff: `2026-08-${String(10 + (n % 15)).padStart(2, '0')}T14:00:00.000Z`,
    home_team_id: 1, away_team_id: 2, home, away, status: 'finished', minute: null,
    home_90: n % 3, away_90: n % 2, home_ht: 0, away_ht: 0, home_et: null, away_et: null, home_pens: null, away_pens: null,
  }
}

// What a demo week holds, leaving out the IDs, which are random.
const shape = (record: WeekRecord) => record.parlays.map(each => ({
  stake: each.stakeCents, boost: each.boostBps,
  legs: each.legs.map(one => [one.fixtureId, one.pick, one.odds, one.confidence, one.settlement?.outcome, one.settlement?.promo]),
}))

test('A demo week: 2 to 4 parlays of 1 to 4 legs, every leg settled, and every check passed', () => {
  const week: Week = { season: 2026, competition: 'PL', period: 'MW1' }
  const games = [game(1, 'ARS', 'HUL'), game(2, 'MCI', 'LIV'), game(3, 'CHE', 'NEW'), game(4, 'IPS', 'COV'), game(5, 'EVE', 'LEE')]
  const random = seeded(7)
  const counts = new Set<number>()
  let promos = 0
  for (let n = 0; n < 200; n++) {
    const record = demoWeek(games, week, random, NOW.toISOString())
    assert.ok(isWeekRecord(record))
    assert.ok(record.parlays.length >= 2 && record.parlays.length <= 4)
    counts.add(record.parlays.length)
    for (const each of record.parlays) {
      assert.ok(each.legs.length >= 1 && each.legs.length <= 4)
      assert.equal(new Set(each.legs.map(one => one.fixtureId)).size, each.legs.length)
      assert.ok([1000, 2000, 2500, 5000].includes(each.stakeCents))
      assert.ok([0, 250, 500].includes(each.boostBps))
      for (const one of each.legs) {
        assert.ok(one.settlement !== null)
        assert.ok(Math.abs(one.odds) <= 5000)
        if (one.settlement.promo) {
          assert.equal(one.settlement.outcome, 'won')
          assert.equal(one.settlement.byScore, 'lost')
          promos++
        }
      }
    }
  }
  assert.deepEqual([...counts].sort(), [2, 3, 4])
  assert.ok(promos > 0, 'a promo now and then')
  // The same seed gives the same week.
  assert.deepEqual(shape(demoWeek(games, week, seeded(99), NOW.toISOString())), shape(demoWeek(games, week, seeded(99), NOW.toISOString())))
  // A week of one game still works: every parlay is a single on it.
  const single = demoWeek([games[0]], week, seeded(5), NOW.toISOString())
  assert.ok(single.parlays.every(each => each.legs.length === 1 && each.legs[0].fixtureId === 1))
})

// Matchweek 1 and Champions League matchday 1 have finished. Matchweek 2
// still has a game to play. Matchweek 3 has finished, but already has a parlay.
async function start() {
  const server = new FakeServer()
  server.state.football.teams = structuredClone(TEAM_ROWS)
  const at = (day: number) => `2026-08-${String(day).padStart(2, '0')}T14:00:00+00:00`
  server.state.football.fixtures = [
    finished(1, 2, 0, { period: 'MW1', kickoff: at(15) }), finished(2, 1, 1, { period: 'MW1', kickoff: at(16), home_team_id: 9003, away_team_id: 9004 }),
    finished(3, 0, 3, { period: 'MW1', kickoff: at(16), home_team_id: 9005, away_team_id: 9006 }),
    finished(4, 1, 0, { period: 'MW2', kickoff: at(22) }), fixtureRow(5, { period: 'MW2', kickoff: '2026-11-29T15:00:00+00:00' }),
    finished(6, 2, 2, { period: 'MW3', kickoff: at(29) }),
    finished(7, 3, 2, { competition: 'UCL', period: 'MD1', kickoff: '2026-09-16T19:00:00+00:00', home_team_id: 9003, away_team_id: 9002 }),
    finished(8, 0, 1, { competition: 'UCL', period: 'MD1', kickoff: '2026-09-17T19:00:00+00:00', home_team_id: 9005, away_team_id: 9001 }),
  ]
  const account = await quickAccount(server)
  const tab = await tabOn(server, account)
  const mw3: Week = { season: 2026, competition: 'PL', period: 'MW3' }
  const mine = weekOf(parlay(1, [leg(6)]))
  assert.equal((await saveWeek(tab, account.dataKey, newWeek(mw3), mine, '2026-08-29T13:00:00.000Z')).result, 'saved')
  return { server, account, tab, mine }
}

test('Filling dev: only finished weeks with no parlays, and a second go adds nothing', async () => {
  const { server, account, tab, mine } = await start()
  const result = await fillDemoSeason(tab, account.dataKey, NOW)
  const { weeks } = await loadWeeks(tab, account.dataKey)
  const byName = new Map(weeks.map(each => [`${each.week.competition} ${each.week.period}`, each]))
  assert.deepEqual([...byName.keys()].sort(), ['PL MW1', 'PL MW3', 'UCL MD1'])
  assert.deepEqual(byName.get('PL MW3')?.record, mine) // left alone
  const filled = [byName.get('PL MW1'), byName.get('UCL MD1')]
  assert.deepEqual(result, { weeks: 2, parlays: filled.reduce((sum, each) => sum + (each?.record.parlays.length ?? 0), 0) })
  for (const each of filled) {
    assert.ok(each !== undefined && each.version === 1 && isWeekRecord(each.record))
    assert.ok(each.record.parlays.flatMap(one => one.legs).every(one => one.settlement !== null))
  }
  // Only matchweek 1's games in matchweek 1, and so on.
  assert.ok(byName.get('PL MW1')?.record.parlays.flatMap(one => one.legs).every(one => [900_001, 900_002, 900_003].includes(one.fixtureId)))
  assert.ok(byName.get('UCL MD1')?.record.parlays.flatMap(one => one.legs).every(one => [900_007, 900_008].includes(one.fixtureId)))

  const rows = server.rowsOf(account.id, 'week_versions').length
  assert.deepEqual(await fillDemoSeason(tab, account.dataKey, NOW), { weeks: 0, parlays: 0 })
  assert.equal(server.rowsOf(account.id, 'week_versions').length, rows)
})

test('The same fixtures give the same demo season on every account', async () => {
  const one = await start()
  const two = await start()
  // The second server sends its fixtures in the opposite order.
  two.server.state.football.fixtures.reverse()
  await fillDemoSeason(one.tab, one.account.dataKey, NOW)
  await fillDemoSeason(two.tab, two.account.dataKey, NOW)
  const shapes = async (s: Awaited<ReturnType<typeof start>>) =>
    (await loadWeeks(s.tab, s.account.dataKey)).weeks.map(each => [each.week, shape(each.record)])
  assert.deepEqual(await shapes(one), await shapes(two))
})
