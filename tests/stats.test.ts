// Tests for src/lib/stats/season.ts, the Dashboard's numbers. Every
// expected number below is worked out by hand in the comments, from a small
// made-up season of three weeks. The fourth parlay is KMan's first bet365
// slip, which returns $130.84.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { settleWeek, voidLeg, type FixtureScore } from '../src/lib/bets/settle.ts'
import type { Leg, Week, WeekRecord } from '../src/lib/bets/week-record.ts'
import { achievements, CUT, fairChance, legResult, pickKind, seasonStats, type PickKind, type SeasonWeek } from '../src/lib/stats/season.ts'
import { confidenceSentence, heroSentence, kindsSentence, legsSentence, listed, sizesSentence } from '../src/lib/stats/words.ts'
import { axisDollars, pointsText, returnText, wholePercent } from '../src/lib/format.ts'
import { leg, parlay, uuid, weekOf } from './bet-samples.ts'

const NOW = '2026-11-08T22:00:00.000Z'
const MW1: Week = { season: 2026, competition: 'PL', period: 'MW1' }
const MD1: Week = { season: 2026, competition: 'UCL', period: 'MD1' }
const MW5: Week = { season: 2026, competition: 'PL', period: 'MW5' }

// Game n's leg: the teams, kick-off, pick, odds and confidence.
const on = (n: number, home: string, away: string, kickoff: string, pick: Leg['pick'], odds: number, confidence: Leg['confidence']) =>
  leg(n, { home, away, kickoff: `${kickoff}:00.000Z`, pick, odds, confidence })
const score = (n: number, home: number, away: number): FixtureScore => ({ id: 900_000 + n, status: 'finished', home_90: home, away_90: away })
const settled = (record: WeekRecord, scores: FixtureScore[]) => settleWeek(record, new Map(scores.map(each => [each.id, each])), NOW).record

// Matchweek 1, Saturday 15 August: a $10 single that wins, and a $20 double
// that loses to a draw on its second leg. −$10.00 for the week.
const mw1 = settled(weekOf(
  parlay(1, [on(1, 'ARS', 'CHE', '2026-08-15T14:00', 'H', 100, 5)], { stakeCents: 1000 }),
  parlay(2, [on(2, 'MCI', 'LIV', '2026-08-15T14:00', 'H', -200, 4), on(3, 'TOT', 'ARS', '2026-08-15T16:30', 'A', 150, 2)], { stakeCents: 2000 }),
), [score(1, 2, 0), score(2, 1, 0), score(3, 1, 1)])

// Champions League matchday 1, from Wednesday 16 September: both cash.
// A $10 double at +200 and −110 returns 10 × 3 × 21/11 = $57.27, and KMan's
// slip returns $130.84. +$153.11 for the week.
const md1 = settled(weekOf(
  parlay(3, [on(4, 'NEW', 'AVL', '2026-09-16T19:00', 'D', 200, 1), on(5, 'ARS', 'BOU', '2026-09-16T19:00', 'H', -110, 3)], { stakeCents: 1000 }),
  parlay(4, [on(6, 'MCI', 'FUL', '2026-09-17T19:00', 'H', -209, 4), on(7, 'LIV', 'EVE', '2026-09-17T19:00', 'H', -143, 3), on(8, 'CHE', 'SUN', '2026-09-17T21:00', 'H', 100, 2)], { stakeCents: 2500, boostBps: 500 }),
), [score(4, 0, 0), score(5, 3, 1), score(6, 2, 0), score(7, 1, 0), score(8, 3, 2)])

// Matchweek 5, Sunday 20 September: a $5 double loses on its +300 leg, its
// other leg is dropped after a postponement, and a $10 single hasn't
// started. −$5.00 for the week.
const mw5 = voidLeg(settled(weekOf(
  parlay(5, [on(9, 'LEE', 'BRE', '2026-09-20T14:00', 'A', 300, 1), on(10, 'MUN', 'NFO', '2026-09-20T16:30', 'H', -150, 3)], { stakeCents: 500 }),
  parlay(6, [on(11, 'CRY', 'SUN', '2026-09-21T19:00', 'H', 120, 3)], { stakeCents: 1000 }),
), [score(9, 2, 0)]), uuid(1010), { outcome: 'dropped', reason: 'The match was postponed. bet365 voided the leg.' }, new Map(), NOW)

// Matchday 1 is listed between the two matchweeks, though its code sorts after them.
const SEASON: SeasonWeek[] = [{ week: MW1, record: mw1 }, { week: MW5, record: mw5 }, { week: MD1, record: md1 }]

// bet365's prices for the odds here, and each one's chance with the cut out:
//   +100: 2.00, 1/2 ÷ 1.05 = .476190    −200: 1.50, 2/3 ÷ 1.05 = .634921
//   +150: 2.50, .4 ÷ 1.05 = .380952     +200: 3.00, 1/3 ÷ 1.05 = .317460
//   −110: 21/11, 11/21 ÷ 1.05 = .498866 −209: 1.48, .675676 ÷ 1.05 = .643501
//   −143: 1.70, .588235 ÷ 1.05 = .560224 +300: 4.00, .25 ÷ 1.05 = .238095
const near = (actual: number, expected: number, what: string) => assert.ok(Math.abs(actual - expected) < 5e-6, `${what}: ${actual} is not ${expected}`)

test("What the odds said: bet365's price, with its 5% cut taken out", () => {
  assert.equal(CUT, 1.05)
  near(fairChance(-110), 0.498866, '-110') // 52.4% with the cut in
  near(fairChance(100), 0.476190, '+100')
  near(fairChance(-209), 0.643501, '-209')
  near(fairChance(-143), 0.560224, '-143')
  near(fairChance(300), 0.238095, '+300')
  // A team at +150 or shorter is the favourite.
  assert.equal(pickKind('H', -500), 'home-fav')
  assert.equal(pickKind('H', 150), 'home-fav')
  assert.equal(pickKind('H', 151), 'home-dog')
  assert.equal(pickKind('A', 100), 'away-fav')
  assert.equal(pickKind('A', 300), 'away-dog')
  assert.equal(pickKind('D', 200), 'draw')
})

test('How each leg finished: won, lost to a draw, lost, or not counted', () => {
  assert.deepEqual(mw1.parlays.flatMap(each => each.legs).map(legResult), ['won', 'won', 'drawn'])
  assert.deepEqual(mw5.parlays.flatMap(each => each.legs).map(legResult), ['lost', null, null]) // dropped, then not started
  // A draw pick on a level score won, so a level score only "draws" other picks.
  assert.equal(legResult(md1.parlays[0].legs[0]), 'won')
})

test('Money: settled parlays only, with the running total, its high point and the worst week', () => {
  const stats = seasonStats(SEASON, 'all')
  // Five parlays settled and not void: 1, 2, 3, 4 and 5. Parlay 6 hasn't started.
  assert.equal(stats.parlays, 5)
  assert.equal(stats.cashed, 3)
  // $10 + $20 + $10 + $25 + $5 = $70 staked.
  assert.equal(stats.stakedCents, 7000)
  // +$10.00 − $20.00 + $47.27 + $105.84 − $5.00 = +$138.11.
  assert.equal(stats.netCents, 13_811)
  near(stats.returnOnStake ?? 0, 13_811 / 7000, 'return on stake')
  // In the order played: MW1 (15 Aug), MD1 (16 Sep), MW5 (20 Sep).
  assert.deepEqual(stats.weeks.map(each => [each.week.period, each.profitCents, each.totalCents]), [['MW1', -1000, -1000], ['MD1', 15_311, 14_311], ['MW5', -500, 13_811]])
  assert.deepEqual(stats.weeks.map(each => [each.won, each.drawn, each.lost, each.cashed, each.counted, each.perfect]), [
    [2, 1, 0, 1, 2, false], [5, 0, 0, 2, 2, true], [0, 0, 1, 0, 1, false],
  ])
  // Up $143.11 after Matchday 1, and $5.00 given back since.
  assert.equal(stats.peak?.week.period, 'MD1')
  assert.equal(stats.worst?.week.period, 'MW1')
})

test('You against the odds: legs and parlays, and what the odds expected in money', () => {
  const stats = seasonStats(SEASON, 'all')
  // Nine settled legs that weren't dropped: 7 won, 1 lost to a draw, 1 lost.
  assert.deepEqual([stats.legs.n, stats.legs.won, stats.legs.drawn, stats.legs.lost], [9, 7, 1, 1])
  // Their chances, from the table above, add up to 4.226400, an average of .469600.
  near(stats.legs.odds, 4.2264 / 9, 'legs, odds said')
  // Parlays: 3 of 5 cashed. Their chances, dropped legs left out:
  //   1: .476190   2: .634921 × .380952 = .241875   3: .317460 × .498866 = .158370
  //   4: .643501 × .560224 × .476190 = .171669   5: .238095
  // which average .257240.
  assert.deepEqual([stats.parlayRate.n, stats.parlayRate.won], [5, 3])
  near(stats.parlayRate.odds, (0.476190 + 0.241875 + 0.158370 + 0.171669 + 0.238095) / 5, 'parlays, odds said')
  // Each parlay's chance × what it pays if it cashes, less its stake, in cents:
  //   1: .476190 × 2000 − 1000 = −47.62     2: .241875 × 7500 − 2000 = −185.94
  //   3: .158370 × 5727 − 1000 = −93.02     4: .171669 × 13084 − 2500 = −253.88
  //   5: .238095 × 2000 − 500 = −23.81 (paid at +300 alone, the dropped leg left out)
  // −604.27 cents in all, so −$6.04 once rounded to the cent.
  assert.equal(stats.expectedCents, -604)
})

test('Types of pick, parlay sizes and confidence ratings', () => {
  const stats = seasonStats(SEASON, 'all')
  const kinds = new Map(stats.kinds.map(each => [each.kind, each]))
  // Home favourites: legs 1, 2, 5, 6, 7 and 8, all won.
  assert.deepEqual([kinds.get('home-fav')?.n, kinds.get('home-fav')?.won], [6, 6])
  near(kinds.get('home-fav')?.odds ?? 0, (0.476190 + 0.634921 + 0.498866 + 0.643501 + 0.560224 + 0.476190) / 6, 'home favourites')
  assert.deepEqual([kinds.get('away-fav')?.n, kinds.get('away-fav')?.won], [1, 0]) // leg 3, at +150
  assert.deepEqual([kinds.get('away-dog')?.n, kinds.get('away-dog')?.won], [1, 0]) // leg 9, at +300
  assert.deepEqual([kinds.get('home-dog')?.n, kinds.get('home-dog')?.you, kinds.get('home-dog')?.odds], [0, 0, 0])
  assert.deepEqual([kinds.get('draw')?.n, kinds.get('draw')?.won], [1, 1]) // leg 4
  assert.deepEqual(stats.kinds.map(each => each.kind), ['home-fav', 'away-fav', 'away-dog', 'home-dog', 'draw'])

  // Sizes go by how many legs a parlay was placed with, so parlay 5 is a double.
  //   Singles: parlay 1, needs 1 ÷ 2.00 = .5 to break even, +$10.00.
  //   Doubles: 2, 3 and 5, one cashed. Break even averages 1 ÷ 3.75, 1 ÷ (3 × 21/11)
  //   and 1 ÷ 4, so (.266667 + .174603 + .25) ÷ 3 = .230423. −$20.00 + $47.27 − $5.00 = +$22.27.
  //   Trebles: parlay 4, needs 1 ÷ 5.032 = .198728, +$105.84.
  assert.deepEqual(stats.sizes.map(each => [each.legs, each.count, each.cashed, each.profitCents]), [[1, 1, 1, 1000], [2, 3, 1, 2227], [3, 1, 1, 10_584]])
  near(stats.sizes[1].hit, 1 / 3, 'doubles hit')
  near(stats.sizes[0].breakEven, 0.5, 'singles break even')
  near(stats.sizes[1].breakEven, (1 / 3.75 + 11 / 63 + 0.25) / 3, 'doubles break even')
  near(stats.sizes[2].breakEven, 1 / (1.48 * 1.7 * 2), 'trebles break even')

  // Ratings: 1 is legs 4 and 9, 2 is legs 3 and 8, 3 is legs 5 and 7,
  // 4 is legs 2 and 6, and 5 is leg 1. Leg 10 was dropped and leg 11 hasn't played.
  assert.deepEqual(stats.confidence.map(each => [each.rating, each.n, each.won]), [[1, 2, 1], [2, 2, 1], [3, 2, 2], [4, 2, 2], [5, 1, 1]])
  near(stats.confidence[0].odds, (0.317460 + 0.238095) / 2, 'rated 1')
  near(stats.confidence[3].odds, (0.634921 + 0.643501) / 2, 'rated 4')
})

test('Clubs you back: picked to win, most backed first, then by hit rate', () => {
  const clubs = seasonStats(SEASON, 'all').clubs
  // Arsenal: legs 1 and 5 won, leg 3 lost to a draw, in both competitions.
  assert.deepEqual(clubs.map(each => [each.code, each.n, each.won, each.drawn, each.lost]), [
    ['ARS', 3, 2, 1, 0], ['MCI', 2, 2, 0, 0], ['CHE', 1, 1, 0, 0], ['LIV', 1, 1, 0, 0], ['BRE', 1, 0, 0, 1],
  ])
  assert.deepEqual(clubs[0].competitions, ['PL', 'UCL'])
  near(clubs[0].odds, (0.476190 + 0.380952 + 0.498866) / 3, 'Arsenal, odds said')
})

test('One competition at a time', () => {
  const pl = seasonStats(SEASON, 'PL')
  // Parlays 1, 2 and 5: $35 staked, +$10.00 − $20.00 − $5.00 = −$15.00.
  assert.deepEqual([pl.parlays, pl.cashed, pl.stakedCents, pl.netCents], [3, 1, 3500, -1500])
  assert.deepEqual(pl.weeks.map(each => each.totalCents), [-1000, -1500])
  assert.equal(pl.peak, null) // never above $0
  const ucl = seasonStats(SEASON, 'UCL')
  assert.deepEqual([ucl.parlays, ucl.cashed, ucl.stakedCents, ucl.netCents], [2, 2, 3500, 15_311])
  assert.equal(ucl.worst?.week.period, 'MD1')
})

test('A new account: nothing settled, so nothing to show', () => {
  const stats = seasonStats([], 'all')
  assert.deepEqual([stats.parlays, stats.stakedCents, stats.netCents, stats.returnOnStake, stats.peak, stats.worst, stats.expectedCents], [0, 0, 0, null, null, null, 0])
  assert.deepEqual([stats.weeks, stats.sizes, stats.clubs], [[], [], []])
  assert.deepEqual([stats.legs.n, stats.legs.you, stats.legs.odds], [0, 0, 0])
  // A week with only a parlay still to play shows no week yet.
  assert.deepEqual(seasonStats([{ week: MW5, record: weekOf(mw5.parlays[1]) }], 'all').weeks, [])
})

test('The six achievements, across the whole season', () => {
  const got = achievements(SEASON, 20)
  // Matchday 1 is the only week where every parlay cashed.
  assert.equal(got.perfectWeek?.period, 'MD1')
  // In kick-off order: won, won, drawn, then five won, then lost. Best run 5.
  assert.equal(got.bestRun, 5)
  // Premier League clubs picked to win in Premier League weeks: Arsenal,
  // Man City and Brentford. Arsenal's Champions League pick doesn't add one.
  assert.equal(got.plBacked, 3)
  assert.equal(got.plClubs, 20)
  assert.equal(got.europeanNight, true)
  assert.equal(got.drawsLanded, 1)
  // Cashed at +100, +472 (3 × 21/11 = 5.727, shown rounded against you) and +403.
  assert.equal(got.longest, 472)
  assert.deepEqual(achievements([], 20), { perfectWeek: null, bestRun: 0, plBacked: 0, plClubs: 20, europeanNight: false, drawsLanded: 0, longest: null })
})

test("The panels' sentences, from the numbers", () => {
  const stats = seasonStats(SEASON, 'all')
  assert.deepEqual(heroSentence(stats), ['On $70.00 staked across 5 parlays.', ' You were up $143.11 after Matchday 1 and have given back $5.00 since.'])
  assert.deepEqual(heroSentence(seasonStats([], 'all')), ['No parlays have settled yet. This page fills in as they do.'])
  assert.deepEqual(legsSentence(stats), ['You lost 1 leg outright and 1 to draws.'])
  assert.deepEqual(legsSentence({ ...stats, legs: { ...stats.legs, drawn: 3, lost: 2 } }), ['Draws cost you ', { b: '3 legs', tone: 'warn' }, ". That's more than you lost outright (2)."])
  // Home favourites: 6 of 6 landed, against (.476190 + .634921 + .498866 + .643501 + .560224 + .476190) ÷ 6 = 55%.
  assert.deepEqual(kindsSentence(stats.kinds), ['Home favourites are your best pick: ', { b: '100%', tone: 'you' }, ' against ', { b: '55%', tone: 'odds' }, '.'])
  const kind = (kind: PickKind, n: number, won: number, odds: number) => ({ kind, n, won, you: won / n, odds })
  assert.deepEqual(kindsSentence([kind('away-dog', 5, 2, 0.3), kind('draw', 3, 0, 0.25), kind('home-fav', 4, 4, 0.6)]),
    ['Away underdogs are your best pick: ', { b: '40%', tone: 'you' }, ' against ', { b: '30%', tone: 'odds' }, '.', ' Draws are the weak spot, 0 of 3 landed.'])
  assert.deepEqual(kindsSentence([kind('draw', 4, 1, 0.25)]), ['Not enough picks yet to call a best type.'])
  // Every size made money here, and doubles, the size placed most, are among them.
  assert.deepEqual(sizesSentence(stats.sizes), ['Singles, 2-leg parlays and 3-leg parlays are in profit.'])
  const size = (legs: number, count: number, profitCents: number) => ({ legs, count, cashed: 0, hit: 0, breakEven: 0, profitCents })
  assert.deepEqual(sizesSentence([size(1, 2, 500), size(3, 5, -2000)]),
    ['Singles are your only size in profit, ', { b: '+$5.00', tone: 'good' }, '.', ' 3-leg parlays, the size you place most, are ', { b: 'down $20.00', tone: 'bad' }, '.'])
  assert.deepEqual(sizesSentence([size(2, 3, 0), size(3, 1, -100)]), ['No parlay size is in profit yet.', ' 2-leg parlays, the size you place most, are ', { b: 'flat at $0.00', tone: undefined }, '.'])
  assert.deepEqual(confidenceSentence(stats.confidence), ['Rate a few more legs to see a pattern.'])
  const rated = (rating: number, n: number, won: number, odds: number) => ({ rating, n, won, you: won / n, odds })
  assert.deepEqual(confidenceSentence([rated(1, 2, 1, 0.3), rated(3, 6, 3, 0.4), rated(5, 6, 3, 0.6)]),
    ['Your 3s beat the odds by the most, ', { b: '+10 pts', tone: 'good' }, '.', ' Your 5s land 50% against ', { b: '60%', tone: 'odds' }, ', ', { b: '10 pts short', tone: 'bad' }, '.'])
  assert.equal(listed(['a']), 'a')
  assert.equal(listed(['a', 'b']), 'a and b')
})

test('Rates, points, returns and axis labels read as the design rules say', () => {
  assert.equal(wholePercent(0.563), '56%')
  assert.equal(wholePercent(0), '0%')
  assert.equal(pointsText(0.06), '+6 pts')
  assert.equal(pointsText(-0.03), '−3 pts')
  assert.equal(pointsText(0.004), '0 pts')
  assert.equal(returnText(0.125), '+12.5%')
  assert.equal(returnText(-0.089), '−8.9%')
  assert.equal(returnText(0), '0.0%')
  assert.equal(axisDollars(200), '+$200')
  assert.equal(axisDollars(-50), '−$50')
  assert.equal(axisDollars(0), '$0')
  assert.equal(axisDollars(1000), '+$1,000')
})

test('The edge cases: void losses, open parlays, kick-off order and long shots', () => {
  const settlement = (outcome: 'won' | 'lost' | 'dropped', how: 'auto' | 'override' | 'void', score90: [number, number] | null) =>
    ({ outcome, byScore: null, score90, how, reason: how === 'auto' ? null : 'A reason', promo: false, settledAt: NOW })
  // Counted as lost after a postponement, with the rearranged match ending level: lost, not drawn.
  assert.equal(legResult(leg(1, { pick: 'H', settlement: settlement('lost', 'void', [1, 1]) })), 'lost')
  // A draw pick settled by hand as lost on a level score didn't lose to a draw either.
  assert.equal(legResult(leg(1, { pick: 'D', settlement: settlement('lost', 'override', [1, 1]) })), 'lost')

  // A parlay with every leg dropped is void, so it counts for nothing.
  const voided = seasonStats([{ week: MW1, record: weekOf(parlay(1, [leg(1, { settlement: settlement('dropped', 'void', null) })])) }], 'all')
  assert.deepEqual([voided.parlays, voided.stakedCents, voided.weeks.length], [0, 0, 0])

  // Week A's first game kicks off before week B's, its last after, so A comes first.
  const at = (n: number, time: string, odds = 100) => leg(n, { kickoff: `2026-08-${time}:00.000Z`, odds })
  const weekA = settled(weekOf(
    parlay(1, [at(1, '01T12:00'), at(2, '01T13:00'), at(3, '30T20:00', 1000)], { stakeCents: 100 }),
    parlay(2, [at(4, '01T14:00'), at(5, '01T15:00')], { stakeCents: 100 }),
    parlay(3, [at(6, '30T21:00')], { stakeCents: 100 }),
  ), [score(1, 1, 0), score(2, 1, 0), score(3, 0, 1), score(4, 1, 0), score(5, 1, 0)])
  const weekB = settled(weekOf(parlay(4, [at(7, '15T12:00')], { stakeCents: 100 }), parlay(5, [at(8, '16T12:00')], { stakeCents: 100 })), [score(7, 1, 0)])
  const two = [{ week: MW5, record: weekB }, { week: MW1, record: weekA }]
  const ordered = seasonStats(two, 'all')
  assert.deepEqual(ordered.weeks.map(each => each.week.period), ['MW1', 'MW5'])
  // Week A cashed both parlays that settled, but parlay 3 hasn't played, so it isn't perfect yet.
  assert.deepEqual([ordered.weeks[0].cashed, ordered.weeks[0].counted, ordered.weeks[0].perfect], [1, 2, false])
  // Week B's one settled parlay cashed, but parlay 5 is still to play, so it isn't perfect yet either.
  assert.deepEqual([ordered.weeks[1].cashed, ordered.weeks[1].counted, ordered.weeks[1].perfect], [1, 1, false])
  const got = achievements(two, 20)
  // In kick-off order: won at 12:00, 13:00, 14:00 and 15:00 on the 1st, won on the 15th, then lost on the 30th.
  assert.equal(got.bestRun, 5)
  // The +1000 leg lost, so the longest cashed is still +300 (2 × 2) and +100.
  assert.equal(got.longest, 300)
})

test('The sentences: their thresholds', () => {
  const stats = seasonStats(SEASON, 'all')
  // 50 cents given back is too little to mention.
  assert.deepEqual(heroSentence({ ...stats, netCents: 14_261 }), ['On $70.00 staked across 5 parlays.'])
  const kind = (kind: PickKind, n: number, won: number, odds: number) => ({ kind, n, won, you: won / n, odds })
  // The weakest type still beats the odds, so it isn't called a weak spot.
  assert.deepEqual(kindsSentence([kind('away-dog', 5, 3, 0.3), kind('home-fav', 3, 2, 0.6)]),
    ['Away underdogs are your best pick: ', { b: '60%', tone: 'you' }, ' against ', { b: '30%', tone: 'odds' }, '.'])
  const rated = (rating: number, n: number, won: number, odds: number) => ({ rating, n, won, you: won / n, odds })
  assert.deepEqual(confidenceSentence([rated(3, 5, 3, 0.4), rated(5, 5, 2, 0.6)]), ['Rate a few more legs to see a pattern.'])
})
