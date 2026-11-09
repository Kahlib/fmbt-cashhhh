// Tests for src/lib/live.ts: the live windows, which week My parlays opens
// on, and the LiveData store that loads, refreshes, settles and saves while
// the tab is open. They run against the fake server, with made-up data.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AccountApi } from '../src/lib/account/api.ts'
import { addParlay, EMPTY_WEEK, TOMBSTONE, type NewParlay, type Week, type WeekRecord } from '../src/lib/bets/week-record.ts'
import { loadWeek, newWeek, saveWeek } from '../src/lib/bets/weeks.ts'
import type { Fixture, SyncStatus } from '../src/lib/fixtures.ts'
import {
  editable, inLiveWindow, LIVE_BEFORE, LIVE_FOR, LiveData, liveSpan, MINUTE, periodsOf, syncBehind, weekKey, weekToOpen,
} from '../src/lib/live.ts'
import { finished, fixtureRow, leg, parlay, quickAccount, tabOn, TEAM_ROWS, weekOf, type QuickAccount } from './bet-samples.ts'
import { FakeServer } from './fake-api.ts'

const KICKOFF = Date.parse('2026-11-07T17:30:00.000Z')
const MW11: Week = { season: 2026, competition: 'PL', period: 'MW11' }

// A fixture as the pages hold it, from game 900000 + n in bet-samples.
function fixture(n: number, change: Partial<Fixture> = {}): Fixture {
  return { ...fixtureRow(n), competition: 'PL', status: 'scheduled', tie_leg: null, kickoff: '2026-11-07T17:30:00.000Z', home: 'MCI', away: 'LIV', ...change } as Fixture
}

test("A match's live window: from 5 minutes before kick-off until it's final, or 3½ hours", () => {
  const scheduled = { kickoff: '2026-11-07T17:30:00.000Z', status: 'scheduled' }
  assert.equal(inLiveWindow(scheduled, KICKOFF - LIVE_BEFORE - 1), false)
  assert.equal(inLiveWindow(scheduled, KICKOFF - LIVE_BEFORE), true)
  assert.equal(inLiveWindow(scheduled, KICKOFF), true)
  assert.equal(inLiveWindow({ ...scheduled, status: 'live' }, KICKOFF + 95 * MINUTE), true)
  assert.equal(inLiveWindow({ ...scheduled, status: 'half_time' }, KICKOFF + 50 * MINUTE), true)
  assert.equal(inLiveWindow({ ...scheduled, status: 'live' }, KICKOFF + LIVE_FOR - 1), true)
  assert.equal(inLiveWindow({ ...scheduled, status: 'live' }, KICKOFF + LIVE_FOR), false)
  // A final score, or a match that didn't finish normally, closes it straight away.
  for (const status of ['finished', 'extra_time', 'penalties', 'postponed', 'suspended', 'cancelled', 'awarded']) {
    assert.equal(inLiveWindow({ ...scheduled, status }, KICKOFF + 30 * MINUTE), false, status)
  }
  assert.equal(LIVE_BEFORE, 5 * MINUTE)
  assert.equal(LIVE_FOR, 210 * MINUTE)
})

test('The span a refresh asks for holds every kick-off that can be in its live window', () => {
  const now = KICKOFF + 10 * MINUTE
  const span = liveSpan(now)
  assert.deepEqual(span, { from: new Date(now - LIVE_FOR).toISOString(), to: new Date(now + LIVE_BEFORE + 1).toISOString() })
  // The window's edges, as kick-offs: in the window means in the span.
  for (const kickoff of [now - LIVE_FOR + 1, now - 60 * MINUTE, now, now + LIVE_BEFORE]) {
    const at = new Date(kickoff).toISOString()
    assert.equal(inLiveWindow({ kickoff: at, status: 'live' }, now), at >= span.from && at < span.to, at)
    assert.ok(at >= span.from && at < span.to, at)
  }
  for (const kickoff of [now - LIVE_FOR - 1, now + LIVE_BEFORE + 1]) {
    const at = new Date(kickoff).toISOString()
    assert.equal(inLiveWindow({ kickoff: at, status: 'live' }, now), false, at)
  }
})

test('Scores may be behind when a match is on and the sync has not worked for 5 minutes', () => {
  const now = KICKOFF + 30 * MINUTE
  const on = [fixture(1, { status: 'live' })]
  const synced = (ago: number): SyncStatus => ({ lastAttemptAt: null, lastSuccessAt: new Date(now - ago).toISOString() })
  assert.equal(syncBehind(synced(4 * MINUTE), on, now), false)
  assert.equal(syncBehind(synced(5 * MINUTE), on, now), false)
  assert.equal(syncBehind(synced(5 * MINUTE + 1), on, now), true)
  assert.equal(syncBehind({ lastAttemptAt: null, lastSuccessAt: null }, on, now), true)
  assert.equal(syncBehind(null, on, now), true)
  // With nothing on, an old sync doesn't matter.
  assert.equal(syncBehind(synced(60 * MINUTE), [fixture(1, { status: 'finished' }), fixture(2, { kickoff: '2026-11-08T17:30:00.000Z' })], now), false)
  assert.equal(syncBehind(null, [], now), false)
})

test('Which week My parlays opens on: the one being played, else the next, else the last', () => {
  const games = [
    fixture(1, { period: 'MW10', kickoff: '2026-10-31T15:00:00.000Z', status: 'finished' }),
    fixture(2, { period: 'MW11', kickoff: '2026-11-07T17:30:00.000Z', status: 'live' }),
    fixture(3, { period: 'MW2', kickoff: '2026-08-22T14:00:00.000Z', status: 'finished' }),
    fixture(4, { period: 'MW12', kickoff: '2026-11-21T15:00:00.000Z' }),
    fixture(5, { competition: 'UCL', period: 'MD4', kickoff: '2026-11-04T20:00:00.000Z', status: 'finished' }),
    fixture(6, { competition: 'UCL', period: 'MD5', kickoff: '2026-11-25T20:00:00.000Z' }),
  ]
  assert.deepEqual(periodsOf(games, 'PL'), ['MW2', 'MW10', 'MW11', 'MW12'])
  assert.deepEqual(periodsOf(games, 'UCL'), ['MD4', 'MD5'])
  assert.equal(weekToOpen(games, 'PL', KICKOFF + 30 * MINUTE), 'MW11')
  assert.equal(weekToOpen(games, 'PL', KICKOFF + LIVE_FOR), 'MW12')
  assert.equal(weekToOpen(games, 'UCL', KICKOFF), 'MD5')
  // A postponed match isn't the next one to kick off.
  const postponed = games.map(each => (each.id === 900_004 ? { ...each, status: 'postponed' as const } : each))
  assert.equal(weekToOpen(postponed, 'PL', KICKOFF + LIVE_FOR), 'MW12') // the last week
  const later = [...postponed, fixture(7, { period: 'MW13', kickoff: '2026-11-28T15:00:00.000Z' })]
  assert.equal(weekToOpen(later, 'PL', KICKOFF + LIVE_FOR), 'MW13')
  assert.equal(weekToOpen(games, 'PL', Date.parse('2027-06-01T00:00:00.000Z')), 'MW12')
  assert.equal(weekToOpen([], 'PL', KICKOFF), null)
  assert.equal(weekKey(MW11), '2026 PL MW11')
  assert.equal(editable({ week: MW11, record: TOMBSTONE, version: 3, newestVersion: 3 }), EMPTY_WEEK)
  const kept = weekOf(parlay(1, [leg(1)]))
  assert.equal(editable({ week: MW11, record: kept, version: 1, newestVersion: 1 }), kept)
})

// ---------------------------------------------------------------------------
// The store, against the fake server
// ---------------------------------------------------------------------------

type Setup = { server: FakeServer; account: QuickAccount; tab: AccountApi; calls: string[]; spans: [string, string][]; clock: { now: number }; live: LiveData }

// Matchweek 11: game 1 finished 3–1 at 15:00, game 2 kicking off at 17:30,
// and matchweek 12's game 3 a fortnight later. The clock starts 10 minutes
// after game 2 kicks off.
async function start(): Promise<Setup> {
  const server = new FakeServer()
  server.state.football.teams = structuredClone(TEAM_ROWS)
  server.state.football.fixtures = [
    finished(1, 3, 1, { kickoff: '2026-11-07T15:00:00+00:00' }),
    fixtureRow(2, { status: 'live', minute: 10, home_90: 0, away_90: 0 }),
    fixtureRow(3, { period: 'MW12', kickoff: '2026-11-21T15:00:00+00:00' }),
  ]
  const clock = { now: KICKOFF + 10 * MINUTE }
  server.state.football.syncStatus = { last_attempt_at: new Date(clock.now).toISOString(), last_success_at: new Date(clock.now).toISOString() }
  const account = await quickAccount(server)
  const tab = await tabOn(server, account)
  // Every call the store makes, by name, and every span it asks for.
  const calls: string[] = []
  const spans: [string, string][] = []
  const watched = new Proxy(tab, {
    get(target, name, receiver) {
      const value: unknown = Reflect.get(target, name, receiver)
      if (typeof value !== 'function') return value
      return (...args: unknown[]) => {
        calls.push(String(name))
        if (name === 'fixturesBetween') spans.push([String(args[0]), String(args[1])])
        return (value as (...a: unknown[]) => unknown).apply(target, args)
      }
    },
  })
  const live = new LiveData(watched, account.dataKey, 2026, () => clock.now)
  return { server, account, tab, calls, spans, clock, live }
}

const entry = (legs: [number, 'H' | 'D' | 'A', number][], stakeCents = 2500): NewParlay =>
  ({ stakeCents, boostBps: 0, legs: legs.map(([n, pick, odds]) => ({ fixtureId: 900_000 + n, pick, odds, confidence: 3 })) })

function withParlay(s: Setup, record: WeekRecord, legs: [number, 'H' | 'D' | 'A', number][]): WeekRecord {
  const result = addParlay(record, MW11, [...s.live.snapshot().fixtures.values()], entry(legs))
  assert.ok(result.ok)
  return result.record
}

const versions = (s: Setup) => s.server.rowsOf(s.account.id, 'week_versions').length

test('Loading settles every leg it can, and saving a parlay settles it straight away', async () => {
  const s = await start()
  assert.equal(s.live.snapshot().phase, 'loading')
  await s.live.loadAll()
  const loaded = s.live.snapshot()
  assert.equal(loaded.phase, 'ready')
  assert.equal(loaded.stale, false)
  assert.equal(loaded.fixtures.size, 3)
  assert.equal(loaded.teams.get(9001)?.code, 'MCI')
  assert.equal(loaded.loadedAt, s.clock.now)
  assert.equal(loaded.now, s.clock.now)
  assert.deepEqual(loaded.sync, { lastAttemptAt: new Date(s.clock.now).toISOString(), lastSuccessAt: new Date(s.clock.now).toISOString() })
  assert.deepEqual(s.live.week(MW11), newWeek(MW11))

  // A parlay on game 1, which has finished, and game 2, which is on.
  const record = withParlay(s, EMPTY_WEEK, [[1, 'H', -150], [2, 'H', 120]])
  assert.equal(await s.live.save(MW11, record), 'saved')
  const week = s.live.week(MW11)
  assert.equal(week.version, 2) // the parlay, then the leg that settled
  assert.equal(versions(s), 2)
  assert.equal(week.record.parlays[0].legs[0].settlement?.outcome, 'won')
  assert.equal(week.record.parlays[0].legs[1].settlement, null)
  // Saving the same again changes nothing, and saves nothing.
  assert.equal(await s.live.save(MW11, week.record), 'unchanged')
  assert.equal(versions(s), 2)
})

test('A refresh asks only for the matches in their live window, and settles what finished', async () => {
  const s = await start()
  await s.live.loadAll()
  await s.live.save(MW11, withParlay(s, EMPTY_WEEK, [[1, 'H', -150], [2, 'H', 120]]))

  // Game 2 finishes 2–0, the sync works again, and the far-off game 3 is postponed.
  s.server.state.football.syncStatus = { last_attempt_at: '2026-11-07T19:19:30.000Z', last_success_at: '2026-11-07T19:19:30.000Z' }
  const rows = s.server.state.football.fixtures
  rows[1] = { ...rows[1], status: 'finished', minute: null, home_90: 2, away_90: 0, home_ht: 1, away_ht: 0 }
  rows[2] = { ...rows[2], status: 'postponed' }
  s.clock.now += 100 * MINUTE
  s.calls.length = 0
  await s.live.refresh()
  // Then the one save, for the leg that settled. No weeks are read again.
  assert.deepEqual(s.calls, ['fixturesBetween', 'syncStatus', 'addRecord'])
  assert.deepEqual(s.spans, [[liveSpan(s.clock.now).from, liveSpan(s.clock.now).to]])
  const snapshot = s.live.snapshot()
  assert.equal(snapshot.fixtures.get(900_002)?.status, 'finished')
  assert.equal(snapshot.fixtures.get(900_003)?.status, 'scheduled') // outside the span, so not asked for
  assert.equal(s.live.week(MW11).record.parlays[0].legs[1].settlement?.outcome, 'won')
  assert.equal(snapshot.stale, false)
  assert.equal(snapshot.sync?.lastSuccessAt, s.server.state.football.syncStatus.last_success_at)

  // The hourly reload picks up the rest.
  await s.live.loadAll()
  assert.equal(s.live.snapshot().fixtures.get(900_003)?.status, 'postponed')
})

test("A first load that fails shows that, a failed refresh keeps what's shown, and refresh waits for a load", async () => {
  const s = await start()
  await s.live.refresh()
  assert.deepEqual(s.calls, []) // nothing to refresh before the first load
  s.server.breakCall(1, 'refused')
  await s.live.loadAll()
  assert.equal(s.live.snapshot().phase, 'failed')
  assert.equal(s.live.snapshot().stale, true)
  await s.live.loadAll()
  assert.equal(s.live.snapshot().phase, 'ready')
  assert.equal(s.live.snapshot().stale, false)

  const before = s.live.snapshot().fixtures
  s.server.breakCall(1, 'lost')
  await s.live.refresh()
  assert.equal(s.live.snapshot().phase, 'ready')
  assert.equal(s.live.snapshot().stale, true)
  assert.equal(s.live.snapshot().fixtures, before)
  // A later load that works clears it.
  await s.live.loadAll()
  assert.equal(s.live.snapshot().stale, false)
})

test('Another tab saving first means "taken", and this tab reloads the week', async () => {
  const s = await start()
  await s.live.loadAll()
  await s.live.save(MW11, withParlay(s, EMPTY_WEEK, [[2, 'D', 210]]))

  const other = new LiveData(await tabOn(s.server, s.account), s.account.dataKey, 2026, () => s.clock.now)
  await other.loadAll()
  const theirs = withParlay(s, other.week(MW11).record, [[2, 'A', 300]])
  assert.equal(await other.save(MW11, theirs), 'saved')

  // This tab still has the older version, so its save is turned down.
  const ours = withParlay(s, s.live.week(MW11).record, [[2, 'H', 150]])
  assert.equal(await s.live.save(MW11, ours), 'taken')
  assert.equal(s.live.week(MW11).version, other.week(MW11).version)
  assert.deepEqual(s.live.week(MW11).record, other.week(MW11).record)
})

test('Saves one after another, so two at once both save, in order', async () => {
  const s = await start()
  await s.live.loadAll()
  const first = withParlay(s, EMPTY_WEEK, [[2, 'H', 150]])
  const second = withParlay(s, first, [[2, 'A', 300]])
  const both = await Promise.all([s.live.save(MW11, first), s.live.save(MW11, second), s.live.refresh()])
  assert.deepEqual(both.slice(0, 2), ['saved', 'saved'])
  assert.equal(s.live.week(MW11).version, 2)
  assert.deepEqual(s.live.week(MW11).record, second)
})

test("Only this season's weeks are settled, and other seasons are kept as they are", async () => {
  const s = await start()
  // A week from last season, with a leg on a game this season's fixtures don't have.
  const lastSeason: Week = { season: 2025, competition: 'PL', period: 'MW11' }
  const old = weekOf(parlay(1, [leg(99)]))
  const saved = await saveWeek(s.tab, s.account.dataKey, newWeek(lastSeason), old, '2025-11-08T12:00:00.000Z')
  assert.equal(saved.result, 'saved')
  await s.live.loadAll()
  const snapshot = s.live.snapshot()
  assert.deepEqual(snapshot.waiting, [])
  assert.deepEqual(snapshot.weeks.find(each => each.week.season === 2025)?.record, old)
  assert.equal((await loadWeek(s.tab, s.account.dataKey, lastSeason)).week.version, 1)
})

test('Listeners hear every change until they stop listening, and tick moves the time on', async () => {
  const s = await start()
  let heard = 0
  const stop = s.live.subscribe(() => {
    heard++
  })
  await s.live.loadAll()
  assert.ok(heard >= 1)
  const after = heard
  s.clock.now += MINUTE
  s.live.tick()
  assert.equal(heard, after + 1)
  assert.equal(s.live.snapshot().now, s.clock.now)
  stop()
  s.live.tick()
  assert.equal(heard, after + 1)
})
