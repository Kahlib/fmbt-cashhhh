// History's rows (step 10 plan, 10.4): every parlay or every pick of the
// season, with the filters and the sorting. Like the rest of src/lib/stats/,
// nothing here fetches or saves anything, so the page only draws what this
// works out from your records and the fixtures.
import { decimalOdds } from '../bets/odds.ts'
import { legState, parlayView, type LegState, type ParlayView } from '../bets/view.ts'
import type { Competition, Leg, Week } from '../bets/week-record.ts'
import type { Fixture } from '../fixtures.ts'
import { inOrder, KINDS, pickKind, type PickKind, type SeasonWeek } from './season.ts'

export type ParlayResult = 'open' | 'cashed' | 'lost' | 'void'
export type PickResult = 'open' | 'won' | 'drawn' | 'lost' | 'dropped'

export type ParlayRow = {
  key: string
  week: Week
  order: number           // its week's place in the order played, from 0
  view: ParlayView        // its number, state, odds and money, as My parlays shows them
  result: ParlayResult
  promo: boolean          // it only cashed because a promo paid a leg
  legsWon: number
  teams: string[]         // every team in its games, for the club filter
}

export type PickRow = {
  key: string
  week: Week
  order: number
  number: number          // its parlay's place in the week, from 1
  place: number           // its place in the parlay, from 0
  leg: Leg
  state: LegState
  kind: PickKind
  result: PickResult
}

// A week's filter value, such as "PL 12".
export const weekValue = (week: Week) => `${week.competition} ${week.period}`

function pickResult(state: LegState): PickResult {
  if (state.kind === 'won' || state.kind === 'dropped') return state.kind
  if (state.kind === 'lost') return state.draw ? 'drawn' : 'lost'
  return 'open'
}

const PARLAY_RESULTS = new Map<ParlayView['state'], ParlayResult>([['pending', 'open'], ['won', 'cashed'], ['lost', 'lost'], ['void', 'void']])

// Every parlay and every pick of the season in one competition, or both.
export function historyRows(weeks: readonly SeasonWeek[], fixtures: ReadonlyMap<number, Fixture>, competition: Competition | 'all'): { parlays: ParlayRow[]; picks: PickRow[] } {
  const parlays: ParlayRow[] = []
  const picks: PickRow[] = []
  inOrder(weeks.filter(each => competition === 'all' || each.week.competition === competition)).forEach(({ week, record }, order) => {
    record.parlays.forEach((parlay, index) => {
      const view = parlayView(parlay, index, fixtures)
      const states = parlay.legs.map(leg => legState(leg, fixtures.get(leg.fixtureId)))
      parlays.push({
        key: `${weekValue(week)} ${parlay.id}`,
        week,
        order,
        view,
        result: PARLAY_RESULTS.get(view.state) ?? 'open',
        promo: view.state === 'won' && parlay.legs.some(leg => leg.settlement?.outcome === 'won' && leg.settlement.promo && leg.settlement.byScore !== 'won'),
        legsWon: states.filter(state => state.kind === 'won').length,
        teams: [...new Set(parlay.legs.flatMap(leg => [leg.home, leg.away]))],
      })
      parlay.legs.forEach((leg, place) => {
        picks.push({
          key: `${weekValue(week)} ${parlay.id} ${leg.id}`,
          week, order, number: index + 1, place, leg,
          state: states[place],
          kind: pickKind(leg.pick, leg.odds),
          result: pickResult(states[place]),
        })
      })
    })
  })
  return { parlays, picks }
}

// ----- Filters. An empty value means "any". -----

export type ParlayFilters = { club: string; week: string; size: string; result: string; stake: string }
export type PickFilters = { club: string; week: string; kind: string; confidence: string; result: string }
export const NO_PARLAY_FILTERS: ParlayFilters = { club: '', week: '', size: '', result: '', stake: '' }
export const NO_PICK_FILTERS: PickFilters = { club: '', week: '', kind: '', confidence: '', result: '' }

const fits = (wanted: string, value: string) => wanted === '' || wanted === value

export function filterParlays(rows: readonly ParlayRow[], filters: ParlayFilters): ParlayRow[] {
  return rows.filter(row => (filters.club === '' || row.teams.includes(filters.club))
    && fits(filters.week, weekValue(row.week))
    && fits(filters.size, String(row.view.parlay.legs.length))
    && fits(filters.result, row.result)
    && fits(filters.stake, String(row.view.parlay.stakeCents)))
}

export function filterPicks(rows: readonly PickRow[], filters: PickFilters): PickRow[] {
  return rows.filter(row => (filters.club === '' || row.leg.home === filters.club || row.leg.away === filters.club)
    && fits(filters.week, weekValue(row.week))
    && fits(filters.kind, row.kind)
    && fits(filters.confidence, String(row.leg.confidence))
    && fits(filters.result, row.result))
}

// The choices a filter offers: only what's in your history. Weeks come
// newest first, like the table.
export function weekChoices(rows: readonly { week: Week; order: number }[]): Week[] {
  const seen = new Map<string, { week: Week; order: number }>()
  for (const row of rows) seen.set(weekValue(row.week), row)
  return [...seen.values()].sort((a, b) => b.order - a.order).map(each => each.week)
}

export const distinctNumbers = (values: readonly number[]) => [...new Set(values)].sort((a, b) => a - b)

// ----- Sorting. Select a heading to sort by it, and again to reverse it. -----

export type ParlayKey = 'week' | 'parlay' | 'picks' | 'odds' | 'stake' | 'boost' | 'result' | 'returned' | 'profit'
export type PickKey = 'week' | 'game' | 'pick' | 'odds' | 'confidence' | 'kind' | 'score' | 'result'
export type SortState<K extends string> = { key: K; down: boolean }

// Numbers sort biggest first on the first select, and words A to Z.
export const PARLAYS_FIRST_DOWN = new Set<ParlayKey>(['week', 'picks', 'odds', 'stake', 'boost', 'returned', 'profit'])
export const PICKS_FIRST_DOWN = new Set<PickKey>(['week', 'odds', 'confidence', 'score'])

export function nextSort<K extends string>(sort: SortState<K>, key: K, firstDown: ReadonlySet<K>): SortState<K> {
  return sort.key === key ? { key, down: !sort.down } : { key, down: firstDown.has(key) }
}

// Sorts by `value`, with rows that have none (a void parlay's odds, an open
// parlay's profit) last either way, and ties broken by `tie`.
export function sortBy<T>(rows: readonly T[], value: (row: T) => number | string | null, down: boolean, tie: (a: T, b: T) => number): T[] {
  return [...rows].sort((a, b) => {
    const x = value(a)
    const y = value(b)
    if (x === null || y === null) return x === y ? tie(a, b) : x === null ? 1 : -1
    const compared = typeof x === 'string' && typeof y === 'string' ? x.localeCompare(y) : Number(x) - Number(y)
    return (down ? -compared : compared) || tie(a, b)
  })
}

// Ties go in History's usual order: newest week first, then parlay 1, 2, 3,
// then each parlay's legs in order.

const PARLAY_RANK: Record<ParlayResult, number> = { open: 0, cashed: 1, lost: 2, void: 3 }
const PICK_RANK: Record<PickResult, number> = { open: 0, won: 1, drawn: 2, lost: 3, dropped: 4 }

export function sortParlays(rows: readonly ParlayRow[], sort: SortState<ParlayKey>): ParlayRow[] {
  const value = (row: ParlayRow): number | null => {
    const view = row.view
    switch (sort.key) {
      case 'week': return row.order
      case 'parlay': return view.number
      case 'picks': return view.parlay.legs.length
      case 'odds': return view.odds === null ? null : decimalOdds(view.odds)
      case 'stake': return view.parlay.stakeCents
      case 'boost': return view.parlay.boostBps
      case 'result': return PARLAY_RANK[row.result]
      case 'returned': return view.payoutCents ?? (row.result === 'lost' ? 0 : view.potentialCents)
      case 'profit': return view.profitCents
    }
  }
  return sortBy(rows, value, sort.down, (a, b) => b.order - a.order || a.view.number - b.view.number)
}

// `name` turns a team's code into its name, so games and picks sort by name.
export function sortPicks(rows: readonly PickRow[], sort: SortState<PickKey>, name: (code: string) => string): PickRow[] {
  const value = (row: PickRow): number | string => {
    const leg = row.leg
    switch (sort.key) {
      case 'week': return row.order
      case 'game': return `${name(leg.home)} v ${name(leg.away)}`
      case 'pick': return leg.pick === 'D' ? 'Draw' : name(leg.pick === 'H' ? leg.home : leg.away)
      case 'odds': return decimalOdds(leg.odds)
      case 'confidence': return leg.confidence
      case 'kind': return KINDS.indexOf(row.kind)
      case 'score': return Date.parse(leg.kickoff)
      case 'result': return PICK_RANK[row.result]
    }
  }
  return sortBy(rows, value, sort.down, (a, b) => b.order - a.order || a.number - b.number || a.place - b.place)
}
