// Tests for src/lib/bets/audit.ts: the audit record's checks, describing what
// changed between two versions of a week, and the chain that shows a missing
// or replaced entry. Every sample here is made up.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  capChanges, chainHash, describeChanges, isAuditRecord, loadAuditLog, MAX_CHANGES, onlyAddsParlays, sealAuditEntry,
  type AuditRecord, type Change,
} from '../src/lib/bets/audit.ts'
import { settleByHand, unsettleLeg } from '../src/lib/bets/settle.ts'
import { isWeekRecord, TOMBSTONE, type Settlement, type WeekRecord } from '../src/lib/bets/week-record.ts'
import { toBase64, utf8 } from '../src/lib/crypto/bytes.ts'
import { decryptRecord, encryptRecord, RECORD_VERSION } from '../src/lib/crypto/records.ts'
import { leg, parlay, quickAccount, tabOn, uuid, weekOf } from './bet-samples.ts'
import { FakeServer } from './fake-api.ts'

const AT = '2026-11-08T09:00:00.000Z'

const GOOD: AuditRecord = {
  schema: 1, at: AT, week: { season: 2026, competition: 'PL', period: 'MW11' }, fromVersion: 2, toVersion: 3,
  changes: [
    { what: 'Parlay 1 · MCI v LIV · odds', from: 150, to: 160 },
    { what: 'Parlay 1 · MCI v LIV · 90-minute score', from: [2, 1], to: [1, 1] },
    { what: 'Parlay 1 · MCI v LIV · promo', from: false, to: true },
    { what: 'Parlay 1 · MCI v LIV · pick', from: 'H', to: 'D' },
    { what: 'Week deleted', from: null, to: null },
  ],
  reason: 'The book had +160',
}

// A copy of GOOD with one field replaced.
const withField = (change: Record<string, unknown>): unknown => ({ ...structuredClone(GOOD), ...change })
const withChange = (change: Record<string, unknown>): unknown => withField({ changes: [{ ...GOOD.changes[0], ...change }] })

test('a good audit record passes, after a trip through JSON too', () => {
  assert.equal(isAuditRecord(GOOD), true)
  assert.equal(isAuditRecord(JSON.parse(JSON.stringify(GOOD))), true)
  assert.equal(isAuditRecord(withField({ changes: Array.from({ length: MAX_CHANGES }, () => GOOD.changes[0]) })), true, '1,000 changes')
  assert.equal(isAuditRecord(withField({ toVersion: 1_000_000 })), true)
  for (const value of [0, -110, true, [0, 0], [30, 30], 'Café · 1–0']) assert.equal(isAuditRecord(withChange({ to: value })), true, JSON.stringify(value))
})

test('every field of an audit record is checked', () => {
  const bad: unknown[] = [
    null, [], 'entry', Object.create(GOOD),
    withField({ extra: 1 }), withField({ schema: 2 }), withField({ at: 'yesterday' }), withField({ at: '2026-02-30T09:00:00.000Z' }),
    withField({ week: null }), withField({ week: { season: 2019, competition: 'PL', period: 'MW11' } }),
    withField({ week: { season: 2026, competition: 'UCL', period: 'MW11' } }), withField({ week: { ...GOOD.week, extra: 1 } }),
    withField({ fromVersion: 0 }), withField({ fromVersion: 2.5 }), withField({ fromVersion: '2' }),
    withField({ toVersion: 2 }), withField({ toVersion: 1 }), withField({ toVersion: 1_000_001 }),
    withField({ changes: [] }), withField({ changes: 'odds' }), withField({ changes: Array.from({ length: MAX_CHANGES + 1 }, () => GOOD.changes[0]) }),
    withField({ reason: '' }), withField({ reason: null }), withField({ reason: 'x'.repeat(201) }),
    withChange({ extra: 1 }), withChange({ what: '' }), withChange({ what: 'x'.repeat(201) }), withChange({ what: 'two\nlines' }),
    ...[{}, [1], [1, 2, 3], [31, 0], [-1, 0], 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, '', 'x'.repeat(201), undefined]
      .map(value => withChange({ from: value })),
  ]
  for (const value of bad) assert.equal(isAuditRecord(value), false, JSON.stringify(value)?.slice(0, 120))
  const { reason: _reason, ...missing } = GOOD
  assert.equal(isAuditRecord(missing), false, 'no reason')
})

// ---------------------------------------------------------------------------
// What changed
// ---------------------------------------------------------------------------

const WON: Settlement = { outcome: 'won', byScore: 'won', score90: [2, 1], how: 'auto', reason: null, promo: false, settledAt: AT }

// Two parlays: one with a settled leg and an open one, and one with an open leg.
const BEFORE = weekOf(
  parlay(1, [leg(1, { settlement: WON }), leg(2, { home: 'ARS', away: 'CHE' })]),
  parlay(2, [leg(3, { home: 'TOT', away: 'NEW' })]),
)

// A copy of BEFORE, changed.
function changed(change: (record: WeekRecord) => void): WeekRecord {
  const copy = structuredClone(BEFORE)
  change(copy)
  assert.ok(isWeekRecord(copy), 'each change still makes a good record')
  return copy
}
const firstLeg = (record: WeekRecord) => {
  const found = record.parlays[0]?.legs[0]
  if (found === undefined) throw new Error('No first leg.')
  return found
}
const happened = (what: string): Change => ({ what, from: null, to: null })

test('the same week twice has no changes', () => {
  assert.deepEqual(describeChanges(BEFORE, structuredClone(BEFORE)), [])
  assert.deepEqual(describeChanges(TOMBSTONE, TOMBSTONE), [])
})

test('every field of a parlay and a leg is compared', () => {
  const cases: [string, WeekRecord, Change[]][] = [
    ['stake', changed(r => { if (r.parlays[0]) r.parlays[0].stakeCents = 5000 }), [{ what: 'Parlay 1 · stake in cents', from: 2500, to: 5000 }]],
    ['odds', changed(r => { firstLeg(r).odds = -110 }), [{ what: 'Parlay 1 · MCI v LIV · odds', from: 150, to: -110 }]],
    ['confidence', changed(r => { firstLeg(r).confidence = 5 }), [{ what: 'Parlay 1 · MCI v LIV · confidence', from: 3, to: 5 }]],
    ['kick-off', changed(r => { firstLeg(r).kickoff = '2026-11-07T20:00:00.000Z' }),
      [{ what: 'Parlay 1 · MCI v LIV · kick-off', from: '2026-11-07T17:30:00.000Z', to: '2026-11-07T20:00:00.000Z' }]],
    ['pick', changed(r => { const open = r.parlays[0]?.legs[1]; if (open) open.pick = 'D' }), [{ what: 'Parlay 1 · ARS v CHE · pick', from: 'H', to: 'D' }]],
    ['game', changed(r => { Object.assign(firstLeg(r), { fixtureId: 900_009, home: 'EVE', away: 'WHU', settlement: null }) }), [
      { what: 'Parlay 1 · MCI v LIV · game', from: 900_001, to: 900_009 },
      { what: 'Parlay 1 · MCI v LIV · teams', from: 'MCI v LIV', to: 'EVE v WHU' },
      { what: 'Parlay 1 · MCI v LIV · outcome', from: 'won', to: null },
      { what: 'Parlay 1 · MCI v LIV · 90-minute score', from: [2, 1], to: null },
      { what: 'Parlay 1 · MCI v LIV · how it settled', from: 'auto', to: null },
      { what: 'Parlay 1 · MCI v LIV · promo', from: false, to: null },
    ]],
  ]
  for (const [name, after, expected] of cases) assert.deepEqual(describeChanges(BEFORE, after), expected, name)
})

test('every field of a settlement is compared, and the time only when nothing else changed', () => {
  // Settled by hand as a promo: how it settled, the promo and the reason change.
  const promo = settleByHand(BEFORE, uuid(1001), { outcome: 'won', promo: true, reason: '2-Up paid out early' }, new Map(), '2026-11-09T10:00:00.000Z')
  assert.deepEqual(describeChanges(BEFORE, promo), [
    { what: 'Parlay 1 · MCI v LIV · 90-minute score', from: [2, 1], to: null },
    { what: 'Parlay 1 · MCI v LIV · how it settled', from: 'auto', to: 'override' },
    { what: 'Parlay 1 · MCI v LIV · promo', from: false, to: true },
    { what: 'Parlay 1 · MCI v LIV · reason', from: null, to: '2-Up paid out early' },
  ])
  // Only the time it settled at.
  const later = changed(r => { const s = firstLeg(r).settlement; if (s) s.settledAt = '2026-11-09T10:00:00.000Z' })
  assert.deepEqual(describeChanges(BEFORE, later), [{ what: 'Parlay 1 · MCI v LIV · settled at', from: AT, to: '2026-11-09T10:00:00.000Z' }])
  // Its settlement taken away.
  assert.deepEqual(describeChanges(BEFORE, unsettleLeg(BEFORE, uuid(1001))), [
    { what: 'Parlay 1 · MCI v LIV · outcome', from: 'won', to: null },
    { what: 'Parlay 1 · MCI v LIV · 90-minute score', from: [2, 1], to: null },
    { what: 'Parlay 1 · MCI v LIV · how it settled', from: 'auto', to: null },
    { what: 'Parlay 1 · MCI v LIV · promo', from: false, to: null },
  ])
})

test('parlays and legs added, removed and reordered', () => {
  const cases: [string, WeekRecord, Change[]][] = [
    ['a parlay removed', changed(r => { r.parlays.splice(1, 1) }), [happened('Parlay 2 removed')]],
    ['a parlay added', changed(r => { r.parlays.push(parlay(3, [leg(4)])) }), [happened('Parlay 3 added')]],
    ['parlays reordered', changed(r => { r.parlays.reverse() }), [happened('Parlays reordered')]],
    ['a leg removed', changed(r => { r.parlays[0]?.legs.splice(1, 1) }), [happened('Parlay 1 · ARS v CHE removed')]],
    ['a leg added', changed(r => { r.parlays[1]?.legs.push(leg(5, { home: 'EVE', away: 'WHU' })) }), [happened('Parlay 2 · EVE v WHU added')]],
    ['legs reordered', changed(r => { r.parlays[0]?.legs.reverse() }), [happened('Parlay 1 · legs reordered')]],
    ['the week deleted', TOMBSTONE, [happened('Week deleted'), happened('Parlay 1 removed'), happened('Parlay 2 removed')]],
  ]
  for (const [name, after, expected] of cases) assert.deepEqual(describeChanges(BEFORE, after), expected, name)
  assert.deepEqual(describeChanges(TOMBSTONE, BEFORE), [happened('Week started again'), happened('Parlay 1 added'), happened('Parlay 2 added')])
})

test('adding parlays after the others is the only change that is never an edit', () => {
  const added = changed(r => { r.parlays.push(parlay(3, [leg(4)])) })
  assert.equal(onlyAddsParlays(BEFORE, added), true)
  assert.equal(onlyAddsParlays(BEFORE, changed(r => { r.parlays.unshift(parlay(3, [leg(4)])) })), false, 'added in front')
  assert.equal(onlyAddsParlays(BEFORE, changed(r => { r.parlays.push(parlay(3, [leg(4)])); firstLeg(r).odds = 160 })), false, 'added, and an edit')
  assert.equal(onlyAddsParlays(BEFORE, structuredClone(BEFORE)), false, 'nothing added')
  assert.equal(onlyAddsParlays(BEFORE, changed(r => { r.parlays.pop() })), false, 'one taken away')
  assert.equal(onlyAddsParlays(TOMBSTONE, BEFORE), false, 'a deleted week started again')
})

test('a long list of changes is capped, and says how many more there were', () => {
  const many = Array.from({ length: MAX_CHANGES + 5 }, (_, i) => happened(`Change ${i + 1}`))
  const capped = capChanges(many)
  assert.equal(capped.length, MAX_CHANGES)
  assert.deepEqual(capped.at(-1), happened('6 more changes'))
  assert.deepEqual(capped.at(-2), happened(`Change ${MAX_CHANGES - 1}`))
  const few = many.slice(0, MAX_CHANGES)
  assert.equal(capChanges(few), few)
})

// ---------------------------------------------------------------------------
// The chain
// ---------------------------------------------------------------------------

test("each entry's hash is the SHA-256 of the ciphertext before it", async () => {
  // The standard test value: SHA-256 of "abc".
  assert.equal(await chainHash(toBase64(utf8('abc'))), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
})

test('an entry numbers on from the last, carrying its hash, inside the encryption', async () => {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  const first = await sealAuditEntry(GOOD, null, key)
  assert.deepEqual([first.seq, first.prev_hash, first.v], [1, null, RECORD_VERSION])
  const second = await sealAuditEntry(GOOD, { ...first, created_at: AT }, key)
  assert.deepEqual([second.seq, second.prev_hash], [2, await chainHash(first.ct)])
  assert.deepEqual(await decryptRecord('audit_entries', second, key), GOOD)
  // The hash is part of the AAD, so changing it stops the entry opening.
  await assert.rejects(decryptRecord('audit_entries', { ...second, prev_hash: 'a'.repeat(64) }, key))
})

// An account with four chained audit entries, saved the way the app saves them.
async function fourEntries() {
  const server = new FakeServer()
  const account = await quickAccount(server)
  const tab = await tabOn(server, account)
  for (let i = 1; i <= 4; i++) {
    const last = await tab.lastAuditEntry()
    assert.equal(await tab.addRecord('audit_entries', await sealAuditEntry({ ...GOOD, reason: `Entry ${i}` }, last, account.dataKey)), 'saved')
  }
  const rows = server.rowsOf(account.id, 'audit_entries').sort((a, b) => a.seq - b.seq)
  return { server, account, tab, rows }
}

test('the log loads in order, and a whole chain has no problems', async () => {
  const { tab, account } = await fourEntries()
  const log = await loadAuditLog(tab, account.dataKey)
  assert.deepEqual(log.problems, [])
  assert.deepEqual(log.entries.map(entry => [entry.seq, entry.record?.reason]), [[1, 'Entry 1'], [2, 'Entry 2'], [3, 'Entry 3'], [4, 'Entry 4']])
})

test('a deleted entry shows as missing', async () => {
  for (const [gone, expected] of [[2, { kind: 'missing', from: 2, to: 2 }], [1, { kind: 'missing', from: 1, to: 1 }]] as const) {
    const { server, tab, account, rows } = await fourEntries()
    server.insiderDelete('audit_entries', rows[gone - 1]?.id ?? '')
    assert.deepEqual((await loadAuditLog(tab, account.dataKey)).problems, [expected], `entry ${gone}`)
  }
  const { server, tab, account, rows } = await fourEntries()
  server.insiderDelete('audit_entries', rows[1]?.id ?? '')
  server.insiderDelete('audit_entries', rows[2]?.id ?? '')
  assert.deepEqual((await loadAuditLog(tab, account.dataKey)).problems, [{ kind: 'missing', from: 2, to: 3 }])
})

test('a replaced entry is unreadable, and breaks the chain on both sides', async () => {
  const { server, tab, account, rows } = await fourEntries()
  const third = rows[2]
  assert.ok(third !== undefined)
  server.insiderDelete('audit_entries', third.id)
  // Someone without the key writes a new entry 3, with a made-up hash.
  const stranger = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  const plain = { id: crypto.randomUUID(), seq: 3, prev_hash: 'b'.repeat(64), v: RECORD_VERSION }
  server.insiderAdd('audit_entries', account.id, { ...plain, ...(await encryptRecord('audit_entries', plain, GOOD, stranger)) })
  const log = await loadAuditLog(tab, account.dataKey)
  assert.deepEqual(log.problems, [{ kind: 'broken', seq: 3 }, { kind: 'unreadable', seq: 3 }, { kind: 'broken', seq: 4 }])
  assert.equal(log.entries[2]?.record, null)
})

test("an entry that opens but isn't an audit record is unreadable, with the chain whole", async () => {
  const { server, tab, account } = await fourEntries()
  const last = await tab.lastAuditEntry()
  const plain = { id: crypto.randomUUID(), seq: 5, prev_hash: await chainHash(last?.ct ?? ''), v: RECORD_VERSION }
  server.insiderAdd('audit_entries', account.id, { ...plain, ...(await encryptRecord('audit_entries', plain, { note: 'junk' }, account.dataKey)) })
  assert.deepEqual((await loadAuditLog(tab, account.dataKey)).problems, [{ kind: 'unreadable', seq: 5 }])
})
