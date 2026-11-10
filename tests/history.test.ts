// Tests for step 10.4: History's rows, filters and sorting
// (src/lib/stats/history.ts), the CSV export and its formula guard
// (src/lib/stats/csv.ts), and the numbers only Analytics shows (analytics()
// in src/lib/stats/season.ts). They use the made-up season from
// stats.test.ts, rebuilt here, with every expected number worked out by hand.
process.env.TZ = 'America/Toronto' // the CSV writes kick-offs in this computer's time

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { settleByHand, settleWeek, voidLeg, type FixtureScore } from '../src/lib/bets/settle.ts'
import type { Leg, Week, WeekRecord } from '../src/lib/bets/week-record.ts'
import { csvCell, csvName, parlaysCsv, picksCsv, toCsv } from '../src/lib/stats/csv.ts'
import {
  filterParlays, filterPicks, historyRows, nextSort, NO_PARLAY_FILTERS, NO_PICK_FILTERS, PARLAYS_FIRST_DOWN, sortParlays, sortPicks, weekChoices,
} from '../src/lib/stats/history.ts'
import { analytics, singlesCents, type SeasonWeek } from '../src/lib/stats/season.ts'
import { ledgerSentence, momentNotes, versusSentence } from '../src/lib/stats/words.ts'
import { leg, parlay, uuid, weekOf } from './bet-samples.ts'

const NOW = '2026-11-08T22:00:00.000Z'
const MW1: Week = { season: 2026, competition: 'PL', period: 'MW1' }
const MD1: Week = { season: 2026, competition: 'UCL', period: 'MD1' }
const MW5: Week = { season: 2026, competition: 'PL', period: 'MW5' }
const on = (n: number, home: string, away: string, kickoff: string, pick: Leg['pick'], odds: number, confidence: Leg['confidence']) =>
  leg(n, { home, away, kickoff: `${kickoff}:00.000Z`, pick, odds, confidence })
const score = (n: number, home: number, away: number): FixtureScore => ({ id: 900_000 + n, status: 'finished', home_90: home, away_90: away })
const settled = (record: WeekRecord, scores: FixtureScore[]) => settleWeek(record, new Map(scores.map(each => [each.id, each])), NOW).record

// Matchweek 1: a $10 single on Arsenal that wins (+$10.00), and a $20 double
// that loses on Arsenal's 1–1 (−$20.00). Its other leg won, so it's a
// heartbreaker that would have paid 20 × 1.5 × 2.5 = $75.00.
const mw1 = settled(weekOf(
  parlay(1, [on(1, 'ARS', 'CHE', '2026-08-15T14:00', 'H', 100, 5)], { stakeCents: 1000 }),
  parlay(2, [on(2, 'MCI', 'LIV', '2026-08-15T14:00', 'H', -200, 4), on(3, 'TOT', 'ARS', '2026-08-15T16:30', 'A', 150, 2)], { stakeCents: 2000 }),
), [score(1, 2, 0), score(2, 1, 0), score(3, 1, 1)])
// Matchday 1: both cash, $57.27 (+$47.27) and KMan's slip, $130.84 (+$105.84).
const md1 = settled(weekOf(
  parlay(3, [on(4, 'NEW', 'AVL', '2026-09-16T19:00', 'D', 200, 1), on(5, 'ARS', 'BOU', '2026-09-16T19:00', 'H', -110, 3)], { stakeCents: 1000 }),
  parlay(4, [on(6, 'MCI', 'FUL', '2026-09-17T19:00', 'H', -209, 4), on(7, 'LIV', 'EVE', '2026-09-17T19:00', 'H', -143, 3), on(8, 'CHE', 'SUN', '2026-09-17T21:00', 'H', 100, 2)], { stakeCents: 2500, boostBps: 500 }),
), [score(4, 0, 0), score(5, 3, 1), score(6, 2, 0), score(7, 1, 0), score(8, 3, 2)])
// Matchweek 5: a $5 double loses on its +300 leg after its other leg is
// dropped (−$5.00), and a $10 single hasn't started.
const mw5 = voidLeg(settled(weekOf(
  parlay(5, [on(9, 'LEE', 'BRE', '2026-09-20T14:00', 'A', 300, 1), on(10, 'MUN', 'NFO', '2026-09-20T16:30', 'H', -150, 3)], { stakeCents: 500 }),
  parlay(6, [on(11, 'CRY', 'SUN', '2026-09-21T19:00', 'H', 120, 3)], { stakeCents: 1000 }),
), [score(9, 2, 0)]), uuid(1010), { outcome: 'dropped', reason: 'The match was postponed. bet365 voided the leg.' }, new Map(), NOW)
const SEASON: SeasonWeek[] = [{ week: MW1, record: mw1 }, { week: MW5, record: mw5 }, { week: MD1, record: md1 }]
const NO_FIXTURES = new Map()
const code = (each: string) => each
const ids = (rows: { view: { parlay: { id: string } } }[]) => rows.map(row => Number.parseInt(row.view.parlay.id.slice(-3), 16))

test("History's rows: every parlay and pick, newest week first, with their results", () => {
  const { parlays, picks } = historyRows(SEASON, NO_FIXTURES, 'all')
  // Played in the order MW1, MD1, MW5; the table shows the newest first.
  assert.deepEqual(ids(sortParlays(parlays, { key: 'week', down: true })), [5, 6, 3, 4, 1, 2])
  assert.deepEqual(parlays.map(row => row.result), ['cashed', 'lost', 'cashed', 'cashed', 'lost', 'open'])
  assert.deepEqual(parlays.map(row => row.legsWon), [1, 1, 2, 3, 0, 0])
  assert.deepEqual(parlays[1].teams, ['MCI', 'LIV', 'TOT', 'ARS'])
  assert.equal(picks.length, 11)
  assert.deepEqual(picks.map(row => row.result), ['won', 'won', 'drawn', 'won', 'won', 'won', 'won', 'won', 'lost', 'dropped', 'open'])
  assert.deepEqual(picks.filter(row => row.number === 2 && row.week === MD1).map(row => row.place), [0, 1, 2])
  // One competition at a time.
  assert.deepEqual(ids(historyRows(SEASON, NO_FIXTURES, 'UCL').parlays), [3, 4])
  assert.deepEqual(weekChoices(parlays).map(week => week.period), ['MW5', 'MD1', 'MW1'])
})

test('Filters: a club in any game, the week, size, result, stake, type and rating', () => {
  const { parlays, picks } = historyRows(SEASON, NO_FIXTURES, 'all')
  const only = (change: Partial<typeof NO_PARLAY_FILTERS>) => ids(filterParlays(parlays, { ...NO_PARLAY_FILTERS, ...change }))
  assert.deepEqual(only({}), [1, 2, 3, 4, 5, 6])
  assert.deepEqual(only({ club: 'ARS' }), [1, 2, 3])     // backed in 1 and 3, faded nowhere, played in 2
  assert.deepEqual(only({ week: 'UCL MD1' }), [3, 4])
  assert.deepEqual(only({ size: '2' }), [2, 3, 5])        // as placed, so the dropped leg still counts
  assert.deepEqual(only({ result: 'lost' }), [2, 5])
  assert.deepEqual(only({ stake: '1000' }), [1, 3, 6])
  assert.deepEqual(only({ club: 'ARS', size: '1' }), [1])
  const pickCount = (change: Partial<typeof NO_PICK_FILTERS>) => filterPicks(picks, { ...NO_PICK_FILTERS, ...change }).length
  assert.equal(pickCount({ club: 'SUN' }), 2)
  assert.equal(pickCount({ kind: 'draw' }), 1)
  assert.equal(pickCount({ kind: 'away-dog' }), 1)        // Brentford at +300; Arsenal at +150 is a favourite
  assert.equal(pickCount({ confidence: '5' }), 1)
  assert.equal(pickCount({ result: 'drawn' }), 1)
  assert.equal(pickCount({ result: 'open' }), 1)
})

test('Sorting: any heading, biggest first for numbers, nothing last either way, ties in the usual order', () => {
  const { parlays, picks } = historyRows(SEASON, NO_FIXTURES, 'all')
  // Profit: +105.84, +47.27, +10, −5, −20, and the open parlay last.
  assert.deepEqual(ids(sortParlays(parlays, { key: 'profit', down: true })), [4, 3, 1, 5, 2, 6])
  assert.deepEqual(ids(sortParlays(parlays, { key: 'profit', down: false })), [2, 5, 1, 3, 4, 6])
  // Stake: $25, $20, the three $10s newest week first (a tie keeps the usual order), then $5.
  assert.deepEqual(ids(sortParlays(parlays, { key: 'stake', down: true })), [4, 2, 6, 3, 1, 5])
  // Returned: biggest first, an open parlay at what it would return, and ties newest week first.
  assert.deepEqual(ids(sortParlays(parlays, { key: 'returned', down: true })), [4, 3, 6, 1, 5, 2])
  // Same heading again reverses; a new one starts the way it suits.
  assert.deepEqual(nextSort({ key: 'week', down: true }, 'week', PARLAYS_FIRST_DOWN), { key: 'week', down: false })
  assert.deepEqual(nextSort({ key: 'week', down: true }, 'profit', PARLAYS_FIRST_DOWN), { key: 'profit', down: true })
  assert.deepEqual(nextSort({ key: 'week', down: true }, 'result', PARLAYS_FIRST_DOWN), { key: 'result', down: false })
  // Picks by game name, A to Z, and by confidence, highest first.
  assert.deepEqual(sortPicks(picks, { key: 'game', down: false }, code).slice(0, 3).map(row => row.leg.home), ['ARS', 'ARS', 'CHE'])
  assert.deepEqual(sortPicks(picks, { key: 'confidence', down: true }, code).slice(0, 2).map(row => row.leg.confidence), [5, 4])
})

test('The CSV formula guard: text that a spreadsheet would run gets an apostrophe', () => {
  assert.equal(csvCell('=1+1'), "'=1+1")
  assert.equal(csvCell('+cmd'), "'+cmd")
  assert.equal(csvCell('-2+3'), "'-2+3")
  assert.equal(csvCell('@SUM(A1)'), "'@SUM(A1)")
  assert.equal(csvCell('\tx'), "'\tx")
  assert.equal(csvCell('\rx'), `"'\rx"`)
  assert.equal(csvCell('=HYPERLINK("http://example.com","Arsenal")'), `"'=HYPERLINK(""http://example.com"",""Arsenal"")"`)
  // Quotes, commas and line breaks are quoted, and plain text left alone.
  assert.equal(csvCell('Brighton, away'), '"Brighton, away"')
  assert.equal(csvCell('Nott\'m Forest'), "Nott'm Forest")
  assert.equal(csvCell('2–1'), '2–1')
  // Numbers this code works out are written as they are.
  assert.equal(csvCell(-175), '-175')
  assert.equal(csvCell(130.84), '130.84')
  assert.equal(csvCell(null), '')
  assert.equal(csvCell(Number.NaN), '')
  assert.equal(toCsv(['A', 'B'], [[1, '=x']]), "\uFEFFA,B\r\n1,'=x\r\n")
  assert.equal(csvName('picks', 2026), 'fmbt-picks-2026-27.csv')
})

test('The CSV files: one row per parlay or pick, in the order shown', () => {
  const { parlays, picks } = historyRows(SEASON, NO_FIXTURES, 'all')
  const lines = parlaysCsv(sortParlays(parlays, { key: 'week', down: true }), code).split('\r\n')
  assert.equal(lines[0], '\uFEFFWeek,Competition,Parlay,Legs,Picks,Odds,Stake,Bonus bet,Boost (%),Result,Returned,Profit,To return')
  assert.equal(lines[2], 'Matchweek 5,Premier League,Parlay 2,1,CRY,120,10,,0,Still to settle,,,22')
  assert.equal(lines[4], 'Matchday 1,Champions League,Parlay 2,3,MCI + LIV + CHE,403,25,,5,Cashed,130.84,105.84,')
  assert.equal(lines.length, 8) // a header, 6 rows, and the last line break
  // A name from the feed that looks like a formula is guarded.
  const hostile = (each: string) => (each === 'ARS' ? '=cmd|"/C calc"!A0' : each)
  assert.match(parlaysCsv(parlays, hostile), /\r\nMatchweek 1,Premier League,Parlay 1,1,"'=cmd\|""\/C calc""!A0",100,10,,0,Cashed,20,10,\r\n/)
  const pickLines = picksCsv(picks, code).split('\r\n')
  assert.equal(pickLines[0], '\uFEFFWeek,Competition,Parlay,Kick-off,Game,Pick,Odds,Confidence,Type,Score,Result')
  assert.equal(pickLines[3], 'Matchweek 1,Premier League,Parlay 2,2026-08-15 12:30,TOT v ARS,ARS,150,2,Away favourite,1–1,Lost to a draw')
  assert.equal(pickLines[10], 'Matchweek 5,Premier League,Parlay 1,2026-09-20 12:30,MUN v NFO,MUN,-150,3,Home favourite,,Dropped')
})

test('Parlays against singles: same picks, an equal share of the stake each', () => {
  // Decision 5's example: −120, +110 and +220 as a $30 parlay that cashes
  // pays $369.60; as $10 singles, $71.33 back, so $41.33 profit. If the +110
  // loses, the singles still make $20.33.
  const three = (outcomes: ('won' | 'lost')[]) => parlay(7, [-120, 110, 220].map((odds, i) => leg(20 + i, { odds,
    settlement: { outcome: outcomes[i], byScore: outcomes[i], score90: [1, 0], how: 'auto', reason: null, promo: false, settledAt: NOW } })), { stakeCents: 3000 })
  assert.equal(singlesCents(three(['won', 'won', 'won']), 33960), 4133)
  assert.equal(singlesCents(three(['won', 'lost', 'won']), -3000), 2033)
  // Made with bonus money, the lost single would have cost nothing: $8.33 + $22.00.
  assert.equal(singlesCents({ ...three(['won', 'lost', 'won']), bonus: true }, 0), 3033)
  // A single keeps its own result, boost and all.
  assert.equal(singlesCents(parlay(8, [leg(30)]), 1234), 1234)

  const { versus } = analytics(SEASON, 'all')
  // The open single isn't counted. Singles: +$10.00; −$5.00 (+$5 and −$10);
  // +$14.55 ($5 at +200 makes $10, $5 at −110 makes $4.55); +$18.17 ($8.33
  // each at 1.48, 1.70 and 2.00); −$2.50 (the dropped leg's single is void).
  assert.deepEqual(versus.sizes, [
    { legs: 1, count: 1, parlayCents: 1000, singlesCents: 1000 },
    { legs: 2, count: 3, parlayCents: -2000 + 4727 - 500, singlesCents: -500 + 1455 - 250 },
    { legs: 3, count: 1, parlayCents: 10584, singlesCents: 1817 },
  ])
  assert.deepEqual({ ...versus, sizes: [] }, { legs: 10, count: 5, parlayCents: 13811, singlesCents: 3522, sizes: [] })
  assert.deepEqual(versusSentence(versus), ['Parlays are ahead at 2 and 3 legs, by ', { b: '$15.22', tone: 'good' }, ' and ', { b: '$87.67', tone: 'good' }, '.', ' A single is the same bet either way.'])
})

test('A parlay waits for every leg before it joins parlays against singles', () => {
  // Lost on its first leg with the second still to play: settled, but its
  // singles aren't, so it's left out until the second leg settles.
  const early = settled(weekOf(parlay(9, [on(40, 'EVE', 'LEE', '2026-10-03T14:00', 'H', 120, 3), on(41, 'BHA', 'WHU', '2026-10-04T14:00', 'H', -150, 3)], { stakeCents: 1000 })), [score(40, 0, 1)])
  const week: Week = { season: 2026, competition: 'PL', period: 'MW7' }
  assert.equal(analytics([{ week, record: early }], 'all').versus.count, 0)
  const later = settleWeek(early, new Map([[900_041, score(41, 2, 0)]]), NOW).record
  assert.deepEqual(analytics([{ week, record: later }], 'all').versus.sizes, [{ legs: 2, count: 1, parlayCents: -1000, singlesCents: -500 + 333 }])
})

test('Moments: perfect weeks, heartbreakers, draw kills and promos', () => {
  const { moments } = analytics(SEASON, 'all')
  assert.deepEqual(moments.perfectWeeks, [MD1])
  // A week isn't perfect while one of its parlays is still to settle.
  const half = settled(weekOf(
    parlay(12, [on(60, 'ARS', 'CHE', '2026-10-17T14:00', 'H', 100, 3)], { stakeCents: 1000 }),
    parlay(13, [on(61, 'MCI', 'LIV', '2026-10-18T14:00', 'H', 100, 3)], { stakeCents: 1000 }),
  ), [score(60, 1, 0)])
  assert.deepEqual(analytics([{ week: { season: 2026, competition: 'PL', period: 'MW8' }, record: half }], 'all').moments.perfectWeeks, [])
  // Matchweek 5's double lost its only leg left after the drop: not a heartbreaker.
  assert.deepEqual(moments.heartbreakers, [{ week: MW1, number: 2, wouldCents: 7500 }])
  assert.deepEqual(moments.drawKills, [{ code: 'ARS', n: 1 }])
  assert.deepEqual(moments.promos, [])
  assert.deepEqual(momentNotes(moments, code), {
    perfect: 'Matchday 1, when every parlay cashed.',
    heartbreak: "Matchweek 1's parlay 2 would have paid $75.00.",
    draws: 'On ARS.',
    promos: 'None yet.',
  })

  // A promo only counts when it paid a leg the score says lost: a 2-Up on a
  // 2–2 draw, not one on a win that came anyway.
  const promo = (n: number, home: number, away: number) => settleByHand(
    weekOf(parlay(n, [on(n + 50, 'RMA', 'LIV', '2026-11-04T20:00', 'A', 200, 2)], { stakeCents: 1000 })),
    uuid(1000 + n + 50), { outcome: 'won', promo: true, reason: 'Paid early by 2-Up.' }, new Map([[900_000 + n + 50, score(n + 50, home, away)]]), NOW)
  const week: Week = { season: 2026, competition: 'UCL', period: 'MD4' }
  const paid = analytics([{ week, record: promo(10, 2, 2) }], 'all').moments
  assert.deepEqual(paid.promos, [{ week, number: 1, payoutCents: 3000 }])
  assert.equal(momentNotes(paid, code).promos, 'From 1 parlay.')
  assert.deepEqual(analytics([{ week, record: promo(11, 1, 3) }], 'all').moments.promos, [])
})

test('The club ledger: backing and fading every club, draw picks for neither', () => {
  const { ledger } = analytics(SEASON, 'all')
  assert.deepEqual(ledger.map(row => row.code), ['ARS', 'BOU', 'BRE', 'CHE', 'EVE', 'FUL', 'LEE', 'LIV', 'MCI', 'SUN', 'TOT'])
  const arsenal = ledger[0]
  assert.deepEqual(arsenal.competitions, ['PL', 'UCL'])
  // Backed three times: won at +100, drawn at +150, won at −110.
  assert.deepEqual({ ...arsenal.backing, odds: 0 }, { n: 3, won: 2, drawn: 1, lost: 0, you: 2 / 3, odds: 0 })
  assert.ok(Math.abs(arsenal.backing.odds - (0.476190 + 0.380952 + 0.498866) / 3) < 5e-6)
  assert.equal(arsenal.fading.n, 0)
  // Tottenham were faded on that 1–1, and Leeds on Brentford's loss.
  assert.deepEqual([ledger[10].fading.drawn, ledger[10].backing.n], [1, 0])
  assert.deepEqual([ledger[6].fading.lost, ledger[2].backing.lost], [1, 1])
  assert.deepEqual(ledgerSentence(ledger, code), ['ARS are your most reliable club: ', { b: '2 of 3', tone: 'you' }, ' landed, where the odds said ', { b: '45%', tone: 'odds' }, '.'])
  // One competition at a time: Arsenal's Champions League pick alone.
  assert.equal(analytics(SEASON, 'UCL').ledger.find(row => row.code === 'ARS')?.backing.n, 1)
})
