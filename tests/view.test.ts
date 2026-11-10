// Tests for src/lib/bets/view.ts: what My parlays shows for each leg, parlay
// and week, and how audit changes read. The numbers are KMan's bet365
// slips from 8 November 2026; the games and teams are made up.
process.env.TZ = 'America/Toronto'

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { lockedChanges } from '../src/lib/bets/audit.ts'
import { settleByHand, settleWeek, voidLeg, type FixtureScore } from '../src/lib/bets/settle.ts'
import { changeWords, legPlace, legState, parlayView, standing, weekSentence, weekSummary, type LegState } from '../src/lib/bets/view.ts'
import type { Leg, WeekRecord } from '../src/lib/bets/week-record.ts'
import type { Fixture } from '../src/lib/fixtures.ts'
import { leg, parlay, uuid, weekOf } from './bet-samples.ts'

const NOW = '2026-11-22T15:20:00.000Z'

// Game 900000 + n, Man City against Liverpool in matchweek 12, not started.
function game(n: number, change: Partial<Fixture> = {}): Fixture {
  return {
    id: 900_000 + n, competition: 'PL', season: 2026, period: 'MW12', tie_leg: null, kickoff: '2026-11-21T15:00:00.000Z',
    home_team_id: 9001, away_team_id: 9002, home: 'MCI', away: 'LIV', status: 'scheduled', minute: null,
    home_90: null, away_90: null, home_ht: null, away_ht: null, home_et: null, away_et: null, home_pens: null, away_pens: null,
    ...change,
  }
}
const ended = (n: number, home: number, away: number, change: Partial<Fixture> = {}) => game(n, { status: 'finished', home_90: home, away_90: away, ...change })
const byId = (...games: Fixture[]) => new Map(games.map(each => [each.id, each]))
const settled = (record: WeekRecord, games: ReadonlyMap<number, FixtureScore>) => settleWeek(record, games, NOW).record
const legOf = (record: WeekRecord, p: number, l: number): Leg => record.parlays[p].legs[l]

test('How a leg stands while its match is on', () => {
  assert.equal(standing('H', [2, 1]), 'on track')
  assert.equal(standing('H', [1, 1]), 'level')
  assert.equal(standing('H', [0, 1]), 'behind')
  assert.equal(standing('A', [0, 1]), 'on track')
  assert.equal(standing('A', [2, 2]), 'level')
  assert.equal(standing('A', [3, 1]), 'behind')
  assert.equal(standing('D', [1, 1]), 'on track')
  assert.equal(standing('D', [0, 0]), 'on track')
  assert.equal(standing('D', [2, 1]), 'behind')
})

test('An unsettled leg: waiting, finished, live or not started', () => {
  const home = { pick: 'H' as const, settlement: null }
  const states: [Fixture | undefined, LegState][] = [
    [undefined, { kind: 'waiting', status: 'missing' }],
    [game(1, { status: 'postponed' }), { kind: 'waiting', status: 'postponed' }],
    [game(1, { status: 'cancelled' }), { kind: 'waiting', status: 'cancelled' }],
    [game(1, { status: 'suspended', home_90: 1, away_90: 0 }), { kind: 'waiting', status: 'suspended' }],
    [game(1, { status: 'awarded' }), { kind: 'waiting', status: 'awarded' }],
    [ended(1, 3, 1), { kind: 'final', outcome: 'won', score: [3, 1], draw: false }],
    [ended(1, 0, 2), { kind: 'final', outcome: 'lost', score: [0, 2], draw: false }],
    [ended(1, 1, 1), { kind: 'final', outcome: 'lost', score: [1, 1], draw: true }],
    // Extra time and penalties don't count: bets settle on 90 minutes.
    [ended(1, 2, 2, { status: 'extra_time' }), { kind: 'final', outcome: 'lost', score: [2, 2], draw: true }],
    [ended(1, 0, 0, { status: 'penalties', home_pens: 5, away_pens: 4 }), { kind: 'final', outcome: 'lost', score: [0, 0], draw: true }],
    [game(1, { status: 'live', minute: 67, home_90: 1, away_90: 1 }), { kind: 'live', standing: 'level', score: [1, 1], minute: 67, halfTime: false }],
    [game(1, { status: 'half_time', minute: 45, home_90: 2, away_90: 0 }), { kind: 'live', standing: 'on track', score: [2, 0], minute: 45, halfTime: true }],
    // Before the first goal the feed may not have sent a score.
    [game(1, { status: 'live', minute: 3 }), { kind: 'live', standing: 'level', score: [0, 0], minute: 3, halfTime: false }],
    [game(1), { kind: 'not started' }],
  ]
  for (const [fixture, state] of states) assert.deepEqual(legState(home, fixture), state, fixture?.status ?? 'missing')
  // A draw pick on a level score that's final has won, so it isn't "lost to a draw".
  assert.deepEqual(legState({ pick: 'D', settlement: null }, ended(1, 1, 1)), { kind: 'final', outcome: 'won', score: [1, 1], draw: false })
})

test('A settled leg: by the score, by a promo, by hand, voided or dropped', () => {
  const week = weekOf(parlay(1, [leg(1), leg(2), leg(3), leg(4), leg(5), leg(6), leg(7)]))
  const games = byId(ended(1, 3, 1), ended(2, 1, 1), ended(3, 0, 1), game(4, { status: 'live', home_90: 0, away_90: 1 }), game(5), game(6, { status: 'postponed' }), game(7, { status: 'postponed' }))
  let record = settled(week, games)
  record = settleByHand(record, uuid(1004), { outcome: 'won', promo: true, reason: '2-Up: they went 2–0 up' }, games, NOW)
  record = settleByHand(record, uuid(1005), { outcome: 'lost', promo: false, reason: 'bet365 settled it early' }, games, NOW)
  record = voidLeg(record, uuid(1006), { outcome: 'dropped', reason: 'The match was postponed. bet365 voided the leg.' }, games, NOW)
  record = voidLeg(record, uuid(1007), { outcome: 'lost', reason: 'The match was postponed. bet365 settled the leg as lost.' }, games, NOW)
  // The postponed match counted as lost is played later, and ends level:
  // settling notes the score, but the leg didn't lose to a draw.
  record = settled(record, byId(...games.values(), ended(7, 2, 2)))
  assert.deepEqual(legOf(record, 0, 6).settlement?.score90, [2, 2])
  const states = record.parlays[0].legs.map(each => legState(each, games.get(each.fixtureId)))
  assert.deepEqual(states, [
    { kind: 'won', how: 'score' },
    { kind: 'lost', how: 'score', draw: true },
    { kind: 'lost', how: 'score', draw: false },
    { kind: 'won', how: 'promo' },
    { kind: 'lost', how: 'hand', draw: false },
    { kind: 'dropped' },
    { kind: 'lost', how: 'void', draw: false },
  ])
})

test("A parlay's odds and returns match KMan's bet365 slip, pending and won", () => {
  const slip = parlay(1, [leg(1, { odds: -209 }), leg(2, { odds: -143 }), leg(3, { odds: 100 })], { stakeCents: 2500, boostBps: 500 })
  const playing = byId(game(1, { status: 'live', minute: 80, home_90: 1, away_90: 0 }), game(2), game(3))
  const pending = parlayView(slip, 0, playing)
  assert.equal(pending.number, 1)
  assert.equal(pending.state, 'pending')
  assert.equal(pending.locked, false)
  assert.equal(pending.odds, 403)
  assert.equal(pending.potentialCents, 13_084) // $130.84
  assert.equal(pending.boostCents, 504)        // including the $5.04 boost
  assert.equal(pending.payoutCents, null)
  assert.equal(pending.profitCents, null)
  assert.equal(pending.live, true)

  // Games 1 and 2 are home wins and game 3 ends 3–3, so leg 3 wins only as
  // a draw pick. As a home pick, it loses the parlay to a draw.
  const results = byId(ended(1, 2, 0), ended(2, 1, 0), ended(3, 3, 3))
  const won = settled(weekOf({ ...slip, legs: slip.legs.map((each, i) => (i === 2 ? { ...each, pick: 'D' as const } : each)) }), results)
  const record = settled(weekOf(slip), results)
  const view = parlayView(won.parlays[0], 2, byId())
  assert.equal(view.number, 3)
  assert.equal(view.state, 'won')
  assert.equal(view.locked, true)
  assert.equal(view.payoutCents, 13_084)
  assert.equal(view.profitCents, 10_584)
  assert.equal(view.boostCents, 504)
  assert.equal(view.potentialCents, null)
  assert.equal(view.live, false)
  // The first version, with leg 3 lost to a draw: one loss, and it was a draw.
  const lost = parlayView(record.parlays[0], 0, byId())
  assert.equal(lost.state, 'lost')
  assert.equal(lost.lostLegs, 1)
  assert.equal(lost.onlyLossWasADraw, true)
  assert.equal(lost.profitCents, -2500)
  assert.equal(lost.boostCents, 0)
})

test('A dropped leg comes out of the odds, and a parlay with every leg dropped is void', () => {
  // −300 won, +120 still to play, −110 dropped, $20: +193 returns $58.666...,
  // which rounds down to $58.66.
  const games = byId(ended(1, 3, 1), game(2), game(3, { status: 'postponed' }))
  let record = settled(weekOf(parlay(1, [leg(1, { odds: -300 }), leg(2, { odds: 120 }), leg(3, { odds: -110 })], { stakeCents: 2000 })), games)
  record = voidLeg(record, uuid(1003), { outcome: 'dropped', reason: 'The match was postponed. bet365 voided the leg.' }, games, NOW)
  const view = parlayView(record.parlays[0], 0, games)
  assert.equal(view.state, 'pending')
  assert.equal(view.odds, 193)
  assert.equal(view.potentialCents, 5866)

  let allDropped = weekOf(parlay(2, [leg(3, { odds: -110 })], { stakeCents: 500 }))
  allDropped = voidLeg(allDropped, uuid(1003), { outcome: 'dropped', reason: 'The match was postponed. bet365 voided the leg.' }, games, NOW)
  const empty = parlayView(allDropped.parlays[0], 0, games)
  assert.equal(empty.odds, null)
  assert.equal(empty.state, 'void')
  assert.equal(empty.payoutCents, 500)
  assert.equal(empty.profitCents, 0)
  assert.equal(empty.locked, true)
})

test('Only one leg lost, to a draw, is the heartbreaker; two losses or a plain loss are not', () => {
  const games = byId(ended(1, 1, 1), ended(2, 0, 1), ended(3, 2, 0))
  const view = (legs: Leg[]) => parlayView(settled(weekOf(parlay(1, legs)), games).parlays[0], 0, games)
  assert.equal(view([leg(1), leg(3)]).onlyLossWasADraw, true)
  assert.equal(view([leg(1), leg(2)]).onlyLossWasADraw, false)
  assert.equal(view([leg(1), leg(2)]).lostLegs, 2)
  assert.equal(view([leg(2), leg(3)]).onlyLossWasADraw, false)
})

test("A week's totals, and the sentence under My parlays' title", () => {
  const games = byId(ended(1, 3, 1), ended(2, 0, 2), game(3, { status: 'live', minute: 30, home_90: 0, away_90: 0 }), game(4, { status: 'postponed' }), game(5))
  let record = settled(weekOf(
    parlay(1, [leg(1, { odds: 100 })], { stakeCents: 2500 }),                         // won: returns $50
    parlay(2, [leg(2), leg(5)], { stakeCents: 1000 }),                                // lost on leg 2, leg 5 still to play
    parlay(3, [leg(4, { id: uuid(1104) })], { stakeCents: 500 }),                     // dropped, so void: returns $5
    parlay(4, [leg(3, { id: uuid(1203) }), leg(4, { id: uuid(1204) }), leg(5, { id: uuid(1205) })], { stakeCents: 2000 }), // pending
  ), games)
  record = voidLeg(record, uuid(1104), { outcome: 'dropped', reason: 'The match was postponed. bet365 voided the leg.' }, games, NOW)
  const summary = weekSummary(record, games)
  assert.deepEqual(summary, {
    parlays: 4, bonusBets: 0, stakedCents: 6000, returnedCents: 5500, netCents: 2500 - 1000 + 0,
    settled: 3, cashed: 1, legsToSettle: 4, live: 1, waiting: 1,
  })
  assert.equal(weekSentence('Matchweek 12', summary), 'Matchweek 12 is in play. 4 of your legs are still to settle, 1 of them live.')
  assert.equal(weekSentence('Matchweek 12', { ...summary, live: 0 }), '4 legs in Matchweek 12 still to settle. 1 is waiting for you.')
  assert.equal(weekSentence('Matchweek 12', { ...summary, live: 0, waiting: 2 }), '4 legs in Matchweek 12 still to settle. 2 are waiting for you.')
  assert.equal(weekSentence('Matchweek 12', { ...summary, live: 0, waiting: 0, legsToSettle: 1 }), '1 leg in Matchweek 12 still to settle.')
  assert.equal(weekSentence('Matchweek 12', { ...summary, legsToSettle: 1, live: 1 }), 'Matchweek 12 is in play. 1 of your legs is still to settle, 1 of them live.')
  assert.equal(weekSentence('Matchweek 12', { ...summary, legsToSettle: 0 }), 'Matchweek 12 is settled. 1 of 4 parlays cashed.')
  assert.equal(weekSentence('Matchday 3', weekSummary(weekOf(), games)), "You haven't logged a parlay for Matchday 3.")
})

test('Where a leg sits in its week, counting from 1', () => {
  const record = weekOf(parlay(1, [leg(1)]), parlay(2, [leg(2), leg(3), leg(4)]))
  assert.deepEqual(legPlace(record, uuid(2), uuid(1004)), { parlay: 2, leg: 3 })
  assert.deepEqual(legPlace(record, uuid(1), uuid(1001)), { parlay: 1, leg: 1 })
  assert.equal(legPlace(record, uuid(3), uuid(1001)), null)
  assert.equal(legPlace(record, uuid(1), uuid(1004)), null)
})

test('Audit changes read as sentences, and an unknown label is only listed', () => {
  const lines: [string, unknown, unknown, string][] = [
    ['Parlay 1 · stake in cents', 2500, 2000, 'Parlay 1: stake from $25.00 to $20.00'],
    ['Parlay 1 · boost in basis points', 0, 250, 'Parlay 1: boost from 0% to 2.5%'],
    ['Parlay 2 · MCI v LIV · odds', -110, 150, 'Parlay 2, MCI v LIV: odds from −110 to +150'],
    ['Parlay 2 · MCI v LIV · pick', 'H', 'D', 'Parlay 2, MCI v LIV: pick from home win to draw'],
    ['Parlay 2 · MCI v LIV · confidence', 3, 4, 'Parlay 2, MCI v LIV: confidence from 3 of 5 to 4 of 5'],
    ['Parlay 2 · MCI v LIV · 90-minute score', [1, 1], [2, 1], 'Parlay 2, MCI v LIV: 90-minute score from 1–1 to 2–1'],
    ['Parlay 2 · MCI v LIV · outcome', null, 'won', 'Parlay 2, MCI v LIV: result from nothing to won'],
    ['Parlay 2 · MCI v LIV · how it settled', 'auto', 'override', 'Parlay 2, MCI v LIV: settled by hand, not from the score'],
    ['Parlay 2 · MCI v LIV · how it settled', null, 'void', 'Parlay 2, MCI v LIV: settled as void'],
    ['Parlay 2 · MCI v LIV · how it settled', 'override', null, 'Parlay 2, MCI v LIV: no longer settled by hand'],
    ['Parlay 2 · MCI v LIV · promo', false, true, 'Parlay 2, MCI v LIV: paid by a promo'],
    ['Parlay 2 · MCI v LIV · promo', true, null, 'Parlay 2, MCI v LIV: no longer paid by a promo'],
    ['Parlay 2 · MCI v LIV · promo', null, false, 'Parlay 2, MCI v LIV: not paid by a promo'],
    ['Parlay 2 · MCI v LIV · reason', null, 'typed the stake wrong', 'Parlay 2, MCI v LIV: reason from nothing to “typed the stake wrong”'],
    ['Parlay 2 · MCI v LIV · kick-off', '2026-11-21T12:30:00.000Z', '2026-11-22T14:00:00.000Z', 'Parlay 2, MCI v LIV: kick-off from Sat 7:30 am to Sun 9:00 am'],
    ['Parlay 2 · MCI v LIV · settled at', '2026-11-21T19:00:00.000Z', null, 'Parlay 2, MCI v LIV: time it settled from 21 Nov 2026 2:00 pm to nothing'],
    ['Parlay 2 · MCI v LIV · game', 900001, 900002, 'Parlay 2, MCI v LIV: game from football-data match 900001 to football-data match 900002'],
    ['Parlay 2 · MCI v LIV · teams', 'MCI v LIV', 'MCI v ARS', 'Parlay 2, MCI v LIV: teams from MCI v LIV to MCI v ARS'],
    ['Parlay 3 removed', null, null, 'Parlay 3 removed'],
    ['Parlay 1 · legs reordered', null, null, 'Parlay 1, legs reordered'],
    ['Week deleted', null, null, 'Week deleted'],
    ['odds', -110, 150, 'odds'],
    // A label the app doesn't know, from a decrypted record, is only listed.
    ['Parlay 1 · constructor', 1, 2, 'Parlay 1, constructor'],
    ['Parlay 1 · __proto__', 1, 2, 'Parlay 1, __proto__'],
  ]
  for (const [what, from, to, words] of lines) {
    assert.equal(changeWords({ what, from: from as never, to: to as never }), words, what)
  }
})

test("Changing a locked parlay lists every change in words for the reason dialog", () => {
  const games = byId(ended(1, 3, 1), ended(2, 0, 1))
  const before = settled(weekOf(parlay(1, [leg(1), leg(2, { home: 'ARS', away: 'CHE' })])), games)
  let after: WeekRecord = { ...before, parlays: [{ ...before.parlays[0], stakeCents: 2000 }] }
  after = settleByHand(after, uuid(1002), { outcome: 'won', promo: true, reason: '2-Up: they went 2–0 up' }, games, NOW)
  assert.deepEqual(lockedChanges(before, after).map(changeWords), [
    'Parlay 1: stake from $25.00 to $20.00',
    'Parlay 1, ARS v CHE: result from lost to won',
    'Parlay 1, ARS v CHE: settled by hand, not from the score',
    'Parlay 1, ARS v CHE: paid by a promo',
    'Parlay 1, ARS v CHE: reason from nothing to “2-Up: they went 2–0 up”',
  ])
})

test("Bonus bets: a parlay's view, a week's totals and the audit log's words", () => {
  const games = byId(ended(1, 3, 1), ended(2, 0, 2), game(3))
  const record = settled(weekOf(
    parlay(1, [leg(1, { odds: 100 }), leg(3, { odds: 120 })], { stakeCents: 2000, bonus: true }), // won one, one to play
    parlay(2, [leg(2)], { stakeCents: 1000, bonus: true }),                                       // lost
    parlay(3, [leg(1, { id: uuid(1101), odds: 100 })], { stakeCents: 500 }),                      // won, your own money
  ), games)
  // Its winnings if the +120 lands: 20 × 2 × 2.2 is $88.00, less the $20 stake.
  assert.equal(parlayView(record.parlays[0], 0, games).potentialCents, 6800)
  // Only the $5 is your money staked, the lost bonus bet costs nothing, and the $5 single returns $10.
  const summary = weekSummary(record, games)
  assert.deepEqual([summary.parlays, summary.bonusBets, summary.stakedCents, summary.returnedCents, summary.netCents], [3, 2, 500, 1000, 500])
  assert.equal(changeWords({ what: 'Parlay 2 · bonus bet', from: false, to: true }), 'Parlay 2: made a bonus bet')
  assert.equal(changeWords({ what: 'Parlay 2 · bonus bet', from: true, to: false }), 'Parlay 2: no longer a bonus bet')
})
