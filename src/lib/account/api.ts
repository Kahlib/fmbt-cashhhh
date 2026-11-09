// Every call the app makes to the server, behind one interface.
//
// The account flows (sign-in, setup, password change, recovery, backups),
// the bets code and the fixtures code only ever talk to an AccountApi. In
// the app that's supabase-api.ts, which wraps the Supabase client. In the
// tests it's a fake server in tests/fake-api.ts that follows the database's
// rules, so every flow can be tested, crash by crash, without a network.
//
// An `interface` is a list of what an object must offer. It disappears from
// the JavaScript that runs, like a `type`.
import type { KeyWrapKind, KeyWrapRow } from '../crypto/keys.ts'

// A row as the database returns it: the browser's columns plus the time the
// database saved it.
export type Stored<T> = T & { created_at: string }

// The three tables of encrypted records, with the columns the browser sends.
export type WeekRow = {
  id: string; season: number; competition: string; period: string
  version_no: number; v: number; iv: string; ct: string
}
export type SettingsRow = { id: string; version_no: number; v: number; iv: string; ct: string }
export type AuditRow = { id: string; seq: number; prev_hash: string | null; v: number; iv: string; ct: string }

// One week or stage of one season, the way week_versions files it.
export type WeekKey = Pick<WeekRow, 'season' | 'competition' | 'period'>

// The football tables, as the sync function writes them (step 8). Times
// come back the way the database writes them, such as 2026-11-07T15:00:00+00:00.
export type TeamRow = { id: number; name: string; short_name: string; code: string }
export type FixtureRow = {
  id: number; competition: string; season: number; period: string; tie_leg: number | null
  kickoff: string; home_team_id: number; away_team_id: number; status: string; minute: number | null
  home_90: number | null; away_90: number | null; home_ht: number | null; away_ht: number | null
  home_et: number | null; away_et: number | null; home_pens: number | null; away_pens: number | null
}
export type SyncStatusRow = { last_attempt_at: string | null; last_success_at: string | null }

// Each table's row type, by table name. `Rows['key_wraps']` is KeyWrapRow.
export type Rows = { key_wraps: KeyWrapRow; week_versions: WeekRow; settings_versions: SettingsRow; audit_entries: AuditRow }
export type Table = keyof Rows
export type RecordTable = Exclude<Table, 'key_wraps'>
export type RecordRow<T extends RecordTable> = Rows[T]

// What a sign-up, sign-in or password change can come back with.
export type AuthResult =
  | { ok: true }
  | { ok: false; problem: 'wrong' | 'not-invited' | 'exists' | 'too-many-tries' | 'unavailable' }

// Saving a row either works, or the version number (or ID) is already taken,
// which means another tab saved first.
export type SaveResult = 'saved' | 'taken'

export interface AccountApi {
  // Sign-in system
  signUp(email: string, loginToken: string): Promise<AuthResult>
  signIn(email: string, loginToken: string): Promise<AuthResult>
  // Needs the current login token, since "Require current password when
  // updating" is on. A wrong one comes back as `wrong`.
  changePassword(currentLoginToken: string, newLoginToken: string): Promise<AuthResult>
  // The recover server function. True only if it set the new password.
  recover(email: string, proofHex: string, newLoginToken: string): Promise<boolean>
  signOut(): Promise<void>

  // Key wraps
  keyWraps(): Promise<Stored<KeyWrapRow>[]>
  addKeyWrap(row: KeyWrapRow): Promise<SaveResult>
  deleteOldKeyWraps(kind: KeyWrapKind): Promise<number>
  // True if the database accepted the new proof hash.
  setRecoveryProof(newProofHashHex: string, currentProofHex?: string): Promise<boolean>

  // Encrypted records
  records<T extends RecordTable>(table: T): Promise<Stored<RecordRow<T>>[]>
  addRecord<T extends RecordTable>(table: T, row: RecordRow<T>): Promise<SaveResult>
  hasRecords(): Promise<boolean>

  // Weeks and the audit log (step 9)
  // The newest version of each of your weeks, from the latest_week_versions view.
  latestWeekVersions(): Promise<Stored<WeekRow>[]>
  // Every version of one week, for when its newest won't open.
  weekVersions(week: WeekKey): Promise<Stored<WeekRow>[]>
  // The audit entry with the highest number, or null when there's none yet.
  lastAuditEntry(): Promise<Stored<AuditRow> | null>
  // A locked week's new version and its audit entry, saved together by
  // save_week_with_audit, or neither. `taken` means another tab saved first.
  saveWeekWithAudit(week: WeekRow, audit: AuditRow): Promise<SaveResult>

  // Football data, which only the sync function writes
  teams(): Promise<TeamRow[]>
  fixtures(season: number): Promise<FixtureRow[]>
  // The fixtures kicking off from `from` up to, but not including, `to`,
  // both times as toISOString() writes them. The pages ask for the matches in
  // their live window this way every minute, rather than the whole season.
  fixturesBetween(from: string, to: string): Promise<FixtureRow[]>
  syncStatus(): Promise<SyncStatusRow>

  // Invites, for app admins (step 10.5). The database refuses anyone else,
  // so the list comes back as null, and adding or removing as false. Adding
  // an email that's already on the list changes nothing, and is still true.
  inviteList(): Promise<InviteRow[] | null>
  inviteAdd(email: string): Promise<boolean>
  inviteRemove(email: string): Promise<boolean>
}

// One invite, as invite_list returns it, newest first.
export type InviteRow = { email: string; added_at: string; has_account: boolean }

// Thrown when the server can't be reached or answers something unexpected.
// The message is safe to show: it never includes what the server said.
export class ServerError extends Error {
  constructor() {
    super("Couldn't reach the server. Check your connection and try again.")
  }
}
