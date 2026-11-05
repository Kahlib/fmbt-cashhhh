// Settling legs, and what each parlay pays (project plan, Betting rules).
//
// Every book KMan uses settles on 90 minutes, Champions League knockouts
// included, so a leg settles on the score after 90 minutes and nothing else.
// That score is final as soon as a match finishes, or the moment it goes to
// extra time or penalties, so a leg can settle while extra time is still
// being played.
//
// Results and settlements are kept apart. The fixtures table holds the
// results, and each leg's settlement in your encrypted record says what it
// settled on. So when a result changes later, the app can see it and ask
// you, rather than quietly re-settling (fmbt-security, section 6).
//
// Everything here works on a copy: a function returns a new record and never
// changes the one it was given.
import { isIsoTime } from '../records/settings.ts'
import { payoutCents } from './odds.ts'
import { byScoreFor, isReason, type Leg, type Parlay, type Settlement, type WeekRecord } from './week-record.ts'

// A fixture's state, as the pages read it from the fixtures table.
export type FixtureScore = { id: number; status: string; home_90: number | null; away_90: number | null }

// Statuses whose 90-minute score is final.
const FINAL_90 = new Set(['finished', 'extra_time', 'penalties'])
// Statuses where a leg never settles itself, and waits for you to choose:
// drop it, count it as lost, or settle it by hand (decided 5 November 2026).
type WaitingStatus = 'postponed' | 'cancelled' | 'suspended' | 'awarded'
const NEEDS_YOU = new Set<string>(['postponed', 'cancelled', 'suspended', 'awarded'])

// The 90-minute score if it's final, or null.
export function finalScore90(fixture: FixtureScore | undefined): [number, number] | null {
  if (fixture === undefined || !FINAL_90.has(fixture.status)) return null
  const { home_90: home, away_90: away } = fixture
  return Number.isInteger(home) && Number.isInteger(away) ? [home as number, away as number] : null
}

// A leg that's waiting for you, and why. "missing" means its game isn't in
// the fixtures it was checked against.
export type Waiting = { parlayId: string; legId: string; fixtureId: number; status: WaitingStatus | 'missing' }

// A leg that settled itself on a score that has since changed. The app shows
// it and asks before re-settling.
export type Correction = { parlayId: string; legId: string; fixtureId: number; from: [number, number]; to: [number, number] }

export type SettleResult = {
  record: WeekRecord          // the same record when nothing changed, so there's nothing to save
  settled: number             // legs that settled themselves just now
  noted: number               // legs settled by hand that just got their 90-minute score noted
  corrections: Correction[]
  waiting: Waiting[]
}

function settlementFrom(leg: Leg, score: [number, number], now: string): Settlement {
  const byScore = byScoreFor(leg.pick, score)
  return { outcome: byScore, byScore, score90: score, how: 'auto', reason: null, promo: false, settledAt: now }
}

function checkTime(now: string): void {
  if (!isIsoTime(now)) throw new RangeError('Times must look like 2026-11-07T17:00:00.000Z.')
}

const sameScore = (a: readonly [number, number], b: readonly [number, number]) => a[0] === b[0] && a[1] === b[1]

// Settles every leg it can, from the fixtures by football-data ID. For each leg:
//   - unsettled, with a final 90-minute score: it settles itself
//   - unsettled, with its match postponed, cancelled, suspended or awarded,
//     or missing: it's listed as waiting for you
//   - settled itself, on a score that's since changed: it's listed as a
//     correction, and left as it was
//   - settled by hand or voided, with no score noted yet: the score is noted,
//     and how it settled doesn't change
// Running it twice in a row changes nothing the second time.
export function settleWeek(record: WeekRecord, fixtures: ReadonlyMap<number, FixtureScore>, now: string): SettleResult {
  checkTime(now)
  let settled = 0
  let noted = 0
  const corrections: Correction[] = []
  const waiting: Waiting[] = []

  const parlays = record.parlays.map(parlay => ({
    ...parlay,
    legs: parlay.legs.map(leg => {
      const fixture = fixtures.get(leg.fixtureId)
      const score = finalScore90(fixture)
      const current = leg.settlement
      const where = { parlayId: parlay.id, legId: leg.id, fixtureId: leg.fixtureId }

      if (current === null) {
        if (score !== null) {
          settled++
          return { ...leg, settlement: settlementFrom(leg, score, now) }
        }
        if (fixture === undefined) waiting.push({ ...where, status: 'missing' })
        else if (NEEDS_YOU.has(fixture.status)) waiting.push({ ...where, status: fixture.status as WaitingStatus })
        return leg
      }
      if (score === null) return leg

      if (current.how === 'auto') {
        const was = current.score90
        if (was !== null && !sameScore(was, score)) corrections.push({ ...where, from: was, to: score })
        return leg
      }
      if (current.score90 === null) {
        noted++
        return { ...leg, settlement: { ...current, score90: score, byScore: byScoreFor(leg.pick, score) } }
      }
      return leg
    }),
  }))

  const changed = settled + noted > 0
  return { record: changed ? { ...record, parlays } : record, settled, noted, corrections, waiting }
}

// Changes one leg, found by its ID, with `change`. Throws if there's no such leg.
function changeLeg(record: WeekRecord, legId: string, change: (leg: Leg) => Leg): WeekRecord {
  let found = false
  const parlays = record.parlays.map(parlay => ({
    ...parlay,
    legs: parlay.legs.map(leg => {
      if (leg.id !== legId) return leg
      found = true
      return change(leg)
    }),
  }))
  if (!found) throw new RangeError('That leg isn\'t in this week.')
  return { ...record, parlays }
}

// Re-settles a leg on its corrected score, once you've said yes. Throws if
// the leg didn't settle itself, or its score hasn't changed after all.
export function acceptCorrection(record: WeekRecord, legId: string, fixtures: ReadonlyMap<number, FixtureScore>, now: string): WeekRecord {
  checkTime(now)
  return changeLeg(record, legId, leg => {
    const was = leg.settlement?.how === 'auto' ? leg.settlement.score90 : null
    const score = finalScore90(fixtures.get(leg.fixtureId))
    if (was === null || score === null || sameScore(was, score)) throw new RangeError('That leg has no correction to accept.')
    return { ...leg, settlement: settlementFrom(leg, score, now) }
  })
}

// Settles a leg by hand, with a reason: for a promo such as a 2-Up early
// payout, or anything else a book did differently. Its 90-minute score is
// noted if it's final yet.
export function settleByHand(
  record: WeekRecord, legId: string, choice: { outcome: 'won' | 'lost'; promo: boolean; reason: string },
  fixtures: ReadonlyMap<number, FixtureScore>, now: string,
): WeekRecord {
  checkTime(now)
  if (!isReason(choice.reason)) throw new RangeError('Settling by hand needs a reason of 1 to 200 characters.')
  if (choice.promo && choice.outcome !== 'won') throw new RangeError('Only a leg that pays can be a promo.')
  return changeLeg(record, legId, leg => {
    const score = finalScore90(fixtures.get(leg.fixtureId))
    return {
      ...leg,
      settlement: {
        outcome: choice.outcome, byScore: score === null ? null : byScoreFor(leg.pick, score), score90: score,
        how: 'override', reason: choice.reason.trim(), promo: choice.promo, settledAt: now,
      },
    }
  })
}

// Voids a leg whose match didn't finish normally: dropped takes it out and
// reprices the parlay, and lost counts it as lost.
export function voidLeg(
  record: WeekRecord, legId: string, choice: { outcome: 'dropped' | 'lost'; reason: string },
  fixtures: ReadonlyMap<number, FixtureScore>, now: string,
): WeekRecord {
  checkTime(now)
  if (!isReason(choice.reason)) throw new RangeError('Voiding a leg needs a reason of 1 to 200 characters.')
  return changeLeg(record, legId, leg => {
    const score = finalScore90(fixtures.get(leg.fixtureId))
    return {
      ...leg,
      settlement: {
        outcome: choice.outcome, byScore: score === null ? null : byScoreFor(leg.pick, score), score90: score,
        how: 'void', reason: choice.reason.trim(), promo: false, settledAt: now,
      },
    }
  })
}

// Takes a leg's settlement away, in Admin mode, so it settles again from the fixtures.
export function unsettleLeg(record: WeekRecord, legId: string): WeekRecord {
  return changeLeg(record, legId, leg => ({ ...leg, settlement: null }))
}

export type ParlayState = 'pending' | 'won' | 'lost' | 'void'
export type ParlayOutcome = { state: ParlayState; payoutCents: number | null; profitCents: number | null }

// What a parlay pays so far:
//   - lost as soon as any leg loses, even with others still to play
//   - pending while any leg is unsettled
//   - void when every leg was dropped, which gives the stake back
//   - otherwise won: the stake times every won leg's decimal odds, with
//     dropped legs left out, rounded once to the nearest cent
export function parlayOutcome(parlay: Parlay): ParlayOutcome {
  const outcomes = parlay.legs.map(leg => leg.settlement?.outcome ?? null)
  if (outcomes.includes('lost')) return { state: 'lost', payoutCents: 0, profitCents: -parlay.stakeCents }
  if (outcomes.includes(null)) return { state: 'pending', payoutCents: null, profitCents: null }
  const wonOdds = parlay.legs.filter(leg => leg.settlement?.outcome === 'won').map(leg => leg.odds)
  if (wonOdds.length === 0) return { state: 'void', payoutCents: parlay.stakeCents, profitCents: 0 }
  const payout = payoutCents(parlay.stakeCents, wonOdds)
  return { state: 'won', payoutCents: payout, profitCents: payout - parlay.stakeCents }
}

// A week locks once every leg in it is settled. After that, changing it
// needs Admin mode and an audit entry (project plan, Locking). An empty week
// and a tombstone have no legs, so they never lock.
export function isLocked(record: WeekRecord): boolean {
  const legs = record.parlays.flatMap(parlay => parlay.legs)
  return legs.length > 0 && legs.every(leg => leg.settlement !== null)
}
