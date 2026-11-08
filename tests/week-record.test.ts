// Tests for src/lib/bets/week-record.ts: every check on a week record, with
// junk of every type, and adding a parlay. Every sample here is made up.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  addParlay, byScoreFor, checkWeek, EMPTY_WEEK, isReason, isWeekRecord, MAX_LEGS, MAX_LEGS_PER_PARLAY, MAX_PARLAYS,
  resultOf, TOMBSTONE, type NewLeg, type NewParlay, type Pick, type Settlement, type Week, type WeekFixture,
  type WeekRecord,
} from '../src/lib/bets/week-record.ts'
import { cheapLegs, deepFreeze, KICKOFF, leg, parlay, uuid, weekOf } from './bet-samples.ts'

const SETTLED_AT = '2026-11-07T19:30:00.000Z'

// One of each kind of settlement, for a leg picking a home win.
const AUTO_WON: Settlement = { outcome: 'won', byScore: 'won', score90: [2, 1], how: 'auto', reason: null, promo: false, settledAt: SETTLED_AT }
const AUTO_LOST: Settlement = { ...AUTO_WON, outcome: 'lost', byScore: 'lost', score90: [1, 1] }
// The home side went two up and the book paid out early, though it ended 2-3.
const PROMO: Settlement = { outcome: 'won', byScore: 'lost', score90: [2, 3], how: 'override', reason: '2-Up paid out early', promo: true, settledAt: SETTLED_AT }
const BY_HAND: Settlement = { outcome: 'lost', byScore: null, score90: null, how: 'override', reason: 'Book settled it as lost', promo: false, settledAt: SETTLED_AT }
const DROPPED: Settlement = { outcome: 'dropped', byScore: null, score90: null, how: 'void', reason: 'Postponed', promo: false, settledAt: SETTLED_AT }

// A good week with every kind of settlement, and game 900001 in two parlays.
const GOOD = weekOf(
  parlay(1, [leg(1, { settlement: AUTO_WON }), leg(2, { settlement: AUTO_LOST })]),
  parlay(2, [leg(3, { settlement: PROMO }), leg(4, { settlement: BY_HAND }), leg(5, { settlement: DROPPED }), leg(6)]),
  parlay(3, [leg(7, { fixtureId: 900_001 })]),
)

// Where things are in GOOD: its first leg, that leg's settlement (AUTO_WON),
// and a leg that hasn't settled.
const LEG = ['parlays', 0, 'legs', 0]
const SETTLEMENT = [...LEG, 'settlement']
const OPEN_LEG = ['parlays', 1, 'legs', 3]

type Loose = Record<string | number, unknown>
const REMOVE = Symbol('remove')

// A copy of `record` with the field at `path` set to `to`, or taken out with
// REMOVE. The path leads to the field, such as ['parlays', 0, 'stakeCents'].
function withField(path: readonly (string | number)[], to: unknown, record: unknown = GOOD): unknown {
  const copy = structuredClone(record) as Loose
  let at = copy
  for (const step of path.slice(0, -1)) at = at[step] as Loose
  const last = path[path.length - 1] as string | number
  if (to === REMOVE) delete at[last]
  else at[last] = to
  return copy
}

// A week with one leg, picking `pick`, settled as given.
const settledAs = (settlement: unknown, pick: Pick = 'H'): unknown => ({
  schema: 1, deleted: false, parlays: [{ id: uuid(1), stakeCents: 2500, boostBps: 0, legs: [{ ...leg(1, { pick }), settlement }] }],
})

// ---------------------------------------------------------------------------
// The record's shape
// ---------------------------------------------------------------------------

test('a good week passes, and so do an empty week and a tombstone', () => {
  assert.equal(isWeekRecord(GOOD), true)
  assert.equal(isWeekRecord(JSON.parse(JSON.stringify(GOOD))), true, 'after a trip through JSON, as when it is decrypted')
  assert.equal(isWeekRecord(EMPTY_WEEK), true)
  assert.equal(isWeekRecord(TOMBSTONE), true)
})

test('anything that is not a record object fails', () => {
  const junk: unknown[] = [
    null, undefined, 'week', 1, true, [], [GOOD], new Date(), () => GOOD,
    Object.create(GOOD),                         // its fields are inherited, not its own
    Object.assign(Object.create({ parlays: [] }), { schema: 1, deleted: false, extra: 1 }), // three fields, one inherited
    Object.assign([], { schema: 1, deleted: false, parlays: [] }), // an array with the right fields
    JSON.parse('{"schema":1,"deleted":false,"parlays":[],"__proto__":{}}'), // a sneaky extra field
  ]
  for (const value of junk) assert.equal(isWeekRecord(value), false, String(value))
})

test('a missing or extra field fails, at every level', () => {
  const levels: [string, (string | number)[], string[]][] = [
    ['the record', [], ['schema', 'deleted', 'parlays']],
    ['a parlay', ['parlays', 0], ['id', 'stakeCents', 'boostBps', 'legs']],
    ['a leg', LEG, ['id', 'fixtureId', 'home', 'away', 'kickoff', 'pick', 'odds', 'confidence', 'settlement']],
    ['a settlement', SETTLEMENT, ['outcome', 'byScore', 'score90', 'how', 'reason', 'promo', 'settledAt']],
  ]
  for (const [level, path, fields] of levels) {
    for (const field of fields) assert.equal(isWeekRecord(withField([...path, field], REMOVE)), false, `${level} without ${field}`)
    assert.equal(isWeekRecord(withField([...path, 'extra'], 1)), false, `${level} with an extra field`)
  }
})

test('every field is checked, with junk of every type', () => {
  const bad: [string, (string | number)[], unknown[]][] = [
    ['schema', ['schema'], [0, 2, '1', null]],
    ['deleted', ['deleted'], ['false', 0, null]],
    ['parlays', ['parlays'], [{}, 'none', [1], null]],
    ['a parlay ID', ['parlays', 0, 'id'], ['not-a-uuid', uuid(0xabcdef).toUpperCase(), '', 1, null]],
    ['a stake', ['parlays', 0, 'stakeCents'], [0, -2500, 1_000_001, 2500.5, '2500', Number.NaN, null]],
    ['a boost', ['parlays', 0, 'boostBps'], [-1, 10_001, 2.5, '250', Number.NaN, Number.POSITIVE_INFINITY, null, false]],
    ['legs', ['parlays', 0, 'legs'], [[], {}, [1], null]],
  ]
  const legFields: [string, unknown[]][] = [
    ['id', ['not-a-uuid', 1, null]],
    ['fixtureId', [0, -1, 1.5, '900001', 2 ** 53, Number.NaN, null]],
    ['home', ['mci', 'MC', 'MCIX', 'M1I', 'Man City', '', 1, null]],
    ['away', ['liv', 'LIV ', null]],
    ['kickoff', ['2026-11-07', '2026-11-07T17:30:00+00:00', '2026-13-45T99:99:99.000Z', 'soon', 1, null]],
    ['pick', ['h', 'X', 'Home', 1, null]],
    ['odds', [99, -99, 0, 150.5, '150', 100_001, -100_001, null]],
    ['confidence', [0, 6, 2.5, '3', null]],
    ['settlement', ['won', {}, [], true]],
  ]
  // Each on a settled leg, and on one that hasn't settled, so no field's
  // check can hide behind its settlement's.
  for (const path of [LEG, OPEN_LEG]) {
    for (const [field, values] of legFields) bad.push([`a leg's ${field}`, [...path, field], values])
  }
  for (const [name, path, values] of bad) {
    for (const value of values) assert.equal(isWeekRecord(withField(path, value)), false, `${name}: ${JSON.stringify(value)}`)
  }
})

test('every field of every kind of settlement is checked', () => {
  // GOOD's five settled legs: won and lost by the score, a promo, by hand, and dropped.
  const settlements = [[0, 0], [0, 1], [1, 0], [1, 1], [1, 2]].map(([p, l]) => ['parlays', p, 'legs', l, 'settlement'] as (string | number)[])
  // Each junk score still reads as a home win, so for the leg that won by the
  // score, only the score's own check can fail it.
  const bad: [string, unknown[]][] = [
    ['outcome', ['push', 'WON', '', 1, null]],
    ['byScore', ['drawn', 1]],
    ['score90', ['2-1', [2], [2, 1, 0], [31, 2], [2, -1], [2, 1.5], ['2', '1'], {}]],
    ['how', ['manual', 'AUTO', null]],
    ['reason', ['', 5, 'two\nlines']],
    ['promo', ['false', 'true', 0, 1, null]],
    ['settledAt', ['yesterday', '2026-11-07', 1, null]],
  ]
  for (const path of settlements) {
    for (const [field, values] of bad) {
      for (const value of values) {
        assert.equal(isWeekRecord(withField([...path, field], value)), false, `${path.join('.')}.${field}: ${JSON.stringify(value)}`)
      }
    }
  }
})

test('the edges of each range pass', () => {
  const good: [string, (string | number)[], unknown[]][] = [
    ['a stake', ['parlays', 0, 'stakeCents'], [1, 1_000_000]],
    ['a boost', ['parlays', 0, 'boostBps'], [0, 1, 250, 10_000]],
    ['odds', [...LEG, 'odds'], [100, -100, 100_000, -100_000]],
    ['confidence', [...LEG, 'confidence'], [1, 5]],
    ['a game ID', [...LEG, 'fixtureId'], [1, Number.MAX_SAFE_INTEGER]],
    ['the kick-off', [...LEG, 'kickoff'], ['2026-11-07T17:30:00Z']],
    ['a score', [...SETTLEMENT, 'score90'], [[30, 0], [1, 0]]],
  ]
  for (const [name, path, values] of good) {
    for (const value of values) assert.equal(isWeekRecord(withField(path, value)), true, `${name}: ${JSON.stringify(value)}`)
  }
})

// ---------------------------------------------------------------------------
// How a settlement fits together
// ---------------------------------------------------------------------------

test('every good kind of settlement passes', () => {
  const good: [string, unknown, Pick?][] = [
    ['won by the score', AUTO_WON],
    ['lost by the score', AUTO_LOST],
    ['a draw pick on a draw', { ...AUTO_WON, score90: [0, 0] }, 'D'],
    ['an away pick on an away win', { ...AUTO_WON, score90: [0, 2] }, 'A'],
    ['a promo', PROMO],
    ['by hand, before any score', BY_HAND],
    ['by hand as won, with a score', { ...BY_HAND, outcome: 'won', score90: [3, 0], byScore: 'won' }],
    ['by hand as lost, though the score says won', { ...BY_HAND, score90: [3, 0], byScore: 'won' }],
    ['dropped', DROPPED],
    ['voided as lost', { ...DROPPED, outcome: 'lost' }],
    ['dropped, with the score noted later', { ...DROPPED, score90: [0, 0], byScore: 'lost' }],
    ['a 200-character reason', { ...BY_HAND, reason: 'x'.repeat(200) }],
    ['200 emoji, which count as 200 characters', { ...BY_HAND, reason: '🏆'.repeat(200) }],
    ['a reason with spaces round it', { ...BY_HAND, reason: '  Postponed  ' }],
  ]
  for (const [name, settlement, pick] of good) assert.equal(isWeekRecord(settledAs(settlement, pick)), true, name)
})

test('a settlement that does not fit together fails', () => {
  const bad: [string, unknown, Pick?][] = [
    ['settled itself, but its outcome is not what the score said', { ...AUTO_WON, outcome: 'lost' }],
    ['settled itself, with no score', { ...AUTO_WON, score90: null, byScore: null }],
    ['settled itself, with a reason', { ...AUTO_WON, reason: 'Because' }],
    ['settled itself, as a promo', { ...AUTO_WON, promo: true }],
    ['settled itself, as dropped', { ...AUTO_WON, outcome: 'dropped' }],
    ['what the score said is wrong', { ...AUTO_WON, score90: [1, 2] }],
    ['what the score said is junk', { ...AUTO_WON, byScore: 'dropped' }],
    ['what the score said, with no score', { ...BY_HAND, byScore: 'won' }],
    ['a score, without what it said', { ...BY_HAND, score90: [1, 0] }],
    ['the pick does not agree with what the score said', AUTO_WON, 'D'],
    ['by hand, as dropped', { ...BY_HAND, outcome: 'dropped' }],
    ['by hand, with no reason', { ...BY_HAND, reason: null }],
    ['by hand, a promo that lost', { ...BY_HAND, promo: true }],
    ['voided as won', { ...DROPPED, outcome: 'won' }],
    ['voided, with no reason', { ...DROPPED, reason: null }],
    ['voided, as a promo', { ...DROPPED, promo: true }],
  ]
  for (const [name, settlement, pick] of bad) assert.equal(isWeekRecord(settledAs(settlement, pick)), false, name)
})

test('reasons are 1 to 200 characters, with no control characters', () => {
  const bad = ['', '   ', 'x'.repeat(201), '🏆'.repeat(201), 'two\nlines', 'tab\there', 'nul\u0000', 'del\u007f', 'next line\u0085', 'broken \uD800', 5, true, null]
  for (const reason of bad) {
    assert.equal(isReason(reason), false, JSON.stringify(reason))
    if (reason !== null) assert.equal(isWeekRecord(settledAs({ ...BY_HAND, reason })), false, JSON.stringify(reason))
  }
  for (const reason of ['x', 'Postponed', '2-Up paid out early', 'Café — 1–0 ✓', ' x ', '🏆']) assert.equal(isReason(reason), true, reason)
})

test("a score's result, and what it says about each pick", () => {
  assert.equal(resultOf([2, 1]), 'H')
  assert.equal(resultOf([0, 0]), 'D')
  assert.equal(resultOf([3, 3]), 'D')
  assert.equal(resultOf([0, 3]), 'A')
  const cases: [Pick, [number, number], 'won' | 'lost'][] = [
    ['H', [1, 0], 'won'], ['H', [0, 0], 'lost'], ['H', [0, 1], 'lost'],
    ['D', [2, 2], 'won'], ['D', [1, 0], 'lost'], ['D', [0, 1], 'lost'],
    ['A', [0, 1], 'won'], ['A', [1, 1], 'lost'], ['A', [1, 0], 'lost'],
  ]
  for (const [pick, score, said] of cases) assert.equal(byScoreFor(pick, score), said, `${pick} on ${score.join('-')}`)
})

// ---------------------------------------------------------------------------
// The rules across a week
// ---------------------------------------------------------------------------

test('a game can go in any number of parlays, but only once in each', () => {
  assert.equal(isWeekRecord(weekOf(parlay(1, [leg(1)]), parlay(2, [leg(2, { fixtureId: 900_001 })]))), true, 'one game in two parlays')
  assert.equal(isWeekRecord(weekOf(parlay(1, [leg(1), leg(2, { fixtureId: 900_001 })]))), false, 'one game twice in a parlay')
})

test('every ID in a week is different', () => {
  assert.equal(isWeekRecord(weekOf(parlay(1, [leg(1)]), parlay(1, [leg(2)]))), false, 'two parlays with one ID')
  assert.equal(isWeekRecord(weekOf(parlay(1, [leg(1)]), parlay(2, [leg(2, { id: uuid(1001) })]))), false, 'two legs with one ID, in two parlays')
  assert.equal(isWeekRecord(weekOf(parlay(1, [leg(1), leg(2, { id: uuid(1001) })]))), false, 'two legs with one ID, in one parlay')
  assert.equal(isWeekRecord(weekOf(parlay(1, [leg(1, { id: uuid(1) })]))), false, "a leg with its parlay's ID")
})

test('a week holds up to 100 parlays and 500 legs, and a parlay up to 40 legs', () => {
  const singles = (count: number) => weekOf(...Array.from({ length: count }, (_, i) => parlay(i + 1, [leg(i + 1)])))
  assert.equal(isWeekRecord(singles(MAX_PARLAYS)), true)
  assert.equal(isWeekRecord(singles(MAX_PARLAYS + 1)), false)

  // 12 parlays of 40 legs, and one more parlay of `last` legs.
  const legs = (last: number) => weekOf(
    ...Array.from({ length: 12 }, (_, i) => parlay(i + 1, cheapLegs(i * 40 + 1, 40))),
    parlay(13, cheapLegs(481, last)),
  )
  assert.equal(isWeekRecord(legs(MAX_LEGS - 480)), true, '500 legs')
  assert.equal(isWeekRecord(legs(MAX_LEGS - 480 + 1)), false, '501 legs')

  assert.equal(isWeekRecord(weekOf(parlay(1, cheapLegs(1, MAX_LEGS_PER_PARLAY)))), true, '40 legs')
  assert.equal(isWeekRecord(weekOf(parlay(1, cheapLegs(1, MAX_LEGS_PER_PARLAY + 1)))), false, '41 legs')
})

test('a parlay that could pay over $100 million fails', () => {
  // $10,000 at +99900 and +900 pays 10,000 × 1000 × 10 = $100 million exactly.
  const atLimit = parlay(1, [leg(1, { odds: 99_900 }), leg(2, { odds: 900 })], { stakeCents: 1_000_000 })
  assert.equal(isWeekRecord(weekOf(atLimit)), true)
  const over = parlay(1, [leg(1, { odds: 99_900 }), leg(2, { odds: 901 })], { stakeCents: 1_000_000 })
  assert.equal(isWeekRecord(weekOf(over)), false)
  // A boost counts too: a 0.01% boost on that $99,990,000 profit adds $9,999.
  assert.equal(isWeekRecord(weekOf({ ...atLimit, boostBps: 1 })), false, 'boosted over the limit')
})

test('a tombstone holds no parlays', () => {
  assert.equal(isWeekRecord({ ...GOOD, deleted: true }), false)
})

// ---------------------------------------------------------------------------
// Adding a parlay
// ---------------------------------------------------------------------------

const WEEK: Week = { season: 2026, competition: 'PL', period: 'MW11' }

function fixture(id: number, home: string, away: string, change: Partial<WeekFixture> = {}): WeekFixture {
  return { id, season: 2026, competition: 'PL', period: 'MW11', home, away, kickoff: KICKOFF, ...change }
}

const FIXTURES: WeekFixture[] = [
  fixture(900_001, 'MCI', 'LIV'),
  fixture(900_002, 'ARS', 'CHE', { kickoff: '2026-11-08T16:30:00.000Z' }),
  fixture(900_003, 'TOT', 'NEW'),
  fixture(900_101, 'EVE', 'WHU', { period: 'MW12' }),                      // the next matchweek
  fixture(900_201, 'MCI', 'INT', { competition: 'UCL', period: 'MD4' }),   // the Champions League
  fixture(900_202, 'ARS', 'BAY', { competition: 'UCL' }),                  // the database can't hold this, but it's refused anyway
  fixture(900_301, 'LIV', 'MUN', { season: 2025 }),                        // last season's matchweek 11
  ...Array.from({ length: 41 }, (_, i) => fixture(910_000 + i, 'AAA', 'BBB')),
]

const entryLeg = (fixtureId: number, change: Partial<NewLeg> = {}): NewLeg => ({ fixtureId, pick: 'H', odds: 150, confidence: 3, ...change })
const single = (change: Partial<NewLeg> = {}): NewParlay => ({ stakeCents: 2500, boostBps: 0, legs: [entryLeg(900_001, change)] })

// The result of a parlay that should have been added, or a clear failure.
function added(result: ReturnType<typeof addParlay>) {
  if (!result.ok) throw new Error(`It should have been added, but the problem was "${result.problem}".`)
  return result
}

// What went wrong adding `entry`, or "added".
function problemWith(entry: NewParlay, record: WeekRecord = EMPTY_WEEK, fixtures: readonly WeekFixture[] = FIXTURES): string {
  const result = addParlay(deepFreeze(structuredClone(record)), WEEK, fixtures, deepFreeze(structuredClone(entry)))
  return result.ok ? 'added' : result.problem
}

test("adding a parlay copies each game's teams and kick-off, and changes nothing it was given", () => {
  const before = deepFreeze(structuredClone(EMPTY_WEEK))
  const entry = deepFreeze({ stakeCents: 1234, boostBps: 250, legs: [entryLeg(900_001, { confidence: 5 }), entryLeg(900_002, { pick: 'D', odds: 240 })] })
  const result = added(addParlay(before, WEEK, deepFreeze(structuredClone(FIXTURES)), entry))

  assert.deepEqual(result.record.parlays, [result.parlay])
  assert.equal(result.parlay.stakeCents, 1234)
  assert.equal(result.parlay.boostBps, 250)
  const [first, second] = result.parlay.legs
  assert.deepEqual({ ...first, id: 'new' }, {
    id: 'new', fixtureId: 900_001, home: 'MCI', away: 'LIV', kickoff: KICKOFF, pick: 'H', odds: 150, confidence: 5, settlement: null,
  })
  assert.deepEqual({ ...second, id: 'new' }, {
    id: 'new', fixtureId: 900_002, home: 'ARS', away: 'CHE', kickoff: '2026-11-08T16:30:00.000Z', pick: 'D', odds: 240, confidence: 3, settlement: null,
  })
  const ids = [result.parlay.id, first?.id, second?.id]
  for (const id of ids) assert.match(String(id), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.equal(new Set(ids).size, 3, 'each gets a new ID of its own')
  assert.equal(isWeekRecord(result.record), true)
  assert.equal(before.parlays.length, 0)
})

test('a game in one parlay can go in another, but not twice in one', () => {
  const one = added(addParlay(EMPTY_WEEK, WEEK, FIXTURES, single()))
  const two = added(addParlay(one.record, WEEK, FIXTURES, { stakeCents: 1000, boostBps: 0, legs: [entryLeg(900_001, { pick: 'A', odds: 320 }), entryLeg(900_002)] }))
  assert.equal(two.record.parlays.length, 2)
  assert.deepEqual(two.record.parlays[0], one.parlay, 'the first parlay is kept as it was')
  assert.equal(problemWith({ stakeCents: 2500, boostBps: 0, legs: [entryLeg(900_001), entryLeg(900_001, { pick: 'D' })] }), 'same game twice')
})

test('every problem with an entry is caught', () => {
  assert.equal(problemWith(single(), TOMBSTONE), 'deleted')
  for (const stakeCents of [0, -2500, 1_000_001, 2500.5, Number.NaN]) assert.equal(problemWith({ ...single(), stakeCents }), 'stake', String(stakeCents))
  for (const boostBps of [-1, 10_001, 2.5, Number.NaN]) assert.equal(problemWith({ ...single(), boostBps }), 'boost', String(boostBps))
  for (const boostBps of [0, 250, 10_000]) assert.equal(problemWith({ ...single(), boostBps }), 'added', String(boostBps))
  assert.equal(problemWith({ stakeCents: 2500, boostBps: 0, legs: [] }), 'no legs')

  const games = (count: number) => Array.from({ length: count }, (_, i) => entryLeg(910_000 + i, { odds: -100_000 }))
  assert.equal(problemWith({ stakeCents: 2500, boostBps: 0, legs: games(MAX_LEGS_PER_PARLAY) }), 'added', '40 legs')
  assert.equal(problemWith({ stakeCents: 2500, boostBps: 0, legs: games(MAX_LEGS_PER_PARLAY + 1) }), 'too many legs')

  for (const fixtureId of [900_101, 900_201, 900_202, 900_301, 999_999]) {
    assert.equal(problemWith({ stakeCents: 2500, boostBps: 0, legs: [entryLeg(fixtureId)] }), 'not this week', String(fixtureId))
  }
  for (const pick of ['X', 'h', '']) assert.equal(problemWith(single({ pick: pick as Pick })), 'pick', pick)
  for (const odds of [99, -99, 0, 150.5, 100_001, Number.NaN]) assert.equal(problemWith(single({ odds })), 'odds', String(odds))
  for (const confidence of [0, 6, 2.5, Number.NaN]) assert.equal(problemWith(single({ confidence })), 'confidence', String(confidence))
  const huge = { stakeCents: 1_000_000, boostBps: 0, legs: [entryLeg(900_001, { odds: 100_000 }), entryLeg(900_002, { odds: 100_000 })] }
  assert.equal(problemWith(huge), 'payout too big')
  // $10,000 at +99900 and +900 pays exactly $100 million, until a boost tips it over.
  const atLimit = { stakeCents: 1_000_000, boostBps: 0, legs: [entryLeg(900_001, { odds: 99_900 }), entryLeg(900_002, { odds: 900 })] }
  assert.equal(problemWith(atLimit), 'added')
  assert.equal(problemWith({ ...atLimit, boostBps: 1 }), 'payout too big')
})

test('a full week takes nothing more', () => {
  const full = weekOf(...Array.from({ length: MAX_PARLAYS }, (_, i) => parlay(i + 1, [leg(i + 1)])))
  assert.equal(problemWith(single(), full), 'week full', '100 parlays')

  // 499 legs, so one more fits but two don't.
  const nearlyFull = weekOf(...Array.from({ length: 12 }, (_, i) => parlay(i + 1, cheapLegs(i * 40 + 1, 40))), parlay(13, cheapLegs(481, 19)))
  assert.equal(isWeekRecord(nearlyFull), true)
  assert.equal(problemWith(single(), nearlyFull), 'added')
  assert.equal(problemWith({ stakeCents: 2500, boostBps: 0, legs: [entryLeg(900_001), entryLeg(900_002)] }, nearlyFull), 'week full')
})

test('a game whose details look wrong is refused', () => {
  for (const odd of [{ home: 'Man City' }, { away: '' }, { kickoff: '2026-11-07T17:30:00+00:00' }]) {
    assert.equal(problemWith(single(), EMPTY_WEEK, [fixture(900_001, 'MCI', 'LIV', odd)]), 'bad fixture', JSON.stringify(odd))
  }
})

test("checking a changed week against that week's fixtures", () => {
  const first = added(addParlay(EMPTY_WEEK, WEEK, FIXTURES, { stakeCents: 2500, boostBps: 0, legs: [entryLeg(900_001), entryLeg(900_002)] })).record
  const week = added(addParlay(first, WEEK, FIXTURES, { stakeCents: 1000, boostBps: 0, legs: [entryLeg(900_003)] })).record
  assert.equal(checkWeek(week, WEEK, FIXTURES), null)
  assert.equal(checkWeek(EMPTY_WEEK, WEEK, FIXTURES), null)
  assert.equal(checkWeek(withField([...LEG, 'fixtureId'], 900_101, week) as WeekRecord, WEEK, FIXTURES), 'not this week', 'a leg moved to next week')
  assert.equal(checkWeek(withField(['parlays', 1, 'legs', 0, 'fixtureId'], 900_101, week) as WeekRecord, WEEK, FIXTURES), 'not this week', 'the same in the second parlay')
  assert.equal(checkWeek(week, { ...WEEK, period: 'MW12' }, FIXTURES), 'not this week', 'the wrong week')
  assert.equal(checkWeek(week, { ...WEEK, competition: 'UCL' }, FIXTURES), 'not this week', 'the wrong competition')
  assert.equal(checkWeek(week, { ...WEEK, season: 2025 }, FIXTURES), 'not this week', 'the wrong season')
  assert.equal(checkWeek(withField(['parlays', 0, 'stakeCents'], 0, week) as WeekRecord, WEEK, FIXTURES), 'shape')
})
