// Build parlay, with its bet slip (canvas "FMBT My parlays screens": Build
// parlay, and Admin mode: changing a locked parlay). KMan's design, 8
// November 2026: the games still to play, this week first and later weeks
// below; choose a team or the draw, and it goes on the slip, where you type
// bet365's odds and your confidence. A parlay stays in one week and one
// competition, so once the slip has a game, the other weeks grey out.
//
// Editing a saved parlay uses the same page, with the slip filled in.
import { useId, useState, type ReactNode } from 'react'
import { useAdmin } from '../components/admin.ts'
import { Button, Hint, Note, Segmented } from '../components/Controls.tsx'
import { CrossIcon, LockIcon, StatusIcon } from '../components/Icons.tsx'
import { PageHead } from '../components/Layout.tsx'
import { LiveMinute, TeamBadge } from '../components/Parlay.tsx'
import { nameOf, pickWords, teamNames, type Names } from '../lib/names.ts'
import { ServerError } from '../lib/account/api.ts'
import { lockedChanges } from '../lib/bets/audit.ts'
import { parseBoost, parseOdds, parseStake } from '../lib/bets/inputs.ts'
import { boostCents, combinedOdds, payoutCents } from '../lib/bets/odds.ts'
import { isParlayLocked } from '../lib/bets/settle.ts'
import { changeWords, legState } from '../lib/bets/view.ts'
import { isReason, type EntryProblem, type Leg, type Pick as Choice, type Week, type WeekRecord } from '../lib/bets/week-record.ts'
import { EMPTY_SLIP, hasStarted, newSlipLeg, recordFromSlip, WAITING, type Slip, type SlipLeg } from '../lib/bets/slip.ts'
import type { Fixture } from '../lib/fixtures.ts'
import { clockTime, dayAndTime, dayRange, longDay, money, oddsText } from '../lib/format.ts'
import { editable, periodsOf, weekToOpen, type LiveData, type LiveSnapshot } from '../lib/live.ts'
import { periodName } from '../lib/periods.ts'
import { ReasonDialog, type Answer } from './LegDialogs.tsx'
import { OFFLINE, TAKEN } from './messages.ts'

const NOT_SAVED = "That parlay couldn't be saved. Nothing has changed."
const LEFT_THE_FEED = 'One of the games has left the football-data feed. Take it off the slip, or cancel to keep the parlay as it is.'

const PROBLEMS: Record<EntryProblem | 'gone', string> = {
  deleted: 'That week was deleted. Reload the page and try again.',
  'week full': 'That week already holds 100 parlays or 500 legs, which is as many as one week can.',
  stake: 'Type a stake from $0.01 to $10,000.',
  boost: 'Type a boost from 0.01% to 100%, or leave it empty.',
  'no legs': 'Add at least one game.',
  'too many legs': 'A parlay can have up to 40 legs.',
  'same game twice': 'A game can only be in a parlay once.',
  'not this week': 'Every game in a parlay has to be from the same week.',
  pick: 'Choose a team or the draw for every game.',
  odds: 'Type odds like −110 or +150 for every leg.',
  confidence: 'Choose a confidence from 1 to 5 for every leg.',
  'payout too big': 'That parlay could pay over $100 million, which is more than the app allows.',
  'bad fixture': "One of the games doesn't look right in the feed, so it can't be saved.",
  gone: 'That parlay is no longer in its week. It may have been removed in another tab.',
}

export function BuildParlay({ live, snapshot, slip, onSlip, onDone, onCancel }: {
  live: LiveData
  snapshot: LiveSnapshot
  slip: Slip
  onSlip: (slip: Slip) => void
  onDone: (toast: string, period: string) => void
  onCancel: () => void
}) {
  const admin = useAdmin()
  const [shownWeeks, setShownWeeks] = useState(3)
  const [problem, setProblem] = useState<string | null>(null)
  const [tried, setTried] = useState(false)
  const [busy, setBusy] = useState(false)
  const [asking, setAsking] = useState<{ week: Week; next: WeekRecord; changes: string[]; number: number } | null>(null)
  const names = teamNames(snapshot.teams)
  const now = snapshot.now
  const fixtures = snapshot.fixtures
  const competition = slip.competition
  const periods = periodsOf(fixtures.values(), competition)
  const current = weekToOpen(fixtures.values(), competition, now)
  const startAt = Math.max(0, current === null ? 0 : periods.indexOf(current))
  const editingWeek: Week | null = slip.editing !== null && slip.period !== null ? { season: live.season, competition, period: slip.period } : null
  const editingRecord = editingWeek === null ? null : editable(live.week(editingWeek))
  const editingIndex = editingRecord?.parlays.findIndex(parlay => parlay.id === slip.editing) ?? -1
  const editingParlay = editingIndex === -1 ? null : editingRecord?.parlays[editingIndex] ?? null
  const locked = editingParlay !== null && isParlayLocked(editingParlay)

  // Picking a game: a new game joins the slip, the same pick again takes it
  // off, and another pick on the same game swaps it. A swapped pick settles
  // from the score again, since how the old pick settled doesn't carry over.
  function choose(fixture: Fixture, pick: Choice) {
    if (slip.period !== null && (fixture.period !== slip.period || fixture.competition !== slip.competition)) return
    const at = slip.legs.findIndex(leg => leg.fixtureId === fixture.id)
    let legs: SlipLeg[]
    if (at === -1) legs = [...slip.legs, newSlipLeg(fixture.id, pick)]
    else if (slip.legs[at].pick === pick) legs = slip.legs.filter((_, i) => i !== at)
    else legs = slip.legs.map((leg, i) => (i === at ? { ...leg, pick, how: 'score', voided: null } : leg))
    onSlip({ ...slip, legs, period: legs.length > 0 || slip.editing !== null ? fixture.period : null })
  }

  function changeLeg(at: number, change: Partial<SlipLeg>) {
    onSlip({ ...slip, legs: slip.legs.map((leg, i) => (i === at ? { ...leg, ...change } : leg)) })
  }

  function removeLeg(at: number) {
    const legs = slip.legs.filter((_, i) => i !== at)
    onSlip({ ...slip, legs, period: legs.length > 0 || slip.editing !== null ? slip.period : null })
  }

  // What the slip adds up to, once every leg's odds read.
  const odds = slip.legs.map(leg => parseOdds(leg.odds))
  const stake = parseStake(slip.stake)
  const boost = parseBoost(slip.boost)
  const ready = odds.length > 0 && odds.every(each => each !== null) && stake !== null && boost !== null
  const legOdds = odds.filter((each): each is number => each !== null)
  // A parlay being changed can have legs you dropped in My parlays. The sum
  // shows the slip as you placed it, then what it pays without them.
  const dropped = slip.legs.filter(leg => leg.voided === 'dropped').length
  const keptOdds = odds.filter((each, i): each is number => each !== null && slip.legs[i].voided !== 'dropped')
  const slipFixtures = slip.legs.map(leg => fixtures.get(leg.fixtureId))
  const allFinished = slipFixtures.length > 0 && slipFixtures.every(fixture => fixture !== undefined && ['finished', 'extra_time', 'penalties'].includes(fixture.status))

  async function save() {
    setTried(true)
    setProblem(null)
    if (slip.period === null || slip.legs.length === 0) return setProblem(PROBLEMS['no legs'])
    if (slip.legs.some(leg => !fixtures.has(leg.fixtureId))) return setProblem(LEFT_THE_FEED)
    if (!ready || stake === null || boost === null) return setProblem('Fix the boxes marked above, then save.')
    if (slip.legs.some(leg => leg.confidence < 1)) return setProblem(PROBLEMS.confidence)
    if (slip.legs.some(leg => leg.how !== 'score' && !isReason(leg.reason))) return setProblem('Say why each leg settled by hand or by a promo, in 1 to 200 characters.')

    const week: Week = { season: live.season, competition, period: slip.period }
    const base = editable(live.week(week))
    const entry = { stakeCents: stake, boostBps: boost, legs: slip.legs.map((leg, i) => ({ fixtureId: leg.fixtureId, pick: leg.pick, odds: legOdds[i], confidence: leg.confidence })) }
    let made: ReturnType<typeof recordFromSlip>
    try {
      made = recordFromSlip(base, week, slip, entry, fixtures, Date.now())
    } catch {
      // Only something the checks above should have caught, such as a
      // reason that isn't 1 to 200 characters, can get here.
      return setProblem(NOT_SAVED)
    }
    if (!made.ok) return setProblem(PROBLEMS[made.problem])
    const next = made.record

    const changes = lockedChanges(base, next)
    const number = slip.editing === null ? next.parlays.length : editingIndex + 1
    if (changes.length > 0) {
      if (!admin.on) return setProblem('This parlay is locked. Turn on Admin mode to change it.')
      setAsking({ week, next, changes: changes.map(changeWords), number })
      return
    }
    setBusy(true)
    const answer = await store(week, next, number)
    setBusy(false)
    if (answer !== null) setProblem(answer)
  }

  async function store(week: Week, next: WeekRecord, number: number, reason?: string): Answer {
    try {
      const outcome = await live.save(week, next, reason)
      if (outcome === 'taken') return TAKEN
      const done = outcome === 'unchanged' ? 'Nothing changed, so nothing was saved.'
        : reason !== undefined ? `Parlay ${number} saved. The change is in the audit log.`
          : slip.editing !== null ? `Parlay ${number} saved.` : `Parlay ${number} saved to ${periodName(week.period)}.`
      onSlip({ ...EMPTY_SLIP, competition: week.competition })
      onDone(done, week.period)
      return null
    } catch (error) {
      return error instanceof ServerError || !(error instanceof RangeError) ? OFFLINE : NOT_SAVED
    }
  }

  const title = slip.editing === null ? 'Build parlay' : `Edit parlay ${editingIndex + 1}`
  const status = slip.editing !== null
    ? `${slip.period === null ? '' : `${periodName(slip.period)}. `}${locked ? 'This parlay is locked, so saving a change asks why, and the change goes in the audit log.' : 'You can change it until every leg has settled.'}`
    : slip.started ? 'Logging a parlay you placed before kick-off. Legs on finished games settle as soon as you save.'
      : 'Choose your games, then type the odds bet365 gave each pick.'
  const otherCompetition = slip.legs.length > 0 || slip.editing !== null
  const competitionSwitch = (
    <div className="segmented" role="group" aria-label="Competition">
      {(['PL', 'UCL'] as const).map(each => (
        <button key={each} type="button" className={each === competition ? 'on' : undefined} aria-pressed={each === competition}
          disabled={otherCompetition && each !== competition} onClick={() => onSlip({ ...slip, competition: each, started: false })}>
          {each}
        </button>
      ))}
    </div>
  )

  // The games, by week and day.
  function gameRow(fixture: Fixture, off: boolean, showScore: boolean): ReactNode {
    const leg = slip.legs.find(each => each.fixtureId === fixture.id)
    const waiting = WAITING.has(fixture.status)
    const state = legState({ pick: 'H', settlement: null }, fixture)
    const score = state.kind === 'live' || state.kind === 'final' ? state.score : null
    const pickButton = (pick: Choice, label: string, words: string) => (
      <button key={pick} type="button" className={leg?.pick === pick ? 'pick-btn on' : 'pick-btn'} aria-pressed={leg?.pick === pick}
        aria-label={words} disabled={off} onClick={() => choose(fixture, pick)}>{label}</button>
    )
    return (
      <div key={fixture.id} className={off ? 'game off' : 'game'}>
        <span className="game-time">
          {waiting ? 'Postponed' : state.kind === 'live' ? <LiveMinute minute={state.minute} halfTime={state.halfTime} /> : clockTime(fixture.kickoff)}
        </span>
        <span className="teams">
          <TeamBadge code={fixture.home} mine={leg?.pick === 'H'} />{nameOf(names, fixture.home)}
          {showScore && score !== null ? <span className="fs">{score[0]}–{score[1]}</span> : <span className="v">v</span>}
          {nameOf(names, fixture.away)}<TeamBadge code={fixture.away} mine={leg?.pick === 'A'} />
        </span>
        {waiting ? <span className="game-note">Can't be picked until it has a date</span> : (
          <span className="picks">
            {pickButton('H', fixture.home, `${nameOf(names, fixture.home)} to win`)}
            {pickButton('D', 'Draw', 'Draw')}
            {pickButton('A', fixture.away, `${nameOf(names, fixture.away)} to win`)}
          </span>
        )}
      </div>
    )
  }

  function weekBlock(period: string, games: Fixture[], note: ReactNode, head: ReactNode): ReactNode {
    const off = slip.period !== null && slip.period !== period
    const days: { day: string; games: Fixture[] }[] = []
    for (const fixture of games) {
      const day = WAITING.has(fixture.status) ? 'New date to come' : longDay(fixture.kickoff)
      const last = days[days.length - 1]
      if (last !== undefined && last.day === day) last.games.push(fixture)
      else days.push({ day, games: [fixture] })
    }
    return (
      <div className="week-block" key={period}>
        <div className="week-h"><h3>{periodName(period)}</h3>{head}</div>
        {off && <p className="week-note">Greyed out: your slip has {periodName(slip.period ?? '')} games, and a parlay stays in one week.</p>}
        {note}
        {days.map(day => (
          <div key={day.day}>
            <div className="day">{day.day}</div>
            {day.games.map(fixture => gameRow(fixture, off, slip.started))}
          </div>
        ))}
      </div>
    )
  }

  const byKickoff = (a: Fixture, b: Fixture) => a.kickoff.localeCompare(b.kickoff) || a.id - b.id
  const gamesOf = (period: string) => [...fixtures.values()].filter(fixture => fixture.competition === competition && fixture.period === period).sort(byKickoff)
  const games: ReactNode[] = []
  if (slip.started) {
    // This week's games that have started, or the slip's week when editing.
    const period = slip.period ?? current
    if (period !== null) {
      const started = gamesOf(period).filter(fixture => hasStarted(fixture, now))
      games.push(weekBlock(period, started,
        <p className="week-note">For a parlay you placed before kick-off and are logging now.</p>,
        <button type="button" className="link" onClick={() => onSlip({ ...slip, started: false })}>Back to games still to play</button>))
    }
  } else {
    for (const period of periods.slice(startAt, startAt + shownWeeks)) {
      const all = gamesOf(period)
      const toPlay = all.filter(fixture => !hasStarted(fixture, now))
      const startedCount = all.length - toPlay.length
      const kickoffs = all.map(fixture => fixture.kickoff)
      const head = period === current && startedCount > 0
        ? <button type="button" className="link" onClick={() => onSlip({ ...slip, started: true, period: slip.legs.length > 0 ? slip.period : null })}>Show the {startedCount === 1 ? 'game' : `${startedCount} games`} that {startedCount === 1 ? 'has' : 'have'} started</button>
        : kickoffs.length > 0 ? <span>{dayRange(kickoffs[0], kickoffs[kickoffs.length - 1])}</span> : null
      if (toPlay.length > 0 || period === current) games.push(weekBlock(period, toPlay, null, head))
    }
  }
  const moreWeeks = !slip.started && startAt + shownWeeks < periods.length

  return (
    <>
      <PageHead title={title} admin={admin} status={status}
        right={<>{competitionSwitch}<Button onClick={onCancel}>Back to My parlays</Button></>} />
      <div className="grid">
        <section className="panel span-7" aria-labelledby="games-title">
          <div className="ph-row">
            <h2 className="ptitle" id="games-title">{slip.started ? 'Games that have started' : 'Games still to play'}</h2>
            <span className="count">{competition === 'PL' ? 'Premier League' : 'Champions League'}</span>
          </div>
          <div>{games.length > 0 ? games : <Hint>No games left to play in this competition.</Hint>}</div>
          {moreWeeks && <div><Button onClick={() => setShownWeeks(shownWeeks + 3)}>Show later weeks</Button></div>}
        </section>

        <section className="panel span-5 slip-panel" aria-labelledby="slip-title">
          <div className="ph-row">
            <h2 className="ptitle" id="slip-title">{slip.editing === null ? 'Bet slip' : `Parlay ${editingIndex + 1}`}</h2>
            {locked ? <span className="tag"><LockIcon />Locked</span>
              : <span className="count">{slip.period === null ? 'Empty' : `${periodName(slip.period)}, ${slip.legs.length === 1 ? '1 leg' : `${slip.legs.length} legs`}`}</span>}
          </div>
          {slip.legs.length === 0 && <Hint>Choose a team or the draw in a game to add it here.</Hint>}
          {slip.legs.length > 0 && (
            <div className="slip-legs">
              {slip.legs.map((leg, i) => (
                <SlipLegCard key={leg.fixtureId} leg={leg} fixture={fixtures.get(leg.fixtureId)} names={names} now={now} tried={tried}
                  saved={editingParlay?.legs.find(each => each.fixtureId === leg.fixtureId)}
                  onChange={change => changeLeg(i, change)} onRemove={() => removeLeg(i)} />
              ))}
            </div>
          )}
          <div className="two">
            <Affix label="Stake" before="$" value={slip.stake} onChange={value => onSlip({ ...slip, stake: value })}
              problem={(tried || slip.stake !== '') && stake === null ? 'Type a stake from $0.01 to $10,000.' : null} />
            <Affix label="Boost, if bet365 gave one" after="%" value={slip.boost} onChange={value => onSlip({ ...slip, boost: value })}
              problem={boost === null ? 'Type a boost from 0.01% to 100%, or leave it empty.' : null} />
          </div>
          {allFinished && slip.editing === null && (
            <Note><p><b>Every game here has finished,</b> so this parlay settles and locks as soon as you save it. Check it first: changing it after that needs Admin mode.</p></Note>
          )}
          {ready && stake !== null && boost !== null && (
            <div className="sum">
              <div className="sum-row"><span>Odds, as bet365 shows them</span><b>{oddsText(combinedOdds(legOdds))}</b></div>
              <div className="sum-row big"><span>Returns</span><b>{money(payoutCents(stake, legOdds, boost))}</b></div>
              {boost > 0 && <div className="sum-row"><span>Boost included</span><b>{money(boostCents(stake, legOdds, boost))}</b></div>}
              <div className="sum-row"><span>Profit if every leg lands</span><b>{money(payoutCents(stake, legOdds, boost) - stake)}</b></div>
              {dropped > 0 && (
                <div className="sum-row">
                  <span>{dropped === 1 ? 'Without the dropped leg' : `Without the ${dropped} dropped legs`}</span>
                  <b>{keptOdds.length === 0 ? `${money(stake)} back` : `${oddsText(combinedOdds(keptOdds))}, returns ${money(payoutCents(stake, keptOdds, boost))}`}</b>
                </div>
              )}
            </div>
          )}
          {slip.legs.length > 0 && <Hint>This should match your bet365 slip to the cent. If it doesn't, check each leg's odds.</Hint>}
          {problem !== null && <Hint tone="bad">{problem}</Hint>}
          <div className="actions">
            <Button onClick={() => onSlip(slip.editing === null ? EMPTY_SLIP : { ...EMPTY_SLIP, competition })} disabled={busy}>{slip.editing === null ? 'Clear slip' : 'Cancel'}</Button>
            <Button kind="primary" onClick={save} busy={busy} busyLabel="Saving…">{slip.editing === null ? 'Save parlay' : 'Save changes'}</Button>
          </div>
        </section>
      </div>
      {asking !== null && (
        <ReasonDialog title={`Why are you changing parlay ${asking.number}?`} sub="It's locked, so the change goes in the audit log with your reason."
          changes={asking.changes} reasonNeeded confirmLabel="Save change" onClose={() => setAsking(null)}
          onConfirm={async reason => {
            const answer = await store(asking.week, asking.next, asking.number, reason)
            if (answer === null) setAsking(null)
            return answer
          }} />
      )}
    </>
  )
}

// A box with a $ before it or a % after it.
function Affix({ label, before, after, value, onChange, problem }: {
  label: string
  before?: string
  after?: string
  value: string
  onChange: (value: string) => void
  problem: string | null
}) {
  const id = useId()
  return (
    <div className="field">
      <label className="label" htmlFor={id}>{label}</label>
      <div className={problem === null ? 'affix' : 'affix bad'}>
        {before !== undefined && <span aria-hidden="true">{before}</span>}
        <input id={id} className={before === undefined ? 'first' : undefined} inputMode="decimal" autoComplete="off" value={value}
          onChange={event => onChange(event.target.value)} aria-invalid={problem !== null || undefined}
          aria-describedby={problem === null ? undefined : `${id}-problem`} />
        {after !== undefined && <span className="after" aria-hidden="true">{after}</span>}
      </div>
      {problem !== null && <Hint tone="bad" id={`${id}-problem`}>{problem}</Hint>}
    </div>
  )
}

// How a leg was settled in My parlays, on a game that hasn't started or
// that didn't finish normally: [words, tone].
function settledWords(leg: SlipLeg): [string, 'good' | 'bad' | 'none'] {
  if (leg.voided === 'dropped') return ['Dropped', 'none']
  if (leg.voided === 'lost') return ['Counted as lost', 'bad']
  if (leg.how === 'promo') return ['Paid by a promo', 'good']
  return leg.outcome === 'won' ? ['Won, settled by hand', 'good'] : ['Lost, settled by hand', 'bad']
}

// One leg on the slip: its odds, your confidence, and, for a game that has
// started, how it settles. A leg settled in My parlays on a game that hasn't
// started, or dropped or counted as lost, shows how, and stays that way
// unless you change it.
function SlipLegCard({ leg, fixture, saved, names, now, tried, onChange, onRemove }: {
  leg: SlipLeg
  fixture: Fixture | undefined
  saved: Leg | undefined   // the leg as it's saved, when changing a parlay
  names: Names
  now: number
  tried: boolean
  onChange: (change: Partial<SlipLeg>) => void
  onRemove: () => void
}) {
  const oddsId = useId()
  const confidenceId = useId()
  if (fixture === undefined) {
    const teams = saved === undefined ? 'A game' : `${nameOf(names, saved.home)} v ${nameOf(names, saved.away)}`
    return (
      <div className="slip-leg">
        <div className="slip-leg-h">
          <div className="slip-pick"><div><b>{teams}</b><small>No longer in the football-data feed</small></div></div>
          <button type="button" className="x-btn" aria-label={`Take ${teams} off the slip`} onClick={onRemove}><CrossIcon /></button>
        </div>
        <Hint>The parlay can't be saved with it on the slip. Take it off to save the rest, or cancel to keep the parlay as it is.</Hint>
      </div>
    )
  }
  const odds = parseOdds(leg.odds)
  const oddsProblem = (tried || leg.odds !== '') && odds === null ? 'Type odds like −110 or +150.' : null
  const state = legState({ pick: leg.pick, settlement: null }, fixture)
  const started = hasStarted(fixture, now)
  const settledBefore = leg.voided !== null || (!started && leg.how !== 'score')
  // A settlement you've just taken off a leg on a game that hasn't started.
  const reopened = !settledBefore && !started && saved !== undefined && saved.settlement !== null
  const where = state.kind === 'final' ? `finished ${state.score[0]}–${state.score[1]}`
    : state.kind === 'live' ? `in play, ${state.score[0]}–${state.score[1]}`
      : state.kind === 'waiting' ? state.status
        : dayAndTime(fixture.kickoff)
  return (
    <div className="slip-leg">
      <div className="slip-leg-h">
        <div className="slip-pick">
          {leg.pick === 'D' ? <span className="pick-draw">Draw</span> : <TeamBadge code={leg.pick === 'H' ? fixture.home : fixture.away} mine />}
          <div><b>{pickWords(leg.pick, fixture.home, fixture.away, names)}</b><small>{nameOf(names, fixture.home)} v {nameOf(names, fixture.away)}, {where}</small></div>
        </div>
        <button type="button" className="x-btn" aria-label={`Take ${pickWords(leg.pick, fixture.home, fixture.away, names)} off the slip`} onClick={onRemove}><CrossIcon /></button>
      </div>
      <div className="slip-row">
        <div className="field">
          <label className="label" htmlFor={oddsId}>Odds</label>
          <input id={oddsId} className={oddsProblem === null ? 'input sm' : 'input sm bad'} autoComplete="off" inputMode="text" value={leg.odds}
            placeholder="−110" onChange={event => onChange({ odds: event.target.value })} aria-invalid={oddsProblem !== null || undefined} />
        </div>
        <div className="field">
          <span className="label" id={confidenceId}>Confidence</span>
          <span className="conf-pick" role="group" aria-labelledby={confidenceId}>
            {[1, 2, 3, 4, 5].map(n => (
              <button key={n} type="button" className={n <= leg.confidence ? 'on' : undefined} aria-label={`${n} of 5`} aria-pressed={n === leg.confidence}
                onClick={() => onChange({ confidence: n })} />
            ))}
          </span>
        </div>
      </div>
      {oddsProblem !== null && <Hint tone="bad">{oddsProblem}</Hint>}
      {tried && leg.confidence < 1 && <Hint tone="bad">Choose a confidence from 1 to 5.</Hint>}
      {settledBefore && (
        <div className="settles">
          <span className="label">How it settled</span>
          <span className={`st ${settledWords(leg)[1]}`}>{settledWords(leg)[0]}</span>
          {leg.how !== 'score' && leg.reason !== '' && <Hint>{leg.reason}</Hint>}
          <button type="button" className="link" onClick={() => onChange({ voided: null, how: 'score' })}>Change how it settled</button>
        </div>
      )}
      {reopened && (
        <Hint>{WAITING.has(fixture.status) ? 'Saving puts it back to waiting for you in My parlays.' : 'It settles from the 90-minute score once the match is over.'}</Hint>
      )}
      {started && !settledBefore && (
        <div className="settles">
          <Segmented label="How it settles" value={leg.how} onChange={how => onChange({ how })}
            options={[{ value: 'score', label: 'From the score' }, { value: 'promo', label: 'Paid by a promo' }, { value: 'hand', label: 'By hand' }]} />
          {leg.how === 'score' && state.kind === 'final' && (
            state.outcome === 'won'
              ? <span className="st good"><StatusIcon kind="good" />Settles as won on {state.score[0]}–{state.score[1]}</span>
              : <span className={state.draw ? 'st warn' : 'st bad'}><StatusIcon kind={state.draw ? 'warn' : 'bad'} />Settles as lost on {state.score[0]}–{state.score[1]}</span>
          )}
          {leg.how === 'score' && state.kind !== 'final' && <Hint>It settles from the 90-minute score once the match is over.</Hint>}
          {leg.how === 'promo' && <ReasonInput label="What was the promo?" value={leg.reason} placeholder="For example: 2-Up, they went 2–0 up" onChange={reason => onChange({ reason })} tried={tried} />}
          {leg.how === 'promo' && <span className="st good"><StatusIcon kind="good" />Counts as won, since the promo paid it</span>}
          {leg.how === 'hand' && (
            <>
              <Segmented label="It" value={leg.outcome} onChange={outcome => onChange({ outcome })}
                options={[{ value: 'won', label: 'Won' }, { value: 'lost', label: 'Lost' }]} />
              <ReasonInput label="Why?" value={leg.reason} placeholder="For example: bet365 paid it early" onChange={reason => onChange({ reason })} tried={tried} />
            </>
          )}
        </div>
      )}
    </div>
  )
}

function ReasonInput({ label, value, placeholder, onChange, tried }: { label: string; value: string; placeholder: string; onChange: (value: string) => void; tried: boolean }) {
  const id = useId()
  const bad = tried && !isReason(value)
  return (
    <div className="field">
      <label className="label" htmlFor={id}>{label}</label>
      <input id={id} className={bad ? 'input bad' : 'input'} value={value} placeholder={placeholder} maxLength={200}
        onChange={event => onChange(event.target.value)} aria-invalid={bad || undefined} />
    </div>
  )
}
