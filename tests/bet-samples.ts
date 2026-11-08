// Made-up samples for the bets tests: IDs, legs, parlays, weeks, teams and
// fixtures, and a quick test account. Nothing here comes from football-data.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { FixtureRow, TeamRow } from '../src/lib/account/api.ts'
import type { Leg, Parlay, WeekRecord } from '../src/lib/bets/week-record.ts'
import type { FakeServer, FakeTab } from './fake-api.ts'

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

// A $25 parlay with the ID uuid(n), and no boost.
export function parlay(n: number, legs: Leg[], change: Partial<Parlay> = {}): Parlay {
  return { id: uuid(n), stakeCents: 2500, boostBps: 0, legs, ...change }
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

// ---------------------------------------------------------------------------
// The football tables and an account, on the fake server
// ---------------------------------------------------------------------------

export const TEAM_ROWS: TeamRow[] = [
  { id: 9001, name: 'Manchester City FC', short_name: 'Man City', code: 'MCI' },
  { id: 9002, name: 'Liverpool FC', short_name: 'Liverpool', code: 'LIV' },
  { id: 9003, name: 'Arsenal FC', short_name: 'Arsenal', code: 'ARS' },
  { id: 9004, name: 'Chelsea FC', short_name: 'Chelsea', code: 'CHE' },
  { id: 9005, name: 'Tottenham Hotspur FC', short_name: 'Spurs', code: 'TOT' },
  { id: 9006, name: 'Newcastle United FC', short_name: 'Newcastle', code: 'NEW' },
]

// Game 900000 + n, Man City against Liverpool in matchweek 11 of 2026, as
// the database sends it.
export function fixtureRow(n: number, change: Partial<FixtureRow> = {}): FixtureRow {
  return {
    id: 900_000 + n, competition: 'PL', season: 2026, period: 'MW11', tie_leg: null,
    kickoff: '2026-11-07T17:30:00+00:00', home_team_id: 9001, away_team_id: 9002, status: 'scheduled', minute: null,
    home_90: null, away_90: null, home_ht: null, away_ht: null, home_et: null, away_et: null, home_pens: null, away_pens: null,
    ...change,
  }
}

// The same game, finished with this score after 90 minutes.
export const finished = (n: number, home: number, away: number, change: Partial<FixtureRow> = {}): FixtureRow =>
  fixtureRow(n, { status: 'finished', home_90: home, away_90: away, home_ht: 0, away_ht: 0, ...change })

export type QuickAccount = { id: string; email: string; loginToken: string; dataKey: CryptoKey }

// An account with a random data key, skipping the slow password steps, which
// the account tests cover.
export async function quickAccount(server: FakeServer, email = 'kman@example.com'): Promise<QuickAccount> {
  const id = randomUUID()
  const loginToken = randomUUID().replaceAll('-', '').repeat(2)
  server.state.accounts.push({ id, email, loginToken, proofHash: null, recoveryTries: [] })
  const dataKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  return { id, email, loginToken, dataKey }
}

// A new tab on `server`, signed in to the account.
export async function tabOn(server: FakeServer, account: QuickAccount): Promise<FakeTab> {
  const tab = server.tab()
  assert.deepEqual(await tab.signIn(account.email, account.loginToken), { ok: true })
  return tab
}
