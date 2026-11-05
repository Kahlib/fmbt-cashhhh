// Made-up samples for the bets tests: IDs, legs, parlays and weeks. Nothing
// here comes from football-data.
import type { Leg, Parlay, WeekRecord } from '../src/lib/bets/week-record.ts'

// IDs that are easy to tell apart: uuid(1) is 00000000-0000-4000-8000-000000000001.
export const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`

export const KICKOFF = '2026-11-07T17:30:00.000Z'

// A leg on game 900000 + n, with the ID uuid(1000 + n), picking a home win at +150.
export function leg(n: number, change: Partial<Leg> = {}): Leg {
  return {
    id: uuid(1000 + n), fixtureId: 900_000 + n, home: 'MCI', away: 'LIV', kickoff: KICKOFF,
    pick: 'H', odds: 150, confidence: 3, settlement: null, ...change,
  }
}

// A $25 parlay with the ID uuid(n).
export function parlay(n: number, legs: Leg[], change: Partial<Parlay> = {}): Parlay {
  return { id: uuid(n), stakeCents: 2500, legs, ...change }
}

export const weekOf = (...parlays: Parlay[]): WeekRecord => ({ schema: 1, deleted: false, parlays })

export const legsOf = (record: WeekRecord): Leg[] => record.parlays.flatMap(parlay => parlay.legs)

// `count` legs on games `from` onwards, at -100000, which pays so little that
// even 40 of them stay far below the payout limit.
export const cheapLegs = (from: number, count: number): Leg[] =>
  Array.from({ length: count }, (_, i) => leg(from + i, { odds: -100_000 }))

// Freezes a value and everything inside it, so any attempt to change it
// throws. A test that passes a frozen value proves the code never changes it.
export function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const inner of Object.values(value)) deepFreeze(inner)
    Object.freeze(value)
  }
  return value
}
