// The dialogs My parlays opens (canvas: "A leg waiting for you", "A score
// correction" and the Admin mode boards): what to do with a leg whose match
// didn't finish normally, whether to take a corrected score, and the reason
// a change to a locked parlay needs.
//
// Each one hands its choice to the page and waits. The page saves it and
// answers with null when it worked, or a message to show.
import { useId, useState } from 'react'
import { Button, Hint, Note, Segmented } from '../components/Controls.tsx'
import { StatusIcon } from '../components/Icons.tsx'
import { Dialog } from '../components/Overlays.tsx'
import { TeamBadge } from '../components/Parlay.tsx'
import { MATCH_WORDS } from '../lib/bets/edit.ts'
import { nameOf, pickWords, type Names } from '../lib/names.ts'
import { combinedOdds, payoutCents } from '../lib/bets/odds.ts'
import { parlayOutcome, type Correction } from '../lib/bets/settle.ts'
import type { WaitingStatus } from '../lib/bets/view.ts'
import { byScoreFor, isReason, MAX_REASON, type Leg, type Parlay } from '../lib/bets/week-record.ts'
import { money, oddsText, signedMoney } from '../lib/format.ts'

export type Answer = Promise<string | null>

// A reason box, with its count. The count leaves out spaces at either end,
// as `isReason` does, which is the same check the saving code makes.
function ReasonField({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (value: string) => void; placeholder?: string }) {
  const id = useId()
  const length = [...value.trim()].length
  const long = length > MAX_REASON
  return (
    <div className="field">
      <label className="label" htmlFor={id}>{label}</label>
      <textarea id={id} className={long ? 'input bad' : 'input'} rows={3} value={value} placeholder={placeholder}
        onChange={event => onChange(event.target.value)} aria-describedby={`${id}-count`} />
      <p className="counter" id={`${id}-count`}>{length} of {MAX_REASON}</p>
    </div>
  )
}

// What a leg waiting for you can become.
export type WaitingChoice = { kind: 'drop' } | { kind: 'lost' } | { kind: 'hand'; outcome: 'won' | 'lost'; reason: string }

export function WaitingDialog({ leg, status, parlay, number, legNumber, names, onClose, onChoose }: {
  leg: Leg
  status: WaitingStatus
  parlay: Parlay
  number: number      // the parlay's number in its week
  legNumber: number
  names: Names
  onClose: () => void
  onChoose: (choice: WaitingChoice) => Answer
}) {
  const [kind, setKind] = useState<'drop' | 'lost' | 'hand'>('drop')
  const [outcome, setOutcome] = useState<'won' | 'lost'>('won')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  // Parlay N with this leg dropped: the legs left, their odds, and its return.
  const rest = parlay.legs.filter(each => each.id !== leg.id && each.settlement?.outcome !== 'dropped')
  const restLost = rest.some(each => each.settlement?.outcome === 'lost')
  const restOpen = rest.some(each => each.settlement === null)
  const restOdds = rest.map(each => each.odds)

  async function save() {
    if (kind === 'hand' && !isReason(reason)) {
      setProblem('Say why in 1 to 200 characters.')
      return
    }
    setBusy(true)
    setProblem(null)
    const answer = await onChoose(kind === 'hand' ? { kind, outcome, reason } : { kind })
    setBusy(false)
    if (answer !== null) setProblem(answer)
  }

  const match = `${nameOf(names, leg.home)} v ${nameOf(names, leg.away)}`
  const label = kind === 'drop' ? 'Drop the leg' : kind === 'lost' ? 'Count it as lost' : 'Settle it'
  const choice = (value: typeof kind, title: string, text: string) => (
    <button type="button" className={kind === value ? 'choice on' : 'choice'} role="radio" aria-checked={kind === value} onClick={() => setKind(value)}>
      <span className="radio" aria-hidden="true" />
      <span className="choice-text"><b>{title}</b><span>{text}</span></span>
    </button>
  )
  return (
    <Dialog title={`${match} ${MATCH_WORDS.get(status) ?? 'did not finish'}`} wide onClose={onClose}
      sub="bet365 usually voids a leg when its match doesn't finish normally. Say what it did with yours.">
      <div className="leg-card">
        {leg.pick !== 'D' && <TeamBadge code={leg.pick === 'H' ? leg.home : leg.away} mine />}
        <span><b>{pickWords(leg.pick, leg.home, leg.away, names)} at {oddsText(leg.odds)}</b>, leg {legNumber} of parlay {number}</span>
      </div>
      <div className="choices" role="radiogroup" aria-label="What bet365 did">
        {choice('drop', 'Drop the leg', `bet365 voided it. Parlay ${number} carries on without it, at new odds.`)}
        {choice('lost', 'Count it as lost', `bet365 settled it as a loss, so parlay ${number} loses.`)}
        {choice('hand', 'Settle it by hand', 'bet365 did something else. Choose won or lost, and say why.')}
      </div>
      {kind === 'drop' && (
        <div className="sum">
          {restLost && <div className="sum-row"><span>Parlay {number}</span><b className="bad-t">Already lost on another leg</b></div>}
          {!restLost && rest.length === 0 && <div className="sum-row"><span>Parlay {number}</span><b>Every leg dropped, so the stake comes back</b></div>}
          {!restLost && rest.length > 0 && (
            <>
              <div className="sum-row"><span>Parlay {number}'s odds</span><b>{oddsText(combinedOdds(restOdds))}</b></div>
              <div className="sum-row big"><span>{restOpen ? 'Returns if the rest land' : 'Returns'}</span><b>{money(payoutCents(parlay.stakeCents, restOdds, parlay.boostBps))}</b></div>
            </>
          )}
        </div>
      )}
      {kind === 'lost' && (
        <div className="sum">
          <div className="sum-row big"><span>Parlay {number} loses</span><b className="bad-t">{signedMoney(-parlay.stakeCents)}</b></div>
        </div>
      )}
      {kind === 'hand' && (
        <div className="form">
          <Segmented label="How it settled" value={outcome} onChange={setOutcome}
            options={[{ value: 'won', label: 'Won' }, { value: 'lost', label: 'Lost' }]} />
          <ReasonField label="Why?" value={reason} placeholder="For example: bet365 settled it on the rearranged game" onChange={value => {
            setReason(value)
            setProblem(null)
          }} />
        </div>
      )}
      {kind !== 'hand' && <Hint>The leg keeps a note of why, which the app writes for you.</Hint>}
      <Hint>Not sure yet? Decide later. If the game gets a new date and is played, the leg settles itself.</Hint>
      {problem !== null && <Hint tone="bad">{problem}</Hint>}
      <div className="actions">
        <Button onClick={onClose}>Decide later</Button>
        <Button kind="primary" onClick={save} busy={busy} busyLabel="Saving…">{label}</Button>
      </div>
    </Dialog>
  )
}

// The leg as it settled, and as it would with the corrected score.
function ResultWords({ outcome, draw }: { outcome: 'won' | 'lost' | 'dropped'; draw: boolean }) {
  if (outcome === 'won') return <span className="st good"><StatusIcon kind="good" />Won</span>
  if (outcome === 'dropped') return <span className="st none">Dropped</span>
  return draw ? <span className="st warn"><StatusIcon kind="warn" />Lost to a draw</span> : <span className="st bad"><StatusIcon kind="bad" />Lost</span>
}

function ParlayWords({ parlay }: { parlay: Parlay }) {
  const outcome = parlayOutcome(parlay)
  if (outcome.state === 'won') return <><span className="st good"><StatusIcon kind="good" />Cashed</span><div className="state-note">{signedMoney(outcome.profitCents ?? 0)}, returns {money(outcome.payoutCents ?? 0)}</div></>
  if (outcome.state === 'lost') return <><span className="st bad"><StatusIcon kind="bad" />Lost</span><div className="state-note">{signedMoney(outcome.profitCents ?? 0)}</div></>
  if (outcome.state === 'void') return <span className="st none">Void, stake back</span>
  return <span className="st none">Still to settle</span>
}

export function CorrectionDialog({ leg, correction, parlay, number, legNumber, locked, names, onClose, onAccept, onKeep }: {
  leg: Leg
  correction: Correction
  parlay: Parlay
  number: number
  legNumber: number
  locked: boolean
  names: Names
  onClose: () => void
  onAccept: () => Answer
  onKeep: () => Answer
}) {
  const [busy, setBusy] = useState<'accept' | 'keep' | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const was = correction.from
  const now = correction.to
  const score = (pair: readonly [number, number]) => `${pair[0]}–${pair[1]}`
  const newOutcome = byScoreFor(leg.pick, now)
  const draw = (pair: readonly [number, number]) => pair[0] === pair[1] && leg.pick !== 'D'
  // The parlay as it would be with the corrected score.
  const after: Parlay = {
    ...parlay,
    legs: parlay.legs.map(each => (each.id === leg.id && each.settlement !== null
      ? { ...each, settlement: { ...each.settlement, outcome: newOutcome, byScore: newOutcome, score90: now } }
      : each)),
  }

  async function run(which: 'accept' | 'keep') {
    setBusy(which)
    setProblem(null)
    const answer = await (which === 'accept' ? onAccept() : onKeep())
    setBusy(null)
    if (answer !== null) setProblem(answer)
  }

  return (
    <Dialog title={`${nameOf(names, leg.home)} v ${nameOf(names, leg.away)}'s score changed`} wide onClose={onClose}
      sub={`Your leg settled itself on ${score(was)}. football-data now has ${score(now)} after 90 minutes.`}>
      <div className="leg-card">
        {leg.pick !== 'D' && <TeamBadge code={leg.pick === 'H' ? leg.home : leg.away} mine />}
        <span><b>{pickWords(leg.pick, leg.home, leg.away, names)} at {oddsText(leg.odds)}</b>, leg {legNumber} of parlay {number}</span>
      </div>
      <table className="compare">
        <thead><tr><th><span className="sr-only">What</span></th><th>Settled on {score(was)}</th><th>With {score(now)}</th></tr></thead>
        <tbody>
          <tr><td>Your leg</td><td><ResultWords outcome={leg.settlement?.outcome ?? 'lost'} draw={draw(was)} /></td><td><ResultWords outcome={newOutcome} draw={draw(now)} /></td></tr>
          <tr><td>Parlay {number}</td><td><ParlayWords parlay={parlay} /></td><td><ParlayWords parlay={after} /></td></tr>
        </tbody>
      </table>
      <Hint>Accept {score(now)} if bet365 settled your bet on it. If bet365 kept {score(was)}, keep it: the leg is marked settled by hand, and the app stops asking.</Hint>
      {locked && <Note><p><b>Parlay {number} is locked,</b> so either choice goes in the audit log. The app fills in the reason for you.</p></Note>}
      {problem !== null && <Hint tone="bad">{problem}</Hint>}
      <div className="actions">
        <Button onClick={() => run('keep')} busy={busy === 'keep'} busyLabel="Saving…" disabled={busy !== null}>Keep {score(was)}</Button>
        <Button kind="primary" onClick={() => run('accept')} busy={busy === 'accept'} busyLabel="Saving…" disabled={busy !== null}>Accept {score(now)}</Button>
      </div>
    </Dialog>
  )
}

// Asks for the reason a change to a locked parlay needs, showing what changes.
// With `reasonNeeded` false it only confirms, for removing an open parlay or
// deleting a week with nothing locked in it.
export function ReasonDialog({ title, sub, changes, reasonNeeded, confirmLabel, danger = false, onClose, onConfirm }: {
  title: string
  sub: string
  changes: string[]
  reasonNeeded: boolean
  confirmLabel: string
  danger?: boolean
  onClose: () => void
  onConfirm: (reason: string | undefined) => Answer
}) {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  async function confirm() {
    if (reasonNeeded && !isReason(reason)) {
      setProblem('Say why in 1 to 200 characters.')
      return
    }
    setBusy(true)
    setProblem(null)
    const answer = await onConfirm(reasonNeeded ? reason : undefined)
    setBusy(false)
    if (answer !== null) setProblem(answer)
  }

  return (
    <Dialog title={title} sub={sub} wide onClose={onClose}>
      {changes.length > 0 && (
        <div className="changes">
          {changes.slice(0, 12).map((line, i) => <span key={i}>{line}</span>)}
          {changes.length > 12 && <span className="muted">and {changes.length - 12} more</span>}
        </div>
      )}
      {reasonNeeded && <ReasonField label="Reason" value={reason} placeholder="For example: typed the stake wrong" onChange={value => {
        setReason(value)
        setProblem(null)
      }} />}
      {problem !== null && <Hint tone="bad">{problem}</Hint>}
      <div className="actions">
        <Button onClick={onClose}>Cancel</Button>
        {danger
          ? <button type="button" className="btn btn-danger" onClick={confirm} disabled={busy}>{busy ? 'Saving…' : confirmLabel}</button>
          : <Button kind="primary" onClick={confirm} busy={busy} busyLabel="Saving…">{confirmLabel}</Button>}
      </div>
    </Dialog>
  )
}
