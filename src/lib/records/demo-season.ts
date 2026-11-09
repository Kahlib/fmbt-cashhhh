// Development only: fills dev with a demo season (step 10 plan, smaller
// choices). Parlays go on dev's real finished matches, with made-up picks,
// odds, confidence and stakes, so every page can be checked with data, and
// portfolio screenshots never show real bets. A production build never
// includes this file, because the Settings button that loads it only exists
// when Vite runs in development.
//
// It never touches a week that already has parlays, and it goes through
// addParlay and saveWeek like everything you enter, so every check applies.
import type { AccountApi } from '../account/api.ts'
import { settleByHand, settleWeek } from '../bets/settle.ts'
import { addParlay, type Competition, type Pick, type Week, type WeekRecord } from '../bets/week-record.ts'
import { loadWeeks, newWeek, saveWeek } from '../bets/weeks.ts'
import { byId, loadFixtures, type Fixture } from '../fixtures.ts'
import { editable, weekKey } from '../live.ts'
import { periodIndex, seasonOf } from '../periods.ts'

// A made-up strength for each club, which shapes the made-up odds. Clubs
// not listed, such as the Champions League's, count as 75.
const STRENGTH = new Map([
  ['ARS', 92], ['MCI', 90], ['LIV', 88], ['CHE', 84], ['NEW', 80], ['AVL', 79], ['MUN', 76], ['BHA', 75], ['TOT', 74], ['BOU', 74],
  ['CRY', 72], ['BRE', 71], ['FUL', 71], ['SUN', 70], ['EVE', 70], ['NFO', 69], ['LEE', 66], ['IPS', 63], ['COV', 62], ['HUL', 60],
])

// A seeded random number generator (mulberry32), so the same fixtures give
// the same demo season every time. Nothing here is secret.
export function seeded(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6D2B79F5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// A shuffled copy, every order equally likely (Fisher-Yates).
function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

// The chances of a home win, a draw and an away win, from the two strengths.
export function chances(home: string, away: string): Record<Pick, number> {
  const diff = (STRENGTH.get(home) ?? 75) + 4 - (STRENGTH.get(away) ?? 75)
  const draw = Math.min(0.31, Math.max(0.2, 0.3 - Math.abs(diff) / 170))
  const homeShare = 1 / (1 + Math.exp(-diff / 8))
  return { H: homeShare * (1 - draw), D: draw, A: (1 - homeShare) * (1 - draw) }
}

// American odds for a chance, with a 5% cut, the way a book prices it.
// The price never goes below 1.02 in decimal, which is −5000, so the cut
// can't price a near-certain result as an underdog.
export function oddsFor(chance: number): number {
  const decimal = Math.max(1.02, 1 / (chance * 1.05))
  const odds = decimal >= 2 ? Math.round((decimal - 1) * 100) : -Math.round(100 / (decimal - 1))
  return Math.max(-5000, Math.min(5000, odds))
}

// One week's parlays: 2 to 4 of them, each with 1 to 4 games from the week.
export function demoWeek(games: readonly Fixture[], week: Week, random: () => number, now: string): WeekRecord {
  let record: WeekRecord = { schema: 1, deleted: false, parlays: [] }
  const count = 2 + Math.floor(random() * 3)
  for (let n = 0; n < count; n++) {
    const sizeRoll = random()
    const size = Math.min(games.length, sizeRoll < 0.15 ? 1 : sizeRoll < 0.4 ? 2 : sizeRoll < 0.8 ? 3 : 4)
    const chosen = shuffled(games, random).slice(0, size)
    const legs = chosen.map(game => {
      const odds = chances(game.home, game.away)
      const favourite: Pick = odds.H >= odds.A ? 'H' : 'A'
      const roll = random()
      let pick: Pick = roll < 0.7 ? favourite : roll < 0.88 ? (favourite === 'H' ? 'A' : 'H') : 'D'
      if (odds[pick] < 0.2) pick = favourite
      const jitter = random()
      const confidence = Math.max(1, Math.min(5, Math.round((odds[pick] - 0.12) / 0.13) + (jitter < 0.15 ? -1 : jitter > 0.85 ? 1 : 0)))
      return { fixtureId: game.id, pick, odds: oddsFor(odds[pick]), confidence }
    })
    const stakes = [1000, 2000, 2500, 2500, 5000]
    const boostBps = size >= 3 && random() < 0.5 ? 500 : size === 2 && random() < 0.3 ? 250 : 0
    const added = addParlay(record, week, games, { stakeCents: stakes[Math.floor(random() * stakes.length)], boostBps, legs })
    if (added.ok) record = added.record
  }
  // Every game has finished, so every leg settles now. Now and then a lost
  // leg was paid early by a promo, so the pages have one to show.
  const fixtures = byId(games)
  record = settleWeek(record, fixtures, now).record
  for (const leg of record.parlays.flatMap(parlay => parlay.legs)) {
    if (leg.settlement?.outcome === 'lost' && random() < 0.05) {
      record = settleByHand(record, leg.id, { outcome: 'won', promo: true, reason: 'Demo season: a 2-Up promo paid it early' }, fixtures, now)
    }
  }
  return record
}

const FINAL = new Set(['finished', 'extra_time', 'penalties'])

// Fills every week whose games have all finished and that has no parlays yet.
export async function fillDemoSeason(api: AccountApi, dataKey: CryptoKey, now = new Date()): Promise<{ weeks: number; parlays: number }> {
  const season = seasonOf(now)
  const { fixtures } = await loadFixtures(api, season)
  const { weeks } = await loadWeeks(api, dataKey)
  const groups = new Map<string, { week: Week; games: Fixture[] }>()
  for (const fixture of fixtures) {
    const week: Week = { season, competition: fixture.competition as Competition, period: fixture.period }
    const group = groups.get(weekKey(week)) ?? { week, games: [] }
    group.games.push(fixture)
    groups.set(weekKey(week), group)
  }
  const random = seeded(18436)
  const iso = now.toISOString()
  let added = { weeks: 0, parlays: 0 }
  const ordered = [...groups.values()].sort((a, b) => a.week.competition.localeCompare(b.week.competition) || periodIndex(a.week.period) - periodIndex(b.week.period))
  for (const { week, games } of ordered) {
    if (!games.every(game => FINAL.has(game.status))) continue
    const current = weeks.find(loaded => weekKey(loaded.week) === weekKey(week)) ?? newWeek(week)
    if (editable(current).parlays.length > 0) continue
    // In kick-off order, then by ID, so the order the server sends them in doesn't matter.
    const record = demoWeek(games.sort((a, b) => a.kickoff.localeCompare(b.kickoff) || a.id - b.id), week, random, iso)
    if (record.parlays.length === 0) continue
    const saved = await saveWeek(api, dataKey, current, record, iso)
    if (saved.result === 'saved') added = { weeks: added.weeks + 1, parlays: added.parlays + record.parlays.length }
  }
  return added
}
