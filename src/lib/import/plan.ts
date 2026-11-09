// Planning an import (step 11.1, claude/fmbt-step11-plan.md): the backfill's
// CSV of KMan's bet365 history, read into weeks of parlays, with every leg
// matched to this season's fixtures and checked. Each week that passes is
// built into the record that saving adds. Nothing here saves or fetches
// anything, so the preview shows exactly what would be saved.
//
// The file has one row per leg. A parlay's own columns (stake, boost, its
// result and what it returned) go on its first row, and its other rows
// leave them blank or repeat them.
import { parseBoost, parseOdds, parseStake } from '../bets/inputs.ts'
import { finalScore90, parlayOutcome, settleByHand, settleWeek, voidLeg, type ParlayState } from '../bets/settle.ts'
import { addParlay, EMPTY_WEEK, type Competition, type EntryProblem, type Pick, type Week, type WeekRecord } from '../bets/week-record.ts'
import type { LoadedWeek } from '../bets/weeks.ts'
import type { Fixture, Team } from '../fixtures.ts'
import { money } from '../format.ts'
import { readCsv } from './csv-reader.ts'

// The reasons the import gives the legs it settles by hand.
export const PROMO_REASON = "Paid early by bet365's 2-goals-ahead promo."
export const VOID_REASON = 'bet365 voided this leg.'

// The file's columns, as Excel shows them, matched without minding case.
// Competition and Date are only needed when a pairing is played twice, and
// Bonus bet only when a parlay was made with bet365 bonus money (step 11.2).
// A bonus bet's Returned is what its slip calls the Net Return: winnings only.
type Column = 'parlay' | 'stake' | 'boost' | 'bonus' | 'result' | 'returned' | 'home' | 'away' | 'pick' | 'odds' | 'early'
  | 'homeGoals' | 'awayGoals' | 'legResult' | 'confidence' | 'competition' | 'date'
const COLUMNS = new Map<string, Column>([
  ['parlay', 'parlay'], ['stake', 'stake'], ['boost %', 'boost'], ['bonus bet', 'bonus'], ['result', 'result'], ['returned', 'returned'],
  ['home', 'home'], ['away', 'away'], ['pick', 'pick'], ['odds', 'odds'], ['early payout', 'early'],
  ['home goals', 'homeGoals'], ['away goals', 'awayGoals'], ['leg result', 'legResult'], ['confidence', 'confidence'],
  ['competition', 'competition'], ['date', 'date'],
])
const OPTIONAL = new Set<Column>(['bonus', 'competition', 'date'])
const PARLAY_COLUMNS = ['stake', 'boost', 'bonus', 'result', 'returned'] as const

export type SlipResult = 'won' | 'lost' | 'void'
export type LegShown = 'won' | 'lost' | 'drawn' | 'dropped' | 'promo'

export type ImportLeg = {
  line: number
  homeText: string          // the teams and pick as the file has them
  awayText: string
  pickText: string
  fixture: Fixture | null
  pick: Pick | null
  odds: number | null
  confidence: number | null
  slipScore: [number, number] | null
  shown: LegShown | null    // how the app will settle it
  problems: string[]
  note: string | null
}

export type ImportParlay = {
  number: number            // its number in the file
  line: number
  stakeCents: number | null
  boostBps: number | null
  bonus: boolean | null     // made with bet365 bonus money; null when the cell isn't yes, no or blank
  slipResult: SlipResult | null
  slipReturnCents: number | null
  legs: ImportLeg[]
  state: ParlayState | null // as the app works it out
  returnCents: number | null
  problems: string[]
  note: string | null       // a return a cent away from the slip's
}

export type ImportWeek = {
  key: string
  week: Week | null         // null for parlays that couldn't be put in a week
  firstKickoff: string      // for putting weeks in the order they were played
  status: 'ready' | 'held' | 'skipped'
  parlays: ImportParlay[]
  record: WeekRecord | null // what saving adds, for a ready week
}

export type ImportPlan = { problem: string; weeks: [] } | { problem: null; weeks: ImportWeek[]; parlays: number; legs: number }

export type ImportContext = {
  season: number
  fixtures: ReadonlyMap<number, Fixture>
  teams: ReadonlyMap<number, Team>
  saved: readonly LoadedWeek[]  // every week already in the app
  now: string
}

// ----- Teams: bet365's names matched to football-data's -----

// Words that don't tell clubs apart, and bet365's short forms.
const SPARE = new Set(['fc', 'afc', 'cf', 'sc', 'sk', 'fk', 'ac', 'club', 'de', 'cp'])
const SHORT = new Map([
  ['man', 'manchester'], ['utd', 'united'], ['nottm', 'nottingham'], ['spurs', 'tottenham hotspur'],
  ['wolves', 'wolverhampton wanderers'], ['prague', 'praha'], ['munich', 'munchen'], ['inter', 'internazionale'],
  ['psg', 'paris saint germain'],
])

const plain = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim()
const words = (text: string) => plain(text).split(' ').filter(word => word !== '' && !SPARE.has(word))
const typedWords = (text: string) => words(text).flatMap(word => (SHORT.get(word) ?? word).split(' '))

// True when `part` appears in `whole`, word for word and in order.
function within(part: readonly string[], whole: readonly string[]): boolean {
  if (part.length === 0) return false
  for (let i = 0; i + part.length <= whole.length; i++) if (part.every((word, j) => whole[i + j] === word)) return true
  return false
}

// The codes of every team a typed name could be. The match itself settles
// which, since only one pairing of them is played at home that way.
export function teamsCalled(typed: string, teams: ReadonlyMap<number, Team>): Set<string> {
  const want = typedWords(typed)
  const found = new Set<string>()
  for (const team of teams.values()) {
    if (plain(typed) === team.code.toLowerCase() || within(want, words(team.name)) || within(want, words(team.shortName))) found.add(team.code)
  }
  return found
}

// ----- Reading values -----

const scoreSays = (pick: Pick, [home, away]: readonly [number, number]): 'won' | 'lost' =>
  (pick === 'H' ? home > away : pick === 'A' ? away > home : home === away) ? 'won' : 'lost'

function moneyCents(text: string): number | null {
  const typed = text.trim().replace(/^\$/, '')
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(typed)) return null
  const [dollars, cents = ''] = typed.split('.')
  return Number(dollars) * 100 + Number(cents.padEnd(2, '0'))
}

// Yes is true, and no or blank is false. Anything else is null.
function yesOrNo(text: string): boolean | null {
  const typed = text.toLowerCase()
  return typed === 'yes' ? true : typed === 'no' || typed === '' ? false : null
}

function slipResult(text: string): SlipResult | null {
  const typed = text.trim().toLowerCase()
  return typed === 'won' || typed === 'lost' || typed === 'void' ? typed : null
}

const goals = (text: string) => (/^\d{1,2}$/.test(text.trim()) ? Number(text.trim()) : null)

// A kick-off's date in this computer's time, as the Date column has it.
function localDate(iso: string): string {
  const time = new Date(iso)
  return `${time.getFullYear()}-${String(time.getMonth() + 1).padStart(2, '0')}-${String(time.getDate()).padStart(2, '0')}`
}

const ENTRY_WORDS: Partial<Record<EntryProblem, string>> = {
  'week full': 'That week would hold over 100 parlays or 500 legs, which is as many as one week can.',
  'too many legs': 'A parlay can have up to 40 legs.',
  'same game twice': 'This parlay has the same game twice.',
  'payout too big': 'This parlay could pay over $100 million, which is more than the app allows.',
}

const weekKeyOf = (week: Week) => `${week.competition} ${week.period}`
const sameLegs = (a: ImportParlay, b: ImportParlay) => a.stakeCents === b.stakeCents && a.boostBps === b.boostBps && a.bonus === b.bonus && a.legs.length === b.legs.length
  && a.legs.every((leg, i) => leg.fixture?.id === b.legs[i].fixture?.id && leg.pick === b.legs[i].pick && leg.odds === b.legs[i].odds)

// ----- The plan -----

export function planImport(text: string, context: ImportContext): ImportPlan {
  const table = readCsv(text)
  if ('problem' in table) return { problem: table.problem, weeks: [] }

  // The header: every column known, none twice, and every one needed there.
  const index = new Map<Column, number>()
  for (const [i, name] of table.header.entries()) {
    const column = COLUMNS.get(name.toLowerCase().replace(/\s+/g, ' '))
    if (column === undefined) return { problem: `The file has a column the import doesn't know: "${name}".`, weeks: [] }
    if (index.has(column)) return { problem: `The file has the "${name}" column twice.`, weeks: [] }
    index.set(column, i)
  }
  const missing = [...COLUMNS].filter(([, column]) => !OPTIONAL.has(column) && !index.has(column)).map(([name]) => `"${name}"`)
  if (missing.length > 0) return { problem: `The file is missing ${missing.length === 1 ? 'a column' : 'columns'}: ${missing.join(', ')}.`, weeks: [] }

  // The rows, grouped into parlays by their number, in the file's order.
  const parlays = new Map<number, ImportParlay>()
  const firsts = new Map<number, Map<Column, string>>() // each parlay's own columns, from its first row
  for (const row of table.rows) {
    if (row.cells.length !== table.header.length) return { problem: `Line ${row.line} has ${row.cells.length} cells, but the header has ${table.header.length}.`, weeks: [] }
    const cell = (column: Column) => {
      const at = index.get(column)
      return at === undefined ? '' : row.cells[at].trim()
    }
    const number = /^\d{1,4}$/.test(cell('parlay')) ? Number(cell('parlay')) : 0
    if (number < 1) return { problem: `Line ${row.line}'s parlay number isn't a whole number from 1 to 9999.`, weeks: [] }
    let parlay = parlays.get(number)
    if (parlay === undefined) {
      parlay = {
        number, line: row.line,
        stakeCents: parseStake(cell('stake')), boostBps: parseBoost(cell('boost')), bonus: yesOrNo(cell('bonus')),
        slipResult: slipResult(cell('result')), slipReturnCents: moneyCents(cell('returned')),
        legs: [], state: null, returnCents: null, problems: [], note: null,
      }
      if (parlay.stakeCents === null) parlay.problems.push('The stake should look like 25.00.')
      if (parlay.boostBps === null) parlay.problems.push('The boost should be a percent like 5, or blank.')
      if (parlay.bonus === null) parlay.problems.push('Bonus bet should be yes, or blank.')
      if (parlay.slipResult === null) parlay.problems.push('The result should be Won, Lost or Void.')
      if (parlay.slipReturnCents === null) parlay.problems.push('What it returned should look like 81.26, or 0.00.')
      parlays.set(number, parlay)
      firsts.set(number, new Map(PARLAY_COLUMNS.map(column => [column, cell(column)])))
    } else {
      // Later rows of a parlay leave its own columns blank, or repeat them.
      const first = firsts.get(number)
      if (PARLAY_COLUMNS.some(column => cell(column) !== '' && cell(column) !== first?.get(column))) {
        parlay.problems.push(`Line ${row.line} gives this parlay a different stake, boost, bonus bet, result or return.`)
      }
    }
    parlay.legs.push(readLeg(row.line, cell, context))
  }

  // Each parlay goes in the week of its games, and every game has to be in one week.
  const weeks = new Map<string, ImportWeek>()
  for (const parlay of parlays.values()) {
    const placed = parlay.legs.map(leg => leg.fixture).filter(fixture => fixture !== null)
    const keys = new Set(placed.map(fixture => `${fixture.competition} ${fixture.period}`))
    if (keys.size > 1) parlay.problems.push("This parlay's games are in different weeks, and the app keeps each parlay to one week.")
    const fixture = keys.size === 1 && placed.length === parlay.legs.length ? placed[0] : null
    const week: Week | null = fixture === null ? null : { season: context.season, competition: fixture.competition, period: fixture.period }
    const key = week === null ? 'unplaced' : weekKeyOf(week)
    const group: ImportWeek = weeks.get(key) ?? { key, week, firstKickoff: '', status: 'held', parlays: [], record: null }
    group.parlays.push(parlay)
    weeks.set(key, group)
  }

  const list = [...context.fixtures.values()]
  for (const group of weeks.values()) {
    const week = group.week
    group.firstKickoff = group.parlays.flatMap(parlay => parlay.legs.map(leg => leg.fixture?.kickoff ?? '')).filter(Boolean).sort()[0] ?? ''
    if (week === null) continue
    // A week that already holds parlays is skipped whole, so nothing doubles
    // up. One you've deleted or emptied holds none, so it fills again, the way
    // Build parlay starts a deleted week again.
    if (context.saved.some(saved => saved.version > 0 && saved.record.parlays.length > 0 && saved.week.season === week.season && saved.week.competition === week.competition && saved.week.period === week.period)) {
      group.status = 'skipped'
      continue
    }
    group.parlays.forEach((parlay, i) => {
      const twin = group.parlays.slice(0, i).find(other => sameLegs(other, parlay))
      if (twin !== undefined) parlay.problems.push(`This is the same as parlay ${twin.number} in the file. If it's a copy, take it out of the file.`)
    })
    // Each parlay that passes so far is added and settled, and what the app
    // works out is checked against the slip.
    let record = EMPTY_WEEK
    for (const parlay of group.parlays) {
      if (parlay.problems.length > 0 || parlay.legs.some(leg => leg.problems.length > 0)) continue
      const built = buildParlay(record, week, list, parlay, context)
      if (built === null) continue
      record = built
    }
    const clean = group.parlays.every(parlay => parlay.problems.length === 0 && parlay.legs.every(leg => leg.problems.length === 0))
    group.status = clean ? 'ready' : 'held'
    group.record = clean ? record : null
  }

  const ordered = [...weeks.values()].sort((a, b) => (a.week === null ? 1 : b.week === null ? -1 : b.firstKickoff.localeCompare(a.firstKickoff)))
  return { problem: null, weeks: ordered, parlays: parlays.size, legs: [...parlays.values()].reduce((sum, parlay) => sum + parlay.legs.length, 0) }
}

// One row: its game found among this season's fixtures, and checked against
// the fixture's 90-minute score.
function readLeg(line: number, cell: (column: Column) => string, context: ImportContext): ImportLeg {
  const leg: ImportLeg = {
    line, homeText: cell('home'), awayText: cell('away'), pickText: cell('pick'),
    fixture: null, pick: null, odds: parseOdds(cell('odds')), confidence: null, slipScore: null, shown: null, problems: [], note: null,
  }
  const problem = (text: string) => leg.problems.push(text)
  if (leg.odds === null) problem('The odds should look like -110 or +175.')
  const confidence = cell('confidence')
  if (confidence === '') problem('Give this leg a confidence rating from 1 to 5.')
  else if (/^[1-5]$/.test(confidence)) leg.confidence = Number(confidence)
  else problem('The confidence should be a whole number from 1 to 5.')
  const earlyText = cell('early').toLowerCase()
  const early = earlyText === 'yes'
  if (earlyText !== '' && earlyText !== 'yes' && earlyText !== 'no') problem('Early payout should be yes, or blank.')
  const result = slipResult(cell('legResult'))
  if (result === null) problem("The leg's result should be Won, Lost or Void.")
  const home = goals(cell('homeGoals'))
  const away = goals(cell('awayGoals'))
  if (home !== null && away !== null) leg.slipScore = [home, away]
  else if (result !== 'void' || cell('homeGoals') !== '' || cell('awayGoals') !== '') problem('The score should be two whole numbers, like 2 and 1.')

  // The game: the pairing played this way round, in the competition and on
  // the date if the file gives them.
  const homes = teamsCalled(leg.homeText, context.teams)
  const aways = teamsCalled(leg.awayText, context.teams)
  const competition = cell('competition').toUpperCase()
  if (competition !== '' && competition !== 'PL' && competition !== 'UCL') problem('The competition should be PL or UCL, or blank.')
  const date = cell('date')
  if (date !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(date)) problem('The date should look like 2026-08-22, or be blank.')
  const games = [...context.fixtures.values()].filter(fixture => homes.has(fixture.home) && aways.has(fixture.away)
    && (competition === '' || fixture.competition === (competition as Competition)) && (date === '' || localDate(fixture.kickoff) === date))
  if (homes.size === 0) problem(`No team called "${leg.homeText}" plays this season.`)
  else if (aways.size === 0) problem(`No team called "${leg.awayText}" plays this season.`)
  else if (games.length === 0) problem(`No match this season has "${leg.homeText}" at home to "${leg.awayText}".`)
  else if (games.length > 1) problem(`"${leg.homeText}" v "${leg.awayText}" is played more than once this season. Add its date, like 2026-08-22, in the Date column.`)
  else leg.fixture = games[0]
  const fixture = leg.fixture
  if (fixture === null) return leg

  // The pick: the draw, or one of the two teams.
  const picked = leg.pickText.toLowerCase() === 'draw' ? 'D' : teamsCalled(leg.pickText, context.teams)
  leg.pick = picked === 'D' ? 'D' : picked.has(fixture.home) ? 'H' : picked.has(fixture.away) ? 'A' : null
  if (leg.pick === null) {
    problem(`The pick "${leg.pickText}" isn't either team or the draw.`)
    return leg
  }

  // How the app will settle it, against what bet365 said.
  if (result === 'void') {
    leg.shown = 'dropped'
    leg.note = 'bet365 voided this leg, so it comes out and the parlay is repriced.'
    return leg
  }
  const score = finalScore90(fixture)
  if (score === null) {
    problem("This match has no final 90-minute score in the fixtures, so the app can't settle it.")
    return leg
  }
  if (leg.slipScore !== null && (leg.slipScore[0] !== score[0] || leg.slipScore[1] !== score[1])) {
    problem(`The file's score is ${leg.slipScore[0]}–${leg.slipScore[1]}, but the 90-minute score was ${score[0]}–${score[1]}.`)
    return leg
  }
  const says = scoreSays(leg.pick, score)
  if (result === 'won' && says === 'lost') {
    if (early) {
      leg.shown = 'promo'
      leg.note = `bet365 paid this leg early. The score says ${score[0]}–${score[1]}, so it's saved as won by a promo, with the reason "${PROMO_REASON}"`
    } else {
      problem(`The file says this leg won, but the 90-minute score was ${score[0]}–${score[1]}. Check the screenshot, and if bet365 paid it early, put yes under Early payout.`)
    }
  } else if (result === 'lost' && (says === 'won' || early)) {
    problem(early ? 'An early payout always pays, but the file says this leg lost.' : `The file says this leg lost, but the 90-minute score was ${score[0]}–${score[1]}, a win for this pick.`)
  } else if (result === 'won' || result === 'lost') {
    leg.shown = says === 'won' ? 'won' : leg.pick !== 'D' && score[0] === score[1] ? 'drawn' : 'lost'
  }
  return leg
}

// Adds one parlay to the week, settles it, and checks what it comes to
// against the slip. Returns the week with it in, or null when it doesn't
// check out, with the reason in the parlay's problems.
function buildParlay(record: WeekRecord, week: Week, list: readonly Fixture[], parlay: ImportParlay, context: ImportContext): WeekRecord | null {
  const added = addParlay(record, week, list, {
    stakeCents: parlay.stakeCents ?? 0, boostBps: parlay.boostBps ?? 0, bonus: parlay.bonus === true,
    legs: parlay.legs.map(leg => ({ fixtureId: leg.fixture?.id ?? 0, pick: leg.pick ?? 'D', odds: leg.odds ?? 0, confidence: leg.confidence ?? 0 })),
  })
  if (!added.ok) {
    parlay.problems.push(ENTRY_WORDS[added.problem] ?? "The app can't save this parlay as it is.")
    return null
  }
  let next = added.record
  added.parlay.legs.forEach((leg, i) => {
    if (parlay.legs[i].shown === 'dropped') next = voidLeg(next, leg.id, { outcome: 'dropped', reason: VOID_REASON }, context.fixtures, context.now)
    if (parlay.legs[i].shown === 'promo') next = settleByHand(next, leg.id, { outcome: 'won', promo: true, reason: PROMO_REASON }, context.fixtures, context.now)
  })
  next = settleWeek(next, context.fixtures, context.now).record
  const saved = next.parlays.find(each => each.id === added.parlay.id)
  if (saved === undefined) return null
  const outcome = parlayOutcome(saved)
  parlay.state = outcome.state
  parlay.returnCents = outcome.payoutCents ?? 0
  const slip = parlay.slipReturnCents ?? 0
  const expected = parlay.slipResult === 'won' ? 'won' : parlay.slipResult === 'lost' ? 'lost' : 'void'
  if (outcome.state !== expected) {
    parlay.problems.push(`The file says this parlay ${parlay.slipResult === 'void' ? 'was void' : parlay.slipResult}, but its legs say it ${outcome.state === 'won' ? 'cashed' : outcome.state === 'void' ? 'was void' : outcome.state}.`)
    return null
  }
  const gap = slip - parlay.returnCents
  if (Math.abs(gap) === 1) {
    parlay.note = `The slip says ${money(slip)}, 1 cent ${gap > 0 ? 'more' : 'less'}. ${money(parlay.returnCents)} is saved.`
  } else if (gap !== 0) {
    parlay.problems.push(`The slip says ${money(slip)}, but these odds and this stake return ${money(parlay.returnCents)}. Check the odds and the stake.`)
    return null
  }
  return next
}
