// My parlays (canvas "FMBT My parlays screens": My parlays, A leg waiting
// for you, A score correction, Admin mode on My parlays). One week at a
// time: what needs you, the week's money, and each parlay with its legs.
import { useState } from 'react'
import { useAdmin } from '../components/admin.ts'
import { Button, Hint, Note } from '../components/Controls.tsx'
import { BackIcon, ChangedIcon, ClockIcon, NextIcon } from '../components/Icons.tsx'
import { PageHead } from '../components/Layout.tsx'
import { ParlayCard } from '../components/Parlay.tsx'
import { nameOf, teamNames } from '../lib/names.ts'
import { ServerError } from '../lib/account/api.ts'
import { lockedChanges } from '../lib/bets/audit.ts'
import { removeParlay, waitingReason } from '../lib/bets/edit.ts'
import { acceptCorrection, isParlayLocked, settleByHand, voidLeg, type Correction } from '../lib/bets/settle.ts'
import { changeWords, legPlace, parlayView, weekSentence, weekSummary, type WaitingStatus } from '../lib/bets/view.ts'
import { TOMBSTONE, type Competition, type Week, type WeekRecord } from '../lib/bets/week-record.ts'
import { CORRECTION_REASON, KEPT_REASON } from '../lib/bets/weeks.ts'
import type { Fixture } from '../lib/fixtures.ts'
import { dayRange, money, signedMoney, timeAgo } from '../lib/format.ts'
import { editable, periodsOf, syncBehind, weekKey, weekToOpen, type LiveData, type LiveSnapshot } from '../lib/live.ts'
import { periodName } from '../lib/periods.ts'
import { CorrectionDialog, ReasonDialog, WaitingDialog, type Answer, type WaitingChoice } from './LegDialogs.tsx'
import { OFFLINE, TAKEN } from './messages.ts'

type Open =
  | { kind: 'waiting'; week: Week; legId: string; status: WaitingStatus }
  | { kind: 'correction'; week: Week; correction: Correction }
  | { kind: 'remove'; week: Week; parlayId: string }
  | { kind: 'delete-week'; week: Week }
  | null

export function MyParlays({ live, snapshot, competition, onCompetition, period, onPeriod, onBuild, onEdit, onToast }: {
  live: LiveData
  snapshot: LiveSnapshot
  competition: Competition
  onCompetition: (competition: Competition) => void
  period: string | null
  onPeriod: (period: string) => void
  onBuild: () => void
  onEdit: (week: Week, parlayId: string) => void
  onToast: (message: string) => void
}) {
  const admin = useAdmin()
  const [open, setOpen] = useState<Open>(null)
  const names = teamNames(snapshot.teams)
  const fixtures = snapshot.fixtures
  const now = snapshot.now

  const competitionSwitch = (
    <div className="segmented" role="group" aria-label="Competition">
      {(['PL', 'UCL'] as const).map(each => (
        <button key={each} type="button" className={each === competition ? 'on' : undefined} aria-pressed={each === competition} onClick={() => onCompetition(each)}>
          {each}
        </button>
      ))}
    </div>
  )
  const right = <>{competitionSwitch}<Button kind="primary" onClick={onBuild}>Build parlay</Button></>

  if (snapshot.phase !== 'ready') {
    return (
      <>
        <PageHead title="My parlays" admin={admin} right={right}
          status={snapshot.phase === 'loading' ? 'Loading your parlays and this season’s games…' : undefined} />
        {snapshot.phase === 'failed' && (
          <Note problem>
            <p>{OFFLINE}</p>
            <p><button type="button" className="link" onClick={() => void live.loadAll()}>Try again</button></p>
          </Note>
        )}
      </>
    )
  }

  const periods = periodsOf(fixtures.values(), competition)
  const shown = period !== null && periods.includes(period) ? period : weekToOpen(fixtures.values(), competition, now)
  if (shown === null) {
    return (
      <>
        <PageHead title="My parlays" admin={admin} right={right} status="No games from the feed for this competition yet." />
      </>
    )
  }

  const week: Week = { season: live.season, competition, period: shown }
  const loaded = live.week(week)
  const record = editable(loaded)
  const views = record.parlays.map((parlay, i) => parlayView(parlay, i, fixtures))
  const summary = weekSummary(record, fixtures)
  const name = periodName(shown)
  const weekGames = [...fixtures.values()].filter(fixture => fixture.competition === competition && fixture.period === shown)
  const kickoffs = weekGames.map(fixture => fixture.kickoff).sort()
  const at = periods.indexOf(shown)
  const behind = syncBehind(snapshot.sync, fixtures.values(), now)
  const lastSync = snapshot.sync?.lastSuccessAt ?? null

  // What can go wrong when saving, in words.
  async function save(target: Week, next: WeekRecord, done: string, reason?: string): Answer {
    try {
      const outcome = await live.save(target, next, reason)
      if (outcome === 'taken') return TAKEN
      setOpen(null)
      onToast(done)
      return null
    } catch (error) {
      return error instanceof ServerError || !(error instanceof RangeError) ? OFFLINE : "That change couldn't be saved. Nothing has changed."
    }
  }

  // Everything that needs you, across the season's weeks.
  const needs = [
    ...snapshot.waiting.filter(item => item.week.season === live.season).map(item => {
      const owner = editable(live.week(item.week))
      const place = legPlace(owner, item.parlayId, item.legId)
      const leg = owner.parlays.flatMap(parlay => parlay.legs).find(each => each.id === item.legId)
      if (place === null || leg === undefined) return null
      const status = item.status
      return {
        key: `w ${weekKey(item.week)} ${item.legId}`,
        icon: <ClockIcon />,
        text: <><b>{nameOf(names, leg.home)} v {nameOf(names, leg.away)} {status === 'missing' ? "isn't in the feed" : `was ${status}`}.</b> Leg {place.leg} of parlay {place.parlay} in {periodName(item.week.period)} waits until you say what bet365 did with it.</>,
        action: <Button onClick={() => setOpen({ kind: 'waiting', week: item.week, legId: item.legId, status })}>Choose what happened</Button>,
      }
    }),
    ...snapshot.corrections.filter(item => item.week.season === live.season).map(item => {
      const owner = editable(live.week(item.week))
      const place = legPlace(owner, item.parlayId, item.legId)
      const leg = owner.parlays.flatMap(parlay => parlay.legs).find(each => each.id === item.legId)
      if (place === null || leg === undefined) return null
      return {
        key: `c ${weekKey(item.week)} ${item.legId}`,
        icon: <ChangedIcon />,
        text: <><b>{nameOf(names, leg.home)} v {nameOf(names, leg.away)}'s score changed from {item.from[0]}–{item.from[1]} to {item.to[0]}–{item.to[1]}.</b> Leg {place.leg} of parlay {place.parlay} in {periodName(item.week.period)} settled itself on {item.from[0]}–{item.from[1]}.</>,
        action: <Button onClick={() => setOpen({ kind: 'correction', week: item.week, correction: item })}>Review the change</Button>,
      }
    }),
    ...snapshot.warnings.map(warning => ({
      key: `u ${weekKey(warning.week)}`,
      icon: <ChangedIcon />,
      text: <><b>A saved version of {periodName(warning.week.period)} couldn't be opened.</b> Someone may have written to your account, or the data is damaged. The newest version that opens is the one shown.</>,
      action: null,
    })),
  ].filter(item => item !== null)

  // The dialog that's open, if any, with what it acts on.
  function dialog() {
    if (open === null) return null
    const owner = editable(live.week(open.week))
    const fixtureMap = fixtures as ReadonlyMap<number, Fixture>
    // The time a change is saved, read when you make it.
    const nowIso = () => new Date().toISOString()
    if (open.kind === 'waiting' || open.kind === 'correction') {
      const legId = open.kind === 'waiting' ? open.legId : open.correction.legId
      const index = owner.parlays.findIndex(parlay => parlay.legs.some(leg => leg.id === legId))
      const parlay = owner.parlays[index]
      const leg = parlay?.legs.find(each => each.id === legId)
      if (parlay === undefined || leg === undefined) return null
      const legNumber = parlay.legs.indexOf(leg) + 1
      if (open.kind === 'waiting') {
        const status = open.status
        const choose = (choice: WaitingChoice): Answer => {
          const next = choice.kind === 'hand'
            ? settleByHand(owner, legId, { outcome: choice.outcome, promo: false, reason: choice.reason }, fixtureMap, nowIso())
            : voidLeg(owner, legId, { outcome: choice.kind === 'drop' ? 'dropped' : 'lost', reason: waitingReason(status, choice.kind) }, fixtureMap, nowIso())
          const done = choice.kind === 'drop' ? 'Leg dropped. The parlay is repriced without it.' : choice.kind === 'lost' ? 'Leg counted as lost.' : 'Leg settled by hand.'
          return save(open.week, next, done)
        }
        return <WaitingDialog leg={leg} status={status} parlay={parlay} number={index + 1} legNumber={legNumber} names={names} onClose={() => setOpen(null)} onChoose={choose} />
      }
      const correction = open.correction
      const kept = leg.settlement?.outcome === 'won' ? 'won' : 'lost'
      return (
        <CorrectionDialog leg={leg} correction={correction} parlay={parlay} number={index + 1} legNumber={legNumber}
          locked={isParlayLocked(parlay)} names={names} onClose={() => setOpen(null)}
          onAccept={() => save(open.week, acceptCorrection(owner, legId, fixtureMap, nowIso()), `Score accepted: ${correction.to[0]}–${correction.to[1]}.`, CORRECTION_REASON)}
          onKeep={() => save(open.week, settleByHand(owner, legId, { outcome: kept, promo: false, reason: KEPT_REASON }, fixtureMap, nowIso()), `Kept ${correction.from[0]}–${correction.from[1]}. The app won't ask again.`, KEPT_REASON)} />
      )
    }
    if (open.kind === 'remove') {
      const index = owner.parlays.findIndex(parlay => parlay.id === open.parlayId)
      const parlay = owner.parlays[index]
      if (parlay === undefined) return null
      const next = removeParlay(owner, parlay.id)
      const locked = isParlayLocked(parlay)
      return (
        <ReasonDialog title={`Remove parlay ${index + 1}?`} reasonNeeded={locked} danger={locked} confirmLabel={`Remove parlay ${index + 1}`}
          sub={locked
            ? `It's locked, so this goes in the audit log with your reason. Its ${parlay.legs.length === 1 ? 'leg goes' : 'legs go'} with it, and the parlays after it move up a number.`
            : `Its ${parlay.legs.length === 1 ? 'leg goes' : 'legs go'} with it, and the parlays after it move up a number.`}
          changes={locked ? lockedChanges(owner, next).map(changeWords) : []}
          onClose={() => setOpen(null)} onConfirm={reason => save(open.week, next, `Parlay ${index + 1} removed.`, reason)} />
      )
    }
    const locked = owner.parlays.filter(isParlayLocked).length
    const count = owner.parlays.length
    return (
      <ReasonDialog title={`Delete ${periodName(open.week.period)}?`} reasonNeeded={locked > 0} danger confirmLabel={`Delete ${periodName(open.week.period)}`}
        sub={`This takes its ${count === 1 ? 'parlay' : `${count} parlays`} off My parlays and out of your stats.${locked > 0 ? ` ${locked === 1 ? '1 of them is' : `${locked} of them are`} locked, so say why.` : ''} Its saved versions stay in your account.`}
        changes={[]} onClose={() => setOpen(null)}
        onConfirm={reason => save(open.week, TOMBSTONE, `${periodName(open.week.period)} deleted.`, reason)} />
    )
  }

  return (
    <>
      <PageHead title="My parlays" admin={admin} right={right} status={weekSentence(name, summary)} />
      <div className="page-stack">
        {behind && (
          <div className="reminder" role="status">
            <div className="reminder-text">
              <ClockIcon />
              <span><b>Scores may be behind.</b> The last sync that worked was {lastSync === null ? 'a while ago' : timeAgo(lastSync, now)}, and a match is on. The app keeps checking every minute.</span>
            </div>
          </div>
        )}

        {needs.length > 0 && (
          <section className="panel" aria-labelledby="needs-title">
            <div className="ph-row"><h2 className="ptitle" id="needs-title">Needs you</h2><span className="count">{needs.length}</span></div>
            <div className="need-list">
              {needs.map(item => (
                <div className="need" key={item.key}>
                  <div className="need-text">{item.icon}<span>{item.text}</span></div>
                  {item.action}
                </div>
              ))}
            </div>
          </section>
        )}

        <section className="panel" aria-label={name}>
          <div className="weekbar">
            <div className="weeknav">
              <button type="button" className="icon-btn" disabled={at <= 0} aria-label={at > 0 ? `Go to ${periodName(periods[at - 1])}` : 'No earlier week'}
                onClick={() => at > 0 && onPeriod(periods[at - 1])}><BackIcon /></button>
              <div>
                <div className="weekname">{name}</div>
                {kickoffs.length > 0 && <div className="weekdates">{dayRange(kickoffs[0], kickoffs[kickoffs.length - 1])}</div>}
              </div>
              <button type="button" className="icon-btn" disabled={at >= periods.length - 1} aria-label={at < periods.length - 1 ? `Go to ${periodName(periods[at + 1])}` : 'No later week'}
                onClick={() => at < periods.length - 1 && onPeriod(periods[at + 1])}><NextIcon /></button>
            </div>
            <div className="weekbar-r">
              <span className="synced">{lastSync === null ? 'Not synced yet' : `Synced ${timeAgo(lastSync, now)}`}{snapshot.stale ? '. Couldn’t refresh just now' : ''}</span>
              {admin.on && record.parlays.length > 0 && (
                <button type="button" className="btn btn-danger btn-sm" onClick={() => setOpen({ kind: 'delete-week', week })}>Delete {name}</button>
              )}
            </div>
          </div>
          {summary.parlays > 0 ? (
            <div className="stats">
              <div><div className="stat-label">Staked</div><div className="stat-value">{money(summary.stakedCents)}</div><div className="stat-note">On {summary.parlays === 1 ? '1 parlay' : `${summary.parlays} parlays`}</div></div>
              <div><div className="stat-label">Returned so far</div><div className="stat-value">{money(summary.returnedCents)}</div><div className="stat-note">{summary.cashed === 1 ? '1 parlay cashed' : `${summary.cashed} parlays cashed`}</div></div>
              <div>
                <div className="stat-label">Net so far</div>
                <div className={summary.netCents > 0 ? 'stat-value good-t' : summary.netCents < 0 ? 'stat-value bad-t' : 'stat-value'}>{signedMoney(summary.netCents)}</div>
                <div className="stat-note">On the {summary.settled === 1 ? 'one' : summary.settled} that {summary.settled === 1 ? 'has' : 'have'} settled</div>
              </div>
              <div>
                <div className="stat-label">Still to settle</div>
                <div className="stat-value">{summary.legsToSettle === 0 ? 'None' : summary.legsToSettle === 1 ? '1 leg' : `${summary.legsToSettle} legs`}</div>
                <div className="stat-note">{summary.legsToSettle === 0 ? 'Every leg has settled' : `${summary.live} live, ${summary.waiting} waiting for you`}</div>
              </div>
            </div>
          ) : (
            <div className="empty">
              <b>No parlays logged for {name}</b>
              {kickoffs.length > 0 && <p className="sub">{weekGames.length === 1 ? 'Its game' : `Its ${weekGames.length} games`} {Date.parse(kickoffs[0]) > now ? `kick off from ${dayRange(kickoffs[0], kickoffs[0])}` : 'have started'}.</p>}
              <Button onClick={onBuild}>Build parlay</Button>
            </div>
          )}
        </section>

        {views.map(view => {
          const waitingIds = new Set(snapshot.waiting.filter(item => weekKey(item.week) === weekKey(week) && item.parlayId === view.parlay.id).map(item => item.legId))
          const corrections = new Map(snapshot.corrections.filter(item => weekKey(item.week) === weekKey(week) && item.parlayId === view.parlay.id).map(item => [item.legId, item]))
          return (
            <ParlayCard key={view.parlay.id} view={view} fixtures={fixtures} names={names} admin={admin.on}
              actions={{
                waiting: waitingIds,
                corrections,
                onWaiting: legId => {
                  const item = snapshot.waiting.find(each => each.legId === legId)
                  if (item !== undefined) setOpen({ kind: 'waiting', week, legId, status: item.status })
                },
                onCorrection: legId => {
                  const item = corrections.get(legId)
                  if (item !== undefined) setOpen({ kind: 'correction', week, correction: item })
                },
              }}
              onEdit={() => onEdit(week, view.parlay.id)}
              onRemove={() => setOpen({ kind: 'remove', week, parlayId: view.parlay.id })} />
          )
        })}
        {snapshot.stale && <Hint>Couldn't reach the server for the last refresh, so scores may be behind. The app tries again every minute.</Hint>}
      </div>
      {dialog()}
    </>
  )
}
