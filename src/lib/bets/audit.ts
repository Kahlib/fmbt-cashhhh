// The audit log (project plan, Locking): every change to a locked week, with
// what changed, from what to what, when and why. Each entry is encrypted like
// a week, and the database only ever adds entries, never changes or deletes
// one, even for you (fmbt-security, section 5).
//
// The entries form a chain. Entry 1 has no previous hash, and every later one
// carries the SHA-256 of the previous entry's ciphertext. That hash is a
// plain column, so it's inside the entry's AAD, and changing it stops the
// entry opening. So when the log loads, a missing, swapped or replaced entry
// shows.
import type { AccountApi, AuditRow, Stored } from '../account/api.ts'
import { isWeekKey } from '../account/rows.ts'
import { fromBase64, toHex } from '../crypto/bytes.ts'
import { decryptRecord, encryptRecord, RECORD_VERSION } from '../crypto/records.ts'
import { isIsoTime } from '../records/settings.ts'
import { hasExactly, isReason, isScore, isWhole, type Leg, type Settlement, type Week, type WeekRecord } from './week-record.ts'

// A value in a change: a stake in cents, odds, a pick, a score, and so on.
export type ChangeValue = null | boolean | number | string | [number, number]
export type Change = { what: string; from: ChangeValue; to: ChangeValue }

// An audit_entries row, decrypted (claude/fmbt-database-and-threat-model.md, section 3).
export type AuditRecord = {
  schema: 1
  at: string           // when, as toISOString() writes it
  week: Week
  fromVersion: number  // the version the change started from
  toVersion: number    // the version it saved
  changes: Change[]
  reason: string
}

// More than this, and the last change says how many more there were. Every
// version is kept, so nothing is lost.
export const MAX_CHANGES = 1000

const isChangeValue = (value: unknown): value is ChangeValue =>
  value === null || typeof value === 'boolean' || Number.isSafeInteger(value) || isReason(value) || isScore(value)

function isChange(value: unknown): value is Change {
  return hasExactly(value, ['what', 'from', 'to']) && isReason(value.what) && isChangeValue(value.from) && isChangeValue(value.to)
}

// Checks a decrypted audit entry before anything uses it (fmbt-security, section 2).
export function isAuditRecord(value: unknown): value is AuditRecord {
  if (!hasExactly(value, ['schema', 'at', 'week', 'fromVersion', 'toVersion', 'changes', 'reason'])) return false
  const { schema, at, week, fromVersion, toVersion, changes, reason } = value
  return schema === 1 && isIsoTime(at) && isWeekKey(week)
    && isWhole(fromVersion, 1, 1_000_000) && isWhole(toVersion, fromVersion + 1, 1_000_000)
    && Array.isArray(changes) && changes.length >= 1 && changes.length <= MAX_CHANGES && changes.every(isChange)
    && isReason(reason)
}

// ---------------------------------------------------------------------------
// What changed
// ---------------------------------------------------------------------------

// The fields of a settlement that the log shows. What the score said always
// follows the score and the pick, so it's left out.
const SETTLEMENT_FIELDS = [
  ['outcome', 'outcome'], ['score90', '90-minute score'], ['how', 'how it settled'], ['promo', 'promo'], ['reason', 'reason'],
] as const

const same = (a: ChangeValue, b: ChangeValue) => JSON.stringify(a) === JSON.stringify(b)

// Every difference between two versions of a week. Parlays and legs are
// matched by their IDs, and numbered as they were before the change. Every
// field is compared, so an empty list means the two versions are the same.
export function describeChanges(before: WeekRecord, after: WeekRecord): Change[] {
  const changes: Change[] = []
  const note = (what: string, from: ChangeValue, to: ChangeValue) => {
    if (!same(from, to)) changes.push({ what, from, to })
  }
  const happened = (what: string) => changes.push({ what, from: null, to: null })

  if (before.deleted !== after.deleted) happened(after.deleted ? 'Week deleted' : 'Week started again')
  matchUp(before.parlays, after.parlays, {
    label: (_parlay, index) => `Parlay ${index + 1}`,
    added: happened,
    removed: happened,
    reordered: () => happened('Parlays reordered'),
    kept: (was, now, label) => {
      note(`${label} · stake in cents`, was.stakeCents, now.stakeCents)
      matchUp(was.legs, now.legs, {
        label: leg => `${label} · ${leg.home} v ${leg.away}`,
        added: happened,
        removed: happened,
        reordered: () => happened(`${label} · legs reordered`),
        kept: (wasLeg, nowLeg, legLabel) => describeLeg(wasLeg, nowLeg, legLabel, note),
      })
    },
  })
  return changes
}

function describeLeg(was: Leg, now: Leg, label: string, note: (what: string, from: ChangeValue, to: ChangeValue) => void): void {
  note(`${label} · game`, was.fixtureId, now.fixtureId)
  note(`${label} · teams`, `${was.home} v ${was.away}`, `${now.home} v ${now.away}`)
  note(`${label} · kick-off`, was.kickoff, now.kickoff)
  note(`${label} · pick`, was.pick, now.pick)
  note(`${label} · odds`, was.odds, now.odds)
  note(`${label} · confidence`, was.confidence, now.confidence)
  const field = (settlement: Settlement | null, name: (typeof SETTLEMENT_FIELDS)[number][0]): ChangeValue => settlement?.[name] ?? null
  const before = SETTLEMENT_FIELDS.map(([name]) => field(was.settlement, name))
  const after = SETTLEMENT_FIELDS.map(([name]) => field(now.settlement, name))
  SETTLEMENT_FIELDS.forEach(([, words], i) => note(`${label} · ${words}`, before[i], after[i]))
  // The time only shows when nothing else about the settlement changed,
  // which keeps a re-settled leg to the lines that matter.
  if (before.every((value, i) => same(value, after[i]))) {
    note(`${label} · settled at`, was.settlement?.settledAt ?? null, now.settlement?.settledAt ?? null)
  }
}

// Pairs up two lists of things with IDs, and says what was added, removed,
// reordered or kept.
function matchUp<T extends { id: string }>(before: readonly T[], after: readonly T[], on: {
  label: (item: T, index: number) => string
  added: (label: string) => void
  removed: (label: string) => void
  reordered: () => void
  kept: (was: T, now: T, label: string) => void
}): void {
  const nowById = new Map(after.map(item => [item.id, item]))
  const wasIds = new Set(before.map(item => item.id))
  before.forEach((was, index) => {
    const now = nowById.get(was.id)
    if (now === undefined) on.removed(`${on.label(was, index)} removed`)
    else on.kept(was, now, on.label(was, index))
  })
  after.forEach((now, index) => {
    if (!wasIds.has(now.id)) on.added(`${on.label(now, index)} added`)
  })
  const keptBefore = before.filter(item => nowById.has(item.id)).map(item => item.id)
  const keptAfter = after.filter(item => wasIds.has(item.id)).map(item => item.id)
  if (keptBefore.join() !== keptAfter.join()) on.reordered()
}

// True if `after` only adds parlays after the ones `before` has, and changes
// nothing else. That's never editing, so it needs no Admin mode and no audit
// entry, even on a locked week (project plan: "Adding a record isn't editing one").
export function onlyAddsParlays(before: WeekRecord, after: WeekRecord): boolean {
  if (after.parlays.length <= before.parlays.length) return false
  return describeChanges(before, { ...after, parlays: after.parlays.slice(0, before.parlays.length) }).length === 0
}

// Caps a list of changes at MAX_CHANGES.
export function capChanges(changes: Change[]): Change[] {
  if (changes.length <= MAX_CHANGES) return changes
  const kept = changes.slice(0, MAX_CHANGES - 1)
  return [...kept, { what: `${changes.length - kept.length} more changes`, from: null, to: null }]
}

// ---------------------------------------------------------------------------
// The chain
// ---------------------------------------------------------------------------

// What the next entry carries for this one: the SHA-256 of its ciphertext, in hex.
export async function chainHash(ct: string): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', fromBase64(ct))))
}

// Encrypts an audit record as the entry after `last`, numbered one past it
// and carrying its hash.
export async function sealAuditEntry(record: AuditRecord, last: Stored<AuditRow> | null, dataKey: CryptoKey): Promise<AuditRow> {
  const plain = {
    id: crypto.randomUUID(),
    seq: last === null ? 1 : last.seq + 1,
    prev_hash: last === null ? null : await chainHash(last.ct),
    v: RECORD_VERSION,
  }
  return { ...plain, ...(await encryptRecord('audit_entries', plain, record, dataKey)) }
}

// One entry of the log, or null where it didn't open or check out.
export type AuditEntry = { seq: number; savedAt: string; record: AuditRecord | null }

// What's wrong with the log, if anything:
//   missing     no entries numbered `from` to `to`, though later ones exist
//   broken      this entry's hash of the one before doesn't match it
//   unreadable  this entry didn't open or check out
export type AuditProblem =
  | { kind: 'missing'; from: number; to: number }
  | { kind: 'broken'; seq: number }
  | { kind: 'unreadable'; seq: number }

export async function loadAuditLog(api: AccountApi, dataKey: CryptoKey): Promise<{ entries: AuditEntry[]; problems: AuditProblem[] }> {
  const rows = (await api.records('audit_entries')).sort((a, b) => a.seq - b.seq)
  const entries: AuditEntry[] = []
  const problems: AuditProblem[] = []
  let previous: Stored<AuditRow> | null = null
  for (const row of rows) {
    const expected = previous === null ? 1 : previous.seq + 1
    if (row.seq > expected) problems.push({ kind: 'missing', from: expected, to: row.seq - 1 })
    // The database makes entry 1 the only one without a hash. A later entry
    // can only be checked against the one just before it.
    else if (previous !== null && row.prev_hash !== (await chainHash(previous.ct))) problems.push({ kind: 'broken', seq: row.seq })
    const record = await openEntry(row, dataKey)
    if (record === null) problems.push({ kind: 'unreadable', seq: row.seq })
    entries.push({ seq: row.seq, savedAt: row.created_at, record })
    previous = row
  }
  return { entries, problems }
}

async function openEntry(row: Stored<AuditRow>, dataKey: CryptoKey): Promise<AuditRecord | null> {
  try {
    const value = await decryptRecord('audit_entries', row, dataKey)
    return isAuditRecord(value) ? value : null
  } catch {
    return null
  }
}
