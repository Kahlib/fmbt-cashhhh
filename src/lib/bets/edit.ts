// Changing parlays that are already saved, through the bet slip (step 10
// plan, The flows): an open parlay changes as normal, and a locked one only
// in Admin mode, where saving asks why. Like settle.ts, everything here
// works on a copy and returns a new record.
import type { FixtureScore } from './settle.ts'
import type { WaitingStatus } from './view.ts'
import { settleByHand, unsettleLeg } from './settle.ts'
import { addParlay, type EntryProblem, type NewParlay, type Week, type WeekFixture, type WeekRecord } from './week-record.ts'

// Puts `entry` in place of the parlay `parlayId`, in the same place and with
// the same ID, after the same checks as a new parlay. A leg on the same game
// keeps its ID, so the audit log shows what changed about that leg rather
// than one leg gone and another added. It keeps how it settled too, unless
// its pick changed, when it settles again from the score.
export function replaceParlay(
  record: WeekRecord, week: Week, fixtures: readonly WeekFixture[], parlayId: string, entry: NewParlay,
): { ok: true; record: WeekRecord } | { ok: false; problem: EntryProblem | 'gone' } {
  const index = record.parlays.findIndex(parlay => parlay.id === parlayId)
  if (index === -1) return { ok: false, problem: 'gone' }
  const old = record.parlays[index]
  const without: WeekRecord = { ...record, parlays: record.parlays.filter(parlay => parlay.id !== parlayId) }
  const added = addParlay(without, week, fixtures, entry)
  if (!added.ok) return added
  const legs = added.parlay.legs.map(leg => {
    const was = old.legs.find(each => each.fixtureId === leg.fixtureId)
    if (was === undefined) return leg
    return { ...leg, id: was.id, settlement: was.pick === leg.pick ? was.settlement : null }
  })
  const parlays = [...without.parlays]
  parlays.splice(index, 0, { ...added.parlay, id: old.id, legs })
  return { ok: true, record: { ...record, parlays } }
}

// Takes a parlay out of its week.
export function removeParlay(record: WeekRecord, parlayId: string): WeekRecord {
  if (!record.parlays.some(parlay => parlay.id === parlayId)) throw new RangeError("That parlay isn't in this week.")
  return { ...record, parlays: record.parlays.filter(parlay => parlay.id !== parlayId) }
}

// How a leg on a game that has started should settle, as the slip asks:
// from the 90-minute score, paid early by a promo such as 2-Up, or by hand.
export type HowItSettles =
  | { by: 'score' }
  | { by: 'promo'; reason: string }
  | { by: 'hand'; outcome: 'won' | 'lost'; reason: string }

// Sets how one leg settles. Anything already settled that way stays exactly
// as it is, so saving the slip again changes nothing about it.
export function setHowItSettles(
  record: WeekRecord, legId: string, how: HowItSettles, fixtures: ReadonlyMap<number, FixtureScore>, now: string,
): WeekRecord {
  const leg = record.parlays.flatMap(parlay => parlay.legs).find(each => each.id === legId)
  if (leg === undefined) throw new RangeError("That leg isn't in this week.")
  const settlement = leg.settlement
  if (how.by === 'score') {
    // A leg settled by hand, or voided, goes back to settling from the score.
    return settlement === null || settlement.how === 'auto' ? record : unsettleLeg(record, legId)
  }
  const outcome = how.by === 'promo' ? 'won' : how.outcome
  const promo = how.by === 'promo'
  const same = settlement !== null && settlement.how === 'override' && settlement.outcome === outcome
    && settlement.promo === promo && settlement.reason === how.reason.trim()
  return same ? record : settleByHand(record, legId, { outcome, promo, reason: how.reason }, fixtures, now)
}

// How a match that didn't finish normally reads: "was postponed".
export const MATCH_WORDS = new Map<WaitingStatus, string>([
  ['postponed', 'was postponed'], ['cancelled', 'was cancelled'], ['suspended', 'was suspended'], ['awarded', 'was awarded'],
  ['missing', "isn't in the feed"],
])

// The reason the app saves for you when you drop a leg or count it as lost.
export function waitingReason(status: WaitingStatus, kind: 'drop' | 'lost'): string {
  const what = status === 'missing' ? 'The game is missing from the feed' : `The match ${MATCH_WORDS.get(status) ?? 'did not finish'}`
  return `${what}. bet365 ${kind === 'drop' ? 'voided the leg' : 'settled the leg as lost'}.`
}
