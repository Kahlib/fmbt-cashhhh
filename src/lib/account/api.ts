// Every call the account code makes to the server, behind one interface.
//
// The account flows (sign-in, setup, password change, recovery, backups)
// only ever talk to an AccountApi. In the app that's supabase-api.ts, which
// wraps the Supabase client. In the tests it's a fake server in
// tests/fake-api.ts that follows the database's rules, so every flow can be
// tested, crash by crash, without a network.
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
}

// Thrown when the server can't be reached or answers something unexpected.
// The message is safe to show: it never includes what the server said.
export class ServerError extends Error {
  constructor() {
    super("Couldn't reach the server. Check your connection and try again.")
  }
}
