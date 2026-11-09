// Tests for step 11.1: the import's CSV reader (src/lib/import/csv-reader.ts)
// and its plan (src/lib/import/plan.ts). The teams, fixtures and files are
// made up by hand. Only the cent-apart parlay uses real numbers: the odds,
// stake, boost and return of KMan's own bet365 slip, which say $81.26 where
// the app works out $81.25 (claude/fmbt-step11-plan.md, decision 3).
process.env.TZ = 'America/Toronto' // the Date column is a date in this computer's time

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parlayOutcome } from '../src/lib/bets/settle.ts'
import { EMPTY_WEEK, isWeekRecord, TOMBSTONE, type Competition, type WeekRecord } from '../src/lib/bets/week-record.ts'
import type { LoadedWeek } from '../src/lib/bets/weeks.ts'
import type { Fixture, Team } from '../src/lib/fixtures.ts'
import { MAX_CELL, MAX_ROWS, readCsv } from '../src/lib/import/csv-reader.ts'
import { planImport, PROMO_REASON, teamsCalled, VOID_REASON, type ImportContext, type ImportPlan } from '../src/lib/import/plan.ts'

const TEAMS = new Map<number, Team>([
  [1, { id: 1, name: 'Manchester City FC', shortName: 'Man City', code: 'MCI' }],
  [2, { id: 2, name: 'Nottingham Forest FC', shortName: 'Nottingham', code: 'NOT' }],
  [3, { id: 3, name: 'Arsenal FC', shortName: 'Arsenal', code: 'ARS' }],
  [4, { id: 4, name: 'Hull City AFC', shortName: 'Hull', code: 'HUL' }],
  [5, { id: 5, name: 'Liverpool FC', shortName: 'Liverpool', code: 'LIV' }],
  [6, { id: 6, name: 'Crystal Palace FC', shortName: 'Crystal Palace', code: 'CRY' }],
  [7, { id: 7, name: 'Borussia Dortmund', shortName: 'Dortmund', code: 'BVB' }],
  [8, { id: 8, name: 'Real Betis Balompié', shortName: 'Real Betis', code: 'BET' }],
  [9, { id: 9, name: 'SK Slavia Praha', shortName: 'Slavia Praha', code: 'SLA' }],
  [10, { id: 10, name: 'RB Leipzig', shortName: 'RB Leipzig', code: 'RBL' }],
  [11, { id: 11, name: 'Real Madrid CF', shortName: 'Real Madrid', code: 'RMA' }],
  [12, { id: 12, name: 'Manchester United FC', shortName: 'Man United', code: 'MUN' }],
  [13, { id: 13, name: 'Tottenham Hotspur FC', shortName: 'Tottenham', code: 'TOT' }],
])
const CODES = new Map([...TEAMS.values()].map(team => [team.code, team.id]))

function game(id: number, competition: Competition, period: string, kickoff: string, home: string, away: string, score: [number, number] | null): Fixture {
  return {
    id, competition, season: 2026, period, tie_leg: null, kickoff, home, away,
    home_team_id: CODES.get(home) ?? 0, away_team_id: CODES.get(away) ?? 0,
    status: score === null ? 'scheduled' : 'finished', minute: null,
    home_90: score?.[0] ?? null, away_90: score?.[1] ?? null, home_ht: null, away_ht: null, home_et: null, away_et: null, home_pens: null, away_pens: null,
  }
}
const FIXTURES = new Map([
  game(1, 'PL', 'MW3', '2026-08-30T14:00:00.000Z', 'NOT', 'MCI', [3, 1]),
  game(2, 'PL', 'MW3', '2026-08-30T14:00:00.000Z', 'ARS', 'HUL', [1, 0]),
  game(3, 'PL', 'MW3', '2026-08-31T15:30:00.000Z', 'CRY', 'LIV', [1, 3]),
  game(4, 'PL', 'MW4', '2026-09-13T14:00:00.000Z', 'MUN', 'TOT', [2, 2]),
  game(5, 'PL', 'MW4', '2026-09-13T16:30:00.000Z', 'LIV', 'HUL', [1, 1]),
  game(6, 'UCL', 'MD1', '2026-09-16T19:00:00.000Z', 'RBL', 'MCI', [2, 3]),
  game(7, 'UCL', 'MD1', '2026-09-17T16:45:00.000Z', 'SLA', 'ARS', [1, 2]),
  game(8, 'UCL', 'MD1', '2026-09-17T19:00:00.000Z', 'BVB', 'BET', [2, 1]),
  game(9, 'UCL', 'MD2', '2026-10-01T19:00:00.000Z', 'MCI', 'RMA', [1, 0]),
  game(10, 'UCL', 'R16', '2027-03-10T20:00:00.000Z', 'MCI', 'RMA', null),
].map(each => [each.id, each]))
const NOW = '2026-11-09T15:00:00.000Z'
const context = (saved: LoadedWeek[] = []): ImportContext => ({ season: 2026, fixtures: FIXTURES, teams: TEAMS, saved, now: NOW })

const HEADER = 'Parlay,Stake,Boost %,Result,Returned,Home,Away,Pick,Odds,Early payout,Home goals,Away goals,Leg result,Confidence'
const file = (...rows: string[]) => `\uFEFF${[HEADER, ...rows].join('\r\n')}\r\n`
function plan(text: string, saved: LoadedWeek[] = []) {
  const planned: ImportPlan = planImport(text, context(saved))
  if (planned.problem !== null) assert.fail(planned.problem)
  return planned
}
const problems = (planned: ReturnType<typeof plan>) =>
  planned.weeks.flatMap(week => week.parlays.flatMap(parlay => [...parlay.problems, ...parlay.legs.flatMap(leg => leg.problems)]))

// Three parlays, one in each of three weeks, each as bet365 shows it.
const GOOD = [
  // Matchweek 3: lost on Man City at Forest. Liverpool's early payout won anyway.
  '1,25.00,,Lost,0.00,Nottm Forest,Man City,Man City,-150,,3,1,Lost,4',
  '1,,,,,Arsenal,Hull,Arsenal,-700,,1,0,Won,5',
  '1,,,,,Crystal Palace,Liverpool,Liverpool,-154,yes,1,3,Won,3',
  // Matchday 1: KMan's slip, three wins with a 5% boost.
  '2,25.00,5,Won,81.26,RB Leipzig,Man City,Man City,-167,,2,3,Won,4',
  '2,25.00,5,Won,81.26,Slavia Prague,Arsenal,Arsenal,-400,,1,2,Won,5',
  '2,25.00,5,Won,81.26,Borussia Dortmund,Real Betis,Borussia Dortmund,-175,,2,1,Won,3',
  // Matchweek 4: a $10 single on the draw.
  '3,$10.00,,Won,35.00,Man Utd,Spurs,Draw,+250,,2,2,Won,2',
]

test('reading the CSV: quotes, line endings, Excel\'s byte-order mark and blank lines', () => {
  assert.deepEqual(readCsv('\uFEFFa,b\r\n"x, y","say ""hi"""\r\n\r\n,\r\n'), { header: ['a', 'b'], rows: [{ line: 2, cells: ['x, y', 'say "hi"'] }] })
  // The mark goes before a quoted first cell too, which would otherwise look like a quote mid-cell.
  assert.deepEqual(readCsv('\uFEFF"Parlay",b\n'), { header: ['Parlay', 'b'], rows: [] })
  assert.deepEqual(readCsv('a\n"two\nlines"\nnext'), { header: ['a'], rows: [{ line: 2, cells: ['two\nlines'] }, { line: 4, cells: ['next'] }] })
  assert.deepEqual(readCsv('a,b\n"open'), { problem: 'A quote that opens on line 2 is never closed.' })
  assert.deepEqual(readCsv('a,b\nx"y,z'), { problem: 'Line 2 has a quote in the middle of a cell.' })
  assert.deepEqual(readCsv(`a\n${'x'.repeat(MAX_CELL + 1)}`), { problem: `Line 2 has a cell longer than ${MAX_CELL} characters.` })
  assert.deepEqual(readCsv('a\n\uFFFD'), { problem: "The file isn't UTF-8. In Excel, save it as CSV UTF-8." })
  assert.deepEqual(readCsv('\r\n\r\n'), { problem: 'The file is empty.' })
  assert.ok('header' in readCsv(`a\n${'1\n'.repeat(MAX_ROWS)}`))
  assert.ok('problem' in readCsv(`a\n${'1\n'.repeat(MAX_ROWS + 1)}`))
})

test('the header: every column the import needs, in any order and case, and nothing else', () => {
  assert.deepEqual(planImport(`${HEADER},Notes\n`, context()), { problem: 'The file has a column the import doesn\'t know: "Notes".', weeks: [] })
  assert.deepEqual(planImport('Parlay,Stake\n', context()).problem?.startsWith('The file is missing columns: "boost %", "result"'), true)
  assert.deepEqual(planImport(`${HEADER},Odds\n`, context()), { problem: 'The file has the "Odds" column twice.', weeks: [] })
  const shuffled = HEADER.split(',').reverse().join(',').toUpperCase()
  const row = GOOD[6].split(',').reverse().join(',')
  assert.equal(plan(`${shuffled}\n${row}\n`).weeks[0].status, 'ready')
  assert.equal(planImport(`${HEADER}\n1,2,3\n`, context()).problem, 'Line 2 has 3 cells, but the header has 14.')
  assert.equal(planImport(`${HEADER}\n${GOOD[6].replace(/^3/, 'three')}\n`, context()).problem, "Line 2's parlay number isn't a whole number from 1 to 9999.")
})

test("bet365's names find football-data's teams, and the match settles which", () => {
  const called = (typed: string) => [...teamsCalled(typed, TEAMS)].sort()
  assert.deepEqual(called('Nottm Forest'), ['NOT'])
  assert.deepEqual(called('Man City'), ['MCI'])
  assert.deepEqual(called('Man Utd'), ['MUN'])
  assert.deepEqual(called('Spurs'), ['TOT'])
  assert.deepEqual(called('Slavia Prague'), ['SLA'])
  assert.deepEqual(called('Borussia Dortmund'), ['BVB'])
  assert.deepEqual(called('real betis'), ['BET'])
  assert.deepEqual(called('Real'), ['BET', 'RMA'])
  assert.deepEqual(called('MCI'), ['MCI'])
  assert.deepEqual(called('Wrexham'), [])
})

test('a good file: each week built and settled the way the slips say, newest first', () => {
  const planned = plan(file(...GOOD))
  assert.deepEqual([planned.parlays, planned.legs], [3, 7])
  assert.deepEqual(planned.weeks.map(week => [week.key, week.status]), [['UCL MD1', 'ready'], ['PL MW4', 'ready'], ['PL MW3', 'ready']])
  assert.deepEqual(problems(planned), [])
  const [md1, mw4, mw3] = planned.weeks.map(week => week.record as WeekRecord)
  for (const record of [md1, mw4, mw3]) assert.ok(isWeekRecord(record))

  // Matchweek 3 lost, and the early payout that won anyway settled from the score.
  assert.deepEqual(parlayOutcome(mw3.parlays[0]).state, 'lost')
  assert.deepEqual(mw3.parlays[0].legs.map(leg => [leg.settlement?.outcome, leg.settlement?.how, leg.confidence]), [['lost', 'auto', 4], ['won', 'auto', 5], ['won', 'auto', 3]])
  assert.deepEqual(planned.weeks[2].parlays[0].legs.map(leg => leg.shown), ['lost', 'won', 'won'])
  // The slip's cent: $81.26 there, $81.25 here, noted and still ready.
  assert.deepEqual(parlayOutcome(md1.parlays[0]), { state: 'won', payoutCents: 8125, profitCents: 5625 })
  assert.equal(md1.parlays[0].boostBps, 500)
  assert.equal(planned.weeks[0].parlays[0].note, 'The slip says $81.26, 1 cent more. $81.25 is saved.')
  // The draw single: 10 × 3.5.
  assert.deepEqual([mw4.parlays[0].legs[0].pick, parlayOutcome(mw4.parlays[0]).payoutCents], ['D', 3500])
})

test('an early payout on a leg the score says lost is won by a promo, and a void leg is dropped', () => {
  // Liverpool drew 1–1 with Hull, but bet365 paid it early: $10 at −200.
  const promo = plan(file('1,10.00,,Won,15.00,Liverpool,Hull,Liverpool,-200,yes,1,1,Won,4'))
  const leg = promo.weeks[0].record?.parlays[0].legs[0]
  assert.deepEqual({ ...leg?.settlement, settledAt: '' }, { outcome: 'won', byScore: 'lost', score90: [1, 1], how: 'override', reason: PROMO_REASON, promo: true, settledAt: '' })
  assert.equal(promo.weeks[0].parlays[0].legs[0].shown, 'promo')
  // The same leg without the early payout is a mistake to fix.
  const wrong = plan(file('1,10.00,,Won,15.00,Liverpool,Hull,Liverpool,-200,,1,1,Won,4'))
  assert.equal(wrong.weeks[0].status, 'held')
  assert.match(problems(wrong)[0], /^The file says this leg won, but the 90-minute score was 1–1\./)
  assert.equal(plan(file('1,10.00,,Lost,0.00,Liverpool,Hull,Liverpool,-200,yes,1,1,Lost,4')).weeks[0].status, 'held')

  // A void leg comes out, so the parlay pays on its other leg: $10 at +250.
  const voided = plan(file('1,10.00,,Won,35.00,Man Utd,Spurs,Draw,+250,,2,2,Won,3', '1,,,,,Liverpool,Hull,Liverpool,-200,,,,Void,3'))
  const legs = voided.weeks[0].record?.parlays[0].legs ?? []
  assert.deepEqual(legs.map(each => [each.settlement?.outcome, each.settlement?.how, each.settlement?.reason]), [['won', 'auto', null], ['dropped', 'void', VOID_REASON]])
  assert.equal(voided.weeks[0].parlays[0].returnCents, 3500)
})

test('every check that holds a week back', () => {
  const only = (...rows: string[]) => problems(plan(file(...rows)))
  assert.deepEqual(only('1,10.00,,Won,15.00,Wrexham,Hull,Wrexham,-200,,1,1,Won,4'), ['No team called "Wrexham" plays this season.'])
  assert.deepEqual(only('1,10.00,,Won,15.00,Hull,Arsenal,Arsenal,-200,,0,1,Won,4'), ['No match this season has "Hull" at home to "Arsenal".'])
  assert.deepEqual(only('1,10.00,,Won,15.00,Arsenal,Hull,Arsenal,-200,,2,0,Won,4'), ["The file's score is 2–0, but the 90-minute score was 1–0."])
  assert.deepEqual(only('1,10.00,,Won,15.00,Arsenal,Hull,Arsenal,-200,,1,0,Won,'), ['Give this leg a confidence rating from 1 to 5.'])
  assert.deepEqual(only('1,10.00,,Won,15.00,Arsenal,Hull,Arsenal,-200,,1,0,Won,6'), ['The confidence should be a whole number from 1 to 5.'])
  assert.deepEqual(only('1,10.00,,Won,15.00,Arsenal,Hull,Arsenal,-99,,1,0,Won,4'), ['The odds should look like -110 or +175.'])
  assert.deepEqual(only('1,10.00,,Won,15.00,Arsenal,Hull,Liverpool,-200,,1,0,Won,4'), ['The pick "Liverpool" isn\'t either team or the draw.'])
  assert.deepEqual(only('1,10.00,,Won,15.00,Arsenal,Hull,Arsenal,-200,maybe,1,0,Won,4'), ['Early payout should be yes, or blank.'])
  assert.deepEqual(only('1,10.00,,Won,15.00,Arsenal,Hull,Arsenal,-200,,1,0,Win,4'), ["The leg's result should be Won, Lost or Void."])
  assert.deepEqual(only('1,ten,,Won,15.00,Arsenal,Hull,Arsenal,-200,,1,0,Won,4'), ['The stake should look like 25.00.'])
  // The legs say lost, the slip says won, or the return is off by more than a cent.
  assert.deepEqual(only('1,10.00,,Won,15.00,Nottm Forest,Man City,Man City,-200,,3,1,Lost,4'), ['The file says this parlay won, but its legs say it lost.'])
  assert.deepEqual(only('1,10.00,,Won,15.02,Arsenal,Hull,Arsenal,-200,,1,0,Won,4'), ['The slip says $15.02, but these odds and this stake return $15.00. Check the odds and the stake.'])
  assert.deepEqual(only('1,10.00,,Won,15.00,Arsenal,Hull,Arsenal,-200,,1,0,Won,4', '1,20.00,,,,Crystal Palace,Liverpool,Liverpool,-154,,1,3,Won,4'),
    ['Line 3 gives this parlay a different stake, boost, result or return.'])
  // A parlay across two weeks, and the same parlay twice.
  assert.deepEqual(only('1,10.00,,Won,30.00,Arsenal,Hull,Arsenal,-200,,1,0,Won,4', '1,,,,,Man Utd,Spurs,Draw,+100,,2,2,Won,4'),
    ["This parlay's games are in different weeks, and the app keeps each parlay to one week."])
  assert.deepEqual(only('1,10.00,,Won,15.00,Arsenal,Hull,Arsenal,-200,,1,0,Won,4', '2,10.00,,Won,15.00,Arsenal,Hull,Arsenal,-200,,1,0,Won,4'),
    ["This is the same as parlay 1 in the file. If it's a copy, take it out of the file."])
  // A match with no final score yet, and a pairing played twice.
  assert.deepEqual(only('1,10.00,,Won,15.00,Man City,Real Madrid,Man City,-200,,1,0,Won,4'),
    ['"Man City" v "Real Madrid" is played more than once this season. Add its date, like 2026-08-22, in the Date column.'])
})

test('the Date and Competition columns settle a pairing played twice', () => {
  const header = `${HEADER},Date,Competition`
  const dated = plan(`${header}\n1,10.00,,Won,15.00,Man City,Real Madrid,Man City,-200,,1,0,Won,4,2026-10-01,UCL\n`)
  assert.deepEqual([dated.weeks[0].key, dated.weeks[0].status], ['UCL MD2', 'ready'])
  const later = plan(`${header}\n1,10.00,,Won,15.00,Man City,Real Madrid,Man City,-200,,1,0,Won,4,2027-03-10,\n`)
  assert.deepEqual(problems(later), ["This match has no final 90-minute score in the fixtures, so the app can't settle it."])
  assert.deepEqual(problems(plan(`${header}\n1,10.00,,Won,15.00,Arsenal,Hull,Arsenal,-200,,1,0,Won,4,30/08/2026,EPL\n`)),
    ['The competition should be PL or UCL, or blank.', 'The date should look like 2026-08-22, or be blank.', 'No match this season has "Arsenal" at home to "Hull".'])
})

test('a problem holds back its whole week, and a week that already has parlays is skipped', () => {
  const held = plan(file(...GOOD, '4,10.00,,Won,15.00,Arsenal,Hull,Arsenal,-200,,1,0,Won,'))
  assert.deepEqual(held.weeks.map(week => [week.key, week.status, week.record === null]), [['UCL MD1', 'ready', false], ['PL MW4', 'ready', false], ['PL MW3', 'held', true]])
  // The good parlay in a held week still shows what it comes to.
  assert.equal(held.weeks[2].parlays[0].state, 'lost')

  // Matchweek 3 saved as the good file saves it.
  const record = plan(file(...GOOD)).weeks[2].record
  assert.ok(record !== null)
  const saved: LoadedWeek = { week: { season: 2026, competition: 'PL', period: 'MW3' }, record, version: 1, newestVersion: 1 }
  const skipped = plan(file(...GOOD), [saved])
  assert.deepEqual(skipped.weeks.map(week => [week.key, week.status, week.record === null]), [['UCL MD1', 'ready', false], ['PL MW4', 'ready', false], ['PL MW3', 'skipped', true]])
  // A week that's never been saved, or saved for another season, doesn't count,
  // and nor does one with no parlays left: emptied, or deleted, which saves a
  // tombstone. It fills again, as Build parlay would start it again.
  assert.equal(plan(file(...GOOD), [{ ...saved, record: EMPTY_WEEK, version: 0, newestVersion: 0 }]).weeks[2].status, 'ready')
  assert.equal(plan(file(...GOOD), [{ ...saved, week: { ...saved.week, season: 2025 } }]).weeks[2].status, 'ready')
  assert.equal(plan(file(...GOOD), [{ ...saved, record: EMPTY_WEEK, version: 2, newestVersion: 2 }]).weeks[2].status, 'ready')
  assert.equal(plan(file(...GOOD), [{ ...saved, record: TOMBSTONE, version: 2, newestVersion: 2 }]).weeks[2].status, 'ready')
})
