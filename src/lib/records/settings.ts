// The settings record: details about your account that only you should
// see, encrypted like everything else. Step 7 needs three:
//   - when you last took a backup that checked out, for the 30-day reminder
//   - which key wraps that backup holds, so the app can tell when your
//     password or recovery key has changed since, without comparing the
//     browser's clock with the server's
//   - which recovery wrap belongs to the recovery key you saved. Sign-in
//     compares it with the newest recovery wrap, so it can tell a key that
//     finished saving from one whose save stopped halfway.
//
// Like every record, settings are never edited. Each save adds a new version,
// and the app uses the newest one that opens and checks out.
import { ServerError, type AccountApi, type SaveResult } from '../account/api.ts'
import { isUuid } from '../account/rows.ts'
import { decryptRecord, encryptRecord, RECORD_VERSION } from '../crypto/records.ts'

export type SettingsRecord = {
  schema: 1
  lastBackupAt: string | null   // when a backup last checked out
  backupWrapIds: string[]       // the key wraps in that backup
  recoveryWrapId: string | null // the recovery wrap of the key you saved, once its proof is saved too
}

export const EMPTY_SETTINGS: SettingsRecord = { schema: 1, lastBackupAt: null, backupWrapIds: [], recoveryWrapId: null }

// Checks that a decrypted value really is a settings record before anything
// uses it (fmbt-security, section 2: validate after decrypting).
export function isSettingsRecord(value: unknown): value is SettingsRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  const names = Object.keys(record)
  if (names.length !== 4 || !names.every(name => Object.hasOwn(EMPTY_SETTINGS, name))) return false
  if (record.schema !== 1) return false
  if (record.lastBackupAt !== null && !isIsoTime(record.lastBackupAt)) return false
  const ids = record.backupWrapIds
  if (!Array.isArray(ids) || ids.length > 200 || !ids.every(id => isUuid(id))) return false
  return record.recoveryWrapId === null || isUuid(record.recoveryWrapId)
}

// A time like 2026-11-02T17:30:00.000Z, which is what toISOString() writes.
// The round trip refuses times that don't exist, which Date would quietly
// roll over: 30 February would become 2 March.
export function isIsoTime(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(value)) return false
  const time = new Date(value)
  return !Number.isNaN(time.getTime()) && time.toISOString().slice(0, 19) === value.slice(0, 19)
}

export type LoadedSettings = {
  record: SettingsRecord  // the newest version that opens and checks out, or empty settings
  newestVersion: number   // the highest version number saved, so the next save uses one more
  unreadable: number      // how many newer versions didn't open or check out
}

export async function loadSettings(api: AccountApi, dataKey: CryptoKey): Promise<LoadedSettings> {
  const rows = (await api.records('settings_versions')).sort((a, b) => b.version_no - a.version_no)
  const newestVersion = rows[0]?.version_no ?? 0
  let unreadable = 0
  for (const row of rows) {
    try {
      const value = await decryptRecord('settings_versions', row, dataKey)
      if (isSettingsRecord(value)) return { record: value, newestVersion, unreadable }
    } catch {
      // It didn't open, so it's counted as unreadable below.
    }
    unreadable++
  }
  return { record: EMPTY_SETTINGS, newestVersion, unreadable }
}

// Saves a new version, numbered one past the newest. `taken` means another
// tab saved first.
export async function saveSettings(
  api: AccountApi, dataKey: CryptoKey, record: SettingsRecord, newestVersion: number,
): Promise<SaveResult> {
  const plain = { id: crypto.randomUUID(), version_no: newestVersion + 1, v: RECORD_VERSION }
  const sealed = await encryptRecord('settings_versions', plain, record, dataKey)
  return api.addRecord('settings_versions', { ...plain, ...sealed })
}

// Loads the settings, changes them, and saves the result as a new version.
// If another tab saves first, it starts again from theirs, up to 3 times.
export async function updateSettings(
  api: AccountApi, dataKey: CryptoKey, change: (record: SettingsRecord) => SettingsRecord,
): Promise<void> {
  for (let tries = 0; tries < 3; tries++) {
    const loaded = await loadSettings(api, dataKey)
    if ((await saveSettings(api, dataKey, change(loaded.record), loaded.newestVersion)) === 'saved') return
  }
  throw new ServerError()
}
