// Backups (fmbt-security, section 5): your whole account in one file, still
// encrypted, so it's safe to keep anywhere.
//
// The file holds every row of the four tables, with exactly the columns the
// browser sends. Restoring puts rows back with the same IDs and version
// numbers, so their AAD matches and they open with the same data key. It
// leaves out the recovery proof's hash, since every restore into a new
// account makes a new recovery key.
import type { AccountApi, AuditRow, Rows, SettingsRow, Table, WeekRow } from './api.ts'
import { checkPassword, type PasswordProblem } from './password-rules.ts'
import { isRow, pickColumns } from './rows.ts'
import type { StepOneDone } from './setup.ts'
import { derivePasswordKeys, tidyEmail, type PasswordKeys } from '../crypto/kdf.ts'
import type { KeyWrapKind, KeyWrapRow } from '../crypto/keys.ts'
import { decryptRecord } from '../crypto/records.ts'
import { deriveRecoveryKeys, readRecoveryKey } from '../crypto/recovery-key.ts'
import { EMPTY_SETTINGS, isIsoTime, updateSettings, type SettingsRecord } from '../records/settings.ts'
import { makeNewRecoveryKey, prepareRecoveryWrap } from './new-recovery-key.ts'
import { newestFirst, openFirst, saveAndProveWrap } from './wraps.ts'

export const BACKUP_FORMAT = 1

// The database's limits for one account come to about 32 MB of ciphertext,
// so a real backup is always smaller than this.
export const MAX_BACKUP_CHARACTERS = 50_000_000

// Every row of an account, table by table.
export type AccountRows = {
  keyWraps: KeyWrapRow[]
  weekVersions: WeekRow[]
  settingsVersions: SettingsRow[]
  auditEntries: AuditRow[]
}

export type Backup = { app: 'fmbt-cashhhh'; kind: 'backup'; format: 1; exportedAt: string } & AccountRows

// Each table's place in a backup, and the most rows the database allows it.
const TABLES = [
  { table: 'key_wraps', field: 'keyWraps', most: 200 },
  { table: 'week_versions', field: 'weekVersions', most: 20_000 },
  { table: 'settings_versions', field: 'settingsVersions', most: 2_000 },
  { table: 'audit_entries', field: 'auditEntries', most: 20_000 },
] as const

// ---------- Export ----------

// Fetches every row of your account, with only the columns a backup keeps.
export async function readAccount(api: AccountApi): Promise<AccountRows> {
  const tidy = <T extends Table>(table: T, rows: Rows[T][]) =>
    rows.map(row => pickColumns(table, row)).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return {
    keyWraps: tidy('key_wraps', await api.keyWraps()),
    weekVersions: tidy('week_versions', await api.records('week_versions')),
    settingsVersions: tidy('settings_versions', await api.records('settings_versions')),
    auditEntries: tidy('audit_entries', await api.records('audit_entries')),
  }
}

export type ExportedBackup = { fileName: string; text: string }

// The file to download, named fmbt-cashhhh-backup-<today>.json.
export async function exportBackup(api: AccountApi, now = new Date()): Promise<ExportedBackup> {
  const backup: Backup = {
    app: 'fmbt-cashhhh', kind: 'backup', format: BACKUP_FORMAT, exportedAt: now.toISOString(), ...(await readAccount(api)),
  }
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  return { fileName: `fmbt-cashhhh-backup-${day}.json`, text: JSON.stringify(backup) }
}

// ---------- Reading a file ----------

export type ReadBackupResult =
  | { ok: true; backup: Backup }
  | { ok: false; problem: 'too-big' | 'not-a-backup' | 'newer-format' | 'damaged' }

// Checks a chosen file strictly before anything uses it. A file is
// untrusted, whoever made it.
export function readBackup(text: string): ReadBackupResult {
  if (text.length > MAX_BACKUP_CHARACTERS) return { ok: false, problem: 'too-big' }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return { ok: false, problem: 'not-a-backup' }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: false, problem: 'not-a-backup' }
  const file = value as Record<string, unknown>
  if (file.app !== 'fmbt-cashhhh' || file.kind !== 'backup') return { ok: false, problem: 'not-a-backup' }
  if (typeof file.format === 'number' && file.format > BACKUP_FORMAT) return { ok: false, problem: 'newer-format' }

  // No other fields, and each of these in its shape. A missing one fails its check.
  const names = ['app', 'kind', 'format', 'exportedAt', ...TABLES.map(t => t.field)]
  const fine = Object.keys(file).every(name => names.includes(name))
    && file.format === BACKUP_FORMAT
    && isIsoTime(file.exportedAt)
    && TABLES.every(({ table, field, most }) => isTableOfRows(table, file[field], most))
  return fine ? { ok: true, backup: file as Backup } : { ok: false, problem: 'damaged' }
}

// A list of rows the database would take: each in the right shape, and no
// two sharing an ID or a version number.
function isTableOfRows(table: Table, value: unknown, most: number): boolean {
  if (!Array.isArray(value) || value.length > most) return false
  const ids = new Set<string>()
  const versions = new Set<string>()
  for (const row of value) {
    if (!isRow(table, row)) return false
    ids.add(row.id)
    versions.add(versionOf(table, row))
  }
  return ids.size === value.length && versions.size === value.length
}

// What the database keeps unique besides the ID, for each table.
function versionOf(table: Table, row: Rows[Table]): string {
  const r = row as Record<string, unknown>
  if (table === 'key_wraps') return `${r.kind} ${r.version_no}`
  if (table === 'week_versions') return `${r.season} ${r.competition} ${r.period} ${r.version_no}`
  if (table === 'settings_versions') return `${r.version_no}`
  return `${r.seq}`
}

// ---------- Checking a file against your account ----------

export type BackupCheck = {
  ok: boolean        // true only when everything below is clean
  keysMatch: boolean // the file's key wraps are exactly your account's
  missing: number    // records your account has that the file doesn't
  extra: number      // records in the file that your account doesn't have
  changed: number    // records in both, but not the same
  wontOpen: number   // records in the file that don't open with your key
}

// Setup step 4 and Settings run this on the file you just downloaded, so
// you know it holds everything and opens before you rely on it.
export async function checkBackup(api: AccountApi, dataKey: CryptoKey, backup: Backup): Promise<BackupCheck> {
  const account = await readAccount(api)
  const check: BackupCheck = { ok: false, keysMatch: false, missing: 0, extra: 0, changed: 0, wontOpen: 0 }
  for (const { table, field } of TABLES) {
    // Each row as text, by ID, so rows compare exactly.
    const here = new Map(account[field].map(row => [row.id, JSON.stringify(row)]))
    const inFile = new Map(backup[field].map(row => [row.id, JSON.stringify(pickColumns(table, row))]))
    const missing = [...here.keys()].filter(id => !inFile.has(id)).length
    const extra = [...inFile.keys()].filter(id => !here.has(id)).length
    const changed = [...inFile].filter(([id, text]) => here.has(id) && here.get(id) !== text).length
    if (table === 'key_wraps') {
      check.keysMatch = missing + extra + changed === 0
    } else {
      check.missing += missing
      check.extra += extra
      check.changed += changed
    }
  }
  check.wontOpen = (await sortRecords(backup, dataKey)).wontOpen
  check.ok = check.keysMatch && check.missing + check.extra + check.changed + check.wontOpen === 0
  return check
}

// Notes in your settings that this backup checked out: when, which resets
// the 30-day reminder, and which key wraps it holds.
export async function recordBackup(api: AccountApi, dataKey: CryptoKey, backup: Backup, now = new Date()): Promise<void> {
  const backupWrapIds = backup.keyWraps.map(wrap => wrap.id)
  await updateSettings(api, dataKey, record => ({ ...record, lastBackupAt: now.toISOString(), backupWrapIds }))
}

export type BackupStatus =
  | { kind: 'fine' }
  | { kind: 'keys-changed'; password: boolean; recovery: boolean } // since the last checked backup
  | { kind: 'overdue'; days: number | null }                       // null: no backup has checked out yet

// Whether Settings should ask for a fresh backup. A changed password or
// recovery key matters most, because older backups still open with the old
// ones. Then a backup more than 30 days old.
export function backupStatus(settings: SettingsRecord, wraps: KeyWrapRow[], now = new Date()): BackupStatus {
  if (settings.lastBackupAt === null) return { kind: 'overdue', days: null }
  const changed = (kind: KeyWrapKind) => {
    const newest = newestFirst(wraps, kind)[0]
    return newest !== undefined && !settings.backupWrapIds.includes(newest.id)
  }
  const password = changed('password')
  const recovery = changed('recovery')
  if (password || recovery) return { kind: 'keys-changed', password, recovery }
  const days = Math.floor((now.getTime() - Date.parse(settings.lastBackupAt)) / 86_400_000)
  return days > 30 ? { kind: 'overdue', days } : { kind: 'fine' }
}

// ---------- Restoring into this account ----------

type Records = Omit<AccountRows, 'keyWraps'>

// The file's records split into those that open with your key and those
// that don't.
async function sortRecords(backup: Records, dataKey: CryptoKey): Promise<{ opens: Records; wontOpen: number }> {
  const opens: Records = { weekVersions: [], settingsVersions: [], auditEntries: [] }
  let wontOpen = 0
  const sort = async <T extends 'week_versions' | 'settings_versions' | 'audit_entries'>(table: T, rows: Rows[T][], into: Rows[T][]) => {
    for (const row of rows) {
      try {
        await decryptRecord(table, row, dataKey)
        into.push(row)
      } catch {
        wontOpen++
      }
    }
  }
  await sort('week_versions', backup.weekVersions, opens.weekVersions)
  await sort('settings_versions', backup.settingsVersions, opens.settingsVersions)
  await sort('audit_entries', backup.auditEntries, opens.auditEntries)
  return { opens, wontOpen }
}

export type RestorePlan = {
  add: Records       // missing here and they open, so these get added
  alreadyHere: number
  wontOpen: number   // missing here, but they don't open with your key, so they're skipped
}

// The preview: what a restore would add. Key wraps are never restored.
export async function planRestore(api: AccountApi, dataKey: CryptoKey, backup: Backup): Promise<RestorePlan> {
  const account = await readAccount(api)
  const here = new Set([...account.weekVersions, ...account.settingsVersions, ...account.auditEntries].map(row => row.id))
  const missing: Records = {
    weekVersions: backup.weekVersions.filter(row => !here.has(row.id)),
    settingsVersions: backup.settingsVersions.filter(row => !here.has(row.id)),
    auditEntries: backup.auditEntries.filter(row => !here.has(row.id)),
  }
  const alreadyHere = backup.weekVersions.length + backup.settingsVersions.length + backup.auditEntries.length
    - (missing.weekVersions.length + missing.settingsVersions.length + missing.auditEntries.length)
  const sorted = await sortRecords(missing, dataKey)
  return { add: sorted.opens, alreadyHere, wontOpen: sorted.wontOpen }
}

export type RestoreResult = { added: number; taken: number }

// Adds the planned rows. `taken` counts rows whose ID or version number is
// already used here, which happens if another tab saved in the meantime.
export async function applyRestore(api: AccountApi, add: Records): Promise<RestoreResult> {
  const result: RestoreResult = { added: 0, taken: 0 }
  const addAll = async <T extends 'week_versions' | 'settings_versions' | 'audit_entries'>(table: T, rows: Rows[T][]) => {
    for (const row of rows) {
      if ((await api.addRecord(table, row)) === 'saved') result.added++
      else result.taken++
    }
  }
  await addAll('week_versions', add.weekVersions)
  await addAll('settings_versions', add.settingsVersions)
  await addAll('audit_entries', add.auditEntries)
  return result
}

// ---------- Start from a backup ----------

// What opens the file: its password, or its recovery key and a new password.
export type BackupSecret = { password: string } | { recoveryKeyText: string; newPassword: string }

export type StartResult =
  | ({ kind: 'started' } & StepOneDone & RestoreResult & { wontOpen: number })
  | { kind: 'password-rules'; problem: PasswordProblem }
  | { kind: 'key-problem'; problem: 'length' | 'characters' | 'typo' }
  | { kind: 'wont-open' } // the password (with this email) or the recovery key doesn't open the file
  | { kind: 'not-invited' | 'exists' | 'too-many-tries' | 'unavailable' }

// A new account that takes over the backup's data key, so its records open
// again. Afterwards the app runs setup steps 2 to 4: a new recovery key and
// a fresh backup. Nothing is created until the file has opened.
export async function startFromBackup(
  api: AccountApi, email: string, backup: Backup, secret: BackupSecret,
): Promise<StartResult> {
  // 1. Open the file's data key, with a copy that can be wrapped again.
  let keys: PasswordKeys
  let dataKey: CryptoKey
  if ('password' in secret) {
    const rules = checkPassword(secret.password, email)
    if (!rules.ok) return { kind: 'password-rules', problem: rules.problem }
    keys = await derivePasswordKeys(email, secret.password)
    const opened = await openFirst(newestFirst(backup.keyWraps, 'password'), keys.wrapKey, { extractable: true })
    if (opened === null) return { kind: 'wont-open' }
    dataKey = opened.key
  } else {
    const read = await readRecoveryKey(secret.recoveryKeyText)
    if (!read.ok) return { kind: 'key-problem', problem: read.problem }
    const rules = checkPassword(secret.newPassword, email)
    if (!rules.ok) return { kind: 'password-rules', problem: rules.problem }
    const recovery = await deriveRecoveryKeys(read.key)
    read.key.fill(0)
    const opened = await openFirst(newestFirst(backup.keyWraps, 'recovery'), recovery.wrapKey, { extractable: true })
    if (opened === null) return { kind: 'wont-open' }
    dataKey = opened.key
    keys = await derivePasswordKeys(email, secret.newPassword)
  }
  const sorted = await sortRecords(backup, dataKey)

  // 2. Create the account.
  const account = await signUpOrCarryOn(api, tidyEmail(email), keys.loginToken)
  if (account !== 'ready') return { kind: account }

  // 3. The account takes over the data key, wrapped by its password. From
  // here, if anything stops, signing in works, and Restore adds the rest.
  const sessionKey = await saveAndProveWrap(api, dataKey, keys.wrapKey, { kind: 'password', version_no: 1 })
  if (sessionKey === null) return { kind: 'unavailable' }

  // 4. Every record that opened, then settings that send sign-in back to
  // setup step 2 if you stop before the end.
  const added = await applyRestore(api, sorted.opens)
  await updateSettings(api, sessionKey, () => EMPTY_SETTINGS)

  // 5. A new recovery key, for steps 2 and 3 to show and save.
  const newKey = await makeNewRecoveryKey()
  const prepared = await prepareRecoveryWrap(dataKey, newKey, await api.keyWraps())
  return {
    kind: 'started',
    unlocked: { email: tidyEmail(email), dataKey: sessionKey },
    newKey,
    prepared,
    ...added,
    wontOpen: sorted.wontOpen,
  }
}

// Signs up. If the account already exists but is empty, with this same
// password, an earlier try of this stopped right after creating it, so
// carry on with that account.
async function signUpOrCarryOn(
  api: AccountApi, email: string, loginToken: string,
): Promise<'ready' | 'not-invited' | 'exists' | 'too-many-tries' | 'unavailable'> {
  const created = await api.signUp(email, loginToken)
  if (created.ok) return 'ready'
  if (created.problem !== 'exists') return created.problem === 'wrong' ? 'unavailable' : created.problem
  if (!(await api.signIn(email, loginToken)).ok) return 'exists'
  if ((await api.keyWraps()).length === 0 && !(await api.hasRecords())) return 'ready'
  await api.signOut()
  return 'exists'
}
