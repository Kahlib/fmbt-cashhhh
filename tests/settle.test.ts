// Tests for src/lib/bets/settle.ts: legs settling themselves on the 90-minute
// score, every match status, settling by hand, promos, dropped legs,
// corrections, and what each parlay pays. Every sample here is made up.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  acceptCorrection, cashPayout, cashStake, finalScore90, isParlayLocked, parlayOutcome, settleByHand, settleWeek, unsettleLeg, voidLeg,
  type FixtureScore,
} from '../src/lib/bets/settle.ts'
import { isWeekRecord, type Pick, type Settlement, type WeekRecord } from '../src/lib/bets/week-record.ts'
import { deepFreeze, leg, legsOf, parlay, uuid, weekOf } from './bet-samples.ts'

const NOW = '2026-11-07T19:35:00.000Z'
const LATER = '2026-11-08T09:00:00.000Z'

// Game 900000 + n in the fixtures table, with its 90-minute score.
function game(n: number, status: string, score: [number, number] | null = null): FixtureScore {
  return { id: 900_000 + n, status, home_90: score === null ? null : score[0], away_90: score === null ? null : score[1] }
}
const gamesOf = (...games: FixtureScore[]) => new Map(games.map(each => [each.id, each]))

// The settlement of the week's first leg, or of leg `index`, counting across parlays.
const settlementOf = (record: WeekRecord, index = 0) => legsOf(record)[index]?.settlement

// ---------------------------------------------------------------------------
// Settling from the fixtures
// ---------------------------------------------------------------------------

test('only a final 90-minute score settles anything', () => {
  assert.deepEqual(finalScore90(game(1, 'finished', [2, 1])), [2, 1])
  assert.deepEqual(finalScore90(game(1, 'extra_time', [1, 1])), [1, 1])
  assert.deepEqual(finalScore90(game(1, 'penalties', [0, 0])), [0, 0])
  for (const status of ['scheduled', 'live', 'half_time', 'postponed', 'suspended', 'cancelled', 'awarded']) {
    assert.equal(finalScore90(game(1, status, [1, 0])), null, status)
  }
  assert.equal(finalScore90(game(1, 'finished')), null, 'finished, with no score')
  assert.equal(finalScore90({ id: 900_001, status: 'finished', home_90: 2, away_90: null }), null, 'half a score')
  assert.equal(finalScore90(undefined), null, 'no such game')
})

test('legs settle themselves on the 90-minute score', () => {
  const week = weekOf(parlay(1, [leg(1), leg(2, { pick: 'D' })]), parlay(2, [leg(3, { pick: 'A' })]))
  const result = settleWeek(week, gamesOf(game(1, 'finished', [2, 1]), game(2, 'finished', [1, 1]), game(3, 'finished', [2, 0])), NOW)
  assert.equal(result.settled, 3)
  assert.deepEqual(legsOf(result.record).map(each => each.settlement), [
    { outcome: 'won', byScore: 'won', score90: [2, 1], how: 'auto', reason: null, promo: false, settledAt: NOW },
    { outcome: 'won', byScore: 'won', score90: [1, 1], how: 'auto', reason: null, promo: false, settledAt: NOW },
    { outcome: 'lost', byScore: 'lost', score90: [2, 0], how: 'auto', reason: null, promo: false, settledAt: NOW },
  ])
  assert.deepEqual([result.noted, result.corrections, result.waiting], [0, [], []])
  assert.equal(isWeekRecord(result.record), true)
})

test('every pick against every kind of result, worked out by hand', () => {
  const cases: [Pick, [number, number], 'won' | 'lost'][] = [
    ['H', [1, 0], 'won'], ['H', [4, 2], 'won'], ['H', [0, 0], 'lost'], ['H', [0, 1], 'lost'],
    ['D', [0, 0], 'won'], ['D', [3, 3], 'won'], ['D', [1, 0], 'lost'], ['D', [0, 1], 'lost'],
    ['A', [0, 1], 'won'], ['A', [2, 5], 'won'], ['A', [1, 1], 'lost'], ['A', [2, 1], 'lost'],
  ]
  for (const [pick, score, outcome] of cases) {
    const result = settleWeek(weekOf(parlay(1, [leg(1, { pick })])), gamesOf(game(1, 'finished', score)), NOW)
    assert.equal(settlementOf(result.record)?.outcome, outcome, `${pick} on ${score.join('-')}`)
    assert.equal(isWeekRecord(result.record), true)
  }
})

test('a game in two parlays settles in both', () => {
  const week = weekOf(parlay(1, [leg(1)]), parlay(2, [leg(2, { fixtureId: 900_001, pick: 'A' })]))
  const result = settleWeek(week, gamesOf(game(1, 'finished', [3, 1])), NOW)
  assert.deepEqual(legsOf(result.record).map(each => each.settlement?.outcome), ['won', 'lost'])
})

test('a match that goes to extra time or penalties settles on its 90 minutes', () => {
  // Both games were 1-1 after 90 minutes. Whoever wins in extra time or on
  // penalties, a draw pick wins and a home pick loses.
  const week = weekOf(parlay(1, [leg(1, { pick: 'D' }), leg(2, { pick: 'H' })]))
  const result = settleWeek(week, gamesOf(game(1, 'extra_time', [1, 1]), game(2, 'penalties', [1, 1])), NOW)
  assert.deepEqual(legsOf(result.record).map(each => each.settlement?.outcome), ['won', 'lost'])
})

test('a game still to finish waits quietly, even with a score', () => {
  const week = weekOf(parlay(1, [leg(1), leg(2), leg(3)]))
  const result = settleWeek(week, gamesOf(game(1, 'scheduled'), game(2, 'live', [1, 0]), game(3, 'half_time', [2, 0])), NOW)
  assert.equal(result.record, week, "the same record back, so there's nothing to save")
  assert.deepEqual([result.settled, result.waiting], [0, []])
})

test('postponed, cancelled, suspended, awarded and missing games wait for you', () => {
  const week = weekOf(parlay(1, [leg(1), leg(2), leg(3), leg(4)]), parlay(2, [leg(5)]))
  const games = gamesOf(game(1, 'postponed'), game(2, 'cancelled'), game(3, 'suspended', [1, 0]), game(4, 'awarded', [3, 0]))
  const result = settleWeek(week, games, NOW)
  assert.equal(result.record, week, 'none of them settles itself')
  assert.deepEqual(result.waiting, [
    { parlayId: uuid(1), legId: uuid(1001), fixtureId: 900_001, status: 'postponed' },
    { parlayId: uuid(1), legId: uuid(1002), fixtureId: 900_002, status: 'cancelled' },
    { parlayId: uuid(1), legId: uuid(1003), fixtureId: 900_003, status: 'suspended' },
    { parlayId: uuid(1), legId: uuid(1004), fixtureId: 900_004, status: 'awarded' },
    { parlayId: uuid(2), legId: uuid(1005), fixtureId: 900_005, status: 'missing' },
  ])
})

test('a suspended match that finishes later settles itself then', () => {
  const first = settleWeek(weekOf(parlay(1, [leg(1)])), gamesOf(game(1, 'suspended', [1, 0])), NOW)
  assert.equal(first.waiting.length, 1)
  const second = settleWeek(first.record, gamesOf(game(1, 'finished', [2, 0])), LATER)
  assert.equal(second.settled, 1)
  assert.deepEqual(second.waiting, [])
  assert.deepEqual(settlementOf(second.record), { outcome: 'won', byScore: 'won', score90: [2, 0], how: 'auto', reason: null, promo: false, settledAt: LATER })
})

test("settling again changes nothing, and the record it's given never changes", () => {
  const week = deepFreeze(weekOf(parlay(1, [leg(1), leg(2, { pick: 'A' })])))
  const games = gamesOf(game(1, 'finished', [2, 1]), game(2, 'finished', [2, 1]))
  const first = settleWeek(week, games, NOW)
  assert.equal(first.settled, 2)
  assert.equal(legsOf(week).every(each => each.settlement === null), true, 'the record it was given is unchanged')
  const again = settleWeek(deepFreeze(first.record), games, LATER)
  assert.equal(again.record, first.record, 'the same record back')
  assert.deepEqual([again.settled, again.noted, again.corrections, again.waiting], [0, 0, [], []])
})

// ---------------------------------------------------------------------------
// Corrections
// ---------------------------------------------------------------------------

// A draw pick that settled itself as won on 1-1, and leg 2, not yet settled.
function settledOnOneOne() {
  return settleWeek(weekOf(parlay(1, [leg(1, { pick: 'D' }), leg(2)])), gamesOf(game(1, 'finished', [1, 1])), NOW).record
}

test('a new score on a leg that settled itself is a correction, which waits for your yes', () => {
  const week = settledOnOneOne()
  const corrected = gamesOf(game(1, 'finished', [2, 1]))
  const result = settleWeek(week, corrected, LATER)
  assert.equal(result.record, week, 'nothing changes until you say so')
  assert.deepEqual(result.corrections, [{ parlayId: uuid(1), legId: uuid(1001), fixtureId: 900_001, from: [1, 1], to: [2, 1] }])

  const accepted = acceptCorrection(deepFreeze(week), uuid(1001), corrected, LATER)
  assert.deepEqual(settlementOf(accepted), { outcome: 'lost', byScore: 'lost', score90: [2, 1], how: 'auto', reason: null, promo: false, settledAt: LATER })
  assert.equal(settlementOf(accepted, 1), null, 'the other leg is left alone')
  assert.equal(isWeekRecord(accepted), true)
  assert.deepEqual(settleWeek(accepted, corrected, LATER).corrections, [], 'asked once')
})

test('a correction still waits when another leg settles in the same run', () => {
  const result = settleWeek(settledOnOneOne(), gamesOf(game(1, 'finished', [2, 1]), game(2, 'finished', [2, 0])), LATER)
  assert.equal(result.settled, 1, 'leg 2 settles')
  assert.equal(result.corrections.length, 1)
  assert.deepEqual(settlementOf(result.record), {
    outcome: 'won', byScore: 'won', score90: [1, 1], how: 'auto', reason: null, promo: false, settledAt: NOW,
  }, 'leg 1 is left as it was')
})

test('accepting a correction that is not there throws', () => {
  const week = settledOnOneOne()
  const cases: [string, string, Map<number, FixtureScore>][] = [
    ['the score has not changed', uuid(1001), gamesOf(game(1, 'finished', [1, 1]))],
    ['the match now has no final score', uuid(1001), gamesOf(game(1, 'awarded', [3, 0]))],
    ['the game is missing', uuid(1001), gamesOf()],
    ['the leg has not settled', uuid(1002), gamesOf(game(2, 'finished', [2, 0]))],
    ['there is no such leg', uuid(9999), gamesOf(game(1, 'finished', [2, 1]))],
  ]
  for (const [name, legId, games] of cases) assert.throws(() => acceptCorrection(week, legId, games, LATER), RangeError, name)
  const byHand = settleByHand(week, uuid(1001), { outcome: 'won', promo: false, reason: 'Book paid it' }, gamesOf(game(1, 'finished', [1, 1])), LATER)
  assert.throws(() => acceptCorrection(byHand, uuid(1001), gamesOf(game(1, 'finished', [2, 1])), LATER), RangeError, 'settled by hand')
})

test('a leg you settled by hand stays as you set it', () => {
  // The home side went two up, the book paid out early, and it ended 1-1.
  const games = gamesOf(game(1, 'finished', [1, 1]))
  const week = settleByHand(weekOf(parlay(1, [leg(1)])), uuid(1001), { outcome: 'won', promo: true, reason: '2-Up paid out early' }, games, NOW)
  assert.deepEqual(settlementOf(week), {
    outcome: 'won', byScore: 'lost', score90: [1, 1], how: 'override', reason: '2-Up paid out early', promo: true, settledAt: NOW,
  })
  assert.equal(isWeekRecord(week), true)
  const result = settleWeek(week, gamesOf(game(1, 'finished', [2, 1])), LATER)
  assert.equal(result.record, week)
  assert.deepEqual(result.corrections, [], 'never asked about')
})

// ---------------------------------------------------------------------------
// Settling by hand, voiding, and taking a settlement away
// ---------------------------------------------------------------------------

test('a leg settled by hand before its score was final gets the score noted later', () => {
  const week = settleByHand(weekOf(parlay(1, [leg(1)])), uuid(1001), { outcome: 'lost', promo: false, reason: 'Book settled it as lost' }, gamesOf(game(1, 'suspended', [0, 1])), NOW)
  assert.equal(settlementOf(week)?.score90, null)
  const result = settleWeek(week, gamesOf(game(1, 'finished', [2, 1])), LATER)
  assert.equal(result.noted, 1)
  assert.deepEqual(settlementOf(result.record), {
    outcome: 'lost', byScore: 'won', score90: [2, 1], how: 'override', reason: 'Book settled it as lost', promo: false, settledAt: NOW,
  })
  assert.equal(isWeekRecord(result.record), true)
  const again = settleWeek(result.record, gamesOf(game(1, 'finished', [3, 1])), LATER)
  assert.equal(again.record, result.record, 'noted once, and never changed after')
  assert.deepEqual([again.noted, again.corrections], [0, []])
})

test('settling by hand needs a reason, and only a leg that pays can be a promo', () => {
  const week = weekOf(parlay(1, [leg(1)]))
  const games = gamesOf(game(1, 'finished', [1, 1]))
  for (const reason of ['', '   ', 'x'.repeat(201), 'two\nlines']) {
    assert.throws(() => settleByHand(week, uuid(1001), { outcome: 'won', promo: false, reason }, games, NOW), RangeError, JSON.stringify(reason))
  }
  assert.throws(() => settleByHand(week, uuid(1001), { outcome: 'lost', promo: true, reason: 'Promo' }, games, NOW), RangeError)
  const won = settleByHand(week, uuid(1001), { outcome: 'won', promo: false, reason: '  Book paid it as a win  ' }, games, NOW)
  assert.deepEqual(settlementOf(won), {
    outcome: 'won', byScore: 'lost', score90: [1, 1], how: 'override', reason: 'Book paid it as a win', promo: false, settledAt: NOW,
  })
  assert.equal(isWeekRecord(won), true)
})

test('voiding a leg drops it, or counts it as lost', () => {
  const week = weekOf(parlay(1, [leg(1), leg(2, { odds: -200 })]))
  const games = gamesOf(game(1, 'postponed'), game(2, 'finished', [3, 0]))
  const dropped = voidLeg(week, uuid(1001), { outcome: 'dropped', reason: ' Postponed ' }, games, NOW)
  assert.deepEqual(settlementOf(dropped), { outcome: 'dropped', byScore: null, score90: null, how: 'void', reason: 'Postponed', promo: false, settledAt: NOW })
  const lost = voidLeg(week, uuid(1001), { outcome: 'lost', reason: 'Book counted it as lost' }, games, NOW)
  assert.equal(settlementOf(lost)?.outcome, 'lost')
  for (const record of [dropped, lost]) assert.equal(isWeekRecord(record), true)
  assert.throws(() => voidLeg(week, uuid(1001), { outcome: 'dropped', reason: '' }, games, NOW), RangeError)

  // The match is played later: its score is noted, and the leg stays dropped.
  const played = settleWeek(dropped, gamesOf(game(1, 'finished', [0, 2]), game(2, 'finished', [3, 0])), LATER)
  assert.deepEqual([played.settled, played.noted], [1, 1])
  assert.deepEqual(settlementOf(played.record), { outcome: 'dropped', byScore: 'lost', score90: [0, 2], how: 'void', reason: 'Postponed', promo: false, settledAt: NOW })
  assert.equal(isWeekRecord(played.record), true)
})

test('voiding a leg whose match finished keeps its score', () => {
  const games = gamesOf(game(1, 'finished', [2, 0]))
  const week = voidLeg(weekOf(parlay(1, [leg(1)])), uuid(1001), { outcome: 'dropped', reason: 'Book voided it' }, games, NOW)
  assert.deepEqual(settlementOf(week), { outcome: 'dropped', byScore: 'won', score90: [2, 0], how: 'void', reason: 'Book voided it', promo: false, settledAt: NOW })
  assert.equal(isWeekRecord(week), true)
})

test('taking a settlement away lets the leg settle again', () => {
  const games = gamesOf(game(1, 'finished', [2, 1]))
  const byHand = settleByHand(weekOf(parlay(1, [leg(1)])), uuid(1001), { outcome: 'lost', promo: false, reason: 'Entered by mistake' }, games, NOW)
  const cleared = unsettleLeg(deepFreeze(byHand), uuid(1001))
  assert.equal(settlementOf(cleared), null)
  assert.equal(settlementOf(byHand)?.outcome, 'lost', 'the record it was given is unchanged')
  assert.equal(settlementOf(settleWeek(cleared, games, LATER).record)?.outcome, 'won')
})

test('an unknown leg or a bad time throws', () => {
  const week = settledOnOneOne()
  const games = gamesOf(game(1, 'finished', [2, 1]), game(2, 'finished', [2, 0]))
  for (const now of ['today', '2026-11-07', '2026-11-07T19:35:00+00:00', '']) {
    assert.throws(() => settleWeek(week, games, now), RangeError, now)
    assert.throws(() => acceptCorrection(week, uuid(1001), games, now), RangeError, now)
    assert.throws(() => settleByHand(week, uuid(1002), { outcome: 'won', promo: false, reason: 'Paid' }, games, now), RangeError, now)
    assert.throws(() => voidLeg(week, uuid(1002), { outcome: 'dropped', reason: 'Postponed' }, games, now), RangeError, now)
  }
  assert.throws(() => settleByHand(week, uuid(9999), { outcome: 'won', promo: false, reason: 'Paid' }, games, NOW), RangeError)
  assert.throws(() => voidLeg(week, uuid(9999), { outcome: 'dropped', reason: 'Postponed' }, games, NOW), RangeError)
  assert.throws(() => unsettleLeg(week, uuid(9999)), RangeError)
})

// ---------------------------------------------------------------------------
// What a parlay pays, and locking
// ---------------------------------------------------------------------------

// A settlement for a home pick: won on 2-0, lost on 0-2, or dropped.
function settled(outcome: 'won' | 'lost' | 'dropped'): Settlement {
  if (outcome === 'dropped') return { outcome, byScore: null, score90: null, how: 'void', reason: 'Postponed', promo: false, settledAt: NOW }
  return { outcome, byScore: outcome, score90: outcome === 'won' ? [2, 0] : [0, 2], how: 'auto', reason: null, promo: false, settledAt: NOW }
}

test('what a parlay pays, worked out by hand', () => {
  // $25 on +150 and -200.
  const two = (first: Settlement | null, second: Settlement | null) =>
    parlay(1, [leg(1, { odds: 150, settlement: first }), leg(2, { odds: -200, settlement: second })])
  const pending = { state: 'pending', payoutCents: null, profitCents: null }
  const lost = { state: 'lost', payoutCents: 0, profitCents: -2500 }

  assert.deepEqual(parlayOutcome(two(settled('won'), settled('won'))), { state: 'won', payoutCents: 9375, profitCents: 6875 }, '25 × 2.5 × 1.5')
  assert.deepEqual(parlayOutcome(two(null, null)), pending)
  assert.deepEqual(parlayOutcome(two(settled('won'), null)), pending)
  assert.deepEqual(parlayOutcome(two(settled('lost'), null)), lost, 'lost as soon as any leg loses')
  assert.deepEqual(parlayOutcome(two(settled('won'), settled('lost'))), lost)
  assert.deepEqual(parlayOutcome(two(settled('won'), settled('dropped'))), { state: 'won', payoutCents: 6250, profitCents: 3750 }, 'repriced without the dropped leg: 25 × 2.5')
  assert.deepEqual(parlayOutcome(two(settled('dropped'), settled('won'))), { state: 'won', payoutCents: 3750, profitCents: 1250 }, '25 × 1.5')
  assert.deepEqual(parlayOutcome(two(settled('dropped'), settled('dropped'))), { state: 'void', payoutCents: 2500, profitCents: 0 }, 'every leg dropped gives the stake back')
  assert.deepEqual(parlayOutcome(two(settled('dropped'), null)), pending)
  assert.deepEqual(parlayOutcome(two(settled('dropped'), settled('lost'))), lost)
  assert.deepEqual(parlayOutcome(two({ ...settled('dropped'), outcome: 'lost' }, settled('won'))), lost, 'a leg voided as lost')

  // A 2-Up promo pays at its odds, though the score said lost.
  const promo: Settlement = { outcome: 'won', byScore: 'lost', score90: [1, 1], how: 'override', reason: '2-Up paid out early', promo: true, settledAt: NOW }
  assert.deepEqual(parlayOutcome(two(promo, settled('won'))), { state: 'won', payoutCents: 9375, profitCents: 6875 })

  // A $50 single on -110 pays $95.4545..., so $95.45.
  const single = parlay(1, [leg(1, { odds: -110, settlement: settled('won') })], { stakeCents: 5000 })
  assert.deepEqual(parlayOutcome(single), { state: 'won', payoutCents: 9545, profitCents: 4545 })

  // $25 on -110, -120 and +105 is exactly $179.375, which rounds up to
  // $179.38, as bet365 rounds a parlay.
  const three = parlay(1, [-110, -120, 105].map((odds, i) => leg(i + 1, { odds, settlement: settled('won') })))
  assert.deepEqual(parlayOutcome(three), { state: 'won', payoutCents: 17_938, profitCents: 15_438 })

  // A boost is a percent of the profit: 2.5% of the $68.75 profit on the
  // first parlay is $1.71875, which rounds up to $1.72, so it returns $95.47.
  const boosted = { ...two(settled('won'), settled('won')), boostBps: 250 }
  assert.deepEqual(parlayOutcome(boosted), { state: 'won', payoutCents: 9547, profitCents: 7047 })
  assert.deepEqual(parlayOutcome({ ...two(settled('won'), settled('lost')), boostBps: 250 }), lost, 'a boost on a lost parlay pays nothing')
  assert.deepEqual(parlayOutcome({ ...two(settled('dropped'), settled('dropped')), boostBps: 250 }), { state: 'void', payoutCents: 2500, profitCents: 0 }, 'nor on a void one')
})

test('a parlay locks once every leg in it is settled, whatever the others in its week do', () => {
  const week = weekOf(parlay(1, [leg(1)]), parlay(2, [leg(2), leg(3)]))
  const locks = (record: typeof week) => record.parlays.map(isParlayLocked)
  assert.deepEqual(locks(week), [false, false])
  const games = gamesOf(game(1, 'finished', [2, 0]), game(2, 'finished', [0, 0]), game(3, 'postponed'))
  const partly = settleWeek(week, games, NOW).record
  assert.deepEqual(locks(partly), [true, false], 'the first parlay is settled, and the second has a leg still open')
  const all = voidLeg(partly, uuid(1003), { outcome: 'dropped', reason: 'Postponed' }, games, NOW)
  assert.deepEqual(locks(all), [true, true], 'a dropped leg counts as settled')
  assert.deepEqual(locks(unsettleLeg(all, uuid(1001))), [false, true], 'taking a settlement away opens only its own parlay')
  assert.equal(isParlayLocked({ ...parlay(3, []), legs: [] }), false, 'a parlay with no legs, which no record can hold, never locks')
})

test('A bonus bet costs nothing, and pays only its winnings', () => {
  // $25 of bonus money on +150 and -200: bet365 keeps the stake and pays the
  // $68.75 winnings.
  const two = (first: Settlement | null, second: Settlement | null) =>
    parlay(1, [leg(1, { odds: 150, settlement: first }), leg(2, { odds: -200, settlement: second })], { bonus: true })
  assert.deepEqual(parlayOutcome(two(settled('won'), settled('won'))), { state: 'won', payoutCents: 6875, profitCents: 6875 }, '$93.75 less the $25 stake')
  assert.deepEqual(parlayOutcome(two(settled('won'), settled('lost'))), { state: 'lost', payoutCents: 0, profitCents: 0 }, 'losing costs nothing')
  assert.ok(Object.is(parlayOutcome(two(settled('lost'), null)).profitCents, 0), 'a lost bonus bet is 0, never -0')
  assert.deepEqual(parlayOutcome(two(settled('dropped'), settled('dropped'))), { state: 'void', payoutCents: 0, profitCents: 0 }, 'it comes back as bonus money')
  assert.deepEqual(parlayOutcome(two(null, null)), { state: 'pending', payoutCents: null, profitCents: null })
  // What the pages use.
  const own = parlay(2, [leg(3)])
  assert.deepEqual([cashStake(own), cashStake(two(null, null))], [2500, 0])
  assert.deepEqual([cashPayout(own, 9375), cashPayout(two(null, null), 9375)], [9375, 6875])
})
