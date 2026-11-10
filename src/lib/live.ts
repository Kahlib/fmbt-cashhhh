// Your weeks and the season's fixtures while the tab is open (step 10 plan,
// smaller choices: Refreshing).
//
// Everything loads when you sign in, and every leg that can settle does.
// Then, every minute while a match is in its live window, the app asks only
// for those matches, and settles again. The whole season reloads every hour
// and when you come back to the tab. Every save goes through here too, one
// job at a time, so a refresh and a save never trip over each other.
import type { AccountApi } from './account/api.ts'
import type { Competition, Week, WeekRecord } from './bets/week-record.ts'
import { EMPTY_WEEK, withGameCodes } from './bets/week-record.ts'
import type { Correction, Waiting } from './bets/settle.ts'
import { loadWeek, loadWeeks, newWeek, saveWeek, settleWeeks, visibleWeeks, type LoadedWeek, type WeekWarning } from './bets/weeks.ts'
import { byId, loadFixtures, loadFixturesBetween, loadSyncStatus, type Fixture, type SyncStatus, type Team } from './fixtures.ts'
import { periodIndex } from './periods.ts'

export const MINUTE = 60_000
export const LIVE_BEFORE = 5 * MINUTE   // a match's live window opens 5 minutes before kick-off
export const LIVE_FOR = 210 * MINUTE    // and closes 3½ hours after it, if the match isn't final sooner
export const SYNC_LATE = 5 * MINUTE     // during a match, the sync is behind once it hasn't worked for this long
export const RELOAD_EVERY = 60 * MINUTE

// Statuses where nothing that matters for settling can change in the next
// minute: a final 90-minute score, or a match that didn't finish normally.
// The hourly reload still catches a postponed match getting a new date.
const DONE = new Set<string>(['finished', 'extra_time', 'penalties', 'postponed', 'suspended', 'cancelled', 'awarded'])

// True from 5 minutes before kick-off until the score is final or 3½ hours
// have passed, as the sync function counts it.
export function inLiveWindow(fixture: { kickoff: string; status: string }, now: number): boolean {
  if (DONE.has(fixture.status)) return false
  const kickoff = Date.parse(fixture.kickoff)
  return now >= kickoff - LIVE_BEFORE && now < kickoff + LIVE_FOR
}

// The kick-off times a match in its live window can have right now, for
// asking the server: from 3½ hours ago up to 5 minutes from now.
export function liveSpan(now: number): { from: string; to: string } {
  return { from: new Date(now - LIVE_FOR).toISOString(), to: new Date(now + LIVE_BEFORE + 1).toISOString() }
}

// True when a match is in its live window and the sync hasn't worked for
// 5 minutes, so the pages warn that scores may be behind.
export function syncBehind(sync: SyncStatus | null, fixtures: Iterable<Fixture>, now: number): boolean {
  for (const fixture of fixtures) {
    if (!inLiveWindow(fixture, now)) continue
    const last = sync?.lastSuccessAt ?? null
    return last === null || now - Date.parse(last) > SYNC_LATE
  }
  return false
}

// One competition's weeks that have fixtures, in the order they're played.
export function periodsOf(fixtures: Iterable<Fixture>, competition: Competition): string[] {
  const periods = new Set<string>()
  for (const fixture of fixtures) if (fixture.competition === competition) periods.add(fixture.period)
  return [...periods].sort((a, b) => periodIndex(a) - periodIndex(b))
}

// The week My parlays opens on: the one with a match on, or else the next
// one to kick off. Once the season's over, its last week.
export function weekToOpen(fixtures: Iterable<Fixture>, competition: Competition, now: number): string | null {
  let live: Fixture | null = null
  let next: Fixture | null = null
  const periods: string[] = []
  for (const fixture of fixtures) {
    if (fixture.competition !== competition) continue
    periods.push(fixture.period)
    if (inLiveWindow(fixture, now) && (live === null || fixture.kickoff < live.kickoff)) live = fixture
    if (fixture.status === 'scheduled' && Date.parse(fixture.kickoff) > now && (next === null || fixture.kickoff < next.kickoff)) next = fixture
  }
  if (live !== null) return live.period
  if (next !== null) return next.period
  return periods.sort((a, b) => periodIndex(b) - periodIndex(a))[0] ?? null
}

// A week's name for maps and lists.
export const weekKey = (week: Week) => `${week.season} ${week.competition} ${week.period}`

// The record a new change starts from: a deleted week starts again empty,
// though its version numbers carry on.
export function editable(loaded: LoadedWeek): WeekRecord {
  return loaded.record.deleted ? EMPTY_WEEK : loaded.record
}

// A week with every leg showing its game's codes as they are now
// (week-record.ts, withGameCodes).
function withCodes(loaded: LoadedWeek, fixtures: ReadonlyMap<number, Fixture>): LoadedWeek {
  const record = withGameCodes(loaded.record, fixtures)
  return record === loaded.record ? loaded : { ...loaded, record }
}

export type InWeek<T> = T & { week: Week }

export type LiveSnapshot = {
  phase: 'loading' | 'ready' | 'failed'  // failed: the first load didn't work, so there's nothing to show
  weeks: LoadedWeek[]                    // every saved week of every season, deleted ones too
  warnings: WeekWarning[]                // weeks with newer versions that didn't open
  fixtures: ReadonlyMap<number, Fixture> // this season's, by football-data's ID
  teams: ReadonlyMap<number, Team>
  sync: SyncStatus | null
  corrections: InWeek<Correction>[]
  waiting: InWeek<Waiting>[]
  loadedAt: number | null                // when the whole season last loaded
  stale: boolean                         // the last load or refresh didn't work
  now: number                            // the time of this snapshot, which the pages count from
}

export type SaveOutcome = 'saved' | 'unchanged' | 'taken'

export class LiveData {
  private state: LiveSnapshot = {
    phase: 'loading', weeks: [], warnings: [], fixtures: new Map(), teams: new Map(), sync: null,
    corrections: [], waiting: [], loadedAt: null, stale: false, now: 0,
  }
  private readonly listeners = new Set<() => void>()
  private queue: Promise<unknown> = Promise.resolve()
  private readonly api: AccountApi
  private readonly dataKey: CryptoKey
  private readonly clock: () => number
  readonly season: number

  // `clock` is the time in milliseconds, so the tests can set it.
  constructor(api: AccountApi, dataKey: CryptoKey, season: number, clock: () => number = Date.now) {
    this.api = api
    this.dataKey = dataKey
    this.season = season
    this.clock = clock
  }

  snapshot = (): LiveSnapshot => this.state

  // React's useSyncExternalStore calls this, and redraws on every change.
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  // The week as it's saved now, or a new empty one.
  week(week: Week): LoadedWeek {
    return this.state.weeks.find(loaded => weekKey(loaded.week) === weekKey(week)) ?? newWeek(week)
  }

  // Loads the season's fixtures, the sync status and every week, then settles.
  loadAll(): Promise<void> {
    return this.serial(async () => {
      try {
        const { fixtures, teams } = await loadFixtures(this.api, this.season)
        const sync = await loadSyncStatus(this.api)
        const { weeks, warnings } = await loadWeeks(this.api, this.dataKey)
        await this.settle(weeks, byId(fixtures), { teams, sync, warnings, loadedAt: this.clock() })
      } catch {
        this.update(this.state.phase === 'loading' ? { phase: 'failed', stale: true } : { stale: true })
      }
    })
  }

  // Asks only for the matches in their live window, and the sync status,
  // then settles again.
  refresh(): Promise<void> {
    return this.serial(async () => {
      if (this.state.phase !== 'ready') return
      try {
        const span = liveSpan(this.clock())
        const fresh = await loadFixturesBetween(this.api, this.state.teams, this.season, span.from, span.to)
        const sync = await loadSyncStatus(this.api)
        const fixtures = new Map(this.state.fixtures)
        for (const fixture of fresh) fixtures.set(fixture.id, fixture)
        await this.settle(this.state.weeks, fixtures, { sync })
      } catch {
        this.update({ stale: true })
      }
    })
  }

  // Saves `next` as the week's next version, then settles, so legs on games
  // that have finished settle straight away. A change to a locked parlay
  // needs `reason`, and saveWeek refuses it without one. 'taken' means
  // another tab saved this week first: it's been reloaded, so look again.
  save(week: Week, next: WeekRecord, reason?: string): Promise<SaveOutcome> {
    return this.serial(async () => {
      const result = await saveWeek(this.api, this.dataKey, this.week(week), next, new Date(this.clock()).toISOString(), reason)
      if (result.result === 'taken') {
        const reloaded = await loadWeek(this.api, this.dataKey, week)
        this.put(reloaded.week, reloaded.warning)
        return 'taken'
      }
      if (result.result === 'unchanged') return 'unchanged'
      this.put(result.week, null)
      try {
        await this.settle(this.state.weeks, new Map(this.state.fixtures), {})
      } catch {
        // The save worked. Settling tries again at the next refresh.
        this.update({ stale: true })
      }
      return 'saved'
    })
  }

  // Moves the snapshot's time on, so "Synced 1 min ago" and the live
  // windows keep up between refreshes.
  tick(): void {
    this.update({})
  }

  private update(next: Partial<LiveSnapshot>): void {
    this.state = { ...this.state, ...next, now: this.clock() }
    for (const listener of this.listeners) listener()
  }

  // Runs one job after the ones before it, whether they worked or not.
  private serial<T>(job: () => Promise<T>): Promise<T> {
    const run = this.queue.then(job, job)
    this.queue = run.catch(() => undefined)
    return run
  }

  // Puts one week in the list, in place of what was there.
  private put(loaded: LoadedWeek, warning: WeekWarning | null): void {
    const key = weekKey(loaded.week)
    const weeks = this.state.weeks.filter(each => weekKey(each.week) !== key).concat(withCodes(loaded, this.state.fixtures))
      .sort((a, b) => a.week.season - b.week.season || a.week.competition.localeCompare(b.week.competition) || periodIndex(a.week.period) - periodIndex(b.week.period))
    const warnings = this.state.warnings.filter(each => weekKey(each.week) !== key).concat(warning === null ? [] : [warning])
    this.update({ weeks, warnings })
  }

  // Settles this season's weeks against `fixtures`, saving any that change,
  // and shows the result, with every leg showing its game's codes as they
  // are now. Weeks from other seasons have no fixtures here, so they're left
  // alone.
  private async settle(weeks: LoadedWeek[], fixtures: Map<number, Fixture>, also: Partial<LiveSnapshot>): Promise<void> {
    const ours = visibleWeeks(weeks).filter(loaded => loaded.week.season === this.season)
    const settled = await settleWeeks(this.api, this.dataKey, ours, fixtures, new Date(this.clock()).toISOString())
    const after = new Map(settled.map(each => [weekKey(each.week.week), each.week]))
    this.update({
      ...also,
      phase: 'ready',
      stale: false,
      fixtures,
      weeks: weeks.map(loaded => withCodes(after.get(weekKey(loaded.week)) ?? loaded, fixtures)),
      corrections: settled.flatMap(each => each.corrections.map(correction => ({ ...correction, week: each.week.week }))),
      waiting: settled.flatMap(each => each.waiting.map(waiting => ({ ...waiting, week: each.week.week }))),
    })
  }
}
