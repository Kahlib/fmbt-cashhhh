// Loading, saving and deleting your weeks (step 9 plan, The flows).
//
// Each week's or stage's bets are one encrypted record, and every save adds
// a new version of it, numbered one past the newest. So two tabs can't
// overwrite each other: the second save finds its number taken. Loading uses
// each week's newest version that opens and checks out, and says when a newer
// one didn't (fmbt-security, section 2).
//
// A parlay locks once every leg in it is settled. After that, any change to
// it, removing it, or deleting its week saves an audit entry along with the
// new version, through save_week_with_audit, so neither exists without the
// other. Adding parlays and changing open ones never need one. Admin mode,
// which asks you for the reason, is the pages' job. Nothing here trusts it
// (fmbt-security, section 11).
import { ServerError, type AccountApi, type SaveResult, type Stored, type WeekRow } from '../account/api.ts'
import { decryptRecord, encryptRecord, RECORD_VERSION } from '../crypto/records.ts'
import { isIsoTime } from '../records/settings.ts'
import { capChanges, describeChanges, isAuditRecord, lockedChanges, sealAuditEntry, type AuditRecord } from './audit.ts'
import { acceptCorrection, settleWeek, type Correction, type FixtureScore, type Waiting } from './settle.ts'
import { EMPTY_WEEK, isReason, isWeekRecord, TOMBSTONE, type Competition, type Week, type WeekRecord } from './week-record.ts'

export type LoadedWeek = {
  week: Week
  record: WeekRecord     // the newest version that opens and checks out, or an empty week if none does
  version: number        // that version's number, or 0 when there's none
  newestVersion: number  // the highest version number saved, so the next save uses one more
}

// A week with newer versions that didn't open or check out. The pages say:
// "A saved version of Matchweek 4 couldn't be opened. Someone may have
// written to your account, or the data is damaged."
export type WeekWarning = { week: Week; unreadable: number }

// The reasons the app gives itself, for the two changes it makes to a locked
// parlay without Admin mode.
export const NOTED_REASON = 'The 90-minute score was noted automatically.'
export const CORRECTION_REASON = 'A score correction from the feed, accepted.'

// Every week, from each one's newest version that opens and checks out.
// Deleted weeks stay in the list, since their version numbers are taken.
// visibleWeeks leaves them out.
export async function loadWeeks(api: AccountApi, dataKey: CryptoKey): Promise<{ weeks: LoadedWeek[]; warnings: WeekWarning[] }> {
  const weeks: LoadedWeek[] = []
  const warnings: WeekWarning[] = []
  const seen = new Set<string>()
  for (const row of await api.latestWeekVersions()) {
    const week = weekOf(row)
    const name = `${week.season} ${week.competition} ${week.period}`
    // The view gives each week once, or the server isn't answering what was asked.
    if (seen.has(name)) throw new ServerError()
    seen.add(name)
    const record = await openWeek(row, dataKey)
    if (record !== null) {
      weeks.push({ week, record, version: row.version_no, newestVersion: row.version_no })
      continue
    }
    // The newest didn't open or check out, so try the older ones.
    const loaded = await loadWeek(api, dataKey, week)
    weeks.push(loaded.week)
    if (loaded.warning !== null) warnings.push(loaded.warning)
  }
  return { weeks: weeks.sort(byWeek), warnings }
}

// One week, from its newest version that opens and checks out. With none,
// it's an empty week, and the next save still numbers past every version.
export async function loadWeek(api: AccountApi, dataKey: CryptoKey, week: Week): Promise<{ week: LoadedWeek; warning: WeekWarning | null }> {
  const rows = (await api.weekVersions(week)).sort((a, b) => b.version_no - a.version_no)
  const newestVersion = rows[0]?.version_no ?? 0
  let unreadable = 0
  for (const row of rows) {
    const record = await openWeek(row, dataKey)
    if (record !== null) return { week: { week, record, version: row.version_no, newestVersion }, warning: warn(week, unreadable) }
    unreadable++
  }
  return { week: { week, record: EMPTY_WEEK, version: 0, newestVersion }, warning: warn(week, unreadable) }
}

// A week that has never been saved.
export function newWeek(week: Week): LoadedWeek {
  return { week, record: EMPTY_WEEK, version: 0, newestVersion: 0 }
}

// The weeks the pages show: not deleted, and with a version that opened.
export function visibleWeeks(weeks: readonly LoadedWeek[]): LoadedWeek[] {
  return weeks.filter(loaded => loaded.version > 0 && !loaded.record.deleted)
}

// True when a change needs an audit entry, so the pages know to ask why: it
// changes or removes a locked parlay, or deletes a week that holds one.
export function needsAudit(before: WeekRecord, after: WeekRecord): boolean {
  return lockedChanges(before, after).length > 0
}

export type SaveWeekResult =
  | { result: 'saved' | 'unchanged'; week: LoadedWeek }
  | { result: 'taken' } // another tab saved this week first: reload it

// Saves `next` as the week's next version. A change that needs an audit
// entry needs a reason too, and saves both together.
export async function saveWeek(
  api: AccountApi, dataKey: CryptoKey, current: LoadedWeek, next: WeekRecord, now: string, reason?: string,
): Promise<SaveWeekResult> {
  // Nothing that fails the record checks is ever saved.
  if (!isWeekRecord(next)) throw new RangeError("That isn't a week record the app can save.")
  if (!isIsoTime(now)) throw new RangeError('Times must look like 2026-11-07T17:00:00.000Z.')
  const changes = describeChanges(current.record, next)
  if (changes.length === 0) return { result: 'unchanged', week: current }
  const version = current.newestVersion + 1
  let audit: AuditRecord | null = null
  // The entry lists the changes to locked parlays only. The rest of the save
  // is in the new version anyway.
  const locked = lockedChanges(current.record, next)
  if (locked.length > 0) {
    if (!isReason(reason)) throw new RangeError('Changing a locked parlay needs a reason of 1 to 200 characters.')
    audit = {
      schema: 1, at: now, week: current.week, fromVersion: current.version, toVersion: version,
      changes: capChanges(locked), reason: reason.trim(),
    }
    if (!isAuditRecord(audit)) throw new RangeError("That change can't go in the audit log.")
  }

  const plain = { id: crypto.randomUUID(), ...current.week, version_no: version, v: RECORD_VERSION }
  const row: WeekRow = { ...plain, ...(await encryptRecord('week_versions', plain, next, dataKey)) }
  let saved: SaveResult
  if (audit === null) {
    saved = await api.addRecord('week_versions', row)
  } else {
    // The entry numbers on from the newest one there is right now.
    const entry = await sealAuditEntry(audit, await api.lastAuditEntry(), dataKey)
    saved = await api.saveWeekWithAudit(row, entry)
  }
  if (saved === 'taken') return { result: 'taken' }
  return { result: 'saved', week: { week: current.week, record: next, version, newestVersion: version } }
}

// Deletes a week by saving a tombstone version: encrypted, so only you can
// write one. The pages only offer it in Admin mode.
export function deleteWeek(api: AccountApi, dataKey: CryptoKey, current: LoadedWeek, now: string, reason?: string): Promise<SaveWeekResult> {
  return saveWeek(api, dataKey, current, TOMBSTONE, now, reason)
}

// Accepts a score correction and saves it. You've just been asked, so on a
// locked parlay the app gives the audit entry's reason itself (step 9 plan,
// decision 5).
export function saveCorrection(
  api: AccountApi, dataKey: CryptoKey, current: LoadedWeek, legId: string, fixtures: ReadonlyMap<number, FixtureScore>, now: string,
): Promise<SaveWeekResult> {
  return saveWeek(api, dataKey, current, acceptCorrection(current.record, legId, fixtures, now), now, CORRECTION_REASON)
}

export type SettledWeek = { week: LoadedWeek; settled: number; noted: number; corrections: Correction[]; waiting: Waiting[] }

// Settles every leg it can, from the fixtures, and saves one new version of
// each week that changed. If another tab changed a week first, it reloads
// that week and settles it again, up to 3 tries, since settling only ever
// adds results.
export async function settleWeeks(
  api: AccountApi, dataKey: CryptoKey, weeks: readonly LoadedWeek[], fixtures: ReadonlyMap<number, FixtureScore>, now: string,
): Promise<SettledWeek[]> {
  const settled: SettledWeek[] = []
  for (const loaded of weeks) settled.push(await settleOne(api, dataKey, loaded, fixtures, now))
  return settled
}

async function settleOne(
  api: AccountApi, dataKey: CryptoKey, loaded: LoadedWeek, fixtures: ReadonlyMap<number, FixtureScore>, now: string,
): Promise<SettledWeek> {
  let current = loaded
  for (let tries = 0; tries < 3; tries++) {
    const result = settleWeek(current.record, fixtures, now)
    // A week with nothing to settle comes back unchanged, with no server
    // call. A locked parlay has nothing left to settle, so settling can only
    // note its scores, and that's the reason its audit entry gives.
    const saved = await saveWeek(api, dataKey, current, result.record, now, NOTED_REASON)
    if (saved.result !== 'taken') {
      return { week: saved.week, settled: result.settled, noted: result.noted, corrections: result.corrections, waiting: result.waiting }
    }
    current = (await loadWeek(api, dataKey, current.week)).week
  }
  throw new ServerError()
}

// The record in a row, or null if it doesn't open or check out.
async function openWeek(row: Stored<WeekRow>, dataKey: CryptoKey): Promise<WeekRecord | null> {
  try {
    const value = await decryptRecord('week_versions', row, dataKey)
    return isWeekRecord(value) ? value : null
  } catch {
    return null
  }
}

// rows.ts has already checked the row's competition is PL or UCL.
const weekOf = (row: WeekRow): Week => ({ season: row.season, competition: row.competition as Competition, period: row.period })

const warn = (week: Week, unreadable: number): WeekWarning | null => (unreadable > 0 ? { week, unreadable } : null)

// Seasons in order, the Premier League before the Champions League, and
// periods in the order they're played.
const PERIODS = [
  ...Array.from({ length: 38 }, (_, i) => `MW${i + 1}`), ...Array.from({ length: 8 }, (_, i) => `MD${i + 1}`), 'KPO', 'R16', 'QF', 'SF', 'F',
]
const byWeek = (a: LoadedWeek, b: LoadedWeek) =>
  a.week.season - b.week.season || a.week.competition.localeCompare(b.week.competition) || PERIODS.indexOf(a.week.period) - PERIODS.indexOf(b.week.period)
