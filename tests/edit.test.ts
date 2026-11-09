// Tests for changing saved parlays: src/lib/bets/edit.ts, and the bet slip
// in src/lib/bets/slip.ts, which Build parlay saves through. Made-up games;
// the odds and stakes are the kind KMan types in from bet365.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isDeepStrictEqual } from 'node:util'
import { lockedChanges } from '../src/lib/bets/audit.ts'
import { MATCH_WORDS, removeParlay, replaceParlay, setHowItSettles, waitingReason } from '../src/lib/bets/edit.ts'
import { parseBoost, parseOdds, parseStake } from '../src/lib/bets/inputs.ts'
import { settleByHand, settleWeek, voidLeg, type Waiting } from '../src/lib/bets/settle.ts'
import { EMPTY_SLIP, hasStarted, newSlipLeg, recordFromSlip, slipFor, type Slip } from '../src/lib/bets/slip.ts'
import { addParlay, isReason, EMPTY_WEEK, type NewParlay, type Week, type WeekRecord } from '../src/lib/bets/week-record.ts'
import type { Fixture } from '../src/lib/fixtures.ts'
import { MINUS } from '../src/lib/format.ts'

const WEEK: Week = { season: 2026, competition: 'PL', period: 'MW12' }
const NOW = '2026-11-22T15:20:00.000Z'
const NOW_MS = Date.parse(NOW)

// Game n of matchweek 12, Man City against Liverpool, not started.
function game(n: number, change: Partial<Fixture> = {}): Fixture {
  return {
    id: n, competition: 'PL', season: 2026, period: 'MW12', tie_leg: null, kickoff: '2026-11-21T15:00:00.000Z',
    home_team_id: 9001, away_team_id: 9002, home: 'MCI', away: 'LIV', status: 'scheduled', minute: null,
    home_90: null, away_90: null, home_ht: null, away_ht: null, home_et: null, away_et: null, home_pens: null, away_pens: null,
    ...change,
  }
}
const ended = (n: number, home: number, away: number) => game(n, { status: 'finished', home_90: home, away_90: away })
const later = (n: number) => game(n, { kickoff: '2026-11-29T15:00:00.000Z' })
const byId = (...games: Fixture[]) => new Map(games.map(each => [each.id, each]))

// A parlay added the way the slip adds one, so its legs carry the games' details.
function added(record: WeekRecord, games: ReadonlyMap<number, Fixture>, entry: NewParlay): WeekRecord {
  const result = addParlay(record, WEEK, [...games.values()], entry)
  assert.ok(result.ok)
  return result.record
}
const settle = (record: WeekRecord, games: ReadonlyMap<number, Fixture>) => settleWeek(record, games, NOW).record
const legOn = (record: WeekRecord, fixtureId: number, parlay = 0) => {
  const found = record.parlays[parlay].legs.find(each => each.fixtureId === fixtureId)
  assert.ok(found)
  return found
}
// The slip read into numbers, as Build parlay does before saving.
function entryOf(slip: Slip): NewParlay {
  const stakeCents = parseStake(slip.stake)
  const boostBps = parseBoost(slip.boost)
  assert.ok(stakeCents !== null && boostBps !== null)
  return {
    stakeCents, boostBps,
    legs: slip.legs.map(each => {
      const odds = parseOdds(each.odds)
      assert.ok(odds !== null)
      return { fixtureId: each.fixtureId, pick: each.pick, odds, confidence: each.confidence }
    }),
  }
}
function save(record: WeekRecord, slip: Slip, games: ReadonlyMap<number, Fixture>): WeekRecord {
  const result = recordFromSlip(record, WEEK, slip, entryOf(slip), games, NOW_MS)
  assert.ok(result.ok, JSON.stringify(result))
  return result.record
}
const POSTPONED = 'The match was postponed. bet365 voided the leg.'

test('Replacing a parlay keeps its place, its ID, and its legs on the same games', () => {
  const games = byId(ended(1, 3, 1), ended(2, 0, 1), later(3), later(4), later(5))
  let record = added(EMPTY_WEEK, games, { stakeCents: 2500, boostBps: 0, legs: [{ fixtureId: 1, pick: 'H', odds: -110, confidence: 3 }, { fixtureId: 2, pick: 'H', odds: 150, confidence: 2 }, { fixtureId: 3, pick: 'A', odds: 200, confidence: 1 }] })
  record = added(record, games, { stakeCents: 1000, boostBps: 0, legs: [{ fixtureId: 4, pick: 'D', odds: 250, confidence: 4 }] })
  record = settle(record, games)
  const [first, second] = record.parlays
  const result = replaceParlay(record, WEEK, [...games.values()], first.id, {
    stakeCents: 2000, boostBps: 250,
    legs: [{ fixtureId: 1, pick: 'H', odds: -120, confidence: 5 }, { fixtureId: 2, pick: 'A', odds: 150, confidence: 2 }, { fixtureId: 5, pick: 'H', odds: 120, confidence: 3 }],
  })
  assert.ok(result.ok)
  const [now, other] = result.record.parlays
  assert.equal(now.id, first.id)
  assert.equal(other, second) // the week's other parlay is left exactly as it was
  assert.equal(now.stakeCents, 2000)
  assert.equal(now.boostBps, 250)
  // Game 1: same pick, new odds and confidence, so it keeps its ID and its settlement.
  assert.equal(now.legs[0].id, first.legs[0].id)
  assert.equal(now.legs[0].odds, -120)
  assert.equal(now.legs[0].confidence, 5)
  assert.deepEqual(now.legs[0].settlement, first.legs[0].settlement)
  // Game 2: a new pick keeps the leg's ID, and settles again from the score.
  assert.equal(now.legs[1].id, first.legs[1].id)
  assert.equal(now.legs[1].settlement, null)
  // Game 3 is gone, and game 5 is a new leg with a new ID.
  assert.ok(!now.legs.some(each => each.id === first.legs[2].id))
  assert.ok(![...first.legs, ...second.legs].some(each => each.id === now.legs[2].id))

  assert.deepEqual(replaceParlay(record, WEEK, [...games.values()], '00000000-0000-4000-8000-0000000000ff', { stakeCents: 100, boostBps: 0, legs: [] }), { ok: false, problem: 'gone' })
  assert.deepEqual(replaceParlay(record, WEEK, [...games.values()], first.id, { stakeCents: 0, boostBps: 0, legs: [{ fixtureId: 1, pick: 'H', odds: -110, confidence: 3 }] }), { ok: false, problem: 'stake' })
  assert.deepEqual(replaceParlay(record, WEEK, [...games.values(), game(6, { period: 'MW13' })], first.id, { stakeCents: 100, boostBps: 0, legs: [{ fixtureId: 6, pick: 'H', odds: -110, confidence: 3 }] }), { ok: false, problem: 'not this week' })
})

test('Removing a parlay leaves the rest, and a parlay that is gone is an error', () => {
  const games = byId(later(1), later(2))
  let record = added(EMPTY_WEEK, games, { stakeCents: 2500, boostBps: 0, legs: [{ fixtureId: 1, pick: 'H', odds: -110, confidence: 3 }] })
  record = added(record, games, { stakeCents: 500, boostBps: 0, legs: [{ fixtureId: 2, pick: 'A', odds: 300, confidence: 1 }] })
  const after = removeParlay(record, record.parlays[0].id)
  assert.deepEqual(after.parlays, [record.parlays[1]])
  assert.throws(() => removeParlay(after, record.parlays[0].id), RangeError)
})

test('How a leg settles: from the score, by a promo or by hand, and the same again changes nothing', () => {
  const games = byId(ended(1, 0, 1), game(2, { status: 'live', minute: 70, home_90: 2, away_90: 0 }), game(3, { status: 'postponed' }))
  let record = added(EMPTY_WEEK, games, { stakeCents: 2500, boostBps: 0, legs: [1, 2, 3].map(fixtureId => ({ fixtureId, pick: 'H' as const, odds: -110, confidence: 3 })) })
  record = settle(record, games)
  const [onScore, live, waiting] = record.parlays[0].legs

  // Settled from the score, or not settled: "from the score" leaves it alone.
  assert.equal(setHowItSettles(record, onScore.id, { by: 'score' }, games, NOW), record)
  assert.equal(setHowItSettles(record, live.id, { by: 'score' }, games, NOW), record)

  // 2-Up paid out while the match was on.
  const promo = setHowItSettles(record, live.id, { by: 'promo', reason: '  2-Up: they went 2–0 up ' }, games, NOW)
  assert.deepEqual(legOn(promo, 2).settlement, { outcome: 'won', byScore: null, score90: null, how: 'override', reason: '2-Up: they went 2–0 up', promo: true, settledAt: NOW })
  assert.equal(setHowItSettles(promo, live.id, { by: 'promo', reason: '2-Up: they went 2–0 up' }, games, '2026-11-22T16:00:00.000Z'), promo)
  assert.equal(setHowItSettles(promo, live.id, { by: 'promo', reason: ' 2-Up: they went 2–0 up  ' }, games, '2026-11-22T16:00:00.000Z'), promo)
  // By hand instead: a different settlement, so it changes.
  const hand = setHowItSettles(promo, live.id, { by: 'hand', outcome: 'won', reason: '2-Up: they went 2–0 up' }, games, NOW)
  assert.equal(legOn(hand, 2).settlement?.promo, false)
  // The same reason with the other outcome is a change too.
  const handLost = setHowItSettles(hand, live.id, { by: 'hand', outcome: 'lost', reason: '2-Up: they went 2–0 up' }, games, NOW)
  assert.equal(legOn(handLost, 2).settlement?.outcome, 'lost')
  const paidEarly = setHowItSettles(hand, onScore.id, { by: 'hand', outcome: 'won', reason: 'bet365 paid it early' }, games, NOW)
  assert.deepEqual(legOn(paidEarly, 1).settlement, { outcome: 'won', byScore: 'lost', score90: [0, 1], how: 'override', reason: 'bet365 paid it early', promo: false, settledAt: NOW })

  // Back to the score: a settlement by hand comes off, and so does a void.
  assert.equal(legOn(setHowItSettles(paidEarly, onScore.id, { by: 'score' }, games, NOW), 1).settlement, null)
  const dropped = voidLeg(record, waiting.id, { outcome: 'dropped', reason: POSTPONED }, games, NOW)
  assert.equal(legOn(setHowItSettles(dropped, waiting.id, { by: 'score' }, games, NOW), 3).settlement, null)

  assert.throws(() => setHowItSettles(record, '00000000-0000-4000-8000-0000000000ff', { by: 'score' }, games, NOW), RangeError)
  assert.throws(() => setHowItSettles(record, live.id, { by: 'promo', reason: '   ' }, games, NOW), RangeError)
})

test('The reasons the app writes for a leg waiting for you', () => {
  assert.equal(waitingReason('postponed', 'drop'), 'The match was postponed. bet365 voided the leg.')
  assert.equal(waitingReason('cancelled', 'lost'), 'The match was cancelled. bet365 settled the leg as lost.')
  assert.equal(waitingReason('suspended', 'drop'), 'The match was suspended. bet365 voided the leg.')
  assert.equal(waitingReason('awarded', 'lost'), 'The match was awarded. bet365 settled the leg as lost.')
  assert.equal(waitingReason('missing', 'drop'), 'The game is missing from the feed. bet365 voided the leg.')
  for (const status of MATCH_WORDS.keys()) for (const kind of ['drop', 'lost'] as const) assert.ok(isReason(waitingReason(status, kind)))
})

test('A saved parlay fills the slip, and what the slip shows reads back the same', () => {
  const games = byId(ended(1, 2, 0), game(2, { status: 'live', home_90: 0, away_90: 0 }), ended(3, 0, 1), game(4, { status: 'postponed' }), game(5, { status: 'cancelled' }), later(6))
  let record = added(EMPTY_WEEK, games, {
    stakeCents: 2550, boostBps: 250,
    legs: [
      { fixtureId: 1, pick: 'H', odds: -110, confidence: 3 }, { fixtureId: 2, pick: 'H', odds: 150, confidence: 4 },
      { fixtureId: 3, pick: 'H', odds: -209, confidence: 2 }, { fixtureId: 4, pick: 'D', odds: 250, confidence: 1 },
      { fixtureId: 5, pick: 'A', odds: 100, confidence: 5 }, { fixtureId: 6, pick: 'A', odds: 100_000, confidence: 5 },
    ],
  })
  record = settle(record, games)
  const ids = record.parlays[0].legs.map(each => each.id)
  record = settleByHand(record, ids[1], { outcome: 'won', promo: true, reason: '2-Up' }, games, NOW)
  record = settleByHand(record, ids[2], { outcome: 'lost', promo: false, reason: 'bet365 settled it early' }, games, NOW)
  record = voidLeg(record, ids[3], { outcome: 'dropped', reason: POSTPONED }, games, NOW)
  record = voidLeg(record, ids[4], { outcome: 'lost', reason: waitingReason('cancelled', 'lost') }, games, NOW)

  const slip = slipFor(record, WEEK, record.parlays[0].id)
  assert.ok(slip !== null)
  assert.deepEqual({ ...slip, legs: [] }, { competition: 'PL', period: 'MW12', legs: [], stake: '25.50', boost: '2.5', editing: record.parlays[0].id, started: true })
  assert.deepEqual(slip.legs, [
    { fixtureId: 1, pick: 'H', odds: `${MINUS}110`, confidence: 3, how: 'score', outcome: 'won', reason: '', voided: null },
    { fixtureId: 2, pick: 'H', odds: '+150', confidence: 4, how: 'promo', outcome: 'won', reason: '2-Up', voided: null },
    { fixtureId: 3, pick: 'H', odds: `${MINUS}209`, confidence: 2, how: 'hand', outcome: 'lost', reason: 'bet365 settled it early', voided: null },
    { fixtureId: 4, pick: 'D', odds: '+250', confidence: 1, how: 'score', outcome: 'won', reason: '', voided: 'dropped' },
    { fixtureId: 5, pick: 'A', odds: '+100', confidence: 5, how: 'score', outcome: 'lost', reason: '', voided: 'lost' },
    { fixtureId: 6, pick: 'A', odds: '+100000', confidence: 5, how: 'score', outcome: 'won', reason: '', voided: null },
  ])
  assert.equal(slipFor(record, WEEK, '00000000-0000-4000-8000-0000000000ff'), null)

  // Saving it again, untouched, gives back exactly the same week, so
  // nothing is saved and nothing goes in the audit log.
  assert.ok(isDeepStrictEqual(save(record, slip, games), record))

  // Every stake, boost and price reads back as it was saved.
  for (const odds of [-100_000, -5000, -209, -110, -100, 100, 150, 5000, 100_000]) assert.equal(parseOdds(slipOf(odds, 0, 2500).legs[0].odds), odds)
  for (const boostBps of [0, 1, 10, 105, 250, 500, 10_000]) assert.equal(parseBoost(slipOf(-110, boostBps, 2500).boost), boostBps)
  assert.equal(slipOf(-110, 0, 2500).boost, '') // no boost leaves the box empty
  for (const stakeCents of [1, 10, 2550, 99_999, 1_000_000]) assert.equal(parseStake(slipOf(-110, 0, stakeCents).stake), stakeCents)
  function slipOf(odds: number, boostBps: number, stakeCents: number): Slip {
    const one = added(EMPTY_WEEK, games, { stakeCents, boostBps, legs: [{ fixtureId: 6, pick: 'H', odds, confidence: 3 }] })
    const filled = slipFor(one, WEEK, one.parlays[0].id)
    assert.ok(filled !== null)
    return filled
  }
})

test("A game has started once the feed says so, or once its kick-off has passed, unless it's waiting", () => {
  assert.equal(hasStarted(later(1), NOW_MS), false)
  assert.equal(hasStarted(game(1, { kickoff: '2026-11-22T15:20:00.000Z' }), NOW_MS), true)
  assert.equal(hasStarted(game(1, { kickoff: '2026-11-22T15:20:01.000Z' }), NOW_MS), false)
  for (const status of ['live', 'half_time', 'extra_time', 'penalties', 'finished'] as const) assert.equal(hasStarted({ ...later(1), status }, NOW_MS), true, status)
  for (const status of ['postponed', 'cancelled', 'suspended', 'awarded'] as const) assert.equal(hasStarted(game(1, { status }), NOW_MS), false, status)
})

test('A new parlay from the slip, logged after kick-off with a promo leg', () => {
  const games = byId(ended(1, 2, 1), game(2, { status: 'live', minute: 60, home_90: 2, away_90: 0 }), later(3))
  const slip: Slip = {
    ...EMPTY_SLIP, period: 'MW12', stake: '25', boost: '5',
    legs: [
      { ...newSlipLeg(1, 'H'), odds: '-209', confidence: 3 },
      { ...newSlipLeg(2, 'H'), odds: '−143', confidence: 4, how: 'promo', reason: ' 2-Up ' },
      { ...newSlipLeg(3, 'D'), odds: '+100', confidence: 2 },
    ],
  }
  assert.deepEqual(newSlipLeg(7, 'A'), { fixtureId: 7, pick: 'A', odds: '', confidence: 0, how: 'score', outcome: 'won', reason: '', voided: null })
  const before = added(EMPTY_WEEK, games, { stakeCents: 500, boostBps: 0, legs: [{ fixtureId: 3, pick: 'H', odds: 120, confidence: 1 }] })
  const after = save(before, slip, games)
  assert.equal(after.parlays.length, 2)
  assert.deepEqual(after.parlays[0], before.parlays[0])
  const made = after.parlays[1]
  assert.deepEqual(made.legs.map(each => [each.fixtureId, each.pick, each.odds, each.confidence]), [[1, 'H', -209, 3], [2, 'H', -143, 4], [3, 'D', 100, 2]])
  assert.equal(made.stakeCents, 2500)
  assert.equal(made.boostBps, 500)
  // Game 1 has finished, but it settles when settling runs after the save, like any other.
  assert.equal(made.legs[0].settlement, null)
  assert.deepEqual(made.legs[1].settlement, { outcome: 'won', byScore: null, score90: null, how: 'override', reason: '2-Up', promo: true, settledAt: NOW })
  assert.equal(made.legs[2].settlement, null)
  assert.deepEqual(recordFromSlip(before, WEEK, { ...slip, stake: '0' }, { ...entryOf(slip), stakeCents: 0 }, games, NOW_MS), { ok: false, problem: 'stake' })
})

test('Changing a locked parlay keeps a leg you dropped, even after its match is played', () => {
  // Game 3 was postponed and KMan dropped the leg, as bet365 voided it.
  // Weeks later the match is played, and he fixes the stake in Admin mode.
  const before = byId(ended(1, 3, 1), ended(2, 0, 2), game(3, { status: 'postponed' }))
  let record = added(EMPTY_WEEK, before, { stakeCents: 2500, boostBps: 0, legs: [{ fixtureId: 1, pick: 'H', odds: -300, confidence: 3 }, { fixtureId: 2, pick: 'A', odds: 120, confidence: 3 }, { fixtureId: 3, pick: 'H', odds: -110, confidence: 3 }] })
  record = settle(record, before)
  record = voidLeg(record, legOn(record, 3).id, { outcome: 'dropped', reason: POSTPONED }, before, NOW)
  const played = byId(ended(1, 3, 1), ended(2, 0, 2), ended(3, 1, 1))
  record = settle(record, played) // notes the 1–1, and the leg stays dropped
  const slip = slipFor(record, WEEK, record.parlays[0].id)
  assert.ok(slip !== null)
  assert.equal(slip.legs[2].voided, 'dropped')

  const after = save(record, { ...slip, stake: '20' }, played)
  assert.deepEqual(legOn(after, 3).settlement, legOn(record, 3).settlement)
  assert.deepEqual(lockedChanges(record, after), [{ what: 'Parlay 1 · stake in cents', from: 2500, to: 2000 }])

  // "Change how it settled" takes the drop off, and the leg settles from the
  // 1–1 like any other: a home pick on a draw loses.
  const reopened = save(record, { ...slip, legs: slip.legs.map((each, i) => (i === 2 ? { ...each, voided: null } : each)) }, played)
  assert.equal(legOn(reopened, 3).settlement, null)
  assert.deepEqual(legOn(settle(reopened, played), 3).settlement?.outcome, 'lost')
})

test("Taking a drop off a leg whose match hasn't been played sends it back to waiting for you", () => {
  const games = byId(ended(1, 3, 1), game(2, { status: 'postponed' }))
  let record = added(EMPTY_WEEK, games, { stakeCents: 1000, boostBps: 0, legs: [{ fixtureId: 1, pick: 'H', odds: -150, confidence: 3 }, { fixtureId: 2, pick: 'H', odds: 110, confidence: 3 }] })
  record = settle(record, games)
  record = voidLeg(record, legOn(record, 2).id, { outcome: 'lost', reason: waitingReason('postponed', 'lost') }, games, NOW)
  const slip = slipFor(record, WEEK, record.parlays[0].id)
  assert.ok(slip !== null)
  assert.equal(slip.legs[1].voided, 'lost')
  const after = save(record, { ...slip, legs: slip.legs.map((each, i) => (i === 1 ? { ...each, voided: null } : each)) }, games)
  assert.equal(legOn(after, 2).settlement, null)
  const waiting: Waiting[] = settleWeek(after, games, NOW).waiting
  assert.deepEqual(waiting, [{ parlayId: after.parlays[0].id, legId: legOn(after, 2).id, fixtureId: 2, status: 'postponed' }])
})

test('On the slip, back to "from the score" takes a settlement by hand off, and a new pick settles again', () => {
  const games = byId(ended(1, 0, 1), ended(2, 2, 2))
  let record = added(EMPTY_WEEK, games, { stakeCents: 1000, boostBps: 0, legs: [{ fixtureId: 1, pick: 'H', odds: -150, confidence: 3 }, { fixtureId: 2, pick: 'H', odds: 250, confidence: 3 }] })
  record = settle(record, games)
  record = settleByHand(record, legOn(record, 1).id, { outcome: 'won', promo: false, reason: 'bet365 paid it early' }, games, NOW)
  const slip = slipFor(record, WEEK, record.parlays[0].id)
  assert.ok(slip !== null)
  assert.equal(slip.legs[0].how, 'hand')

  const byScore = save(record, { ...slip, legs: slip.legs.map((each, i) => (i === 0 ? { ...each, how: 'score' } : each)) }, games)
  assert.equal(legOn(byScore, 1).settlement, null)
  assert.equal(legOn(byScore, 2).settlement, legOn(record, 2).settlement)

  // Build parlay sets a swapped pick back to "from the score".
  const swapped = save(record, { ...slip, legs: slip.legs.map((each, i) => (i === 1 ? { ...each, pick: 'D', how: 'score', voided: null } : each)) }, games)
  assert.equal(legOn(swapped, 2).id, legOn(record, 2).id)
  assert.equal(legOn(swapped, 2).settlement, null)
  assert.equal(legOn(settle(swapped, games), 2).settlement?.outcome, 'won')

  // Removed in another tab while the slip was open.
  assert.deepEqual(recordFromSlip(EMPTY_WEEK, WEEK, slip, entryOf(slip), games, NOW_MS), { ok: false, problem: 'gone' })
})
