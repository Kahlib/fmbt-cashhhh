// Every number on the Dashboard and Analytics, worked out in the browser from your
// records (step 10 plan, "How the stats are worked out"). Nothing here
// fetches or saves anything, so the page only ever draws what these say.
//
// Money counts settled parlays, and leg stats count settled legs. A void
// parlay, every leg dropped, returned its stake, so it counts for nothing.
import { combinedOdds, decimalOdds, payoutCents } from '../bets/odds.ts'
import { cashPayout, cashStake, parlayOutcome } from '../bets/settle.ts'
import type { Competition, Leg, Parlay, Pick, Week, WeekRecord } from '../bets/week-record.ts'
import { periodIndex } from '../periods.ts'

// bet365's cut, taken out of every price for "what the odds said" only
// (decision 2). Its prices for one match add up to about 105%.
export const CUT = 1.05

// The chance the odds gave a pick, with the cut taken out: 1 ÷ bet365's
// decimal price ÷ 1.05. −110 is 52.4% with the cut in, and 49.9% without.
export function fairChance(odds: number): number {
  return 1 / decimalOdds(odds) / CUT
}

// Favourite or underdog, by decision 3's rule: a team at +150 or shorter is
// the favourite, and anything longer the underdog.
export type PickKind = 'home-fav' | 'away-fav' | 'away-dog' | 'home-dog' | 'draw'
export const KINDS: readonly PickKind[] = ['home-fav', 'away-fav', 'away-dog', 'home-dog', 'draw']

export function pickKind(pick: Pick, odds: number): PickKind {
  if (pick === 'D') return 'draw'
  return `${pick === 'H' ? 'home' : 'away'}-${odds <= 150 ? 'fav' : 'dog'}`
}

// How a settled leg finished: won (a promo's payout counts, decision 4), lost
// to a draw, or lost. Null while it's unsettled, and for a dropped leg. A leg
// counted as lost because its match didn't finish normally didn't lose to a
// draw, even if its match was played later and ended level.
export type Result = 'won' | 'drawn' | 'lost'

export function legResult(leg: Leg): Result | null {
  const settlement = leg.settlement
  if (settlement === null || settlement.outcome === 'dropped') return null
  if (settlement.outcome === 'won') return 'won'
  const score = settlement.score90
  const level = settlement.how !== 'void' && score !== null && score[0] === score[1] && leg.pick !== 'D'
  return level ? 'drawn' : 'lost'
}

export type SeasonWeek = { week: Week; record: WeekRecord }

// One parlay, with what the stats need from it.
type Placed = {
  week: Week
  parlay: Parlay
  settled: boolean        // won, lost or void
  counts: boolean         // settled and not void
  cashed: boolean
  profitCents: number     // 0 until it's settled
  odds: number[]          // its legs' odds, leaving dropped legs out
  chance: number          // the odds' chance of it cashing, with the cut out
  decimal: number         // its decimal odds, cut left in
  payoutCents: number     // what it pays if it cashes, boost included, winnings only for a bonus bet
}

function placed(week: Week, parlay: Parlay): Placed {
  const outcome = parlayOutcome(parlay)
  const odds = parlay.legs.filter(leg => leg.settlement?.outcome !== 'dropped').map(leg => leg.odds)
  return {
    week,
    parlay,
    settled: outcome.state !== 'pending',
    counts: outcome.state === 'won' || outcome.state === 'lost',
    cashed: outcome.state === 'won',
    profitCents: outcome.profitCents ?? 0,
    odds,
    chance: odds.reduce((product, each) => product * fairChance(each), 1),
    decimal: odds.reduce((product, each) => product * decimalOdds(each), 1),
    payoutCents: odds.length === 0 ? cashStake(parlay) : cashPayout(parlay, payoutCents(parlay.stakeCents, odds, parlay.boostBps)),
  }
}

// A settled leg, with where it sits.
type Played = { week: Week; parlay: Placed; leg: Leg; place: number; result: Result }

const weekName = (week: Week) => `${week.competition} ${week.period}`

// The weeks in the order they were played, by their first kick-off, so
// Matchday 1 sits between the matchweeks around it. History uses it too.
export function inOrder(weeks: readonly SeasonWeek[]): SeasonWeek[] {
  const first = new Map(weeks.map(each => [weekName(each.week), firstKickoff(each.record)]))
  return [...weeks].sort((a, b) => (first.get(weekName(a.week)) ?? '').localeCompare(first.get(weekName(b.week)) ?? '')
    || a.week.competition.localeCompare(b.week.competition) || periodIndex(a.week.period) - periodIndex(b.week.period))
}

function firstKickoff(record: WeekRecord): string {
  let first = '9999'
  for (const parlay of record.parlays) for (const leg of parlay.legs) if (leg.kickoff < first) first = leg.kickoff
  return first
}

export type WeekPoint = {
  week: Week
  profitCents: number     // this week's settled parlays
  totalCents: number      // the season so far, after this week
  won: number
  drawn: number
  lost: number
  cashed: number
  counted: number         // settled parlays that aren't void
  perfect: boolean        // every parlay settled, and every one that isn't void cashed
}

export type RateRow = { n: number; won: number; you: number; odds: number }
export type KindRow = RateRow & { kind: PickKind }
export type ConfidenceRow = RateRow & { rating: number }
export type SizeRow = { legs: number; count: number; cashed: number; hit: number; breakEven: number; profitCents: number }
export type ClubRow = RateRow & { code: string; drawn: number; lost: number; competitions: Competition[] }

export type SeasonStats = {
  parlays: number               // settled, not void
  cashed: number
  bonusBets: number             // how many of those were bonus bets
  stakedCents: number           // on those parlays, your own money only
  netCents: number
  returnOnStake: number | null  // net ÷ staked
  weeks: WeekPoint[]            // weeks with anything settled, in the order played
  peak: WeekPoint | null        // the highest running total, when it went above $0
  worst: WeekPoint | null       // the week with the lowest profit
  legs: RateRow & { drawn: number; lost: number }
  parlayRate: RateRow           // parlays cashed, against the odds' chance
  expectedCents: number         // where the odds expected you to be, at the prices you took
  kinds: KindRow[]
  sizes: SizeRow[]
  confidence: ConfidenceRow[]
  clubs: ClubRow[]              // clubs you picked to win, most backed first
}

const rate = (rows: { result: Result; chance: number }[]): RateRow => {
  const won = rows.filter(row => row.result === 'won').length
  return {
    n: rows.length,
    won,
    you: rows.length === 0 ? 0 : won / rows.length,
    odds: rows.length === 0 ? 0 : rows.reduce((sum, row) => sum + row.chance, 0) / rows.length,
  }
}

// The Dashboard's numbers for one competition, or both.
export function seasonStats(weeks: readonly SeasonWeek[], competition: Competition | 'all'): SeasonStats {
  const ours = inOrder(weeks.filter(each => competition === 'all' || each.week.competition === competition))
  const parlays: Placed[] = []
  const legs: Played[] = []
  const points: WeekPoint[] = []
  let total = 0
  for (const { week, record } of ours) {
    const these = record.parlays.map(parlay => placed(week, parlay))
    const played: Played[] = []
    for (const each of these) {
      each.parlay.legs.forEach((leg, place) => {
        const result = legResult(leg)
        if (result !== null) played.push({ week, parlay: each, leg, place, result })
      })
    }
    parlays.push(...these)
    legs.push(...played)
    const counted = these.filter(each => each.counts)
    if (counted.length === 0 && played.length === 0) continue
    const profit = counted.reduce((sum, each) => sum + each.profitCents, 0)
    total += profit
    points.push({
      week,
      profitCents: profit,
      totalCents: total,
      won: played.filter(each => each.result === 'won').length,
      drawn: played.filter(each => each.result === 'drawn').length,
      lost: played.filter(each => each.result === 'lost').length,
      cashed: counted.filter(each => each.cashed).length,
      counted: counted.length,
      perfect: these.every(each => each.settled) && counted.length > 0 && counted.every(each => each.cashed),
    })
  }

  const counted = parlays.filter(each => each.counts)
  // Your own money only: a bonus bet's stake cost nothing.
  const staked = counted.reduce((sum, each) => sum + cashStake(each.parlay), 0)
  const net = counted.reduce((sum, each) => sum + each.profitCents, 0)
  const withChance = legs.map(each => ({ result: each.result, chance: fairChance(each.leg.odds) }))

  const peak = points.reduce<WeekPoint | null>((best, each) => (each.totalCents > 0 && (best === null || each.totalCents > best.totalCents) ? each : best), null)
  const worst = points.reduce<WeekPoint | null>((low, each) => (low === null || each.profitCents < low.profitCents ? each : low), null)

  // Parlays by how many legs they were placed with, dropped ones included.
  const bySize = new Map<number, Placed[]>()
  for (const each of counted) bySize.set(each.parlay.legs.length, [...(bySize.get(each.parlay.legs.length) ?? []), each])
  const sizes = [...bySize].sort(([a], [b]) => a - b).map(([size, group]) => {
    const cashed = group.filter(each => each.cashed).length
    return {
      legs: size,
      count: group.length,
      cashed,
      hit: cashed / group.length,
      breakEven: group.reduce((sum, each) => sum + 1 / each.decimal, 0) / group.length,
      profitCents: group.reduce((sum, each) => sum + each.profitCents, 0),
    }
  })

  // Clubs you picked to win. A draw pick backs neither team.
  const clubs = new Map<string, { rows: { result: Result; chance: number }[]; competitions: Set<Competition> }>()
  for (const each of legs) {
    if (each.leg.pick === 'D') continue
    const code = each.leg.pick === 'H' ? each.leg.home : each.leg.away
    const club = clubs.get(code) ?? { rows: [], competitions: new Set() }
    club.rows.push({ result: each.result, chance: fairChance(each.leg.odds) })
    club.competitions.add(each.week.competition)
    clubs.set(code, club)
  }

  return {
    parlays: counted.length,
    cashed: counted.filter(each => each.cashed).length,
    bonusBets: counted.filter(each => each.parlay.bonus === true).length,
    stakedCents: staked,
    netCents: net,
    returnOnStake: staked === 0 ? null : net / staked,
    weeks: points,
    peak,
    worst,
    legs: {
      ...rate(withChance),
      drawn: legs.filter(each => each.result === 'drawn').length,
      lost: legs.filter(each => each.result === 'lost').length,
    },
    parlayRate: {
      n: counted.length,
      won: counted.filter(each => each.cashed).length,
      you: counted.length === 0 ? 0 : counted.filter(each => each.cashed).length / counted.length,
      odds: counted.length === 0 ? 0 : counted.reduce((sum, each) => sum + each.chance, 0) / counted.length,
    },
    // Each parlay's stake × (its chance × what it returns per dollar − 1),
    // boost included, added up, then rounded to the cent.
    expectedCents: Math.round(counted.reduce((sum, each) => sum + each.chance * each.payoutCents - cashStake(each.parlay), 0)),
    kinds: KINDS.map(kind => ({ kind, ...rate(legs.filter(each => pickKind(each.leg.pick, each.leg.odds) === kind).map(each => ({ result: each.result, chance: fairChance(each.leg.odds) }))) })),
    sizes,
    confidence: [1, 2, 3, 4, 5].map(rating => ({ rating, ...rate(legs.filter(each => each.leg.confidence === rating).map(each => ({ result: each.result, chance: fairChance(each.leg.odds) }))) })),
    clubs: [...clubs].map(([code, club]) => {
      const row = rate(club.rows)
      return {
        code, ...row,
        drawn: club.rows.filter(each => each.result === 'drawn').length,
        lost: club.rows.filter(each => each.result === 'lost').length,
        competitions: [...club.competitions].sort(),
      }
    }).sort((a, b) => b.n - a.n || b.you - a.you || a.code.localeCompare(b.code)),
  }
}

// The six achievements the Dashboard shows, across the whole season and
// both competitions. `plClubs` is how many clubs the Premier League has.
export type Achievements = {
  perfectWeek: Week | null      // the first week where every parlay cashed
  bestRun: number               // the most legs won in a row, in kick-off order
  plBacked: number              // Premier League clubs you've picked to win
  plClubs: number
  europeanNight: boolean        // a Champions League parlay cashed
  drawsLanded: number
  longest: number | null        // the longest odds of a parlay that cashed
}

export function achievements(weeks: readonly SeasonWeek[], plClubs: number): Achievements {
  const stats = seasonStats(weeks, 'all')
  const legs: { kickoff: string; order: number; result: Result }[] = []
  const backed = new Set<string>()
  let order = 0
  let draws = 0
  let longest: number | null = null
  let european = false
  for (const { week, record } of inOrder(weeks)) {
    for (const parlay of record.parlays) {
      const each = placed(week, parlay)
      if (each.cashed) {
        const odds = combinedOdds(each.odds)
        if (longest === null || odds > longest) longest = odds
        if (week.competition === 'UCL') european = true
      }
      for (const leg of parlay.legs) {
        const result = legResult(leg)
        order++
        if (result === null) continue
        legs.push({ kickoff: leg.kickoff, order, result })
        if (leg.pick === 'D' && result === 'won') draws++
        if (week.competition === 'PL' && leg.pick !== 'D') backed.add(leg.pick === 'H' ? leg.home : leg.away)
      }
    }
  }
  let run = 0
  let best = 0
  for (const leg of legs.sort((a, b) => a.kickoff.localeCompare(b.kickoff) || a.order - b.order)) {
    run = leg.result === 'won' ? run + 1 : 0
    best = Math.max(best, run)
  }
  return {
    perfectWeek: stats.weeks.find(each => each.perfect)?.week ?? null,
    bestRun: best,
    plBacked: backed.size,
    plClubs,
    europeanNight: european,
    drawsLanded: draws,
    longest,
  }
}

// ----- Analytics (step 10 plan, 10.4): the numbers only that page shows -----

// Parlays against singles (decision 5), by how many legs they were placed with.
export type VersusRow = { legs: number; count: number; parlayCents: number; singlesCents: number }
export type Versus = VersusRow & { sizes: VersusRow[] }  // `legs` is every pick in them

// One side of a club's ledger: picking it to win (backing), or picking the
// team it plays (fading). Draw picks count for neither.
export type LedgerSide = RateRow & { drawn: number; lost: number }
export type LedgerRow = { code: string; competitions: Competition[]; backing: LedgerSide; fading: LedgerSide }

// A parlay as My parlays names it: its week and its place in that week.
export type ParlayRef = { week: Week; number: number }

export type Moments = {
  perfectWeeks: Week[]                                   // every parlay that isn't void cashed, in the order played
  heartbreakers: (ParlayRef & { wouldCents: number })[]  // lost on one leg, with every other leg won
  drawKills: { code: string; n: number }[]               // legs lost to a draw, by the club picked, most first
  promos: (ParlayRef & { payoutCents: number })[]        // cashed only because a promo paid a leg
}

export type Analytics = { versus: Versus; moments: Moments; ledger: LedgerRow[] }

// What a parlay's picks would have made as singles, each with an equal share
// of its stake. A single is the same bet, so it keeps its own result, boost
// and all. A dropped leg's single would have been void, so it makes nothing,
// and a bonus bet's lost single would have cost nothing.
export function singlesCents(parlay: Parlay, profitCents: number): number {
  if (parlay.legs.length === 1) return profitCents
  const share = parlay.stakeCents / parlay.legs.length
  let total = 0
  for (const leg of parlay.legs) {
    if (leg.settlement?.outcome === 'won') total += share * (decimalOdds(leg.odds) - 1)
    else if (leg.settlement?.outcome === 'lost' && parlay.bonus !== true) total -= share
  }
  return Math.round(total)
}

const side = (rows: { result: Result; chance: number }[]): LedgerSide => ({
  ...rate(rows),
  drawn: rows.filter(each => each.result === 'drawn').length,
  lost: rows.filter(each => each.result === 'lost').length,
})

// Analytics' numbers for one competition, or both. Parlays against singles
// waits until every leg of a parlay has settled, since a parlay can lose
// while its other legs are still to play, and their singles would not be
// settled yet. A void parlay counts for nothing, as everywhere else.
export function analytics(weeks: readonly SeasonWeek[], competition: Competition | 'all'): Analytics {
  const ours = inOrder(weeks.filter(each => competition === 'all' || each.week.competition === competition))
  const sizes = new Map<number, VersusRow>()
  const total: VersusRow = { legs: 0, count: 0, parlayCents: 0, singlesCents: 0 }
  const moments: Moments = { perfectWeeks: [], heartbreakers: [], drawKills: [], promos: [] }
  const kills = new Map<string, number>()
  const clubs = new Map<string, { back: { result: Result; chance: number }[]; fade: { result: Result; chance: number }[]; competitions: Set<Competition> }>()
  const club = (code: string) => {
    const found = clubs.get(code) ?? { back: [], fade: [], competitions: new Set<Competition>() }
    clubs.set(code, found)
    return found
  }

  for (const { week, record } of ours) {
    const these = record.parlays.map(parlay => placed(week, parlay))
    const counted = these.filter(each => each.counts)
    if (counted.length > 0 && these.every(each => each.settled) && counted.every(each => each.cashed)) moments.perfectWeeks.push(week)

    these.forEach((each, index) => {
      const ref = { week, number: index + 1 }
      const legs = each.parlay.legs
      if (each.counts && legs.every(leg => leg.settlement !== null)) {
        const singles = singlesCents(each.parlay, each.profitCents)
        const row = sizes.get(legs.length) ?? { legs: legs.length, count: 0, parlayCents: 0, singlesCents: 0 }
        sizes.set(legs.length, row)
        for (const sum of [row, total]) {
          sum.count += 1
          sum.parlayCents += each.profitCents
          sum.singlesCents += singles
        }
        total.legs += legs.length
      }
      // A heartbreaker needs another leg that won: a single, or a parlay with
      // only one leg left after a drop, just lost.
      const results = legs.filter(leg => leg.settlement?.outcome !== 'dropped').map(legResult)
      if (each.counts && !each.cashed && results.length > 1 && results.filter(result => result !== 'won').length === 1) {
        moments.heartbreakers.push({ ...ref, wouldCents: each.payoutCents })
      }
      // A promo that paid a leg the score says lost, or before there was a score.
      if (each.cashed && legs.some(leg => leg.settlement?.outcome === 'won' && leg.settlement.promo && leg.settlement.byScore !== 'won')) {
        moments.promos.push({ ...ref, payoutCents: cashStake(each.parlay) + each.profitCents })
      }
      for (const leg of legs) {
        const result = legResult(leg)
        if (result === null || leg.pick === 'D') continue
        const [backed, faded] = leg.pick === 'H' ? [leg.home, leg.away] : [leg.away, leg.home]
        if (result === 'drawn') kills.set(backed, (kills.get(backed) ?? 0) + 1)
        const chance = fairChance(leg.odds)
        club(backed).back.push({ result, chance })
        club(faded).fade.push({ result, chance })
        club(backed).competitions.add(week.competition)
        club(faded).competitions.add(week.competition)
      }
    })
  }

  return {
    versus: { ...total, sizes: [...sizes.values()].sort((a, b) => a.legs - b.legs) },
    moments: { ...moments, drawKills: [...kills].map(([code, n]) => ({ code, n })).sort((a, b) => b.n - a.n || a.code.localeCompare(b.code)) },
    ledger: [...clubs].map(([code, each]) => ({ code, competitions: [...each.competitions].sort(), backing: side(each.back), fading: side(each.fade) }))
      .sort((a, b) => a.code.localeCompare(b.code)),
  }
}
