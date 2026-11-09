// How a parlay, its legs and their teams look (the canvas "FMBT My parlays
// screens"). Everything here draws what lib/bets/view.ts works out, and all
// text goes through React, which escapes it (fmbt-security, section 8).
import type { ReactNode } from 'react'
import type { Correction } from '../lib/bets/settle.ts'
import { legState, type LegState, type ParlayView } from '../lib/bets/view.ts'
import type { Leg, Pick as Choice } from '../lib/bets/week-record.ts'
import type { Fixture } from '../lib/fixtures.ts'
import { count, dayAndTime, money, oddsText, percentText, signedMoney } from '../lib/format.ts'
import { LockIcon, OpenLockIcon, StatusIcon } from './Icons.tsx'
import { nameOf, type Names } from '../lib/names.ts'

export function TeamBadge({ code, mine = false }: { code: string; mine?: boolean }) {
  return <span className={mine ? 'bd mine' : 'bd'} aria-hidden="true">{code}</span>
}

// Your pick: the team, with its badge ringed, or "Draw".
export function PickLabel({ pick, home, away, names }: { pick: Choice; home: string; away: string; names: Names }) {
  if (pick === 'D') return <span className="pick"><span className="pick-draw">Draw</span></span>
  const code = pick === 'H' ? home : away
  return <span className="pick"><TeamBadge code={code} mine /><span className="pick-name">{nameOf(names, code)}</span></span>
}

export function Confidence({ rating }: { rating: number }) {
  return (
    <span className="conf" role="img" aria-label={`Confidence ${rating} of 5`}>
      {[1, 2, 3, 4, 5].map(n => <i key={n} className={n <= rating ? 'on' : undefined} />)}
    </span>
  )
}

// A live match's minute: 67′, or Live (HT at half-time) when the feed sends none.
export function LiveMinute({ minute, halfTime }: { minute: number | null; halfTime: boolean }) {
  return <span className="live"><i />{halfTime ? 'HT' : minute === null ? 'Live' : `${minute}′`}</span>
}

const WAITING_WORDS = new Map([
  ['postponed', 'Postponed'], ['cancelled', 'Cancelled'], ['suspended', 'Suspended'], ['awarded', 'Awarded'], ['missing', 'Not in the feed'],
])

// How a leg stands, in words, with an icon where it's settled.
export function LegResult({ state, reason }: { state: LegState; reason: string | null }) {
  let tone = 'none'
  let icon: 'good' | 'bad' | 'warn' | null = null
  let text = ''
  let note: string | null = null
  switch (state.kind) {
    case 'won':
      tone = 'good'
      icon = 'good'
      text = state.how === 'promo' ? 'Paid by a promo' : state.how === 'hand' ? 'Won, settled by hand' : 'Won'
      note = state.how === 'score' ? null : reason
      break
    case 'lost':
      tone = state.draw ? 'warn' : 'bad'
      icon = state.draw ? 'warn' : 'bad'
      text = state.how === 'void' ? 'Counted as lost' : state.draw ? 'Lost to a draw' : state.how === 'hand' ? 'Lost, settled by hand' : 'Lost'
      note = state.how === 'score' ? null : reason
      break
    case 'dropped':
      text = 'Dropped'
      note = reason
      break
    case 'final':
      text = 'Finished, settling now'
      break
    case 'live':
      tone = state.standing === 'on track' ? 'good' : state.standing === 'level' ? 'warn' : 'bad'
      text = state.standing === 'on track' ? 'On track' : state.standing === 'level' ? 'Level' : 'Behind'
      note = state.standing === 'level' ? 'A draw would lose this leg' : null
      break
    case 'not started':
      text = 'Not started'
      break
    case 'waiting':
      tone = 'you'
      text = 'Waiting for you'
      break
  }
  return (
    <span className="state">
      <span className={`st ${tone}`}>{icon !== null && <StatusIcon kind={icon} />}{text}</span>
      {note !== null && <span className="state-note">{note}</span>}
    </span>
  )
}

// The score column: the 90-minute score, the running score, the kick-off,
// or why the match didn't finish.
export function ScoreCell({ leg, fixture, state }: { leg: Leg; fixture: Fixture | undefined; state: LegState }) {
  if (state.kind === 'live') {
    return <span className="score">{state.score[0]}–{state.score[1]}<LiveMinute minute={state.minute} halfTime={state.halfTime} /></span>
  }
  const score = leg.settlement?.score90 ?? (state.kind === 'final' ? state.score : null)
  if (score !== null) return <span className="score">{score[0]}–{score[1]}</span>
  const waiting = WAITING_WORDS.get(state.kind === 'waiting' ? state.status : fixture?.status ?? '')
  if (waiting !== undefined) return <span className="score muted">{waiting}</span>
  if (state.kind === 'not started') return <span className="score muted">{dayAndTime(leg.kickoff)}</span>
  return null
}

export type LegActions = {
  waiting: ReadonlySet<string>                    // legs waiting for you, by ID
  corrections: ReadonlyMap<string, Correction>   // legs whose score changed, by ID
  onWaiting: (legId: string) => void
  onCorrection: (legId: string) => void
}

export function LegsTable({ legs, fixtures, names, actions }: {
  legs: readonly Leg[]
  fixtures: ReadonlyMap<number, Fixture>
  names: Names
  actions: LegActions
}) {
  return (
    <table className="legs">
      <thead>
        <tr><th className="c-game">Game</th><th className="c-pick">Your pick</th><th className="r c-odds">Odds</th><th className="c-conf">Confidence</th><th className="c-score">Score</th><th>Result</th></tr>
      </thead>
      <tbody>
        {legs.map(leg => {
          const fixture = fixtures.get(leg.fixtureId)
          const state = legState(leg, fixture)
          const correction = actions.corrections.get(leg.id)
          return (
            <tr key={leg.id}>
              <td><div className="match"><b>{nameOf(names, leg.home)} v {nameOf(names, leg.away)}</b><span>{dayAndTime(leg.kickoff)}</span></div></td>
              <td><PickLabel pick={leg.pick} home={leg.home} away={leg.away} names={names} /></td>
              <td className="r num">{oddsText(leg.odds)}</td>
              <td><Confidence rating={leg.confidence} /></td>
              <td><ScoreCell leg={leg} fixture={fixture} state={state} /></td>
              <td>
                <span className="state">
                  <LegResult state={state} reason={leg.settlement?.reason ?? null} />
                  {actions.waiting.has(leg.id) && (
                    <button type="button" className="link state-link" onClick={() => actions.onWaiting(leg.id)}>Choose what happened</button>
                  )}
                  {correction !== undefined && (
                    <button type="button" className="link state-link" onClick={() => actions.onCorrection(leg.id)}>
                      Score now {correction.to[0]}–{correction.to[1]}. Review it
                    </button>
                  )}
                </span>
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

// The money at the top right of a parlay.
function Payout({ view }: { view: ParlayView }) {
  const parlay = view.parlay
  const legs = parlay.legs.length
  let label: string
  let value: ReactNode
  let note: string
  switch (view.state) {
    case 'won':
      label = 'Profit'
      value = <b className="good-t">{signedMoney(view.profitCents ?? 0)}</b>
      // A bonus bet's stake doesn't come back, so its profit is all it returned.
      note = `${parlay.bonus === true ? 'A bonus bet, so winnings only' : `Returned ${money(view.payoutCents ?? 0)}`}${view.boostCents > 0 ? `, ${money(view.boostCents)} of it boost` : ''}`
      break
    case 'lost':
      label = 'Loss'
      // A lost bonus bet loses $0.00, which stays plain, as every zero does.
      value = <b className={(view.profitCents ?? 0) < 0 ? 'bad-t' : undefined}>{signedMoney(view.profitCents ?? 0)}</b>
      note = view.onlyLossWasADraw ? 'Lost on one leg, to a draw' : view.lostLegs === 1 ? 'Lost on one leg' : `Lost on ${view.lostLegs} legs`
      break
    case 'void':
      label = 'Returned'
      value = <b>{money(view.payoutCents ?? 0)}</b>
      note = `Every leg was dropped, so the ${parlay.bonus === true ? 'bonus bet' : 'stake'} came back`
      break
    default:
      label = 'To return'
      value = <b>{money(view.potentialCents ?? 0)}</b>
      note = legs === 1 ? 'If it lands' : parlay.legs.every(leg => leg.settlement === null) ? `If all ${legs} legs land` : 'If the rest land'
  }
  return <div className="payout"><span>{label}</span>{value}<span>{note}</span></div>
}

export function ParlayStatus({ view }: { view: ParlayView }) {
  if (view.state === 'won') return <span className="st good"><StatusIcon kind="good" />Cashed</span>
  if (view.state === 'lost') return <span className="st bad"><StatusIcon kind="bad" />Lost</span>
  if (view.state === 'void') return <span className="st none">Void</span>
  if (view.live) return <span className="live"><i />In play</span>
  const started = view.parlay.legs.some(leg => leg.settlement !== null)
  return <span className="st none">{started ? 'Still to settle' : 'Not started'}</span>
}

export function ParlayCard({ view, fixtures, names, actions, admin, onEdit, onRemove }: {
  view: ParlayView
  fixtures: ReadonlyMap<number, Fixture>
  names: Names
  actions: LegActions
  admin: boolean
  onEdit: () => void
  onRemove: () => void
}) {
  const parlay = view.parlay
  const legs = parlay.legs.length
  const titleId = `parlay-${parlay.id}`
  const odds = view.odds === null ? 'every leg dropped' : `at ${oddsText(view.odds)}`
  const boost = parlay.boostBps > 0 ? `, ${percentText(parlay.boostBps)} boost` : ''
  const dropped = parlay.legs.filter(leg => leg.settlement?.outcome === 'dropped').length
  return (
    <section className="panel parlay" aria-labelledby={titleId}>
      <div className="parlay-h">
        <div>
          <div className="parlay-t">
            <h2 id={titleId}>Parlay {view.number}</h2>
            <ParlayStatus view={view} />
            {view.locked && <span className="tag"><LockIcon />Locked</span>}
            {legs === 1 && <span className="tag">Single</span>}
            {parlay.bonus === true && <span className="tag">Bonus bet</span>}
          </div>
          <p className="parlay-meta">{count(legs, 'leg', 'legs')}{dropped > 0 && view.odds !== null ? `, ${dropped} dropped,` : ''} {odds}, {money(parlay.stakeCents)} {parlay.bonus === true ? 'bonus bet' : 'staked'}{boost}</p>
        </div>
        <Payout view={view} />
      </div>
      <LegsTable legs={parlay.legs} fixtures={fixtures} names={names} actions={actions} />
      <div className="parlay-f">
        {view.locked && !admin && (
          <span className="lock-note"><LockIcon />Every leg has settled, so this parlay is locked. Turn on Admin mode to change it.</span>
        )}
        {view.locked && admin && <span className="lock-note"><OpenLockIcon />Locked. A change asks why, and goes in the audit log.</span>}
        {!view.locked && <span className="muted small-note">You can change it until every leg has settled.</span>}
        {(!view.locked || admin) && (
          <div className="btn-row">
            <button type="button" className="btn btn-secondary btn-sm" onClick={onEdit}>Edit</button>
            <button type="button" className={view.locked ? 'btn btn-danger btn-sm' : 'btn btn-secondary btn-sm'} onClick={onRemove}>Remove</button>
          </div>
        )}
      </div>
    </section>
  )
}
