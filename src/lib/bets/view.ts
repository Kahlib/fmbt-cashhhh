// What My parlays and Build parlay show for each leg, parlay and week,
// worked out from your records and the fixtures (step 10 plan, The flows).
// Nothing here saves anything, so the pages only ever draw what these say.
import type { Fixture } from '../fixtures.ts'
import { clockTime, count, dayAndTime, formatDay, money, oddsText, percentText } from '../format.ts'
import type { AuditEntry, AuditProblem, Change, ChangeValue } from './audit.ts'
import { boostCents, combinedOdds, payoutCents } from './odds.ts'
import { cashPayout, cashStake, finalScore90, isParlayLocked, parlayOutcome, type ParlayState } from './settle.ts'
import { byScoreFor, type Leg, type Parlay, type Pick, type WeekRecord } from './week-record.ts'

export type WaitingStatus = 'postponed' | 'cancelled' | 'suspended' | 'awarded' | 'missing'
const WAITING = new Set<string>(['postponed', 'cancelled', 'suspended', 'awarded'])
const LIVE = new Set<string>(['live', 'half_time'])

// How a leg stands against the score while its match is on. "Level" means a
// draw would lose it, so a draw pick on a level score is on track.
export type Standing = 'on track' | 'level' | 'behind'

export type LegState =
  | { kind: 'won'; how: 'score' | 'promo' | 'hand' }
  | { kind: 'lost'; how: 'score' | 'hand' | 'void'; draw: boolean }
  | { kind: 'dropped' }
  | { kind: 'final'; outcome: 'won' | 'lost'; score: [number, number]; draw: boolean } // finished, and settles next time settling runs
  | { kind: 'live'; standing: Standing; score: [number, number]; minute: number | null; halfTime: boolean }
  | { kind: 'not started' }
  | { kind: 'waiting'; status: WaitingStatus }

export function standing(pick: Pick, [home, away]: readonly [number, number]): Standing {
  if (pick === 'D') return home === away ? 'on track' : 'behind'
  const ahead = pick === 'H' ? home - away : away - home
  if (ahead > 0) return 'on track'
  return ahead === 0 ? 'level' : 'behind'
}

// A loss on a level score, by a pick that wasn't the draw.
const lostToDraw = (pick: Pick, score: readonly [number, number] | null) => score !== null && score[0] === score[1] && pick !== 'D'

// A saved leg's state, or a leg on the slip, which has no settlement yet.
export function legState(leg: { pick: Pick; settlement: Leg['settlement'] }, fixture: Fixture | undefined): LegState {
  const settlement = leg.settlement
  if (settlement !== null) {
    if (settlement.outcome === 'dropped') return { kind: 'dropped' }
    if (settlement.outcome === 'won') return { kind: 'won', how: settlement.promo ? 'promo' : settlement.how === 'auto' ? 'score' : 'hand' }
    // A leg counted as lost because its match didn't finish normally didn't
    // lose to a draw, even if a score is noted later when the match is played.
    const how = settlement.how === 'auto' ? 'score' : settlement.how === 'void' ? 'void' : 'hand'
    return { kind: 'lost', how, draw: how !== 'void' && lostToDraw(leg.pick, settlement.score90) }
  }
  if (fixture === undefined) return { kind: 'waiting', status: 'missing' }
  if (WAITING.has(fixture.status)) return { kind: 'waiting', status: fixture.status as WaitingStatus }
  const final = finalScore90(fixture)
  if (final !== null) return { kind: 'final', outcome: byScoreFor(leg.pick, final), score: final, draw: lostToDraw(leg.pick, final) }
  if (LIVE.has(fixture.status)) {
    // Before the first goal the feed may not have sent a score yet.
    const score: [number, number] = [fixture.home_90 ?? 0, fixture.away_90 ?? 0]
    return { kind: 'live', standing: standing(leg.pick, score), score, minute: fixture.minute, halfTime: fixture.status === 'half_time' }
  }
  return { kind: 'not started' }
}

export type ParlayView = {
  parlay: Parlay
  number: number                  // its place in the week, from 1, as the audit log numbers it
  locked: boolean
  state: ParlayState
  odds: number | null             // as bet365 shows them, leaving dropped legs out; null once every leg is dropped
  payoutCents: number | null      // what it returned, once it's won or void
  profitCents: number | null      // once settled: the return less the stake, the stake lost, or 0 when void
  potentialCents: number | null   // while it's pending: what it returns if every leg still to play wins, winnings only for a bonus bet
  boostCents: number              // how much of the payout or the potential is boost
  lostLegs: number
  onlyLossWasADraw: boolean       // lost on one leg, to a draw: the heartbreaker
  live: boolean                   // a leg's match is being played now
}

export function parlayView(parlay: Parlay, index: number, fixtures: ReadonlyMap<number, Fixture>): ParlayView {
  const outcome = parlayOutcome(parlay)
  const states = parlay.legs.map(leg => legState(leg, fixtures.get(leg.fixtureId)))
  const counted = parlay.legs.filter(leg => leg.settlement?.outcome !== 'dropped')
  // While pending, every leg left counts as if it wins. Once won, only the
  // legs that won count, which is the same legs.
  const odds = counted.map(leg => leg.odds)
  const lost = states.filter(state => state.kind === 'lost')
  let potential: number | null = null
  let boost = 0
  if (outcome.state === 'pending') potential = cashPayout(parlay, payoutCents(parlay.stakeCents, odds, parlay.boostBps))
  if ((outcome.state === 'pending' || outcome.state === 'won') && parlay.boostBps > 0) boost = boostCents(parlay.stakeCents, odds, parlay.boostBps)
  return {
    parlay,
    number: index + 1,
    locked: isParlayLocked(parlay),
    state: outcome.state,
    odds: counted.length === 0 ? null : combinedOdds(odds),
    payoutCents: outcome.state === 'won' || outcome.state === 'void' ? outcome.payoutCents : null,
    profitCents: outcome.state === 'pending' ? null : outcome.profitCents,
    potentialCents: potential,
    boostCents: boost,
    lostLegs: lost.length,
    onlyLossWasADraw: lost.length === 1 && lost[0].kind === 'lost' && lost[0].draw,
    live: states.some(state => state.kind === 'live'),
  }
}

export type WeekSummary = {
  parlays: number
  bonusBets: number       // how many of them were bonus bets, whose stakes cost nothing
  stakedCents: number     // your own money: bonus bets' stakes aren't in it
  returnedCents: number   // what settled parlays paid back: won ones, and void ones' stakes
  netCents: number        // profit and loss on the parlays that have settled
  settled: number
  cashed: number
  legsToSettle: number
  live: number
  waiting: number
}

export function weekSummary(record: WeekRecord, fixtures: ReadonlyMap<number, Fixture>): WeekSummary {
  const summary: WeekSummary = { parlays: 0, bonusBets: 0, stakedCents: 0, returnedCents: 0, netCents: 0, settled: 0, cashed: 0, legsToSettle: 0, live: 0, waiting: 0 }
  for (const parlay of record.parlays) {
    const outcome = parlayOutcome(parlay)
    summary.parlays += 1
    if (parlay.bonus === true) summary.bonusBets += 1
    summary.stakedCents += cashStake(parlay)
    if (outcome.state !== 'pending') {
      summary.settled += 1
      summary.netCents += outcome.profitCents ?? 0
      summary.returnedCents += outcome.payoutCents ?? 0 // a lost parlay's is 0
      if (outcome.state === 'won') summary.cashed += 1
    }
    for (const leg of parlay.legs) {
      if (leg.settlement !== null) continue
      summary.legsToSettle += 1
      const state = legState(leg, fixtures.get(leg.fixtureId))
      if (state.kind === 'live') summary.live += 1
      if (state.kind === 'waiting') summary.waiting += 1
    }
  }
  return summary
}

// The sentence under My parlays' title.
export function weekSentence(name: string, summary: WeekSummary): string {
  if (summary.parlays === 0) return `You haven't logged a parlay for ${name}.`
  if (summary.legsToSettle === 0) return `${name} is settled. ${summary.cashed} of ${count(summary.parlays, 'parlay', 'parlays')} cashed.`
  if (summary.live > 0) return `${name} is in play. ${count(summary.legsToSettle, 'of your legs is', 'of your legs are')} still to settle, ${summary.live} of them live.`
  const waiting = summary.waiting === 0 ? '' : ` ${summary.waiting === 1 ? '1 is' : `${summary.waiting} are`} waiting for you.`
  return `${count(summary.legsToSettle, 'leg', 'legs')} in ${name} still to settle.${waiting}`
}

// Where a leg sits, for sentences like "leg 3 of parlay 2". Null if it's gone.
export function legPlace(record: WeekRecord, parlayId: string, legId: string): { parlay: number; leg: number } | null {
  const parlay = record.parlays.findIndex(each => each.id === parlayId)
  if (parlay === -1) return null
  const leg = record.parlays[parlay].legs.findIndex(each => each.id === legId)
  return leg === -1 ? null : { parlay: parlay + 1, leg: leg + 1 }
}

// One line of the audit log, or of the list a reason is asked for, in
// words: "Parlay 1: stake from $25.00 to $20.00". The labels come from a
// decrypted record, so they're looked up in Maps, where a label such as
// "constructor" finds nothing (fmbt-security, section 6). A few fields read
// better as their own sentence, such as "settled by hand, not from the score".
type Field = {
  name: string
  value: (value: Exclude<ChangeValue, null>) => string
  words?: (from: string | null, to: string | null) => string
}
const PICK_WORDS = new Map([['H', 'home win'], ['D', 'draw'], ['A', 'away win']])
const HOW_WORDS = new Map([['auto', 'from the score'], ['override', 'by hand'], ['void', 'as void']])
const FIELDS = new Map<string, Field>([
  ['stake in cents', { name: 'stake', value: v => money(Number(v)) }],
  ['boost in basis points', { name: 'boost', value: v => percentText(Number(v)) }],
  ['bonus bet', {
    name: 'bonus bet',
    value: v => (v === true ? 'yes' : 'no'),
    words: (_from, to) => (to === 'yes' ? 'made a bonus bet' : 'no longer a bonus bet'),
  }],
  ['odds', { name: 'odds', value: v => oddsText(Number(v)) }],
  ['pick', { name: 'pick', value: v => PICK_WORDS.get(String(v)) ?? String(v) }],
  ['confidence', { name: 'confidence', value: v => `${String(v)} of 5` }],
  ['90-minute score', { name: '90-minute score', value: v => (Array.isArray(v) ? `${v[0]}–${v[1]}` : String(v)) }],
  ['outcome', { name: 'result', value: v => String(v) }],
  ['how it settled', {
    name: 'how it settled',
    value: v => HOW_WORDS.get(String(v)) ?? String(v),
    words: (from, to) => (to === null ? `no longer settled ${from}` : from === null ? `settled ${to}` : `settled ${to}, not ${from}`),
  }],
  ['promo', {
    name: 'promo',
    value: v => (v === true ? 'yes' : 'no'),
    words: (from, to) => (to === 'yes' ? 'paid by a promo' : from === 'yes' ? 'no longer paid by a promo' : 'not paid by a promo'),
  }],
  ['reason', { name: 'reason', value: v => `“${String(v)}”` }],
  ['kick-off', { name: 'kick-off', value: v => dayAndTime(String(v)) }],
  ['settled at', { name: 'time it settled', value: v => `${formatDay(String(v))} ${clockTime(String(v))}` }],
  ['game', { name: 'game', value: v => `football-data match ${String(v)}` }],
  ['teams', { name: 'teams', value: v => String(v) }],
])

export function changeWords(change: Change): string {
  const parts = change.what.split(' · ')
  const field = FIELDS.get(parts[parts.length - 1])
  if (field === undefined || parts.length < 2) return parts.join(', ')
  const where = parts.slice(0, -1).join(', ')
  const from = change.from === null ? null : field.value(change.from)
  const to = change.to === null ? null : field.value(change.to)
  if (field.words !== undefined) return `${where}: ${field.words(from, to)}`
  return `${where}: ${field.name} from ${from ?? 'nothing'} to ${to ?? 'nothing'}`
}

// The line at the top of Settings' audit log (step 10.5): that it checks
// out, or the first thing wrong with it. Null while it's empty.
export function auditCheck(entries: readonly AuditEntry[], problems: readonly AuditProblem[]): { ok: boolean; text: string } | null {
  const first = problems[0]
  if (first === undefined) {
    if (entries.length === 0) return null
    return { ok: true, text: entries.length === 1 ? 'Its 1 entry opens and checks out.' : `All ${entries.length.toLocaleString('en-GB')} entries open and check out, and each is linked to the one before it.` }
  }
  const what = first.kind === 'missing' ? (first.from === first.to ? `Entry ${first.from} is missing` : `Entries ${first.from} to ${first.to} are missing`)
    : first.kind === 'broken' ? `Entry ${first.seq} doesn't link to entry ${first.seq - 1}`
      : `Entry ${first.seq} doesn't open`
  const more = problems.length - 1
  return {
    ok: false,
    text: `${what}, so something in the log changed after it was saved.${more > 0 ? ` It has ${count(more, 'other problem', 'other problems')} too.` : ''} Your backups hold their own copy of the log.`,
  }
}
