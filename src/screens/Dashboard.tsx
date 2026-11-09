// The Dashboard, as mockup v7 draws it (step 10 plan, 10.3), with your
// real numbers. Everything on it comes from src/lib/stats/, worked out in
// the browser from the weeks and fixtures LiveData already holds, so this
// page fetches nothing of its own except your backup's status.
import { useEffect, useMemo, useState } from 'react'
import { useAdmin } from '../components/admin.ts'
import { Bankroll, ChartFilters, ConfidenceColumns, Donut, Ladder, MoneyBars, Progress, Radar, Ring, Stack, Strip } from '../components/charts/Charts.tsx'
import { useWidth } from '../components/charts/size.ts'
import { Button, Hint } from '../components/Controls.tsx'
import { PageHead } from '../components/Layout.tsx'
import { LiveMinute, TeamBadge } from '../components/Parlay.tsx'
import { Reminder } from '../components/Reminder.tsx'
import type { AccountApi } from '../lib/account/api.ts'
import { backupStatus, type BackupStatus } from '../lib/account/backup.ts'
import type { Unlocked } from '../lib/account/wraps.ts'
import { legState, weekSentence, weekSummary } from '../lib/bets/view.ts'
import type { Competition, Leg } from '../lib/bets/week-record.ts'
import { visibleWeeks } from '../lib/bets/weeks.ts'
import type { Fixture } from '../lib/fixtures.ts'
import { dayAndTime, oddsText, pointsText, returnText, signedMoney, wholePercent } from '../lib/format.ts'
import { editable, weekToOpen, type LiveData, type LiveSnapshot } from '../lib/live.ts'
import { nameOf, teamNames, type Names } from '../lib/names.ts'
import { periodName } from '../lib/periods.ts'
import { loadSettings } from '../lib/records/settings.ts'
import { achievements, KINDS, seasonStats, type Achievements } from '../lib/stats/season.ts'
import { confidenceSentence, heroSentence, KIND_NAMES, kindsSentence, legsSentence, sizesSentence, type Sentence } from '../lib/stats/words.ts'

type Filter = Competition | 'all'

// A sentence from words.ts: bold parts in their tone. Analytics uses it too.
export function Say({ sentence }: { sentence: Sentence }) {
  if (sentence.length === 0) return null
  return (
    <p className="say">
      {sentence.map((part, i) => (typeof part === 'string' ? part : <b key={i} className={part.tone === undefined ? undefined : `${part.tone}-t`}>{part.b}</b>))}
    </p>
  )
}

const tone = (value: number) => (value > 0 ? 'good-t' : value < 0 ? 'bad-t' : undefined)

export function Dashboard({ live, snapshot, api, unlocked, onBuild, onSettings }: {
  live: LiveData
  snapshot: LiveSnapshot
  api: AccountApi
  unlocked: Unlocked
  onBuild: () => void
  onSettings: () => void
}) {
  const admin = useAdmin()
  const [filter, setFilter] = useState<Filter>('all')
  const [backup, setBackup] = useState<BackupStatus | null>(null)
  const names = teamNames(snapshot.teams)

  // The fresh-backup reminder, as Settings shows it.
  useEffect(() => {
    let current = true
    void (async () => {
      try {
        const wraps = await api.keyWraps()
        const settings = (await loadSettings(api, unlocked.dataKey)).record
        if (current) setBackup(backupStatus(settings, wraps))
      } catch {
        // No reminder this time. Settings shows it too.
      }
    })()
    return () => {
      current = false
    }
  }, [api, unlocked])

  const seasonWeeks = useMemo(
    () => visibleWeeks(snapshot.weeks).filter(each => each.week.season === live.season).map(each => ({ week: each.week, record: each.record })),
    [snapshot.weeks, live.season],
  )
  const stats = useMemo(() => seasonStats(seasonWeeks, filter), [seasonWeeks, filter])
  const plClubs = useMemo(() => {
    const codes = new Set<string>()
    for (const fixture of snapshot.fixtures.values()) if (fixture.competition === 'PL') codes.add(fixture.home).add(fixture.away)
    return codes.size === 0 ? 20 : codes.size
  }, [snapshot.fixtures])
  const earned = useMemo(() => achievements(seasonWeeks, plClubs), [seasonWeeks, plClubs])

  // The sentence under the title: the week being played, or the next one.
  const statusCompetition: Competition = filter === 'UCL' ? 'UCL' : 'PL'
  const current = weekToOpen(snapshot.fixtures.values(), statusCompetition, snapshot.now)
  const status = current === null ? undefined
    : weekSentence(periodName(current), weekSummary(editable(live.week({ season: live.season, competition: statusCompetition, period: current })), snapshot.fixtures))

  const nothing = stats.legs.n === 0
  const right = (
    <>
      <div className="segmented" role="group" aria-label="Competition">
        {([['all', 'All'], ['PL', 'Premier League'], ['UCL', 'Champions League']] as const).map(([value, label]) => (
          <button key={value} type="button" className={filter === value ? 'on' : undefined} aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}</button>
        ))}
      </div>
      <Button kind="primary" onClick={onBuild}>Build parlay</Button>
    </>
  )

  return (
    <>
      <ChartFilters />
      <PageHead title="Dashboard" admin={admin} status={status} right={right} />
      {backup !== null && backup.kind !== 'fine' && <Reminder status={backup} action="Back up in Settings" onAction={onSettings} />}
      <div className="grid">
        <section className="panel span-8 wide" aria-labelledby="bank-title">
          <div className="ph-row">
            <h2 className="ptitle" id="bank-title">Bankroll</h2>
            <div className="legend"><span><i className="sw-line good" />Above $0</span><span><i className="sw-line bad" />Below $0</span></div>
          </div>
          <div className="hero-top">
            <div>
              <div className={`net ${tone(stats.netCents) ?? ''}`}>{signedMoney(stats.netCents)}</div>
              <Say sentence={heroSentence(stats)} />
            </div>
            <div className="hstats">
              <div className="hs"><span>Parlays cashed</span><b>{stats.cashed} of {stats.parlays}</b></div>
              <div className="hs"><span>Worst week</span><b className={tone(stats.worst?.profitCents ?? 0)}>{stats.worst === null ? '—' : signedMoney(stats.worst.profitCents)}</b></div>
              <div className="hs"><span>Return on stake</span><b className={tone(stats.returnOnStake ?? 0)}>{stats.returnOnStake === null ? '—' : returnText(stats.returnOnStake)}</b></div>
            </div>
          </div>
          {stats.weeks.length === 0
            ? <Hint>Your running total starts once a parlay settles.</Hint>
            : <Bankroll weeks={stats.weeks} netCents={stats.netCents} peak={stats.peak} />}
        </section>

        <section className="panel span-4 wide" aria-labelledby="odds-title">
          <h2 className="ptitle" id="odds-title">You against the odds</h2>
          <p className="sub">How often your picks land, against what the odds gave them once the bookmaker's cut is taken out.</p>
          {nothing ? <Hint>Nothing has settled yet.</Hint> : (
            <>
              <div className="rings">
                <Ring name="Legs" row={stats.legs} what="landed" />
                <Ring name="Parlays" row={stats.parlayRate} what="cashed" />
              </div>
              <MoneyBars expectedCents={stats.expectedCents} netCents={stats.netCents} />
            </>
          )}
        </section>

        <StillToSettle snapshot={snapshot} filter={filter} names={names} />

        <section className="panel span-4" aria-labelledby="legs-title">
          <h2 className="ptitle" id="legs-title">How your legs finished</h2>
          <p className="sub">Every leg you've had settled, by what happened in the match.</p>
          {nothing ? <Hint>No legs have settled yet.</Hint> : <Donut won={stats.legs.won} drawn={stats.legs.drawn} lost={stats.legs.lost} />}
          <Say sentence={legsSentence(stats)} />
        </section>

        <section className="panel span-4" aria-labelledby="kinds-title">
          <h2 className="ptitle" id="kinds-title">Where you beat the odds</h2>
          <p className="sub">Your hit rate on each type of pick. Cyan outside the violet line means you beat the odds there.</p>
          {nothing ? <Hint>No legs have settled yet.</Hint> : (
            <>
              <Radar rows={KINDS.map(kind => ({ name: KIND_NAMES.get(kind) ?? kind, row: stats.kinds.find(each => each.kind === kind) ?? { n: 0, won: 0, you: 0, odds: 0 } }))} />
              <div className="legend center"><span><i className="sw-you" />You</span><span><i className="sw-odds" />Odds said</span></div>
              <Say sentence={kindsSentence(stats.kinds)} />
            </>
          )}
        </section>

        <section className="panel span-4" aria-labelledby="sizes-title">
          <h2 className="ptitle" id="sizes-title">Which parlay size pays</h2>
          <p className="sub">How often each size cashes. The violet mark is what that size needs to break even.</p>
          {stats.sizes.length === 0 ? <Hint>No parlays have settled yet.</Hint> : (
            <>
              <Ladder rows={stats.sizes.map(each => ({ label: each.legs === 1 ? 'Single' : `${each.legs} legs`, placed: each.count, hit: each.hit, breakEven: each.breakEven, profitCents: each.profitCents }))} />
              <div className="legend"><span><i className="sw-you tall" />Your hit rate</span><span><i className="sw-tick" />Break even</span></div>
              <Say sentence={sizesSentence(stats.sizes)} />
            </>
          )}
        </section>

        <section className="panel span-7" aria-labelledby="weeks-title">
          <div className="ph-row">
            <h2 className="ptitle" id="weeks-title">Legs by week</h2>
            <div className="legend"><span><i className="ic won">✓</i>Won</span><span><i className="ic drawn">=</i>Lost to a draw</span><span><i className="ic lost">✕</i>Lost</span></div>
          </div>
          <p className="sub">Each column is one matchweek or matchday, split by how its legs finished.</p>
          {stats.weeks.length === 0 ? <Hint>No legs have settled yet.</Hint> : <Stack weeks={stats.weeks} />}
        </section>

        <section className="panel span-5" aria-labelledby="conf-title">
          <h2 className="ptitle" id="conf-title">Does your confidence mean anything?</h2>
          <p className="sub">How often legs land at each confidence rating you gave them.</p>
          {nothing ? <Hint>No legs have settled yet.</Hint> : (
            <>
              <ConfidenceColumns rows={stats.confidence} />
              <div className="legend"><span><i className="sw-you tall" />Your hit rate</span><span><i className="sw-tick flat" />Odds said</span></div>
              <Say sentence={confidenceSentence(stats.confidence)} />
            </>
          )}
        </section>

        <section className="panel span-8" aria-labelledby="clubs-title">
          <h2 className="ptitle" id="clubs-title">Clubs you back most</h2>
          <p className="sub">Every leg where you picked them to win, against what the odds gave those picks.</p>
          {stats.clubs.length === 0 ? <Hint>No legs that picked a winner have settled yet.</Hint> : (
            <table className="clubs">
              <thead>
                <tr><th>Club</th><th className="r">Backed</th><th className="rec">Record</th><th className="r">Hit rate</th><th className="r">Odds said</th><th className="r">Against the odds</th></tr>
              </thead>
              <tbody>
                {stats.clubs.slice(0, 8).map(club => (
                  <tr key={club.code}>
                    <td>
                      <span className="club"><TeamBadge code={club.code} />{nameOf(names, club.code)}
                        {filter === 'all' && club.competitions.length > 1 && <small>Both competitions</small>}</span>
                    </td>
                    <td className="r">{club.n}</td>
                    <td className="rec"><Strip won={club.won} drawn={club.drawn} lost={club.lost} /></td>
                    <td className="r you-t">{wholePercent(club.you)}</td>
                    <td className="r odds-t">{wholePercent(club.odds)}</td>
                    <td className={`r strong ${tone(Math.round((club.you - club.odds) * 100)) ?? ''}`}>{pointsText(club.you - club.odds)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <AchievementsPanel earned={earned} />
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// Still to settle: a tile for each leg that hasn't finished
// ---------------------------------------------------------------------------

type OpenLeg = { leg: Leg; competition: Competition; parlay: number; place: number; of: number; fixture: Fixture | undefined }

function openLegs(snapshot: LiveSnapshot, filter: Filter): OpenLeg[] {
  const legs: OpenLeg[] = []
  for (const loaded of visibleWeeks(snapshot.weeks)) {
    if (filter !== 'all' && loaded.week.competition !== filter) continue
    loaded.record.parlays.forEach((parlay, p) => parlay.legs.forEach((leg, l) => {
      if (leg.settlement === null) legs.push({ leg, competition: loaded.week.competition, parlay: p + 1, place: l + 1, of: parlay.legs.length, fixture: snapshot.fixtures.get(leg.fixtureId) })
    }))
  }
  // The ones being played first, then by kick-off.
  const playing = (each: OpenLeg) => (each.fixture !== undefined && legState(each.leg, each.fixture).kind === 'live' ? 0 : 1)
  return legs.sort((a, b) => playing(a) - playing(b) || a.leg.kickoff.localeCompare(b.leg.kickoff))
}

const SHOWN = 12

function StillToSettle({ snapshot, filter, names }: { snapshot: LiveSnapshot; filter: Filter; names: Names }) {
  const [ref, width] = useWidth<HTMLDivElement>(1000)
  const legs = openLegs(snapshot, filter)
  const shown = legs.slice(0, SHOWN)
  // Columns from the width, tiles at least 188px wide, then balanced so no
  // tile sits alone on a row.
  const most = Math.min(6, Math.max(2, Math.floor((width + 10) / 188)))
  const rows = Math.ceil(shown.length / most)
  const columns = shown.length > most ? Math.ceil(shown.length / rows) : most
  const live = legs.filter(each => each.fixture !== undefined && legState(each.leg, each.fixture).kind === 'live').length
  return (
    <section className="panel span-12" aria-labelledby="open-title">
      <div className="ph-row">
        <h2 className="ptitle" id="open-title">Still to settle</h2>
        <div className="legend"><span><i className="sw-pick" />Your pick</span><span>{legs.length === 1 ? '1 leg' : `${legs.length} legs`}{live > 0 ? `, ${live} live` : ''}</span></div>
      </div>
      <p className="sub">Your legs that haven't finished yet. A level score loses a leg unless you picked the draw.</p>
      <div ref={ref}>
        {legs.length === 0 ? <Hint>Every leg you've logged has settled.</Hint> : (
          <div className={`fxs cols-${columns}`}>
            {shown.map(each => <Tile key={each.leg.id} open={each} names={names} />)}
          </div>
        )}
      </div>
      {legs.length > SHOWN && <Hint>{legs.length - SHOWN} more in My parlays.</Hint>}
    </section>
  )
}

function Tile({ open, names }: { open: OpenLeg; names: Names }) {
  const { leg, fixture } = open
  const state = legState(leg, fixture)
  const score = state.kind === 'live' || state.kind === 'final' ? state.score : null
  let words = 'Not started'
  let toneClass = 'none'
  let note = `Kicks off ${dayAndTime(leg.kickoff)} your time.`
  if (state.kind === 'live') {
    words = state.standing === 'on track' ? 'On track' : state.standing === 'level' ? 'Level' : 'Behind'
    toneClass = state.standing === 'on track' ? 'good' : state.standing === 'level' ? 'warn' : 'bad'
    note = state.standing === 'on track' ? 'Winning right now.' : state.standing === 'level' ? 'Level right now. A draw would lose this leg.' : 'Losing right now.'
  } else if (state.kind === 'final') {
    words = 'Finished, settling now'
    note = 'Finished. It settles at the next refresh.'
  } else if (state.kind === 'waiting') {
    words = 'Waiting for you'
    toneClass = 'you'
    note = 'Its match didn\'t finish normally. Choose what happened in My parlays.'
  }
  const pickName = leg.pick === 'D' ? 'Draw' : nameOf(names, leg.pick === 'H' ? leg.home : leg.away)
  const team = (code: string, side: 'H' | 'A', goals: number | undefined) => (
    <div className={leg.pick === side ? 'tm mine' : 'tm'}>
      <TeamBadge code={code} mine={leg.pick === side} /><span className="nm">{nameOf(names, code)}</span>{goals !== undefined && <b>{goals}</b>}
    </div>
  )
  return (
    <div className="fx" tabIndex={0} aria-label={`${nameOf(names, leg.home)} v ${nameOf(names, leg.away)}. Your pick: ${pickName}, at ${oddsText(leg.odds)}. ${words}. Leg ${open.place} of ${open.of} in parlay ${open.parlay}.`}>
      <div className="fx-h">
        <span className="tag">{open.competition}</span>
        {state.kind === 'live' ? <LiveMinute minute={state.minute} halfTime={state.halfTime} /> : <span>{dayAndTime(leg.kickoff)}</span>}
      </div>
      {team(leg.home, 'H', score?.[0])}
      {team(leg.away, 'A', score?.[1])}
      <div className="fx-f"><span className={`st ${toneClass}`}>{words}</span><span>Leg {open.place} of {open.of}</span></div>
      <div className="fx-tip" aria-hidden="true">
        <b>{nameOf(names, leg.home)} v {nameOf(names, leg.away)}</b>
        <div className="row"><span>Your pick</span><strong className="you-t">{pickName}</strong></div>
        <div className="row"><span>Odds</span><strong>{oddsText(leg.odds)}</strong></div>
        <div className="note">{note} Leg {open.place} of {open.of} in parlay {open.parlay}.</div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Achievements: the six the mockup shows (step 10 plan, smaller choices)
// ---------------------------------------------------------------------------

function AchievementsPanel({ earned }: { earned: Achievements }) {
  const items = [
    {
      got: earned.perfectWeek !== null, icon: '★', name: 'Perfect week',
      say: earned.perfectWeek !== null ? `Every parlay cashed in ${periodName(earned.perfectWeek.period)}` : 'Cash every parlay in one week',
    },
    {
      got: earned.bestRun >= 10, icon: String(earned.bestRun), name: 'Hot streak', progress: earned.bestRun / 10,
      say: earned.bestRun >= 10 ? `${earned.bestRun} legs in a row, your best run` : `Land 10 legs in a row. Best run ${earned.bestRun}`,
    },
    {
      got: earned.plBacked >= earned.plClubs, icon: String(earned.plClubs), name: 'Full house', progress: earned.plBacked / earned.plClubs,
      say: earned.plBacked >= earned.plClubs ? `Backed all ${earned.plClubs} Premier League clubs` : `Back all ${earned.plClubs} Premier League clubs. ${earned.plBacked} so far`,
    },
    {
      got: earned.europeanNight, icon: '★', name: 'European night',
      say: earned.europeanNight ? 'Cashed a Champions League parlay' : 'Cash a Champions League parlay',
    },
    {
      got: earned.drawsLanded >= 3, icon: '=', name: 'Draw whisperer', progress: earned.drawsLanded / 3,
      say: earned.drawsLanded >= 3 ? `${earned.drawsLanded} draw picks landed` : `Land 3 draw picks. ${earned.drawsLanded} so far`,
    },
    {
      got: earned.longest !== null && earned.longest >= 1000, icon: '+', name: 'Long shot', progress: earned.longest === null ? 0 : earned.longest / 1000,
      say: earned.longest !== null && earned.longest >= 1000 ? `Cashed a ${oddsText(earned.longest)} parlay`
        : earned.longest === null ? 'Cash a +1000 parlay' : `Cash a +1000 parlay. Best so far ${oddsText(earned.longest)}`,
    },
  ]
  const unlocked = items.filter(each => each.got).length
  return (
    <section className="panel span-4" aria-labelledby="ach-title">
      <div className="ph-row"><h2 className="ptitle" id="ach-title">Achievements</h2><span className="count">{unlocked} of 6 unlocked</span></div>
      <p className="sub">Across the whole season, both competitions.</p>
      <div className="ach">
        {items.map(each => (
          <div key={each.name} className={each.got ? 'a got' : 'a'}>
            <div className="a-ic" aria-hidden="true">{each.icon}</div>
            <div>
              <b>{each.name}</b>
              <span>{each.say}</span>
              {!each.got && each.progress !== undefined && each.progress > 0 && <Progress share={each.progress} />}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}
