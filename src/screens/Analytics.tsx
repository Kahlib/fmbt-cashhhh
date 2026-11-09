// Analytics (step 10 plan, 10.4, and the canvas "FMBT History and Analytics
// screens"): the numbers the Dashboard doesn't show. Parlays against
// singles, the season's moments, and every club's ledger, backing and
// fading. Everything comes from src/lib/stats/, worked out in the browser
// from what LiveData already holds, so this page fetches nothing.
import { Fragment, useMemo, useState } from 'react'
import { useAdmin } from '../components/admin.ts'
import { Strip } from '../components/charts/Charts.tsx'
import { useWidth } from '../components/charts/size.ts'
import { Hint, SortHeading } from '../components/Controls.tsx'
import { PageHead } from '../components/Layout.tsx'
import { TeamBadge } from '../components/Parlay.tsx'
import type { Competition } from '../lib/bets/week-record.ts'
import { visibleWeeks } from '../lib/bets/weeks.ts'
import { count, money, signedMoney, wholePercent } from '../lib/format.ts'
import type { LiveData, LiveSnapshot } from '../lib/live.ts'
import { nameOf, teamNames } from '../lib/names.ts'
import { nextSort, sortBy, type SortState } from '../lib/stats/history.ts'
import { analytics, seasonStats, type LedgerRow, type LedgerSide, type VersusRow } from '../lib/stats/season.ts'
import { ledgerSentence, momentNotes, versusSentence } from '../lib/stats/words.ts'
import { Say } from './Dashboard.tsx'

type Filter = Competition | 'all'
type LedgerKey = 'club' | 'backN' | 'backYou' | 'backOdds' | 'fadeN' | 'fadeYou' | 'fadeOdds'
const LEDGER_FIRST_DOWN = new Set<LedgerKey>(['backN', 'backYou', 'backOdds', 'fadeN', 'fadeYou', 'fadeOdds'])

const NO_SIDE: LedgerSide = { n: 0, won: 0, you: 0, odds: 0, drawn: 0, lost: 0 }
const tone = (cents: number) => (cents > 0 ? 'good-t' : cents < 0 ? 'bad-t' : '')

export function Analytics({ live, snapshot }: { live: LiveData; snapshot: LiveSnapshot }) {
  const admin = useAdmin()
  const [filter, setFilter] = useState<Filter>('all')
  const [sort, setSort] = useState<SortState<LedgerKey>>({ key: 'club', down: false })
  const names = useMemo(() => teamNames(snapshot.teams), [snapshot.teams])
  const name = (code: string) => nameOf(names, code)

  const seasonWeeks = useMemo(
    () => visibleWeeks(snapshot.weeks).filter(each => each.week.season === live.season).map(each => ({ week: each.week, record: each.record })),
    [snapshot.weeks, live.season],
  )
  const stats = useMemo(() => seasonStats(seasonWeeks, filter), [seasonWeeks, filter])
  const numbers = useMemo(() => analytics(seasonWeeks, filter), [seasonWeeks, filter])
  const { versus, moments, ledger } = numbers
  const notes = momentNotes(moments, name)

  // The ledger's groups. Every Premier League club is listed, greyed until
  // you have a settled pick on it, and a Champions League club once you've
  // backed or faded it. The Champions League view lists every club you've
  // picked in it, Premier League clubs included.
  const groups = useMemo(() => {
    const premier = new Set<string>()
    for (const fixture of snapshot.fixtures.values()) if (fixture.competition === 'PL') premier.add(fixture.home).add(fixture.away)
    if (premier.size === 0) for (const row of ledger) if (row.competitions.includes('PL')) premier.add(row.code)
    const byCode = new Map(ledger.map(row => [row.code, row]))
    const value = (row: LedgerRow): number | string | null => {
      switch (sort.key) {
        case 'club': return nameOf(names, row.code)
        case 'backN': return row.backing.n === 0 ? null : row.backing.n
        case 'backYou': return row.backing.n === 0 ? null : row.backing.you
        case 'backOdds': return row.backing.n === 0 ? null : row.backing.odds
        case 'fadeN': return row.fading.n === 0 ? null : row.fading.n
        case 'fadeYou': return row.fading.n === 0 ? null : row.fading.you
        case 'fadeOdds': return row.fading.n === 0 ? null : row.fading.odds
      }
    }
    const sorted = (rows: LedgerRow[]) => sortBy(rows, value, sort.down, (a, b) => nameOf(names, a.code).localeCompare(nameOf(names, b.code)))
    if (filter === 'UCL') return [{ title: 'Champions League', rows: sorted(ledger) }]
    const list = [{ title: 'Premier League', rows: sorted([...premier].map(code => byCode.get(code) ?? { code, competitions: [], backing: NO_SIDE, fading: NO_SIDE })) }]
    if (filter === 'all') list.push({ title: 'Champions League', rows: sorted(ledger.filter(row => !premier.has(row.code))) })
    return list.filter(group => group.rows.length > 0)
  }, [snapshot.fixtures, ledger, filter, sort, names])

  const status = stats.parlays === 0 && stats.legs.n === 0 ? 'Nothing has settled yet.'
    : `From the ${count(stats.parlays, 'parlay', 'parlays')} and ${count(stats.legs.n, 'pick', 'picks')} that have settled.`
  const right = (
    <div className="segmented" role="group" aria-label="Competition">
      {([['all', 'All'], ['PL', 'Premier League'], ['UCL', 'Champions League']] as const).map(([value, label]) => (
        <button key={value} type="button" className={filter === value ? 'on' : undefined} aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}</button>
      ))}
    </div>
  )

  if (stats.legs.n === 0) {
    return (
      <>
        <PageHead title="Analytics" admin={admin} status={status} right={right} />
        <section className="panel" aria-label="Analytics"><Hint>This page fills in as your picks settle.</Hint></section>
      </>
    )
  }

  const gap = versus.parlayCents - versus.singlesCents
  const killed = moments.drawKills.reduce((sum, each) => sum + each.n, 0)
  const promoCents = moments.promos.reduce((sum, each) => sum + each.payoutCents, 0)
  const heading = (label: string, column: LedgerKey, right = false, className?: string) =>
    <SortHeading label={label} column={column} sort={sort} onSort={key => setSort(nextSort(sort, key, LEDGER_FIRST_DOWN))} right={right} className={className} />

  return (
    <>
      <PageHead title="Analytics" admin={admin} status={status} right={right} />
      <div className="grid">
        <section className="panel span-7" aria-labelledby="versus-title">
          <div>
            <div className="ph-row"><h2 className="ptitle" id="versus-title">Parlays against singles</h2><span className="count">Same picks, same money</span></div>
            <p className="sub">Your parlays whose legs have all settled, against betting each of their picks on its own with an equal share of the stake.</p>
          </div>
          {versus.count === 0 ? <Hint>Nothing to compare until every leg of a parlay has settled.</Hint> : (
            <>
              <div className="stats">
                <div><div className="stat-label">Your parlays</div><div className={`stat-value ${tone(versus.parlayCents)}`}>{signedMoney(versus.parlayCents)}</div><div className="stat-note">{count(versus.count, 'parlay', 'parlays')}</div></div>
                <div><div className="stat-label">As singles</div><div className={`stat-value ${tone(versus.singlesCents)}`}>{signedMoney(versus.singlesCents)}</div><div className="stat-note">Their {count(versus.legs, 'pick', 'picks')}</div></div>
                <div><div className="stat-label">{gap > 0 ? 'Parlays ahead by' : gap < 0 ? 'Singles ahead by' : 'Difference'}</div><div className="stat-value">{money(Math.abs(gap))}</div><div className="stat-note">This season</div></div>
              </div>
              <VersusBars sizes={versus.sizes} />
              <div className="legend"><span><i className="sw-you tall" />Your parlays</span><span><i className="sw-alt" />The same picks as singles</span></div>
              <Say sentence={versusSentence(versus)} />
              <p className="hint">How it works: picks at −120, +110 and +220 as a $30 parlay pay $369.60 if all three land. As three $10 singles they'd pay $71.33. If the +110 loses, the parlay pays nothing and the singles still pay $50.33.</p>
            </>
          )}
        </section>

        <section className="panel span-5" aria-labelledby="moments-title">
          <h2 className="ptitle" id="moments-title">Moments</h2>
          <div className="moments">
            <Moment label="Perfect weeks" value={String(moments.perfectWeeks.length)} tone={moments.perfectWeeks.length > 0 ? 'good-t' : ''} note={notes.perfect} />
            <Moment label="Heartbreakers" value={String(moments.heartbreakers.length)} tone="" note={notes.heartbreak} />
            <Moment label="Draw kills" value={String(killed)} tone={killed > 0 ? 'warn-t' : ''} note={notes.draws} />
            <Moment label="Promos collected" value={money(promoCents)} tone={promoCents > 0 ? 'good-t' : ''} note={notes.promos} />
          </div>
          <p className="hint">A perfect week is one where every parlay cashed. A heartbreaker lost on one leg, with every other leg won. A draw kill is a leg lost to a draw. Promos collected adds up the payouts of parlays that only cashed because of a promo.</p>
        </section>

        <section className="panel span-12" aria-labelledby="ledger-title">
          <div>
            <div className="ph-row"><h2 className="ptitle" id="ledger-title">Club ledger</h2><span className="count">Every club, backing and fading</span></div>
            <p className="sub">Backing a club means picking it to win, and fading it means picking the team it plays. Draw picks count for neither. Hit rates are for settled picks, against what the odds gave those picks.</p>
          </div>
          <div className="table-box">
            <table className="hist ledger">
              <thead>
                <tr><td className="blank" /><th scope="colgroup" colSpan={3} className="side-h">Backing</th><th scope="colgroup" colSpan={3} className="side-h split">Fading</th></tr>
                <tr>
                  {heading('Club', 'club')}{heading('Record', 'backN')}{heading('Hit rate', 'backYou', true)}{heading('Odds said', 'backOdds', true)}
                  {heading('Record', 'fadeN', false, 'split')}{heading('Hit rate', 'fadeYou', true)}{heading('Odds said', 'fadeOdds', true)}
                </tr>
              </thead>
              <tbody>
                {groups.map(group => (
                  <Fragment key={group.title}>
                    <tr className="club-group"><th scope="rowgroup" colSpan={7}>{group.title}</th></tr>
                    {group.rows.map(row => {
                      const none = row.backing.n === 0 && row.fading.n === 0
                      return (
                        <tr key={row.code} className={none ? 'none' : undefined}>
                          <td><span className="club"><TeamBadge code={row.code} />{name(row.code)}{filter === 'all' && row.competitions.length > 1 && <small>Both competitions</small>}</span></td>
                          <Side side={row.backing} />
                          <Side side={row.fading} split />
                        </tr>
                      )
                    })}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
          <Say sentence={ledgerSentence(ledger, name)} />
        </section>
      </div>
    </>
  )
}

function Moment({ label, value, tone, note }: { label: string; value: string; tone: string; note: string }) {
  return (
    <div className="moment">
      <div className="stat-label">{label}</div>
      <div className={`stat-value ${tone}`}>{value}</div>
      <div className="stat-note">{note}</div>
    </div>
  )
}

// One side of a club's row: its record, hit rate and what the odds said.
function Side({ side, split = false }: { side: LedgerSide; split?: boolean }) {
  if (side.n === 0) return <td className={split ? 'none-side split' : 'none-side'} colSpan={3}>None settled</td>
  return (
    <>
      <td className={split ? 'split' : undefined}><Strip won={side.won} drawn={side.drawn} lost={side.lost} /></td>
      <td className="r you-t">{wholePercent(side.you)}</td>
      <td className="r odds-t">{wholePercent(side.odds)}</td>
    </>
  )
}

// Each size's parlays and their singles as two bars, on one scale for all
// the sizes, with a line at $0 when anything is down. Sizes are attributes.
function VersusBars({ sizes }: { sizes: VersusRow[] }) {
  const values = sizes.flatMap(row => [row.parlayCents, row.singlesCents])
  const low = Math.min(0, ...values)
  const high = Math.max(0, ...values)
  return (
    <div className="pvs">
      {sizes.map(row => (
        <div key={row.legs} className="pvs-row">
          <div className="match"><b>{row.legs === 1 ? 'Singles' : `${row.legs}-leg parlays`}</b><span>{row.count} placed</span></div>
          <Bars parlay={row.parlayCents} singles={row.singlesCents} low={low} high={high} />
          <div className="pvs-vals"><span className="you-t">{signedMoney(row.parlayCents)}</span><span className="muted">{signedMoney(row.singlesCents)}</span></div>
        </div>
      ))}
    </div>
  )
}

function Bars({ parlay, singles, low, high }: { parlay: number; singles: number; low: number; high: number }) {
  const [box, width] = useWidth<HTMLDivElement>(280)
  const x = (cents: number) => ((cents - low) / (high - low || 1)) * width
  const zero = x(0)
  const bar = (cents: number, y: number, className: string) => (
    <rect className={className} x={Math.min(zero, x(cents))} y={y} width={Math.abs(x(cents) - zero)} height={10} rx={2} />
  )
  return (
    <div ref={box} className="pvs-bars">
      <svg width={width} height={26} aria-hidden="true">
        {bar(parlay, 0, 'you')}
        {bar(singles, 15, 'alt')}
        {low < 0 && <line className="gridline" x1={zero} x2={zero} y1={0} y2={26} />}
      </svg>
    </div>
  )
}
