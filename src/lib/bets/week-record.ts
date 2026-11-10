// The week record: everything you bet in one Premier League matchweek or one
// Champions League stage, encrypted as one row of week_versions. Its shape
// is in claude/fmbt-database-and-threat-model.md, section 3.
//
// A record arrives from two places this code can't trust: the database,
// after decrypting, and the pages, as you enter bets. So there are two kinds
// of check (fmbt-security, sections 2 and 11):
//   - isWeekRecord checks a record's shape and every rule that needs nothing
//     else, such as the limits and how a settlement fits together. Every
//     decrypted record goes through it before anything uses it.
//   - checkWeek and addParlay also check each leg's game against that week's
//     fixtures. Everything you enter goes through them before it's saved.
import { isUuid } from '../account/rows.ts'
import { isIsoTime } from '../records/settings.ts'
import { exactPayoutCents, isAmericanOdds, isBoostBps, isStakeCents, MAX_PAYOUT_CENTS } from './odds.ts'

export type Competition = 'PL' | 'UCL'
export type Pick = 'H' | 'D' | 'A' // home win, draw, away win
export type Outcome = 'won' | 'lost' | 'dropped'

// How a leg settled. Null until it does.
export type Settlement = {
  outcome: Outcome                // what pays. Dropped takes the leg out and reprices the parlay
  byScore: 'won' | 'lost' | null  // what the 90-minute score said, once there is one
  score90: [number, number] | null // the 90-minute score it used, to spot corrections
  how: 'auto' | 'override' | 'void' // settled itself, by hand, or voided by hand
  reason: string | null           // required for override and void
  promo: boolean                  // paid by a promo such as 2-Up, though the score may say lost
  settledAt: string
}

export type Leg = {
  id: string
  fixtureId: number               // football-data's match ID
  home: string                    // the teams' codes and the kick-off are copied in,
  away: string                    //   so the record makes sense on its own
  kickoff: string
  pick: Pick
  odds: number                    // American: +100 or more, or -100 or less
  confidence: 1 | 2 | 3 | 4 | 5
  settlement: Settlement | null
}

export type Parlay = {
  id: string
  stakeCents: number
  boostBps: number                // a boost on the profit, in hundredths of a percent: 250 is 2.5%, 0 is none
  // Made with bet365 bonus money (step 11 plan, 11.2). Only ever true: a
  // parlay staked with your own money leaves it out, so every record saved
  // before 11.2 still checks out as it is.
  bonus?: true
  legs: Leg[]                     // one leg makes a single
}

export type WeekRecord = {
  schema: 1
  deleted: boolean                // true marks a deleted week: a tombstone with no parlays
  parlays: Parlay[]
}

// Which week a record belongs to: the plain columns beside its ciphertext.
export type Week = { season: number; competition: Competition; period: string }

export const EMPTY_WEEK: WeekRecord = { schema: 1, deleted: false, parlays: [] }
export const TOMBSTONE: WeekRecord = { schema: 1, deleted: true, parlays: [] }

// Limits, which keep a record far below the database's size limit
// (step 9 plan, smaller choices).
export const MAX_PARLAYS = 100
export const MAX_LEGS = 500
export const MAX_LEGS_PER_PARLAY = 40
export const MAX_REASON = 200
const MAX_GOALS = 30 // the database's goal_count

// ---------------------------------------------------------------------------
// Checking a record's shape
// ---------------------------------------------------------------------------

type Fields = Record<string, unknown>

// True if `value` is a plain object with exactly these fields, no more and
// no fewer. Object.hasOwn, so an inherited one such as "toString" never counts.
export function hasExactly(value: unknown, names: readonly string[]): value is Fields {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const own = Object.keys(value)
  return own.length === names.length && names.every(name => Object.hasOwn(value, name))
}

export const isWhole = (value: unknown, low: number, high: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= low && value <= high
const isTeamCode = (value: unknown): value is string => typeof value === 'string' && /^[A-Z]{3}$/.test(value)
const isPick = (value: unknown): value is Pick => value === 'H' || value === 'D' || value === 'A'
export const isScore = (value: unknown): value is [number, number] =>
  Array.isArray(value) && value.length === 2 && isWhole(value[0], 0, MAX_GOALS) && isWhole(value[1], 0, MAX_GOALS)

// Control characters and broken surrogates have no place in a reason.
const UNSAFE_TEXT = /[\p{Cc}\p{Cs}]/u
// A reason you type for settling by hand: 1 to 200 characters once trimmed.
export function isReason(value: unknown): value is string {
  if (typeof value !== 'string' || UNSAFE_TEXT.test(value)) return false
  const length = [...value.trim()].length
  return length >= 1 && length <= MAX_REASON
}

// The result a score shows: H for a home win, D for a draw, A for an away win.
export function resultOf(score: readonly [number, number]): Pick {
  return score[0] > score[1] ? 'H' : score[0] < score[1] ? 'A' : 'D'
}

// What a score says about a pick.
export function byScoreFor(pick: Pick, score: readonly [number, number]): 'won' | 'lost' {
  return resultOf(score) === pick ? 'won' : 'lost'
}

function isSettlement(value: unknown, pick: Pick): value is Settlement {
  if (!hasExactly(value, ['outcome', 'byScore', 'score90', 'how', 'reason', 'promo', 'settledAt'])) return false
  const { outcome, byScore, score90, how, reason, promo, settledAt } = value
  if (outcome !== 'won' && outcome !== 'lost' && outcome !== 'dropped') return false
  if (how !== 'auto' && how !== 'override' && how !== 'void') return false
  if (reason !== null && !isReason(reason)) return false
  if (typeof promo !== 'boolean' || !isIsoTime(settledAt)) return false

  // What the score said always goes with the score, and has to be right.
  if (score90 === null) {
    if (byScore !== null) return false
  } else if (!isScore(score90) || byScore !== byScoreFor(pick, score90)) {
    return false
  }

  // How each kind of settlement fits together. A leg that settled itself has
  // the outcome its score said, so it always has a score.
  if (how === 'auto') return outcome === byScore && reason === null && !promo
  if (how === 'override') return outcome !== 'dropped' && reason !== null && (!promo || outcome === 'won')
  return (outcome === 'dropped' || outcome === 'lost') && reason !== null && !promo // void
}

function isLeg(value: unknown): value is Leg {
  if (!hasExactly(value, ['id', 'fixtureId', 'home', 'away', 'kickoff', 'pick', 'odds', 'confidence', 'settlement'])) return false
  const leg = value
  return isUuid(leg.id) && isWhole(leg.fixtureId, 1, Number.MAX_SAFE_INTEGER) && isTeamCode(leg.home) && isTeamCode(leg.away)
    && isIsoTime(leg.kickoff) && isPick(leg.pick) && isAmericanOdds(leg.odds) && isWhole(leg.confidence, 1, 5)
    && (leg.settlement === null || isSettlement(leg.settlement, leg.pick))
}

// True if the parlay's payout, if every leg won, stays within the limit,
// boost included.
function payoutFits(stakeCents: number, legs: readonly Leg[], boostBps: number): boolean {
  return exactPayoutCents(stakeCents, legs.map(leg => leg.odds), boostBps) <= BigInt(MAX_PAYOUT_CENTS)
}

const PARLAY_FIELDS = ['id', 'stakeCents', 'boostBps', 'legs']

function isParlay(value: unknown): value is Parlay {
  // A bonus bet has one more field, bonus, which has to be exactly true.
  const bonus = typeof value === 'object' && value !== null && Object.hasOwn(value, 'bonus')
  if (!hasExactly(value, bonus ? [...PARLAY_FIELDS, 'bonus'] : PARLAY_FIELDS)) return false
  if (bonus && value.bonus !== true) return false
  const { id, stakeCents, boostBps, legs } = value
  if (!isUuid(id) || !isStakeCents(stakeCents) || !isBoostBps(boostBps)) return false
  if (!Array.isArray(legs) || legs.length < 1 || legs.length > MAX_LEGS_PER_PARLAY || !legs.every(isLeg)) return false
  // Each game once per parlay: one parlay can't carry two picks on the same match.
  if (new Set(legs.map(leg => leg.fixtureId)).size !== legs.length) return false
  return payoutFits(stakeCents, legs, boostBps)
}

// Checks that a decrypted value really is a week record before anything uses
// it (fmbt-security, section 2: validate after decrypting).
export function isWeekRecord(value: unknown): value is WeekRecord {
  if (!hasExactly(value, ['schema', 'deleted', 'parlays'])) return false
  const { schema, deleted, parlays } = value
  if (schema !== 1 || typeof deleted !== 'boolean') return false
  if (!Array.isArray(parlays) || parlays.length > MAX_PARLAYS || !parlays.every(isParlay)) return false
  if (deleted && parlays.length > 0) return false // a tombstone holds nothing
  const legs = parlays.flatMap(parlay => parlay.legs)
  if (legs.length > MAX_LEGS) return false
  // Every ID is unique within the week, so a change can never land on the wrong leg.
  const ids = [...parlays.map(parlay => parlay.id), ...legs.map(leg => leg.id)]
  return new Set(ids).size === ids.length
}

// ---------------------------------------------------------------------------
// Checking against the week's fixtures, for everything you enter
// ---------------------------------------------------------------------------

// A fixture as the pages read it: football-data's ID, its week, and the
// teams' codes. The kick-off is in the form toISOString() writes, such as
// 2026-11-07T17:30:00.000Z. The database sends times in another form
// (2026-11-07T17:30:00+00:00), so the code that reads fixtures converts them.
export type WeekFixture = { id: number; season: number; competition: Competition; period: string; home: string; away: string; kickoff: string }

// What can be wrong with a parlay you enter. The pages turn each into words.
export type EntryProblem =
  | 'deleted'          // the week has been deleted
  | 'week full'        // the week already holds 100 parlays or 500 legs
  | 'stake'            // not from $0.01 to $10,000
  | 'boost'            // not from 0% to 100%, in hundredths of a percent
  | 'no legs'
  | 'too many legs'    // over 40
  | 'same game twice'  // one parlay can't hold two picks on the same match
  | 'not this week'    // the game isn't one of this week's fixtures
  | 'pick'
  | 'odds'             // not +100 or more, or -100 or less
  | 'confidence'       // not 1 to 5
  | 'payout too big'   // over $100 million if every leg won
  | 'bad fixture'      // a game's teams or kick-off don't look right, which fixtures read the normal way never do

export type NewLeg = { fixtureId: number; pick: Pick; odds: number; confidence: number }
export type NewParlay = { stakeCents: number; boostBps: number; bonus?: boolean; legs: NewLeg[] }

// Adds a parlay to a week, after checking every part of it. Adding is
// allowed on any week that isn't deleted, locked or not, since adding a
// record isn't editing one (project plan, Entering bets).
export function addParlay(
  record: WeekRecord, week: Week, fixtures: readonly WeekFixture[], entry: NewParlay,
): { ok: true; record: WeekRecord; parlay: Parlay } | { ok: false; problem: EntryProblem } {
  const fail = (problem: EntryProblem) => ({ ok: false as const, problem })
  if (record.deleted) return fail('deleted')
  const legCount = record.parlays.reduce((sum, parlay) => sum + parlay.legs.length, 0)
  if (record.parlays.length >= MAX_PARLAYS || legCount + entry.legs.length > MAX_LEGS) return fail('week full')
  if (!isStakeCents(entry.stakeCents)) return fail('stake')
  if (!isBoostBps(entry.boostBps)) return fail('boost')
  if (entry.legs.length === 0) return fail('no legs')
  if (entry.legs.length > MAX_LEGS_PER_PARLAY) return fail('too many legs')
  if (new Set(entry.legs.map(leg => leg.fixtureId)).size !== entry.legs.length) return fail('same game twice')

  const ofWeek = weekFixtures(week, fixtures)
  const legs: Leg[] = []
  for (const entered of entry.legs) {
    const fixture = ofWeek.get(entered.fixtureId)
    if (fixture === undefined) return fail('not this week')
    if (!isPick(entered.pick)) return fail('pick')
    if (!isAmericanOdds(entered.odds)) return fail('odds')
    if (!isWhole(entered.confidence, 1, 5)) return fail('confidence')
    legs.push({
      id: crypto.randomUUID(),
      fixtureId: fixture.id,
      home: fixture.home,
      away: fixture.away,
      kickoff: fixture.kickoff,
      pick: entered.pick,
      odds: entered.odds,
      confidence: entered.confidence as Leg['confidence'],
      settlement: null,
    })
  }
  if (!payoutFits(entry.stakeCents, legs, entry.boostBps)) return fail('payout too big')

  // Only a bonus bet carries the bonus field, so a record has one way to say each.
  const parlay: Parlay = { id: crypto.randomUUID(), stakeCents: entry.stakeCents, boostBps: entry.boostBps, ...(entry.bonus === true ? { bonus: true as const } : {}), legs }
  const next: WeekRecord = { ...record, parlays: [...record.parlays, parlay] }
  // A last check of the whole thing, so nothing that fails here can be saved.
  // Everything above passed, so only a fixture with odd data, such as a team
  // code that isn't three letters, can fail it.
  return isWeekRecord(next) ? { ok: true, record: next, parlay } : fail('bad fixture')
}

// Each leg keeps its teams' codes from when it was saved, but a code can
// change, as when two teams shared one (fixtures.ts, withUniqueCodes). So
// the pages show every leg with its game's codes as they are now. Only the
// copy in memory changes, until the week is next saved. A leg whose game
// isn't in `fixtures` keeps the codes it has, and with nothing to change,
// the same record comes back.
export function withGameCodes(record: WeekRecord, fixtures: ReadonlyMap<number, { home: string; away: string }>): WeekRecord {
  const current = (leg: Leg): Leg => {
    const game = fixtures.get(leg.fixtureId)
    return game === undefined || (game.home === leg.home && game.away === leg.away) ? leg : { ...leg, home: game.home, away: game.away }
  }
  const parlays = record.parlays.map(parlay => {
    const legs = parlay.legs.map(current)
    return legs.every((leg, i) => leg === parlay.legs[i]) ? parlay : { ...parlay, legs }
  })
  return parlays.every((parlay, i) => parlay === record.parlays[i]) ? record : { ...record, parlays }
}

// Checks a whole changed record, as an Admin-mode edit makes: its shape, and
// every leg's game among this week's fixtures. Null means it's fine.
export function checkWeek(record: WeekRecord, week: Week, fixtures: readonly WeekFixture[]): 'shape' | 'not this week' | null {
  if (!isWeekRecord(record)) return 'shape'
  const ofWeek = weekFixtures(week, fixtures)
  const fits = record.parlays.every(parlay => parlay.legs.every(leg => ofWeek.has(leg.fixtureId)))
  return fits ? null : 'not this week'
}

// The fixtures that belong to this week, by ID. A Map, so a game ID can
// never find anything that isn't one of them.
function weekFixtures(week: Week, fixtures: readonly WeekFixture[]): Map<number, WeekFixture> {
  return new Map(fixtures
    .filter(fixture => fixture.season === week.season && fixture.competition === week.competition && fixture.period === week.period)
    .map(fixture => [fixture.id, fixture]))
}
