// History (step 10 plan, 10.4, and the canvas "FMBT History and Analytics
// screens"): every parlay or every pick of the season, with filters, sorting
// on every heading, and a CSV export that first warns the file isn't
// encrypted. Everything comes from src/lib/stats/history.ts, worked out in
// the browser from what LiveData already holds, so this page fetches nothing.
import { useMemo, useState } from 'react'
import { useAdmin } from '../components/admin.ts'
import { Button, Hint, LinkButton, SortHeading } from '../components/Controls.tsx'
import { downloadText } from '../components/files.ts'
import { DownloadIcon, FileIcon, StatusIcon } from '../components/Icons.tsx'
import { PageHead } from '../components/Layout.tsx'
import { Dialog } from '../components/Overlays.tsx'
import { Confidence, LegResult, ParlayStatus, PickLabel, ScoreCell, TeamBadge } from '../components/Parlay.tsx'
import type { Competition } from '../lib/bets/week-record.ts'
import { visibleWeeks } from '../lib/bets/weeks.ts'
import type { Fixture } from '../lib/fixtures.ts'
import { count, dayRange, money, oddsText, percentText, signedMoney } from '../lib/format.ts'
import type { LiveData, LiveSnapshot } from '../lib/live.ts'
import { nameOf, teamNames, type Names } from '../lib/names.ts'
import { COMPETITION_NAMES, periodName } from '../lib/periods.ts'
import { csvName, parlaysCsv, picksCsv } from '../lib/stats/csv.ts'
import {
  distinctNumbers, filterParlays, filterPicks, historyRows, nextSort, NO_PARLAY_FILTERS, NO_PICK_FILTERS, PARLAYS_FIRST_DOWN, PICKS_FIRST_DOWN,
  sortParlays, sortPicks, weekChoices, weekValue, type ParlayFilters, type ParlayKey, type ParlayResult, type ParlayRow, type PickFilters,
  type PickKey, type PickResult, type PickRow, type SortState,
} from '../lib/stats/history.ts'
import { KINDS } from '../lib/stats/season.ts'
import { KIND_NAME, listed, PARLAY_RESULT_WORDS, PICK_RESULT_WORDS } from '../lib/stats/words.ts'

type Filter = Competition | 'all'
type View = 'parlays' | 'picks'
type Choice = { value: string; label: string }

const PARLAY_RESULTS: ParlayResult[] = ['open', 'cashed', 'lost', 'void']
const PICK_RESULTS: PickResult[] = ['open', 'won', 'drawn', 'lost', 'dropped']

// A filter above the table: a labelled <select> whose first choice is "any".
function FilterSelect({ label, value, any, choices, onChange }: { label: string; value: string; any: string; choices: Choice[]; onChange: (value: string) => void }) {
  return (
    <label className={value === '' ? 'filter' : 'filter on'}>
      {label}
      <span className="fsel">
        <select value={value} onChange={event => onChange(event.target.value)}>
          <option value="">{any}</option>
          {choices.map(choice => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
        </select>
        <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M3 4.5 6 7.5 9 4.5" /></svg>
      </span>
    </label>
  )
}

// Only what's in the rows can be chosen: their clubs by name, and their weeks
// newest first.
const clubChoices = (codes: Iterable<string>, names: Names): Choice[] =>
  [...new Set(codes)].map(code => ({ value: code, label: nameOf(names, code) })).sort((a, b) => a.label.localeCompare(b.label))
const weekChoicesFor = (rows: readonly { week: ParlayRow['week']; order: number }[], filter: Filter): Choice[] =>
  weekChoices(rows).map(week => ({ value: weekValue(week), label: filter === 'all' ? `${periodName(week.period)}, ${COMPETITION_NAMES[week.competition]}` : periodName(week.period) }))

export function History({ live, snapshot, onToast }: { live: LiveData; snapshot: LiveSnapshot; onToast: (message: string) => void }) {
  const admin = useAdmin()
  const [filter, setFilter] = useState<Filter>('all')
  const [view, setView] = useState<View>('parlays')
  const [parlayFilters, setParlayFilters] = useState<ParlayFilters>(NO_PARLAY_FILTERS)
  const [pickFilters, setPickFilters] = useState<PickFilters>(NO_PICK_FILTERS)
  const [parlaySort, setParlaySort] = useState<SortState<ParlayKey>>({ key: 'week', down: true })
  const [pickSort, setPickSort] = useState<SortState<PickKey>>({ key: 'week', down: true })
  const [exporting, setExporting] = useState(false)
  const names = useMemo(() => teamNames(snapshot.teams), [snapshot.teams])
  const name = (code: string) => nameOf(names, code)

  const seasonWeeks = useMemo(
    () => visibleWeeks(snapshot.weeks).filter(each => each.week.season === live.season).map(each => ({ week: each.week, record: each.record })),
    [snapshot.weeks, live.season],
  )
  const rows = useMemo(() => historyRows(seasonWeeks, snapshot.fixtures, filter), [seasonWeeks, snapshot.fixtures, filter])
  const parlays = useMemo(() => sortParlays(filterParlays(rows.parlays, parlayFilters), parlaySort), [rows.parlays, parlayFilters, parlaySort])
  const picks = useMemo(() => sortPicks(filterPicks(rows.picks, pickFilters), pickSort, code => nameOf(names, code)), [rows.picks, pickFilters, pickSort, names])

  // Each week's days, from all its games, as My parlays shows them.
  const weekDays = useMemo(() => {
    const kickoffs = new Map<string, string[]>()
    for (const fixture of snapshot.fixtures.values()) {
      const key = `${fixture.competition} ${fixture.period}`
      const list = kickoffs.get(key) ?? []
      list.push(fixture.kickoff)
      kickoffs.set(key, list)
    }
    const days = new Map<string, string>()
    for (const [key, list] of kickoffs) {
      list.sort()
      days.set(key, dayRange(list[0], list[list.length - 1]))
    }
    return days
  }, [snapshot.fixtures])

  const where = filter === 'all' ? 'this season' : `in the ${COMPETITION_NAMES[filter]} this season`
  const open = rows.parlays.filter(row => row.result === 'open').length
  const status = rows.parlays.length === 0 ? `No parlays ${where} yet.`
    : `${count(rows.parlays.length, 'parlay', 'parlays')} and ${count(rows.picks.length, 'pick', 'picks')} ${where}.${open === 0 ? '' : open === 1 ? ' 1 parlay is still to settle.' : ` ${open} parlays are still to settle.`}`

  const noun = view === 'parlays' ? ['parlay', 'parlays'] as const : ['pick', 'picks'] as const
  const all = view === 'parlays' ? rows.parlays.length : rows.picks.length
  const shown = view === 'parlays' ? parlays.length : picks.length
  // Any filter set, even one that every row matches, can be cleared.
  const filtered = Object.values(view === 'parlays' ? parlayFilters : pickFilters).some(value => value !== '')
  const fileName = csvName(view, live.season)

  // A filter chosen for one competition may not exist in another.
  function chooseCompetition(next: Filter) {
    setFilter(next)
    setParlayFilters(NO_PARLAY_FILTERS)
    setPickFilters(NO_PICK_FILTERS)
  }

  function download() {
    const text = view === 'parlays' ? parlaysCsv(parlays, name) : picksCsv(picks, name)
    downloadText(fileName, text, 'text/csv;charset=utf-8')
    setExporting(false)
    onToast(`Saved ${fileName}`)
  }

  const right = (
    <>
      <div className="segmented" role="group" aria-label="Competition">
        {([['all', 'All'], ['PL', 'Premier League'], ['UCL', 'Champions League']] as const).map(([value, label]) => (
          <button key={value} type="button" className={filter === value ? 'on' : undefined} aria-pressed={filter === value} onClick={() => chooseCompetition(value)}>{label}</button>
        ))}
      </div>
      <Button disabled={shown === 0} onClick={() => setExporting(true)}><DownloadIcon />Export CSV</Button>
    </>
  )

  return (
    <>
      <PageHead title="History" admin={admin} status={status} right={right} />
      <section className="panel" aria-label={view === 'parlays' ? 'Every parlay' : 'Every pick'}>
        {rows.parlays.length === 0 ? <Hint>The parlays you log show up here, with every pick in them.</Hint> : (
          <>
            <div className="hist-bar">
              <div className="segmented" role="group" aria-label="Show">
                {([['parlays', 'Parlays', rows.parlays.length], ['picks', 'Picks', rows.picks.length]] as const).map(([value, label, n]) => (
                  <button key={value} type="button" className={view === value ? 'on' : undefined} aria-pressed={view === value} onClick={() => setView(value)}>
                    {label}<span className="n">{n}</span>
                  </button>
                ))}
              </div>
              {view === 'parlays' ? (
                <div className="filters">
                  <FilterSelect label="Club" any="Any club" value={parlayFilters.club} choices={clubChoices(rows.parlays.flatMap(row => row.teams), names)}
                    onChange={club => setParlayFilters({ ...parlayFilters, club })} />
                  <FilterSelect label="Week" any="Any week" value={parlayFilters.week} choices={weekChoicesFor(rows.parlays, filter)}
                    onChange={week => setParlayFilters({ ...parlayFilters, week })} />
                  <FilterSelect label="Size" any="Any size" value={parlayFilters.size}
                    choices={distinctNumbers(rows.parlays.map(row => row.view.parlay.legs.length)).map(n => ({ value: String(n), label: n === 1 ? 'Single' : `${n} legs` }))}
                    onChange={size => setParlayFilters({ ...parlayFilters, size })} />
                  <FilterSelect label="Result" any="Any result" value={parlayFilters.result}
                    choices={PARLAY_RESULTS.filter(result => rows.parlays.some(row => row.result === result)).map(result => ({ value: result, label: PARLAY_RESULT_WORDS[result] }))}
                    onChange={result => setParlayFilters({ ...parlayFilters, result })} />
                  <FilterSelect label="Stake" any="Any stake" value={parlayFilters.stake}
                    choices={distinctNumbers(rows.parlays.map(row => row.view.parlay.stakeCents)).map(cents => ({ value: String(cents), label: money(cents) }))}
                    onChange={stake => setParlayFilters({ ...parlayFilters, stake })} />
                </div>
              ) : (
                <div className="filters">
                  <FilterSelect label="Club" any="Any club" value={pickFilters.club} choices={clubChoices(rows.picks.flatMap(row => [row.leg.home, row.leg.away]), names)}
                    onChange={club => setPickFilters({ ...pickFilters, club })} />
                  <FilterSelect label="Week" any="Any week" value={pickFilters.week} choices={weekChoicesFor(rows.picks, filter)}
                    onChange={week => setPickFilters({ ...pickFilters, week })} />
                  <FilterSelect label="Type" any="Any type" value={pickFilters.kind}
                    choices={KINDS.filter(kind => rows.picks.some(row => row.kind === kind)).map(kind => ({ value: kind, label: KIND_NAME.get(kind) ?? kind }))}
                    onChange={kind => setPickFilters({ ...pickFilters, kind })} />
                  <FilterSelect label="Confidence" any="Any rating" value={pickFilters.confidence}
                    choices={distinctNumbers(rows.picks.map(row => row.leg.confidence)).map(n => ({ value: String(n), label: `${n} of 5` }))}
                    onChange={confidence => setPickFilters({ ...pickFilters, confidence })} />
                  <FilterSelect label="Result" any="Any result" value={pickFilters.result}
                    choices={PICK_RESULTS.filter(result => rows.picks.some(row => row.result === result)).map(result => ({ value: result, label: PICK_RESULT_WORDS[result] }))}
                    onChange={result => setPickFilters({ ...pickFilters, result })} />
                </div>
              )}
              <div className="shown">
                <span>{filtered ? `Showing ${shown} of ${count(all, noun[0], noun[1])}` : all === 1 ? `Showing 1 ${noun[0]}` : `Showing all ${count(all, noun[0], noun[1])}`}</span>
                {filtered && <LinkButton onClick={() => (view === 'parlays' ? setParlayFilters(NO_PARLAY_FILTERS) : setPickFilters(NO_PICK_FILTERS))}>Clear filters</LinkButton>}
              </div>
            </div>

            {shown === 0 ? <Hint>Nothing matches these filters.</Hint> : view === 'parlays'
              ? <ParlaysTable rows={parlays} sort={parlaySort} onSort={key => setParlaySort(nextSort(parlaySort, key, PARLAYS_FIRST_DOWN))} weekDays={weekDays} name={name} />
              : <PicksTable rows={picks} sort={pickSort} onSort={key => setPickSort(nextSort(pickSort, key, PICKS_FIRST_DOWN))} fixtures={snapshot.fixtures} names={names} />}
            <p className="hint">
              Weeks go in the order they were played. Select a heading to sort by it, and again to reverse it.
              {view === 'parlays' ? ' The totals leave out parlays still to settle and void ones.' : ' Type uses the +150 line: odds of +150 or shorter are a favourite.'}
            </p>
          </>
        )}
      </section>

      {exporting && (
        <Dialog title="Export to CSV" wide onClose={() => setExporting(false)}
          sub={`This saves the ${count(shown, noun[0], noun[1])} you're looking at, with any filters you've set, as a file a spreadsheet can open.`}>
          <div className="file"><FileIcon /><div className="file-text"><span className="file-name">{fileName}</span><span className="file-meta">{count(shown, 'row', 'rows')}</span></div></div>
          <div className="note icon">
            <StatusIcon kind="warn" />
            <p><b>This file isn't encrypted.</b> Anyone who opens it can read your {view === 'parlays' ? 'parlays, stakes and results' : 'picks and results'}. Keep it somewhere private, and delete it when you've finished with it.</p>
          </div>
          <Hint>Text that a spreadsheet could run as a formula gets an apostrophe in front, so it opens as plain text.</Hint>
          <div className="actions">
            <Button onClick={() => setExporting(false)}>Cancel</Button>
            <Button kind="primary" onClick={download}><DownloadIcon />Download CSV</Button>
          </div>
        </Dialog>
      )}
    </>
  )
}

function ParlaysTable({ rows, sort, onSort, weekDays, name }: {
  rows: ParlayRow[]
  sort: SortState<ParlayKey>
  onSort: (key: ParlayKey) => void
  weekDays: ReadonlyMap<string, string>
  name: (code: string) => string
}) {
  const heading = (label: string, column: ParlayKey, right = false) => <SortHeading label={label} column={column} sort={sort} onSort={onSort} right={right} />
  // The totals: settled parlays that aren't void, as the Dashboard counts them.
  const settled = rows.filter(row => row.result === 'cashed' || row.result === 'lost')
  const sum = (cents: (row: ParlayRow) => number) => settled.reduce((total, row) => total + cents(row), 0)
  const net = sum(row => row.view.profitCents ?? 0)
  return (
    <div className="table-box">
      <table className="hist">
        <thead>
          <tr>
            {heading('Week', 'week')}{heading('Parlay', 'parlay')}{heading('Picks', 'picks')}{heading('Odds', 'odds', true)}{heading('Stake', 'stake', true)}
            {heading('Boost', 'boost', true)}{heading('Result', 'result')}{heading('Returned', 'returned', true)}{heading('Profit', 'profit', true)}
          </tr>
        </thead>
        <tbody>
          {rows.map(row => {
            const { view } = row
            const legs = view.parlay.legs
            const note = row.result === 'open' && row.legsWon > 0 ? `${row.legsWon} of ${legs.length} legs won`
              : row.promo ? 'Paid by a promo'
                : row.result === 'lost' && view.onlyLossWasADraw ? 'Lost on one leg, to a draw' : null
            const picks = legs.map(leg => (leg.pick === 'D' ? 'Draw' : name(leg.pick === 'H' ? leg.home : leg.away)))
            return (
              <tr key={row.key}>
                <td><div className="match"><b>{periodName(row.week.period)}</b><span>{weekDays.get(weekValue(row.week)) ?? COMPETITION_NAMES[row.week.competition]}</span></div></td>
                <td><div className="match"><b>Parlay {view.number}</b><span>{legs.length === 1 ? 'Single' : `${legs.length} legs`}</span></div></td>
                <td>
                  <span className="badges" role="img" aria-label={listed(picks)}>
                    {legs.map(leg => (leg.pick === 'D' ? <span key={leg.id} className="pick-draw">Draw</span> : <TeamBadge key={leg.id} code={leg.pick === 'H' ? leg.home : leg.away} />))}
                  </span>
                </td>
                <td className="r">{view.odds === null ? '—' : oddsText(view.odds)}</td>
                <td className="r">{money(view.parlay.stakeCents)}</td>
                <td className={view.parlay.boostBps > 0 ? 'r' : 'r muted'}>{view.parlay.boostBps > 0 ? percentText(view.parlay.boostBps) : 'None'}</td>
                <td><span className="state"><ParlayStatus view={view} />{note !== null && <span className="state-note">{note}</span>}</span></td>
                {row.result === 'open' ? (
                  <>
                    <td className="r muted">To return {money(view.potentialCents ?? 0)}</td>
                    <td className="r muted"><span aria-hidden="true">—</span><span className="sr-only">Not settled yet</span></td>
                  </>
                ) : (
                  <>
                    <td className="r">{money(view.payoutCents ?? 0)}</td>
                    <td className={`r strong ${(view.profitCents ?? 0) > 0 ? 'good-t' : (view.profitCents ?? 0) < 0 ? 'bad-t' : ''}`}>{signedMoney(view.profitCents ?? 0)}</td>
                  </>
                )}
              </tr>
            )
          })}
        </tbody>
        {settled.length > 0 && (
          <tfoot>
            <tr>
              <td colSpan={4}>{settled.length} settled</td>
              <td className="r">{money(sum(row => row.view.parlay.stakeCents))}</td>
              <td /><td />
              <td className="r">{money(sum(row => row.view.payoutCents ?? 0))}</td>
              <td className={net > 0 ? 'r good-t' : net < 0 ? 'r bad-t' : 'r'}>{signedMoney(net)}</td>
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  )
}

function PicksTable({ rows, sort, onSort, fixtures, names }: {
  rows: PickRow[]
  sort: SortState<PickKey>
  onSort: (key: PickKey) => void
  fixtures: ReadonlyMap<number, Fixture>
  names: Names
}) {
  const heading = (label: string, column: PickKey, right = false) => <SortHeading label={label} column={column} sort={sort} onSort={onSort} right={right} />
  return (
    <div className="table-box">
      <table className="hist">
        <thead>
          <tr>
            {heading('Week', 'week')}{heading('Game', 'game')}{heading('Your pick', 'pick')}{heading('Odds', 'odds', true)}
            {heading('Confidence', 'confidence')}{heading('Type', 'kind')}{heading('Score', 'score')}{heading('Result', 'result')}
          </tr>
        </thead>
        <tbody>
          {rows.map(row => {
            const leg = row.leg
            return (
              <tr key={row.key}>
                <td><div className="match"><b>{periodName(row.week.period)}</b><span>Parlay {row.number}</span></div></td>
                <td>{nameOf(names, leg.home)} v {nameOf(names, leg.away)}</td>
                <td><PickLabel pick={leg.pick} home={leg.home} away={leg.away} names={names} /></td>
                <td className="r">{oddsText(leg.odds)}</td>
                <td><Confidence rating={leg.confidence} /></td>
                <td className="kind">{KIND_NAME.get(row.kind)}</td>
                <td><ScoreCell leg={leg} fixture={fixtures.get(leg.fixtureId)} state={row.state} /></td>
                <td><LegResult state={row.state} reason={leg.settlement?.reason ?? null} /></td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
