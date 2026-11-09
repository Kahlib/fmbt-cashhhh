// Settings' Import (step 11.1, and the canvas "FMBT Import screens"): the
// backfill's CSV of your bet365 history, checked against this season's
// fixtures in a preview before anything saves. It all happens in this tab:
// the file is read here, each week that passes is encrypted and saved the
// way Build parlay saves, and nothing of the file is kept afterwards.
import { useState } from 'react'
import { useAdmin } from '../components/admin.ts'
import { Button, FileButton, Hint, LinkButton, Note } from '../components/Controls.tsx'
import { StatusIcon, UploadIcon } from '../components/Icons.tsx'
import { PageHead } from '../components/Layout.tsx'
import { Confidence, PickLabel } from '../components/Parlay.tsx'
import { finalScore90 } from '../lib/bets/settle.ts'
import { count, dayRange, money, oddsText, percentText } from '../lib/format.ts'
import { MAX_FILE_BYTES } from '../lib/import/csv-reader.ts'
import { planImport, type ImportLeg, type ImportParlay, type ImportPlan, type ImportWeek, type LegShown } from '../lib/import/plan.ts'
import type { LiveData, LiveSnapshot } from '../lib/live.ts'
import { nameOf, teamNames, type Names } from '../lib/names.ts'
import { periodName } from '../lib/periods.ts'
import { listed } from '../lib/stats/words.ts'

export type Planned = { fileName: string; plan: Extract<ImportPlan, { problem: null }> }

// The section in Settings: the warning, and choosing the file.
export function ImportPanel({ live, snapshot, done, onPlanned }: { live: LiveData; snapshot: LiveSnapshot; done: string | null; onPlanned: (planned: Planned) => void }) {
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function read(file: File) {
    setProblem(null)
    if (file.size > MAX_FILE_BYTES) {
      setProblem('That file is over 1 MB, which is far more than a season of bets.')
      return
    }
    if (snapshot.phase !== 'ready') return // the button waits for the season's games, so this is only a file chosen too early
    setBusy(true)
    try {
      const plan = planImport(await file.text(), {
        season: live.season, fixtures: snapshot.fixtures, teams: snapshot.teams, saved: snapshot.weeks, now: new Date().toISOString(),
      })
      if (plan.problem === null) onPlanned({ fileName: file.name, plan })
      else setProblem(plan.problem)
    } catch {
      setProblem("That file couldn't be read.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="panel span-12" aria-labelledby="import-title">
      <div>
        <div className="ph-row"><h2 className="ptitle" id="import-title">Import</h2><span className="count">From bet365's bet history</span></div>
        <p className="sub">Adds the parlays in a CSV of your bet365 history. A preview checks every leg against this season's fixtures first, and nothing saves until you confirm. It only ever adds: a week that already has parlays is skipped, and nothing you've saved changes.</p>
      </div>
      <div className="note icon">
        <StatusIcon kind="warn" />
        <p><b>The file isn't encrypted.</b> It holds your bets in plain text, so keep it off cloud drives, and delete it once it's imported.</p>
      </div>
      {done !== null && (
        <div className="log-check" role="status">
          <StatusIcon kind="good" />
          <span>{done}</span>
        </div>
      )}
      {problem !== null && <Note problem><p>{problem}</p></Note>}
      {snapshot.phase === 'failed' ? (
        <Note problem>
          <p>This season's games didn't load, so the import can't check a file yet.</p>
          <p><LinkButton onClick={() => void live.loadAll()}>Try again</LinkButton></p>
        </Note>
      ) : (
        <div className="btn-row">
          {/* It waits for this season's games, which every check needs. */}
          <FileButton accept=".csv,text/csv" busy={busy || snapshot.phase === 'loading'} busyLabel={busy ? 'Reading…' : 'Loading this season’s games…'} onFile={file => void read(file)}>
            <UploadIcon />Choose a CSV file
          </FileButton>
        </div>
      )}
      <p className="hint">Save it from Excel as CSV UTF-8, so names with accents come through.</p>
    </section>
  )
}

const RESULT_WORDS: Record<LegShown, string> = { won: 'Won', lost: 'Lost', drawn: 'Lost to a draw', dropped: 'Dropped', promo: 'Paid by a promo' }
const RESULT_KIND: Record<LegShown, 'good' | 'bad' | 'warn' | 'none'> = { won: 'good', lost: 'bad', drawn: 'warn', dropped: 'none', promo: 'good' }

const hasProblems = (parlay: ImportParlay) => parlay.problems.length > 0 || parlay.legs.some(leg => leg.problems.length > 0)
const problemCount = (week: ImportWeek) => week.parlays.reduce((sum, parlay) => sum + parlay.problems.length + parlay.legs.reduce((n, leg) => n + leg.problems.length, 0), 0)
const weekName = (week: ImportWeek) => (week.week === null ? 'Not matched to a week' : periodName(week.week.period))

// The page the preview takes over Settings with.
export function ImportPreview({ live, snapshot, planned, onCancel, onDone }: {
  live: LiveData
  snapshot: LiveSnapshot
  planned: Planned
  onCancel: () => void
  onDone: (summary: string) => void
}) {
  const admin = useAdmin()
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const { fileName, plan } = planned
  const names = teamNames(snapshot.teams)
  const ready = plan.weeks.filter(week => week.status === 'ready')
  const held = plan.weeks.filter(week => week.status === 'held')
  const skipped = plan.weeks.filter(week => week.status === 'skipped')
  const readyParlays = ready.reduce((sum, week) => sum + week.parlays.length, 0)
  const heldParlays = held.reduce((sum, week) => sum + week.parlays.length, 0)
  const cents = plan.weeks.flatMap(week => week.parlays).filter(parlay => parlay.note !== null).length
  const weekCount = plan.weeks.filter(week => week.week !== null).length
  const action = readyParlays === 0 ? 'Nothing to import' : `Import ${count(readyParlays, 'parlay', 'parlays')}`
  const which = (weeks: readonly ImportWeek[]) => (weeks.length <= 3 ? listed(weeks.map(weekName)) : `In ${weeks.length} weeks`)

  // Each week's days, from all its games, as My parlays shows them.
  const days = new Map<string, string[]>()
  for (const fixture of snapshot.fixtures.values()) {
    const key = `${fixture.competition} ${fixture.period}`
    days.set(key, [...(days.get(key) ?? []), fixture.kickoff])
  }
  const dates = (week: ImportWeek) => {
    const list = week.week === null ? [] : [...(days.get(week.key) ?? [])].sort()
    return list.length === 0 ? null : dayRange(list[0], list[list.length - 1])
  }

  async function save() {
    setBusy(true)
    setFailed(false)
    let parlays = 0
    let weeks = 0
    let late = 0
    try {
      for (const week of ready) {
        if (week.week === null || week.record === null) continue
        // A week that got parlays in another tab since the preview is left alone.
        if (live.week(week.week).record.parlays.length > 0) {
          late++
          continue
        }
        const outcome = await live.save(week.week, week.record)
        if (outcome === 'saved') {
          weeks++
          parlays += week.parlays.length
        } else {
          late++
        }
      }
    } catch {
      // What saved stays saved, and importing the file again skips it.
      setFailed(true)
      setBusy(false)
      return
    }
    const parts = [`Imported ${count(parlays, 'parlay', 'parlays')} in ${count(weeks, 'week', 'weeks')}.`]
    if (held.length > 0) parts.push(`${listed(held.map(weekName))} ${held.length === 1 ? 'was' : 'were'} held back, so fix ${held.length === 1 ? 'its' : 'their'} problems in the file and import it again.`)
    if (late > 0) parts.push(`${count(late, 'week was', 'weeks were')} saved in another tab meanwhile, so the import left ${late === 1 ? 'it' : 'them'} alone.`)
    parts.push("Delete the file once you're done.")
    onDone(parts.join(' '))
  }

  const actions = (
    <>
      <Button onClick={onCancel} disabled={busy}>Cancel</Button>
      <Button kind="primary" disabled={readyParlays === 0} busy={busy} busyLabel="Importing…" onClick={() => void save()}>{action}</Button>
    </>
  )

  return (
    <>
      <PageHead title="Import" admin={admin} status={`${fileName}: ${count(plan.parlays, 'parlay', 'parlays')} and ${count(plan.legs, 'leg', 'legs')} in ${count(weekCount, 'week', 'weeks')}, checked against this season's fixtures.`} right={actions} />
      {failed && <Note problem><p>Saving stopped partway, so check your connection. The weeks that saved are in the app, and importing the file again skips them.</p></Note>}
      <div className="grid">
        <section className="panel span-12" aria-label="What's in the file">
          <div className="stats">
            <div><div className="stat-label">Ready to import</div><div className="stat-value good-t">{count(readyParlays, 'parlay', 'parlays')}</div><div className="stat-note">{ready.length === 0 ? 'No week is ready yet' : which(ready)}</div></div>
            <div><div className="stat-label">Held back</div><div className={heldParlays > 0 ? 'stat-value bad-t' : 'stat-value'}>{count(heldParlays, 'parlay', 'parlays')}</div><div className="stat-note">{held.length === 0 ? 'Nothing needs fixing' : which(held)}</div></div>
            <div><div className="stat-label">Skipped</div><div className="stat-value">{count(skipped.length, 'week', 'weeks')}</div><div className="stat-note">{skipped.length === 0 ? 'None already here' : `${which(skipped)}, already here`}</div></div>
            <div><div className="stat-label">A cent apart</div><div className="stat-value">{count(cents, 'parlay', 'parlays')}</div><div className="stat-note">The app's figure is saved</div></div>
          </div>
          <p className="hint">A problem anywhere in a week holds the whole week back, so it comes in complete once the file is fixed. Weeks go newest first, as in your bet365 history.</p>
        </section>

        {plan.weeks.map(week => (
          <section key={week.key} className="panel span-12" aria-labelledby={`import-${week.key}`}>
            <div className="week-h">
              <h2 className="ptitle" id={`import-${week.key}`}>{weekName(week)}</h2>
              <span className={week.status === 'ready' ? 'tag good' : week.status === 'held' ? 'tag bad' : 'tag'}>{week.status === 'ready' ? 'Ready' : week.status === 'held' ? 'Held back' : 'Skipped'}</span>
              <span className="count">{[dates(week), count(week.parlays.length, 'parlay', 'parlays')].filter(Boolean).join(' · ')}</span>
            </div>
            {week.status === 'skipped' && <p className="week-note">It already has parlays in the app, so it's skipped and nothing in it changes.</p>}
            {week.status === 'held' && (
              <p className="week-note bad">
                {week.week === null ? "These parlays couldn't be matched to a week. Fix the problems below in the file, and import it again." : `${count(problemCount(week), 'problem', 'problems')} below. Fix ${problemCount(week) === 1 ? 'it' : 'them'} in the file and import it again, and this week comes in then.`}
              </p>
            )}
            {week.status !== 'skipped' && week.parlays.map((parlay, i) => <ParlayCheck key={parlay.number} parlay={parlay} place={i + 1} names={names} />)}
          </section>
        ))}

        <section className="panel span-12" aria-label="Import">
          <div className="btn-row">{actions}</div>
          <Hint>Once the weeks held back are fixed, import the same file again. Weeks that already have parlays are skipped, so only those come in.</Hint>
        </section>
      </div>
    </>
  )
}

// One parlay of the file: what it comes to, then its legs and their checks.
function ParlayCheck({ parlay, place, names }: { parlay: ImportParlay; place: number; names: Names }) {
  const size = parlay.legs.length === 1 ? 'Single' : `${parlay.legs.length} legs`
  const details = [size, parlay.stakeCents === null ? null : money(parlay.stakeCents), parlay.bonus === true ? 'bonus bet' : null, parlay.boostBps ? `${percentText(parlay.boostBps)} boost` : null, `line ${parlay.line} in the file`]
  const checked = parlay.state !== null && !hasProblems(parlay)
  return (
    <div className="ip">
      <div className="ip-h">
        <b>Parlay {place}</b>
        <span className="muted">{details.filter(Boolean).join(' · ')}</span>
        {checked && (
          <span className="sum">
            {parlay.state === 'won' ? <span className="st good"><StatusIcon kind="good" />Cashed {money(parlay.returnCents ?? 0)}</span>
              : parlay.state === 'void' ? <span className="st none">Void, {parlay.bonus === true ? 'the bonus bet' : money(parlay.returnCents ?? 0)} back</span>
                : <span className="st bad"><StatusIcon kind="bad" />Lost</span>}
            {parlay.note === null ? <span className="match-ok">Matches the slip</span> : <span className="cent">{parlay.note}</span>}
          </span>
        )}
      </div>
      {parlay.problems.map(problem => <p key={problem} className="week-note bad">{problem}</p>)}
      <div className="table-box">
        <table className="hist ileg">
          <thead><tr><th>Game</th><th>Your pick</th><th className="r">Odds</th><th>Confidence</th><th>Score</th><th>Result</th></tr></thead>
          <tbody>{parlay.legs.map(leg => <LegCheck key={leg.line} leg={leg} names={names} />)}</tbody>
        </table>
      </div>
    </div>
  )
}

function LegCheck({ leg, names }: { leg: ImportLeg; names: Names }) {
  const fixture = leg.fixture
  const score = fixture === null ? leg.slipScore : finalScore90(fixture) ?? leg.slipScore
  const extra = leg.problems.length > 0 ? 'has-problem' : leg.note !== null ? 'has-note' : undefined
  return (
    <>
      <tr className={extra}>
        <td>{fixture === null ? `${leg.homeText} v ${leg.awayText}` : `${nameOf(names, fixture.home)} v ${nameOf(names, fixture.away)}`}</td>
        <td>{fixture !== null && leg.pick !== null ? <PickLabel pick={leg.pick} home={fixture.home} away={fixture.away} names={names} /> : leg.pickText}</td>
        <td className="r">{leg.odds === null ? '—' : oddsText(leg.odds)}</td>
        <td>{leg.confidence === null ? <span className="muted">—</span> : <Confidence rating={leg.confidence} />}</td>
        <td>{score === null ? <span className="muted">—</span> : <span className="score">{score[0]}–{score[1]}</span>}</td>
        <td>
          {leg.problems.length > 0 ? <span className="st bad"><StatusIcon kind="bad" />Needs fixing</span>
            : leg.shown === null ? null
              : <span className={`st ${RESULT_KIND[leg.shown]}`}><StatusIcon kind={RESULT_KIND[leg.shown]} />{RESULT_WORDS[leg.shown]}</span>}
        </td>
      </tr>
      {leg.problems.map(problem => <tr key={problem} className="problem"><td colSpan={6}>Line {leg.line}: {problem}</td></tr>)}
      {leg.problems.length === 0 && leg.note !== null && <tr className="note"><td colSpan={6}>{leg.note}</td></tr>}
    </>
  )
}
