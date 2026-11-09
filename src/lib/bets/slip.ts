// The bet slip: what Build parlay holds while you put a parlay together or
// change one (step 10 plan, The flows: Building a parlay). It holds games
// and what you typed, never anything else, and lives in memory only.
import type { Fixture } from '../fixtures.ts'
import { oddsText, percentText } from '../format.ts'
import { replaceParlay, setHowItSettles, type HowItSettles } from './edit.ts'
import { addParlay, type Competition, type EntryProblem, type NewParlay, type Pick as Choice, type Week, type WeekRecord } from './week-record.ts'

// One leg on the slip, as typed.
export type SlipLeg = {
  fixtureId: number
  pick: Choice
  odds: string
  confidence: number          // 0 until you choose
  how: 'score' | 'promo' | 'hand'
  outcome: 'won' | 'lost'     // for 'hand'
  reason: string              // for 'promo' and 'hand'
  // A leg you dropped or counted as lost in My parlays, because its match
  // didn't finish normally. The slip keeps it that way unless you change it.
  voided: 'dropped' | 'lost' | null
}

// A game you've just chosen, before you type anything.
export function newSlipLeg(fixtureId: number, pick: Choice): SlipLeg {
  return { fixtureId, pick, odds: '', confidence: 0, how: 'score', outcome: 'won', reason: '', voided: null }
}

// The slip, kept while you move between pages, so leaving and coming back
// doesn't lose it. It holds games and odds you typed, never anything else.
export type Slip = {
  competition: Competition
  period: string | null       // the week its games are from, once it has one
  legs: SlipLeg[]
  stake: string
  boost: string
  editing: string | null      // the saved parlay being changed, by ID
  started: boolean            // showing the games that have started
}

export const EMPTY_SLIP: Slip = { competition: 'PL', period: null, legs: [], stake: '', boost: '', editing: null, started: false }

// The slip for changing a saved parlay.
export function slipFor(record: WeekRecord, week: Week, parlayId: string): Slip | null {
  const parlay = record.parlays.find(each => each.id === parlayId)
  if (parlay === undefined) return null
  return {
    competition: week.competition,
    period: week.period,
    editing: parlay.id,
    started: true,
    stake: (parlay.stakeCents / 100).toFixed(2),
    boost: parlay.boostBps === 0 ? '' : percentText(parlay.boostBps).replace('%', ''),
    legs: parlay.legs.map(leg => {
      const settlement = leg.settlement
      const how = settlement?.how === 'override' ? (settlement.promo ? 'promo' : 'hand') : 'score'
      return {
        fixtureId: leg.fixtureId,
        pick: leg.pick,
        odds: oddsText(leg.odds),
        confidence: leg.confidence,
        how,
        outcome: settlement?.outcome === 'lost' ? 'lost' : 'won',
        reason: settlement?.how === 'override' ? settlement.reason ?? '' : '',
        voided: settlement?.how !== 'void' ? null : settlement.outcome === 'dropped' ? 'dropped' : 'lost',
      }
    }),
  }
}

export const STARTED = new Set<string>(['live', 'half_time', 'extra_time', 'penalties', 'finished'])
export const WAITING = new Set<string>(['postponed', 'cancelled', 'suspended', 'awarded'])

// True once a game has kicked off, by the clock or by the feed.
export function hasStarted(fixture: Fixture, now: number): boolean {
  return STARTED.has(fixture.status) || (Date.parse(fixture.kickoff) <= now && !WAITING.has(fixture.status))
}


// How a leg on the slip settles, for setHowItSettles.
function howOf(leg: SlipLeg): HowItSettles {
  if (leg.how === 'promo') return { by: 'promo', reason: leg.reason }
  if (leg.how === 'hand') return { by: 'hand', outcome: leg.outcome, reason: leg.reason }
  return { by: 'score' }
}

// The week as it will be saved: the slip's parlay added to `record`, or put
// in place of the one being changed, with each leg settling the way the
// slip says. A leg you dropped or counted as lost stays that way. Any other
// leg settles as the slip says, so taking a settlement off one sends it back
// to settling from the score, or to waiting for you if its match didn't
// finish normally. `entry` is the slip read into numbers.
export function recordFromSlip(
  record: WeekRecord, week: Week, slip: Slip, entry: NewParlay, fixtures: ReadonlyMap<number, Fixture>, now: number,
): { ok: true; record: WeekRecord } | { ok: false; problem: EntryProblem | 'gone' } {
  const list = [...fixtures.values()]
  let next: WeekRecord
  let parlayId: string
  if (slip.editing === null) {
    const added = addParlay(record, week, list, entry)
    if (!added.ok) return added
    next = added.record
    parlayId = added.parlay.id
  } else {
    const replaced = replaceParlay(record, week, list, slip.editing, entry)
    if (!replaced.ok) return replaced
    next = replaced.record
    parlayId = slip.editing
  }
  const nowIso = new Date(now).toISOString()
  const legs = next.parlays.find(parlay => parlay.id === parlayId)?.legs ?? []
  for (const leg of slip.legs) {
    const saved = legs.find(each => each.fixtureId === leg.fixtureId)
    if (saved === undefined || leg.voided !== null) continue
    next = setHowItSettles(next, saved.id, howOf(leg), fixtures, nowIso)
  }
  return { ok: true, record: next }
}
