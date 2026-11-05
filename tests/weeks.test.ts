// Tests for src/lib/bets/weeks.ts: loading, saving and deleting weeks, locked
// weeks and their audit entries, settling that retries, and every server call
// breaking in each save. They run against the fake server, with made-up data.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isDeepStrictEqual } from 'node:util'
import { ServerError, type AccountApi, type FixtureRow } from '../src/lib/account/api.ts'
import { chainHash, isAuditRecord, loadAuditLog, type AuditRecord } from '../src/lib/bets/audit.ts'
import { isLocked, settleByHand } from '../src/lib/bets/settle.ts'
import { addParlay, EMPTY_WEEK, isWeekRecord, TOMBSTONE, type NewParlay, type Week, type WeekRecord } from '../src/lib/bets/week-record.ts'
import {
  CORRECTION_REASON, deleteWeek, loadWeek, loadWeeks, needsAudit, newWeek, NOTED_REASON, saveCorrection, saveWeek,
  settleWeeks, visibleWeeks, type LoadedWeek, type SaveWeekResult,
} from '../src/lib/bets/weeks.ts'
import { decryptRecord, encryptRecord, RECORD_VERSION } from '../src/lib/crypto/records.ts'
import { byId, loadFixtures } from '../src/lib/fixtures.ts'
import { everyFault } from './accounts.ts'
import { finished, fixtureRow, leg, parlay, quickAccount, tabOn, TEAM_ROWS, weekOf, type QuickAccount } from './bet-samples.ts'
import { FakeServer } from './fake-api.ts'

const MW11: Week = { season: 2026, competition: 'PL', period: 'MW11' }
const MW12: Week = { season: 2026, competition: 'PL', period: 'MW12' }
const NOW = '2026-11-07T19:35:00.000Z'
const LATER = '2026-11-08T09:00:00.000Z'

// Matchweek 11's three games and matchweek 12's two, none played yet.
const ARS_CHE = { home_team_id: 9003, away_team_id: 9004 }
const TOT_NEW = { home_team_id: 9005, away_team_id: 9006 }
const LIV_ARS_12 = { period: 'MW12', home_team_id: 9002, away_team_id: 9003, kickoff: '2026-11-21T15:00:00+00:00' }
const TOT_NEW_12 = { period: 'MW12', ...TOT_NEW, kickoff: '2026-11-21T17:30:00+00:00' }
const GAMES: FixtureRow[] = [
  fixtureRow(1), fixtureRow(2, ARS_CHE), fixtureRow(3, TOT_NEW), fixtureRow(101, LIV_ARS_12), fixtureRow(102, TOT_NEW_12),
]

type Setup = { server: FakeServer; account: QuickAccount; tab: AccountApi; key: CryptoKey }

async function start(): Promise<Setup> {
  const server = new FakeServer()
  server.state.football.teams = structuredClone(TEAM_ROWS)
  server.state.football.fixtures = structuredClone(GAMES)
  const account = await quickAccount(server)
  return { server, account, tab: await tabOn(server, account), key: account.dataKey }
}

// A game's new state in the fixtures table.
function play(server: FakeServer, row: FixtureRow): void {
  server.state.football.fixtures = server.state.football.fixtures.map(each => (each.id === row.id ? row : each))
}

async function fixturesOf(api: AccountApi) {
  return byId((await loadFixtures(api, 2026)).fixtures)
}

// $25 on a home win at +150 in each of these games.
const bet = (...fixtureIds: number[]): NewParlay => ({ stakeCents: 2500, legs: fixtureIds.map(fixtureId => ({ fixtureId, pick: 'H', odds: 150, confidence: 3 })) })

// The week with one more parlay, built the way the pages build it.
async function withParlay(api: AccountApi, loaded: LoadedWeek, entry: NewParlay): Promise<WeekRecord> {
  const { fixtures } = await loadFixtures(api, loaded.week.season)
  const result = addParlay(loaded.record, loaded.week, fixtures, entry)
  if (!result.ok) throw new Error(`It should have been added, but the problem was "${result.problem}".`)
  return result.record
}

// The week a save saved, or a clear failure.
function saved(result: SaveWeekResult): LoadedWeek {
  if (result.result !== 'saved') throw new Error(`It should have saved, but the result was "${result.result}".`)
  return result.week
}

// A week with one parlay on these games, saved once.
async function savedWeek({ tab, key }: Setup, week: Week, ...fixtureIds: number[]): Promise<LoadedWeek> {
  return saved(await saveWeek(tab, key, newWeek(week), await withParlay(tab, newWeek(week), bet(...fixtureIds)), NOW))
}

// A week with one parlay on one game, which ends 2-1, so the leg wins and
// the week locks. Saved as versions 1 and 2. Matchweek 11's game is Man City
// against Liverpool, and matchweek 12's is Liverpool against Arsenal.
async function lockedWeek(setup: Setup, week: Week = MW11): Promise<LoadedWeek> {
  const game = week === MW11 ? 1 : 101
  const first = await savedWeek(setup, week, 900_000 + game)
  play(setup.server, finished(game, 2, 1, week === MW11 ? {} : LIV_ARS_12))
  const [settled] = await settleWeeks(setup.tab, setup.key, [first], await fixturesOf(setup.tab), NOW)
  assert.ok(settled !== undefined && isLocked(settled.week.record))
  return settled.week
}

// The week with the first leg's odds changed: an edit.
function withOdds(record: WeekRecord, odds: number): WeekRecord {
  const [first, ...rest] = record.parlays
  if (first === undefined) throw new Error('The week has no parlay.')
  return { ...record, parlays: [{ ...first, legs: first.legs.map((each, i) => (i === 0 ? { ...each, odds } : each)) }, ...rest] }
}

// The account's audit entries, opened, in order.
async function auditRecords(server: FakeServer, account: QuickAccount): Promise<AuditRecord[]> {
  const rows = server.rowsOf(account.id, 'audit_entries').sort((a, b) => a.seq - b.seq)
  const records: AuditRecord[] = []
  for (const row of rows) {
    const value = await decryptRecord('audit_entries', row, account.dataKey)
    assert.ok(isAuditRecord(value), 'every audit entry checks out')
    records.push(value)
  }
  return records
}

const nameOf = (week: { season: number; competition: string; period: string }) => `${week.season} ${week.competition} ${week.period}`

// Checks everything the server holds for the account: every version opens
// and checks out, each week's versions count 1, 2, 3 with no gaps, every
// change to a locked week other than adding parlays has the one audit entry
// that says so, no audit entry lacks its version, and the log has no problems.
async function checkHistory(server: FakeServer, account: QuickAccount): Promise<void> {
  const weeks = new Map<string, { version: number; record: WeekRecord }[]>()
  for (const row of server.rowsOf(account.id, 'week_versions')) {
    const record = await decryptRecord('week_versions', row, account.dataKey)
    assert.ok(isWeekRecord(record), 'every version checks out')
    weeks.set(nameOf(row), [...(weeks.get(nameOf(row)) ?? []), { version: row.version_no, record }])
  }
  const audits = await auditRecords(server, account)
  for (const [name, versions] of weeks) {
    versions.sort((a, b) => a.version - b.version)
    versions.forEach((each, i) => assert.equal(each.version, i + 1, `${name}'s versions count up with no gaps`))
    for (let i = 1; i < versions.length; i++) {
      const was = versions[i - 1]
      const now = versions[i]
      if (was === undefined || now === undefined) continue
      const entries = audits.filter(audit => nameOf(audit.week) === name && audit.toVersion === now.version)
      assert.equal(entries.length, needsAudit(was.record, now.record) ? 1 : 0, `${name} version ${now.version}'s audit entries`)
    }
  }
  for (const audit of audits) {
    assert.ok(weeks.get(nameOf(audit.week))?.some(each => each.version === audit.toVersion), 'no audit entry without its version')
  }
  assert.deepEqual((await loadAuditLog(await tabOn(server, account), account.dataKey)).problems, [])
}

// An AccountApi with one call replaced.
function withCall<K extends keyof AccountApi>(api: AccountApi, name: K, replacement: AccountApi[K]): AccountApi {
  return new Proxy(api, { get: (target, prop, receiver) => (prop === name ? replacement : Reflect.get(target, prop, receiver)) })
}

// ---------------------------------------------------------------------------
// Loading and saving
// ---------------------------------------------------------------------------

test('a new account has no weeks', async () => {
  const { tab, key } = await start()
  assert.deepEqual(await loadWeeks(tab, key), { weeks: [], warnings: [] })
})

test('a saved week loads in another tab, as version 1', async () => {
  const setup = await start()
  const week = await savedWeek(setup, MW11, 900_001, 900_002)
  const loaded = await loadWeeks(await tabOn(setup.server, setup.account), setup.key)
  assert.deepEqual(loaded, { weeks: [{ week: MW11, record: week.record, version: 1, newestVersion: 1 }], warnings: [] })
  assert.equal(loaded.weeks[0]?.record.parlays[0]?.legs.length, 2)
})

test('every save is a new version, and every version is kept', async () => {
  const setup = await start()
  let week = await savedWeek(setup, MW11, 900_001)
  week = saved(await saveWeek(setup.tab, setup.key, week, await withParlay(setup.tab, week, bet(900_002)), NOW))
  week = saved(await saveWeek(setup.tab, setup.key, week, await withParlay(setup.tab, week, bet(900_003)), NOW))
  assert.deepEqual([week.version, week.newestVersion], [3, 3])
  assert.deepEqual(setup.server.rowsOf(setup.account.id, 'week_versions').map(row => row.version_no).sort(), [1, 2, 3])
  assert.deepEqual((await loadWeeks(setup.tab, setup.key)).weeks, [week])
  await checkHistory(setup.server, setup.account)
})

test('saving the same record again saves nothing', async () => {
  const setup = await start()
  const week = await savedWeek(setup, MW11, 900_001)
  const calls = setup.server.calls
  assert.deepEqual(await saveWeek(setup.tab, setup.key, week, structuredClone(week.record), NOW), { result: 'unchanged', week })
  assert.equal(setup.server.calls, calls, 'no server call at all')
})

test('a record that fails the checks is never saved', async () => {
  const setup = await start()
  const week = await savedWeek(setup, MW11, 900_001)
  const junk = { ...week.record, parlays: [...week.record.parlays, ...week.record.parlays] } // the same parlay twice
  await assert.rejects(saveWeek(setup.tab, setup.key, week, junk, NOW), RangeError)
  await assert.rejects(saveWeek(setup.tab, setup.key, week, EMPTY_WEEK, 'today'), RangeError)
  assert.equal(setup.server.rowsOf(setup.account.id, 'week_versions').length, 1)
})

test("two tabs: the second save finds its number taken, and saves nothing", async () => {
  const setup = await start()
  const week = await savedWeek(setup, MW11, 900_001)
  const other = await tabOn(setup.server, setup.account)
  const theirs = saved(await saveWeek(other, setup.key, week, await withParlay(other, week, bet(900_002)), NOW))
  assert.deepEqual(await saveWeek(setup.tab, setup.key, week, await withParlay(setup.tab, week, bet(900_003)), NOW), { result: 'taken' })
  assert.equal(setup.server.rowsOf(setup.account.id, 'week_versions').length, 2)
  // Reloading shows the other tab's save, and the next save goes after it.
  const reloaded = await loadWeek(setup.tab, setup.key, MW11)
  assert.deepEqual(reloaded, { week: theirs, warning: null })
  assert.equal(saved(await saveWeek(setup.tab, setup.key, reloaded.week, await withParlay(setup.tab, reloaded.week, bet(900_003)), NOW)).version, 3)
})

// Adds a version of matchweek 11 that a tab didn't save: `record`, encrypted
// with `key`, or this row as it is.
async function sneakIn(setup: Setup, version: number, record: unknown, key: CryptoKey = setup.key, week: Week = MW11): Promise<void> {
  const plain = { id: crypto.randomUUID(), ...week, version_no: version, v: RECORD_VERSION }
  setup.server.insiderAdd('week_versions', setup.account.id, { ...plain, ...(await encryptRecord('week_versions', plain, record, key)) })
}

test("a newer version that doesn't open is skipped, with a warning, and the next save numbers past it", async () => {
  const setup = await start()
  const week = await savedWeek(setup, MW11, 900_001)
  const strangerKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  await sneakIn(setup, 2, week.record, strangerKey)
  const loaded = await loadWeeks(setup.tab, setup.key)
  assert.deepEqual(loaded.weeks, [{ ...week, newestVersion: 2 }])
  assert.deepEqual(loaded.warnings, [{ week: MW11, unreadable: 1 }])
  const next = loaded.weeks[0]
  assert.ok(next !== undefined)
  assert.equal(saved(await saveWeek(setup.tab, setup.key, next, await withParlay(setup.tab, next, bet(900_002)), NOW)).version, 3)
})

test("a version that opens but isn't a week record is skipped too", async () => {
  const setup = await start()
  const week = await savedWeek(setup, MW11, 900_001)
  await sneakIn(setup, 2, { note: 'not a week' })
  await sneakIn(setup, 3, { ...week.record, schema: 2 })
  const loaded = await loadWeeks(setup.tab, setup.key)
  assert.deepEqual(loaded.weeks, [{ ...week, newestVersion: 3 }])
  assert.deepEqual(loaded.warnings, [{ week: MW11, unreadable: 2 }])
})

test("a version moved to another week doesn't open there", async () => {
  const setup = await start()
  await savedWeek(setup, MW11, 900_001)
  const row = setup.server.rowsOf(setup.account.id, 'week_versions')[0]
  assert.ok(row !== undefined)
  const { created_at: _saved, ...moved } = { ...row, id: crypto.randomUUID(), period: 'MW12' }
  setup.server.insiderAdd('week_versions', setup.account.id, moved)
  const loaded = await loadWeeks(setup.tab, setup.key)
  // Matchweek 12 has no version that opens: it's empty, hidden and warned about.
  assert.deepEqual(loaded.weeks.map(each => [each.week.period, each.version, each.newestVersion]), [['MW11', 1, 1], ['MW12', 0, 1]])
  assert.deepEqual(loaded.weeks[1]?.record, EMPTY_WEEK)
  assert.deepEqual(loaded.warnings, [{ week: MW12, unreadable: 1 }])
  assert.deepEqual(visibleWeeks(loaded.weeks).map(each => each.week.period), ['MW11'])
})

test('a week the view gives twice means the server is wrong', async () => {
  const setup = await start()
  await savedWeek(setup, MW11, 900_001)
  const twice = withCall(setup.tab, 'latestWeekVersions', async () => {
    const rows = await setup.tab.latestWeekVersions()
    return [...rows, ...rows]
  })
  await assert.rejects(loadWeeks(twice, setup.key), ServerError)
})

test('weeks come back in order: by season, the Premier League first, then as played', async () => {
  const setup = await start()
  const weeks: Week[] = [
    { season: 2027, competition: 'PL', period: 'MW1' }, { season: 2026, competition: 'UCL', period: 'F' },
    { season: 2026, competition: 'UCL', period: 'MD4' }, { season: 2026, competition: 'PL', period: 'MW12' },
    { season: 2026, competition: 'PL', period: 'MW2' }, { season: 2026, competition: 'UCL', period: 'KPO' },
  ]
  for (const week of weeks) saved(await saveWeek(setup.tab, setup.key, newWeek(week), weekOf(parlay(1, [leg(1)])), NOW))
  const loaded = await loadWeeks(setup.tab, setup.key)
  assert.deepEqual(loaded.weeks.map(each => `${each.week.season} ${each.week.period}`), ['2026 MW2', '2026 MW12', '2026 MD4', '2026 KPO', '2026 F', '2027 MW1'])
})

test('deleting a week saves a tombstone, which stays hidden until a parlay starts the week again', async () => {
  const setup = await start()
  const week = await savedWeek(setup, MW11, 900_001)
  const deleted = saved(await deleteWeek(setup.tab, setup.key, week, NOW))
  assert.deepEqual(deleted.record, TOMBSTONE)
  const loaded = await loadWeeks(setup.tab, setup.key)
  assert.deepEqual(loaded.weeks, [deleted], "the week is still there, since its version numbers are taken")
  assert.deepEqual(visibleWeeks(loaded.weeks), [])
  assert.deepEqual(setup.server.rowsOf(setup.account.id, 'audit_entries'), [], 'an unlocked week needs no audit entry')
  // Starting it again begins from an empty week, as version 3.
  const again = await withParlay(setup.tab, { ...deleted, record: EMPTY_WEEK }, bet(900_002))
  const restarted = saved(await saveWeek(setup.tab, setup.key, deleted, again, NOW))
  assert.equal(restarted.version, 3)
  assert.deepEqual(visibleWeeks((await loadWeeks(setup.tab, setup.key)).weeks), [restarted])
})

// ---------------------------------------------------------------------------
// Locked weeks and the audit log
// ---------------------------------------------------------------------------

test('changing a locked week needs a reason, and saves an audit entry with the new version', async () => {
  const setup = await start()
  const locked = await lockedWeek(setup)
  const edited = withOdds(locked.record, 160)
  assert.equal(needsAudit(locked.record, edited), true)
  for (const reason of [undefined, '', '   ', 'x'.repeat(201)]) {
    await assert.rejects(saveWeek(setup.tab, setup.key, locked, edited, LATER, reason), /needs a reason/, JSON.stringify(reason))
  }
  assert.equal(setup.server.rowsOf(setup.account.id, 'week_versions').length, 2, 'nothing saved without one')

  const result = saved(await saveWeek(setup.tab, setup.key, locked, edited, LATER, '  The book had +160  '))
  assert.equal(result.version, 3)
  const [entry] = setup.server.rowsOf(setup.account.id, 'audit_entries')
  assert.ok(entry !== undefined)
  assert.deepEqual([entry.seq, entry.prev_hash], [1, null])
  assert.deepEqual(await auditRecords(setup.server, setup.account), [{
    schema: 1, at: LATER, week: MW11, fromVersion: 2, toVersion: 3,
    changes: [{ what: 'Parlay 1 · MCI v LIV · odds', from: 150, to: 160 }], reason: 'The book had +160',
  }])
  await checkHistory(setup.server, setup.account)
})

test('a locked week that is saved again unchanged needs no reason', async () => {
  const setup = await start()
  const locked = await lockedWeek(setup)
  assert.equal(needsAudit(locked.record, structuredClone(locked.record)), false)
  assert.deepEqual(await saveWeek(setup.tab, setup.key, locked, structuredClone(locked.record), LATER), { result: 'unchanged', week: locked })
})

test('a locked-week change after an unreadable version says which version it started from', async () => {
  const setup = await start()
  await lockedWeek(setup)
  await sneakIn(setup, 3, { note: 'not a week' })
  const loaded = (await loadWeek(setup.tab, setup.key, MW11)).week
  assert.deepEqual([loaded.version, loaded.newestVersion], [2, 3])
  saved(await saveWeek(setup.tab, setup.key, loaded, withOdds(loaded.record, 160), LATER, 'The book had +160'))
  const [audit] = await auditRecords(setup.server, setup.account)
  assert.deepEqual([audit?.fromVersion, audit?.toVersion], [2, 4])
})

test('a huge change to a locked week still saves, with its list of changes capped', async () => {
  const setup = await start()
  // 13 parlays and 500 legs, all settled, so the week is locked.
  const settledLeg = (n: number) => leg(n, { odds: -100_000, settlement: { outcome: 'won', byScore: 'won', score90: [1, 0], how: 'auto', reason: null, promo: false, settledAt: NOW } })
  const legs = (from: number, count: number) => Array.from({ length: count }, (_, i) => settledLeg(from + i))
  const big = weekOf(...Array.from({ length: 12 }, (_, i) => parlay(i + 1, legs(i * 40 + 1, 40))), parlay(13, legs(481, 20)))
  const week = saved(await saveWeek(setup.tab, setup.key, newWeek(MW11), big, NOW))
  assert.ok(isLocked(week.record))
  // Every leg's odds and confidence, and every stake: 1,013 changes.
  const edited: WeekRecord = { ...big, parlays: big.parlays.map(p => ({ ...p, stakeCents: 100, legs: p.legs.map(l => ({ ...l, odds: -99_999, confidence: 5 })) })) }
  saved(await saveWeek(setup.tab, setup.key, week, edited, LATER, 'Typed everything in wrong'))
  const [audit] = await auditRecords(setup.server, setup.account)
  assert.equal(audit?.changes.length, 1000)
  assert.deepEqual(audit?.changes.at(-1), { what: '14 more changes', from: null, to: null })
})

test("a save whose audit entry wouldn't check out is refused", async () => {
  const setup = await start()
  const locked = await lockedWeek(setup)
  // A week claiming a newer version than any saved, which loading never gives.
  await assert.rejects(saveWeek(setup.tab, setup.key, { ...locked, version: 5 }, withOdds(locked.record, 160), LATER, 'Fixed'), RangeError)
  assert.deepEqual(setup.server.rowsOf(setup.account.id, 'audit_entries'), [])
})

test("adding a parlay to a locked week isn't an edit, so it needs no reason or audit entry", async () => {
  const setup = await start()
  const locked = await lockedWeek(setup)
  const more = await withParlay(setup.tab, locked, bet(900_002))
  assert.equal(needsAudit(locked.record, more), false)
  const result = saved(await saveWeek(setup.tab, setup.key, locked, more, LATER))
  assert.equal(isLocked(result.record), false, 'its new leg is still to settle')
  assert.deepEqual(setup.server.rowsOf(setup.account.id, 'audit_entries'), [])
  await checkHistory(setup.server, setup.account)
})

test('deleting a locked week needs a reason, and its audit entry says what went', async () => {
  const setup = await start()
  const locked = await lockedWeek(setup)
  await assert.rejects(deleteWeek(setup.tab, setup.key, locked, LATER), RangeError)
  saved(await deleteWeek(setup.tab, setup.key, locked, LATER, 'Entered in the wrong week'))
  const [audit] = await auditRecords(setup.server, setup.account)
  assert.deepEqual(audit?.changes, [{ what: 'Week deleted', from: null, to: null }, { what: 'Parlay 1 removed', from: null, to: null }])
  await checkHistory(setup.server, setup.account)
})

test('audit entries number on from the last, each carrying the hash of the one before', async () => {
  const setup = await start()
  let week = await lockedWeek(setup)
  for (const odds of [160, 170, 180]) week = saved(await saveWeek(setup.tab, setup.key, week, withOdds(week.record, odds), LATER, `Odds now ${odds}`))
  const rows = setup.server.rowsOf(setup.account.id, 'audit_entries').sort((a, b) => a.seq - b.seq)
  assert.deepEqual(rows.map(row => row.seq), [1, 2, 3])
  assert.equal(rows[0]?.prev_hash, null)
  assert.equal(rows[1]?.prev_hash, await chainHash(rows[0]?.ct ?? ''))
  assert.equal(rows[2]?.prev_hash, await chainHash(rows[1]?.ct ?? ''))
  const log = await loadAuditLog(setup.tab, setup.key)
  assert.deepEqual(log.problems, [])
  assert.deepEqual(log.entries.map(entry => entry.record?.reason), ['Odds now 160', 'Odds now 170', 'Odds now 180'])
  await checkHistory(setup.server, setup.account)
})

test('two tabs changing locked weeks at once: the second finds the audit number taken, and saves neither row', async () => {
  const setup = await start()
  const first = await lockedWeek(setup, MW11)
  const second = await lockedWeek(setup, MW12)
  const other = await tabOn(setup.server, setup.account)
  // The other tab saves its change between this tab's two calls.
  const interrupted = withCall(setup.tab, 'lastAuditEntry', async () => {
    const last = await setup.tab.lastAuditEntry()
    saved(await saveWeek(other, setup.key, second, withOdds(second.record, 200), LATER, 'Fixed in the other tab'))
    return last
  })
  assert.deepEqual(await saveWeek(interrupted, setup.key, first, withOdds(first.record, 160), LATER, 'Fixed here'), { result: 'taken' })
  assert.equal(setup.server.rowsOf(setup.account.id, 'audit_entries').length, 1)
  assert.equal((await loadWeek(setup.tab, setup.key, MW11)).week.newestVersion, 2, "this tab's week version wasn't saved either")
  await checkHistory(setup.server, setup.account)
})

test('a week version that is taken takes its audit entry with it', async () => {
  const setup = await start()
  const locked = await lockedWeek(setup)
  const other = await tabOn(setup.server, setup.account)
  saved(await saveWeek(other, setup.key, locked, await withParlay(other, locked, bet(900_002)), LATER))
  assert.deepEqual(await saveWeek(setup.tab, setup.key, locked, withOdds(locked.record, 160), LATER, 'Fixed here'), { result: 'taken' })
  assert.deepEqual(setup.server.rowsOf(setup.account.id, 'audit_entries'), [])
  await checkHistory(setup.server, setup.account)
})

test("a score correction on a locked week saves an audit entry, and on an unlocked one it doesn't", async () => {
  const setup = await start()
  const locked = await lockedWeek(setup) // won on 2-1
  play(setup.server, finished(1, 1, 1))
  const [lockedResult] = await settleWeeks(setup.tab, setup.key, [locked], await fixturesOf(setup.tab), LATER)
  assert.equal(lockedResult?.corrections.length, 1)
  assert.equal(lockedResult?.week, locked, 'nothing saved until you accept')

  const legId = locked.record.parlays[0]?.legs[0]?.id ?? ''
  const corrected = saved(await saveCorrection(setup.tab, setup.key, locked, legId, await fixturesOf(setup.tab), LATER))
  assert.equal(corrected.record.parlays[0]?.legs[0]?.settlement?.outcome, 'lost')
  const [audit] = await auditRecords(setup.server, setup.account)
  assert.equal(audit?.reason, CORRECTION_REASON)
  assert.deepEqual(audit?.changes, [
    { what: 'Parlay 1 · MCI v LIV · outcome', from: 'won', to: 'lost' },
    { what: 'Parlay 1 · MCI v LIV · 90-minute score', from: [2, 1], to: [1, 1] },
  ])
  await checkHistory(setup.server, setup.account)
})

test("accepting a correction on an unlocked week needs no audit entry", async () => {
  const setup = await start()
  const week = await savedWeek(setup, MW11, 900_001, 900_002)
  play(setup.server, finished(1, 2, 1))
  const [settled] = await settleWeeks(setup.tab, setup.key, [week], await fixturesOf(setup.tab), NOW)
  assert.ok(settled !== undefined && !isLocked(settled.week.record))
  play(setup.server, finished(1, 1, 1))
  const legId = week.record.parlays[0]?.legs[0]?.id ?? ''
  saved(await saveCorrection(setup.tab, setup.key, settled.week, legId, await fixturesOf(setup.tab), LATER))
  assert.deepEqual(setup.server.rowsOf(setup.account.id, 'audit_entries'), [])
  await checkHistory(setup.server, setup.account)
})

test('noting a score on a locked week saves an audit entry, with the reason the app gives', async () => {
  const setup = await start()
  // A promo leg settled by hand while its match is on, after the other leg
  // won: that locks the week.
  let week = await savedWeek(setup, MW11, 900_001, 900_002)
  play(setup.server, finished(1, 2, 0))
  play(setup.server, fixtureRow(2, { ...ARS_CHE, status: 'live', home_90: 2, away_90: 0 }))
  week = (await settleWeeks(setup.tab, setup.key, [week], await fixturesOf(setup.tab), NOW))[0]?.week ?? week
  const promoLeg = week.record.parlays[0]?.legs[1]?.id ?? ''
  const byHand = settleByHand(week.record, promoLeg, { outcome: 'won', promo: true, reason: '2-Up paid out early' }, await fixturesOf(setup.tab), NOW)
  week = saved(await saveWeek(setup.tab, setup.key, week, byHand, NOW))
  assert.ok(isLocked(week.record))
  assert.deepEqual(setup.server.rowsOf(setup.account.id, 'audit_entries'), [], "the week wasn't locked before that save")

  // The match ends 2-2, and settling notes the score.
  play(setup.server, finished(2, 2, 2, ARS_CHE))
  const [result] = await settleWeeks(setup.tab, setup.key, [week], await fixturesOf(setup.tab), LATER)
  assert.equal(result?.noted, 1)
  const [audit] = await auditRecords(setup.server, setup.account)
  assert.equal(audit?.reason, NOTED_REASON)
  assert.deepEqual(audit?.changes, [{ what: 'Parlay 1 · ARS v CHE · 90-minute score', from: null, to: [2, 2] }])
  await checkHistory(setup.server, setup.account)
})

// ---------------------------------------------------------------------------
// Settling
// ---------------------------------------------------------------------------

test('settling saves one new version of each week it changed, and nothing for the rest', async () => {
  const setup = await start()
  const mw11 = await savedWeek(setup, MW11, 900_001, 900_002)
  const mw12 = await savedWeek(setup, MW12, 900_101)
  play(setup.server, finished(1, 2, 1))
  play(setup.server, finished(2, 0, 0, ARS_CHE))
  const results = await settleWeeks(setup.tab, setup.key, [mw11, mw12], await fixturesOf(setup.tab), NOW)
  assert.deepEqual(results.map(each => [each.week.version, each.settled]), [[2, 2], [1, 0]])
  assert.equal(results[1]?.week, mw12)
  assert.deepEqual(results[0]?.week.record.parlays[0]?.legs.map(each => each.settlement?.outcome), ['won', 'lost'])
  assert.deepEqual((await loadWeeks(setup.tab, setup.key)).weeks, results.map(each => each.week))

  const again = await settleWeeks(setup.tab, setup.key, results.map(each => each.week), await fixturesOf(setup.tab), LATER)
  assert.deepEqual(again.map(each => each.week), results.map(each => each.week), 'settling again saves nothing')
  assert.equal(setup.server.rowsOf(setup.account.id, 'week_versions').length, 3)
  await checkHistory(setup.server, setup.account)
})

test('settling a week another tab just changed reloads it, and settles that', async () => {
  const setup = await start()
  const week = await savedWeek(setup, MW11, 900_001)
  const other = await tabOn(setup.server, setup.account)
  const theirs = saved(await saveWeek(other, setup.key, week, await withParlay(other, week, bet(900_002)), NOW))
  play(setup.server, finished(1, 2, 1))
  const [result] = await settleWeeks(setup.tab, setup.key, [week], await fixturesOf(setup.tab), NOW)
  assert.equal(result?.week.version, 3)
  assert.deepEqual(result?.week.record.parlays.map(each => each.id), theirs.record.parlays.map(each => each.id), "the other tab's parlay is kept")
  assert.equal(result?.week.record.parlays[0]?.legs[0]?.settlement?.outcome, 'won')
  await checkHistory(setup.server, setup.account)
})

test('settling gives up after 3 tries', async () => {
  const setup = await start()
  const week = await savedWeek(setup, MW11, 900_001)
  play(setup.server, finished(1, 2, 1))
  let tries = 0
  const busy = withCall(setup.tab, 'addRecord', async () => {
    tries++
    return 'taken'
  })
  await assert.rejects(settleWeeks(busy, setup.key, [week], await fixturesOf(setup.tab), NOW), ServerError)
  assert.equal(tries, 3)
})

test('settling lists what waits for you and what changed, week by week', async () => {
  const setup = await start()
  const week = await savedWeek(setup, MW11, 900_001, 900_002)
  play(setup.server, fixtureRow(1, { status: 'postponed' }))
  const [result] = await settleWeeks(setup.tab, setup.key, [week], await fixturesOf(setup.tab), NOW)
  const first = week.record.parlays[0]
  assert.deepEqual(result?.waiting, [{ parlayId: first?.id, legId: first?.legs[0]?.id, fixtureId: 900_001, status: 'postponed' }])
  assert.deepEqual(result?.corrections, [])
})

// ---------------------------------------------------------------------------
// Every server call breaking
// ---------------------------------------------------------------------------

// The week loads as one of these records, with no warnings, and saving
// `next` again from `from` gets it saved, either now or by an earlier try.
async function settlesOn(server: FakeServer, account: QuickAccount, from: LoadedWeek, next: WeekRecord, label: string, reason?: string) {
  const tab = await tabOn(server, account)
  const loaded = await loadWeeks(tab, account.dataKey)
  assert.deepEqual(loaded.warnings, [], label)
  const record = loaded.weeks.find(each => nameOf(each.week) === nameOf(from.week))?.record
  assert.ok([from.record, next].some(each => isDeepStrictEqual(each, record)), `${label}: the old version or the new one`)
  const again = await saveWeek(tab, account.dataKey, from, next, LATER, reason)
  if (again.result === 'taken') assert.deepEqual(record, next, `${label}: taken only because the first try saved`)
  const final = await loadWeek(tab, account.dataKey, from.week)
  assert.deepEqual(final.week.record, next, label)
  await checkHistory(server, account)
}

test('a save that breaks at any call leaves the old version or the new one, and trying again finishes it', async () => {
  const setup = await start()
  const week = await savedWeek(setup, MW11, 900_001)
  const next = await withParlay(setup.tab, week, bet(900_002))
  const calls = await everyFault(
    setup.server.snapshot(),
    server => tabOn(server, setup.account),
    tab => saveWeek(tab, setup.key, week, next, LATER),
    (server, _tab, _outcome, label) => settlesOn(server, setup.account, week, next, label),
  )
  assert.equal(calls, 1)
})

test('a locked-week change that breaks at any call saves both rows or neither', async () => {
  const setup = await start()
  const locked = await lockedWeek(setup)
  const next = withOdds(locked.record, 160)
  const calls = await everyFault(
    setup.server.snapshot(),
    server => tabOn(server, setup.account),
    tab => saveWeek(tab, setup.key, locked, next, LATER, 'The book had +160'),
    (server, _tab, _outcome, label) => settlesOn(server, setup.account, locked, next, label, 'The book had +160'),
  )
  assert.equal(calls, 2)
})

test('deleting a locked week that breaks at any call saves both rows or neither', async () => {
  const setup = await start()
  const locked = await lockedWeek(setup)
  const calls = await everyFault(
    setup.server.snapshot(),
    server => tabOn(server, setup.account),
    tab => deleteWeek(tab, setup.key, locked, LATER, 'Entered by mistake'),
    (server, _tab, _outcome, label) => settlesOn(server, setup.account, locked, TOMBSTONE, label, 'Entered by mistake'),
  )
  assert.equal(calls, 2)
})

test('settling that breaks at any call leaves every week loadable, and settling again finishes', async () => {
  const setup = await start()
  // Matchweek 11 has two legs to settle. Matchweek 12 is locked, with a promo
  // leg settled by hand while its match was on, so settling notes its score.
  const mw11 = await savedWeek(setup, MW11, 900_001, 900_002)
  const locked = await lockedWeek(setup, MW12)
  const more = saved(await saveWeek(setup.tab, setup.key, locked, await withParlay(setup.tab, locked, bet(900_102)), NOW))
  play(setup.server, fixtureRow(102, { ...TOT_NEW_12, status: 'live', home_90: 2, away_90: 0 }))
  const promoLeg = more.record.parlays[1]?.legs[0]?.id ?? ''
  const promo = saved(await saveWeek(setup.tab, setup.key, more,
    settleByHand(more.record, promoLeg, { outcome: 'won', promo: true, reason: '2-Up paid out early' }, await fixturesOf(setup.tab), NOW), NOW))
  assert.ok(isLocked(promo.record))
  play(setup.server, finished(1, 2, 1))
  play(setup.server, finished(2, 1, 1, ARS_CHE))
  play(setup.server, finished(102, 2, 2, TOT_NEW_12))
  const weeks = [mw11, promo]
  const calls = await everyFault(
    setup.server.snapshot(),
    async server => ({ tab: await tabOn(server, setup.account), fixtures: await fixturesOf(await tabOn(server, setup.account)) }),
    ({ tab, fixtures }) => settleWeeks(tab, setup.key, weeks, fixtures, LATER),
    async (server, _context, _outcome, label) => {
      const tab = await tabOn(server, setup.account)
      const loaded = await loadWeeks(tab, setup.key)
      assert.deepEqual(loaded.warnings, [], label)
      const results = await settleWeeks(tab, setup.key, loaded.weeks, await fixturesOf(tab), LATER)
      for (const each of results) {
        const legs = each.week.record.parlays.flatMap(p => p.legs)
        assert.ok(legs.every(l => l.settlement !== null && l.settlement.score90 !== null), `${label}: every leg settled, with its score`)
      }
      await checkHistory(server, setup.account)
    },
  )
  assert.equal(calls, 3, "matchweek 11's save, then matchweek 12's audit entry and save")
})
