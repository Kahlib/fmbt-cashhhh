// The small pieces the 7.5 screens lean on: the backup reminder, dates and
// sizes, the settings record's shape, sign-in's first-key flag, and the
// development-only junk weeks.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { backupStatus } from '../src/lib/account/backup.ts'
import { replaceRecoveryKey } from '../src/lib/account/recovery.ts'
import { makeNewRecoveryKey } from '../src/lib/account/new-recovery-key.ts'
import { createAccount } from '../src/lib/account/setup.ts'
import { signInWithKeys } from '../src/lib/account/signin.ts'
import type { KeyWrapRow } from '../src/lib/crypto/keys.ts'
import { derivePasswordKeys } from '../src/lib/crypto/kdf.ts'
import { decryptRecord } from '../src/lib/crypto/records.ts'
import { count, daysAgo, formatDay, formatSize } from '../src/lib/format.ts'
import { addJunkWeek } from '../src/lib/records/junk-weeks.ts'
import { EMPTY_SETTINGS, isSettingsRecord, loadSettings, type SettingsRecord } from '../src/lib/records/settings.ts'
import { EMAIL, PASSWORD, setUpAccount, signedIn } from './accounts.ts'
import { FakeServer, TabClosed } from './fake-api.ts'

const wrap = (id: string, kind: 'password' | 'recovery', version_no: number): KeyWrapRow =>
  ({ id, kind, version_no, v: 1, iv: 'A'.repeat(16), wrapped: 'B'.repeat(64) })
const P1 = '00000000-0000-4000-8000-000000000001'
const P2 = '00000000-0000-4000-8000-000000000002'
const R1 = '00000000-0000-4000-8000-000000000003'
const R2 = '00000000-0000-4000-8000-000000000004'
const backedUp = (at: string): SettingsRecord => ({ ...EMPTY_SETTINGS, lastBackupAt: at, backupWrapIds: [P1, R1] })
const NOW = new Date('2026-11-02T18:00:00.000Z')

test('The backup reminder: keys changed since the last checked backup, then 30 days', () => {
  const same = [wrap(P1, 'password', 1), wrap(R1, 'recovery', 1)]
  assert.deepEqual(backupStatus(EMPTY_SETTINGS, same, NOW), { kind: 'overdue', days: null })
  assert.deepEqual(backupStatus(backedUp('2026-10-20T10:00:00.000Z'), same, NOW), { kind: 'fine' })
  assert.deepEqual(backupStatus(backedUp('2026-09-29T10:00:00.000Z'), same, NOW), { kind: 'overdue', days: 34 })
  // A new password wrap, a new recovery wrap, or both, whatever the clocks say.
  const newPassword = [wrap(P1, 'password', 1), wrap(P2, 'password', 2), wrap(R1, 'recovery', 1)]
  assert.deepEqual(backupStatus(backedUp('2026-11-02T17:59:00.000Z'), newPassword, NOW), { kind: 'keys-changed', password: true, recovery: false })
  const newKey = [wrap(P1, 'password', 1), wrap(R2, 'recovery', 2)]
  assert.deepEqual(backupStatus(backedUp('2026-11-02T17:59:00.000Z'), newKey, NOW), { kind: 'keys-changed', password: false, recovery: true })
  const both = [wrap(P2, 'password', 2), wrap(R2, 'recovery', 2)]
  assert.deepEqual(backupStatus(backedUp('2025-01-01T00:00:00.000Z'), both, NOW), { kind: 'keys-changed', password: true, recovery: true })
})

test('The settings record keeps its four fields in their shapes', () => {
  assert.ok(isSettingsRecord(EMPTY_SETTINGS))
  assert.ok(isSettingsRecord(backedUp('2026-11-02T17:59:00.000Z')))
  assert.equal(isSettingsRecord({ schema: 1, lastBackupAt: null, recoveryWrapId: null }), false)
  assert.equal(isSettingsRecord({ ...EMPTY_SETTINGS, backupWrapIds: ['not-an-id'] }), false)
  assert.equal(isSettingsRecord({ ...EMPTY_SETTINGS, backupWrapIds: P1 }), false)
  assert.equal(isSettingsRecord({ ...EMPTY_SETTINGS, extra: true }), false)
})

test('Dates, sizes and counts read the way the canvas shows them', () => {
  assert.equal(formatDay('2026-09-28T12:00:00.000Z'), '28 Sep 2026')
  assert.equal(formatDay('2026-11-01T12:00:00.000Z'), '1 Nov 2026')
  // Times near noon UTC, so the local calendar day is the same anywhere from UTC-11 to UTC+11.
  assert.equal(daysAgo('2026-11-02T11:30:00.000Z', new Date('2026-11-02T12:30:00.000Z')), 'today')
  assert.equal(daysAgo('2026-10-31T12:00:00.000Z', new Date('2026-11-01T12:00:00.000Z')), 'yesterday')
  assert.equal(daysAgo('2026-09-29T12:00:00.000Z', new Date('2026-11-02T12:00:00.000Z')), '34 days ago')
  assert.equal(formatSize(10), '1 KB')
  assert.equal(formatSize(3 * 1024 - 100), '3 KB')
  assert.equal(formatSize(5.5 * 1024 * 1024), '5.5 MB')
  assert.equal(count(1, 'saved version', 'saved versions'), '1 saved version')
  assert.equal(count(1041, 'saved version', 'saved versions'), '1,041 saved versions')
})

test('Sign-in says when a recovery key would be the first one', async () => {
  const keys = await derivePasswordKeys(EMAIL, PASSWORD)
  // Setup that stopped before saving its key: the next one is the first.
  const fresh = new FakeServer()
  fresh.invite(EMAIL)
  const created = await createAccount(fresh.tab(), EMAIL, PASSWORD)
  assert.equal(created.kind, 'created')
  const resumed = await signInWithKeys(fresh.tab(), EMAIL, keys)
  assert.ok(resumed.kind === 'unlocked' && resumed.next.step === 'save-recovery-key' && resumed.next.first)

  // A replacement that stopped after saving its wrap: not the first.
  const server = new FakeServer()
  await setUpAccount(server)
  const { tab, unlocked } = await signedIn(server, keys)
  server.breakCall(3, 'crash')
  await assert.rejects(replaceRecoveryKey(tab, unlocked, await makeNewRecoveryKey(), PASSWORD), TabClosed)
  const after = await signInWithKeys(server.tab(), EMAIL, keys)
  assert.ok(after.kind === 'unlocked' && after.next.step === 'save-recovery-key' && !after.next.first)
})

test('Junk weeks fill matchweeks in order and open with the data key', async () => {
  const server = new FakeServer()
  const account = await setUpAccount(server)
  const { tab, unlocked } = await signedIn(server, await derivePasswordKeys(EMAIL, PASSWORD))
  assert.equal(await addJunkWeek(tab, unlocked.dataKey), 'saved')
  assert.equal(await addJunkWeek(tab, unlocked.dataKey), 'saved')
  const weeks = server.rowsOf(account.id, 'week_versions')
  // The sample from setUpAccount sits in MW1, so the junk goes in MW2 and MW3.
  assert.deepEqual(weeks.map(w => w.period), ['MW1', 'MW2', 'MW3'])
  const opened = await decryptRecord('week_versions', weeks[2], unlocked.dataKey)
  assert.equal((opened as { junk?: unknown }).junk, true)
  assert.equal((await loadSettings(tab, unlocked.dataKey)).unreadable, 0)
})
