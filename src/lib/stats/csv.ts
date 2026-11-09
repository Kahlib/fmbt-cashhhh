// History's CSV export (step 10 plan, 10.4). Our own code writes it, so it
// needs no package. The file is built in this tab and saved straight to the
// computer: nothing is uploaded, and History warns that it isn't encrypted.
//
// The formula guard: a spreadsheet treats a cell that starts with = + - or @,
// or with a tab or a carriage return, as a formula, so a name such as
// "=HYPERLINK(...)" could do something when the file is opened. Every text
// cell that starts with one gets an apostrophe in front, so it opens as plain
// text (OWASP, "CSV Injection"). Numbers are worked out by this code from
// checked records, so they're written as they are: -175 is a number, not a
// formula.
import { COMPETITION_NAMES, periodName, seasonLabel } from '../periods.ts'
import type { ParlayRow, PickRow } from './history.ts'
import { KIND_NAME, PARLAY_RESULT_WORDS, PICK_RESULT_WORDS } from './words.ts'

export type Cell = string | number | null

const FORMULA_START = /^[=+\-@\t\r]/

// One cell as CSV: the guard, then quotes round anything with a comma, a
// quote or a line break in it, with its quotes doubled (RFC 4180).
export function csvCell(cell: Cell): string {
  if (cell === null) return ''
  if (typeof cell === 'number') return Number.isFinite(cell) ? String(cell) : ''
  const text = FORMULA_START.test(cell) ? `'${cell}` : cell
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

// The whole file, with Windows line endings and a byte-order mark first, so
// Excel reads names like "Atlético" correctly.
export function toCsv(header: readonly string[], rows: readonly (readonly Cell[])[]): string {
  return `\uFEFF${[header, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n')}\r\n`
}

// "fmbt-picks-2026-27.csv"
export const csvName = (view: 'parlays' | 'picks', season: number) => `fmbt-${view}-${seasonLabel(season).replace('/', '-')}.csv`

const dollars = (cents: number | null) => (cents === null ? null : cents / 100)
const pad = (n: number) => String(n).padStart(2, '0')

// A kick-off in this computer's time: "2026-11-22 11:30".
function localTime(iso: string): string {
  const time = new Date(iso)
  return `${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())} ${pad(time.getHours())}:${pad(time.getMinutes())}`
}

export function parlaysCsv(rows: readonly ParlayRow[], name: (code: string) => string): string {
  return toCsv(
    ['Week', 'Competition', 'Parlay', 'Legs', 'Picks', 'Odds', 'Stake', 'Boost (%)', 'Result', 'Returned', 'Profit', 'To return'],
    rows.map(row => {
      const view = row.view
      const parlay = view.parlay
      const settled = row.result !== 'open'
      return [
        periodName(row.week.period),
        COMPETITION_NAMES[row.week.competition],
        `Parlay ${view.number}`,
        parlay.legs.length,
        parlay.legs.map(leg => (leg.pick === 'D' ? `Draw (${name(leg.home)} v ${name(leg.away)})` : name(leg.pick === 'H' ? leg.home : leg.away))).join(' + '),
        view.odds,
        dollars(parlay.stakeCents),
        parlay.boostBps / 100,
        PARLAY_RESULT_WORDS[row.result],
        settled ? dollars(view.payoutCents ?? 0) : null,
        settled ? dollars(view.profitCents) : null,
        settled ? null : dollars(view.potentialCents),
      ]
    }),
  )
}

export function picksCsv(rows: readonly PickRow[], name: (code: string) => string): string {
  return toCsv(
    ['Week', 'Competition', 'Parlay', 'Kick-off', 'Game', 'Pick', 'Odds', 'Confidence', 'Type', 'Score', 'Result'],
    rows.map(row => {
      const leg = row.leg
      const score = leg.settlement?.score90 ?? (row.state.kind === 'final' ? row.state.score : null)
      return [
        periodName(row.week.period),
        COMPETITION_NAMES[row.week.competition],
        `Parlay ${row.number}`,
        localTime(leg.kickoff),
        `${name(leg.home)} v ${name(leg.away)}`,
        leg.pick === 'D' ? 'Draw' : name(leg.pick === 'H' ? leg.home : leg.away),
        leg.odds,
        leg.confidence,
        KIND_NAME.get(row.kind) ?? '',
        score === null ? null : `${score[0]}–${score[1]}`,
        row.state.kind === 'won' && row.state.how === 'promo' ? 'Paid by a promo' : PICK_RESULT_WORDS[row.result],
      ]
    }),
  )
}
