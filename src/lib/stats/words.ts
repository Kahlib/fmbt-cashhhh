// The Dashboard's and Analytics' sentences: what each panel shows, in words,
// worked out from the numbers (fmbt-design-system, "Panel contents"). Each
// sentence is a list of parts, and a part with `b` is shown in bold, in its tone.
import { count, money, pointsText, signedMoney, wholePercent } from '../format.ts'
import { periodName } from '../periods.ts'
import type { ParlayResult, PickResult } from './history.ts'
import type { ConfidenceRow, KindRow, LedgerRow, Moments, ParlayRef, PickKind, SeasonStats, SizeRow, Versus } from './season.ts'

export type Tone = 'good' | 'bad' | 'warn' | 'you' | 'odds'
export type Part = string | { b: string; tone?: Tone }
export type Sentence = Part[]

const toneOf = (value: number): Tone | undefined => (value > 0 ? 'good' : value < 0 ? 'bad' : undefined)

export const KIND_NAMES = new Map<PickKind, string>([
  ['home-fav', 'Home favourites'], ['away-fav', 'Away favourites'], ['away-dog', 'Away underdogs'],
  ['home-dog', 'Home underdogs'], ['draw', 'Draws'],
])

// One pick's type, as History's Type column and filter name it.
export const KIND_NAME = new Map<PickKind, string>([
  ['home-fav', 'Home favourite'], ['away-fav', 'Away favourite'], ['away-dog', 'Away underdog'],
  ['home-dog', 'Home underdog'], ['draw', 'Draw'],
])

// History's results in words, for its Result filters and the CSV.
export const PARLAY_RESULT_WORDS: Record<ParlayResult, string> = { open: 'Still to settle', cashed: 'Cashed', lost: 'Lost', void: 'Void' }
export const PICK_RESULT_WORDS: Record<PickResult, string> = { open: 'Still to settle', won: 'Won', drawn: 'Lost to a draw', lost: 'Lost', dropped: 'Dropped' }

// "Singles" or "3-leg parlays".
export const sizeName = (legs: number) => (legs === 1 ? 'Singles' : `${legs}-leg parlays`)

// "a", "a and b", or "a, b and c".
export const listed = (items: readonly string[]) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`)

// Under the bankroll: what's been staked, and how much of the high point
// has gone since, when it's more than a dollar.
export function heroSentence(stats: SeasonStats): Sentence {
  if (stats.parlays === 0) return ['No parlays have settled yet. This page fills in as they do.']
  const parts: Sentence = [`On ${money(stats.stakedCents)} staked across ${stats.parlays === 1 ? '1 parlay' : `${stats.parlays} parlays`}.`]
  const peak = stats.peak
  if (peak !== null && peak.totalCents - stats.netCents > 100) {
    parts.push(` You were up ${money(peak.totalCents)} after ${periodName(peak.week.period)} and have given back ${money(peak.totalCents - stats.netCents)} since.`)
  }
  return parts
}

// Under the donut.
export function legsSentence(stats: SeasonStats): Sentence {
  const { drawn, lost } = stats.legs
  if (stats.legs.n === 0) return []
  if (drawn > lost) return ['Draws cost you ', { b: drawn === 1 ? '1 leg' : `${drawn} legs`, tone: 'warn' }, `. That's more than you lost outright (${lost}).`]
  return [`You lost ${lost} ${lost === 1 ? 'leg' : 'legs'} outright and ${drawn} to draws.`]
}

// Under the radar: the type of pick that beats the odds by the most, with
// 5 or more picks, and the one that falls furthest short, with 3 or more.
export function kindsSentence(kinds: readonly KindRow[]): Sentence {
  const edge = (row: KindRow) => row.you - row.odds
  const best = kinds.filter(row => row.n >= 5).sort((a, b) => edge(b) - edge(a))[0]
  const weak = kinds.filter(row => row.n >= 3).sort((a, b) => edge(a) - edge(b))[0]
  if (best === undefined) return ['Not enough picks yet to call a best type.']
  const parts: Sentence = [`${KIND_NAMES.get(best.kind)} are your best pick: `, { b: wholePercent(best.you), tone: 'you' }, ' against ', { b: wholePercent(best.odds), tone: 'odds' }, '.']
  if (weak !== undefined && weak !== best && weak.you < weak.odds) parts.push(` ${KIND_NAMES.get(weak.kind)} are the weak spot, ${weak.won} of ${weak.n} landed.`)
  return parts
}

// Under the ladder: which sizes are in profit, and how the size you place
// most is doing when it isn't.
export function sizesSentence(sizes: readonly SizeRow[]): Sentence {
  if (sizes.length === 0) return []
  const profitable = sizes.filter(row => row.profitCents > 0)
  const parts: Sentence = profitable.length === 1
    ? [`${sizeName(profitable[0].legs)} are your only size in profit, `, { b: signedMoney(profitable[0].profitCents), tone: 'good' }, '.']
    : profitable.length > 1
      ? [`${listed(profitable.map(row => sizeName(row.legs)))} are in profit.`]
      : ['No parlay size is in profit yet.']
  const most = [...sizes].sort((a, b) => b.count - a.count || a.legs - b.legs)[0]
  if (!profitable.includes(most)) {
    parts.push(` ${sizeName(most.legs)}, the size you place most, are `, { b: `${most.profitCents < 0 ? 'down' : 'flat at'} ${money(most.profitCents)}`, tone: toneOf(most.profitCents) }, '.')
  }
  return parts
}

// Under the confidence columns: the rating that beats the odds by the most,
// with 6 or more legs, and how your 5s do.
export function confidenceSentence(rows: readonly ConfidenceRow[]): Sentence {
  const enough = rows.filter(row => row.n >= 6)
  if (enough.length < 2) return ['Rate a few more legs to see a pattern.']
  const edge = (row: ConfidenceRow) => row.you - row.odds
  const best = [...enough].sort((a, b) => edge(b) - edge(a))[0]
  const parts: Sentence = [`Your ${best.rating}s beat the odds by the most, `, { b: pointsText(edge(best)), tone: toneOf(edge(best)) }, '.']
  const fives = rows.find(row => row.rating === 5)
  if (fives !== undefined && fives.n >= 6 && fives !== best) {
    parts.push(` Your 5s land ${wholePercent(fives.you)} against `, { b: wholePercent(fives.odds), tone: 'odds' }, ', ')
    parts.push(fives.you < fives.odds
      ? { b: `${Math.abs(Math.round(edge(fives) * 100))} pts short`, tone: 'bad' }
      : { b: pointsText(edge(fives)), tone: 'good' })
    parts.push('.')
  }
  return parts
}

// ----- Analytics -----

// Under parlays against singles: the sizes where parlays are ahead, and the
// ones where the same picks as singles would have done better.
export function versusSentence(versus: Versus): Sentence {
  if (versus.count === 0) return []
  const multi = versus.sizes.filter(row => row.legs > 1)
  if (multi.length === 0) return ['Only singles so far, and a single is the same bet either way.']
  const gap = (row: (typeof multi)[number]) => row.parlayCents - row.singlesCents
  const ahead = multi.filter(row => gap(row) > 0)
  const behind = multi.filter(row => gap(row) < 0)
  const sizes = (rows: typeof multi) => `${listed(rows.map(row => String(row.legs)))} legs`
  const amounts = (rows: typeof multi, tone: Tone): Sentence =>
    rows.flatMap((row, i) => [...(i === 0 ? [] : [i === rows.length - 1 ? ' and ' : ', ']), { b: money(Math.abs(gap(row))), tone }])
  const parts: Sentence = []
  if (ahead.length > 0) parts.push(`Parlays are ahead at ${sizes(ahead)}, by `, ...amounts(ahead, 'good'), '.')
  if (behind.length > 0) parts.push(`${parts.length > 0 ? ' ' : ''}The same picks as singles would have done better at ${sizes(behind)}, by `, ...amounts(behind, 'bad'), '.')
  if (parts.length === 0) parts.push('Parlays and singles are level at every size.')
  if (versus.sizes.some(row => row.legs === 1)) parts.push(' A single is the same bet either way.')
  return parts
}

// Under the club ledger: of the clubs you've backed 3 or more times, the one
// that beats the odds by the most, and the one that falls furthest short.
export function ledgerSentence(rows: readonly LedgerRow[], name: (code: string) => string): Sentence {
  const edge = (row: LedgerRow) => row.backing.you - row.backing.odds
  const enough = rows.filter(row => row.backing.n >= 3)
  if (enough.length === 0) return []
  const best = [...enough].sort((a, b) => edge(b) - edge(a) || a.code.localeCompare(b.code))[0]
  const weak = [...enough].sort((a, b) => edge(a) - edge(b) || a.code.localeCompare(b.code))[0]
  const parts: Sentence = []
  if (edge(best) > 0) {
    parts.push(`${name(best.code)} are your most reliable club: `, { b: `${best.backing.won} of ${best.backing.n}`, tone: 'you' },
      ' landed, where the odds said ', { b: wholePercent(best.backing.odds), tone: 'odds' }, '.')
  }
  if (edge(weak) < 0) parts.push(`${parts.length > 0 ? ' ' : ''}${name(weak.code)} are the weak spot, ${weak.backing.won} of ${weak.backing.n} against ${wholePercent(weak.backing.odds)}.`)
  return parts
}

// The line under each of the Moments numbers.
export function momentNotes(moments: Moments, name: (code: string) => string): { perfect: string; heartbreak: string; draws: string; promos: string } {
  const none = 'None yet.'
  const parlayName = (ref: ParlayRef) => `${periodName(ref.week.period)}'s parlay ${ref.number}`
  const perfect = moments.perfectWeeks
  const latest = perfect[perfect.length - 1]
  const biggest = [...moments.heartbreakers].sort((a, b) => b.wouldCents - a.wouldCents)[0]
  const kills = moments.drawKills
  const killed = kills.reduce((sum, each) => sum + each.n, 0)
  let draws = none
  if (kills.length === 1) draws = killed === 1 ? `On ${name(kills[0].code)}.` : killed === 2 ? `Both on ${name(kills[0].code)}.` : `All ${killed} on ${name(kills[0].code)}.`
  else if (kills.length > 1) draws = kills[0].n === kills[1].n ? `Across ${kills.length} clubs.` : `${name(kills[0].code)} the most, ${kills[0].n} of ${killed}.`
  return {
    perfect: latest === undefined ? none : perfect.length === 1 ? `${periodName(latest.period)}, when every parlay cashed.` : `The latest was ${periodName(latest.period)}.`,
    heartbreak: biggest === undefined ? none
      : moments.heartbreakers.length === 1 ? `${parlayName(biggest)} would have paid ${money(biggest.wouldCents)}.`
        : `The biggest, ${parlayName(biggest)}, would have paid ${money(biggest.wouldCents)}.`,
    draws,
    promos: moments.promos.length === 0 ? none : `From ${count(moments.promos.length, 'parlay', 'parlays')}.`,
  }
}
