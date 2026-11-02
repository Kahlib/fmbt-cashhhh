// Backups: export, the checks on a chosen file, restoring into this account
// and starting a new account from a backup.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  applyRestore, checkBackup, exportBackup, planRestore, readBackup, startFromBackup, type Backup,
} from '../src/lib/account/backup.ts'
import { makeNewRecoveryKey, saveRecoveryKey } from '../src/lib/account/new-recovery-key.ts'
import { derivePasswordKeys } from '../src/lib/crypto/kdf.ts'
import { addSample, EMAIL, keysOf, NEW_PASSWORD, opensSample, PASSWORD, setUpAccount, signedIn, takeBackup, whereSignInGoes } from './accounts.ts'
import { FakeServer } from './fake-api.ts'

const keys = await derivePasswordKeys(EMAIL, PASSWORD)
const ready = new FakeServer()
const account = await setUpAccount(ready)
const start = ready.snapshot()

// Signs in and exports, returning the file as text and as read back.
async function exported(server: FakeServer) {
  const { tab, unlocked } = await signedIn(server, keys)
  const file = await exportBackup(tab, new Date(2026, 10, 2, 21, 30))
  const read = readBackup(file.text)
  if (!read.ok) throw new Error(read.problem)
  return { tab, unlocked, file, backup: read.backup }
}

// A copy of a backup with one change made to it.
function edited(backup: Backup, change: (copy: Backup) => void): Backup {
  const copy = structuredClone(backup)
  change(copy)
  return copy
}

test('An export reads back, checks out, and is named after the local date', async () => {
  const server = FakeServer.from(start)
  const { tab, unlocked, file, backup } = await exported(server)
  assert.equal(file.fileName, 'fmbt-cashhhh-backup-2026-11-02.json')
  assert.equal(backup.keyWraps.length, 2)
  assert.equal(backup.weekVersions.length, 1)
  // Only the columns the browser sends: no user IDs, no times.
  assert.deepEqual(Object.keys(backup.weekVersions[0]), ['id', 'season', 'competition', 'period', 'version_no', 'v', 'iv', 'ct'])
  assert.doesNotMatch(file.text, /user_id|created_at|proof/)
  assert.deepEqual(await checkBackup(tab, unlocked.dataKey, backup),
    { ok: true, keysMatch: true, missing: 0, extra: 0, changed: 0, wontOpen: 0 })
})

test('The check catches a changed byte, a missing row and someone else\'s file', async () => {
  const server = FakeServer.from(start)
  const { tab, unlocked, backup } = await exported(server)

  const changedByte = edited(backup, copy => {
    const ct = copy.weekVersions[0].ct
    copy.weekVersions[0].ct = ct.slice(0, 100) + (ct[100] === 'A' ? 'B' : 'A') + ct.slice(101)
  })
  assert.deepEqual(await checkBackup(tab, unlocked.dataKey, changedByte),
    { ok: false, keysMatch: true, missing: 0, extra: 0, changed: 1, wontOpen: 1 })

  const missingRow = edited(backup, copy => {
    copy.weekVersions = []
  })
  assert.deepEqual(await checkBackup(tab, unlocked.dataKey, missingRow),
    { ok: false, keysMatch: true, missing: 1, extra: 0, changed: 0, wontOpen: 0 })

  // Someone else's account, with its own data key.
  const other = new FakeServer()
  await setUpAccount(other, 'friend@example.com', NEW_PASSWORD)
  const friend = await signedIn(other, await derivePasswordKeys('friend@example.com', NEW_PASSWORD), 'friend@example.com')
  const theirs = readBackup((await exportBackup(friend.tab)).text)
  if (!theirs.ok) throw new Error(theirs.problem)
  const check = await checkBackup(tab, unlocked.dataKey, theirs.backup)
  assert.equal(check.ok, false)
  assert.equal(check.keysMatch, false)
  assert.equal(check.wontOpen, theirs.backup.weekVersions.length + theirs.backup.settingsVersions.length)
})

test('Reading a file refuses anything that is not exactly a backup', async () => {
  const server = FakeServer.from(start)
  const { file, backup } = await exported(server)
  const problem = (text: string) => {
    const read = readBackup(text)
    return read.ok ? 'ok' : read.problem
  }
  const withChange = (change: (copy: Record<string, unknown>) => void) => {
    const copy = JSON.parse(file.text) as Record<string, unknown>
    change(copy)
    return JSON.stringify(copy)
  }
  assert.equal(problem(file.text), 'ok')
  assert.equal(problem('not json'), 'not-a-backup')
  assert.equal(problem('[]'), 'not-a-backup')
  assert.equal(problem(withChange(copy => { copy.app = 'something-else' })), 'not-a-backup')
  assert.equal(problem(withChange(copy => { copy.format = 2 })), 'newer-format')
  assert.equal(problem(withChange(copy => { copy.extra = true })), 'damaged')
  assert.equal(problem(withChange(copy => { copy.exportedAt = 'yesterday' })), 'damaged')
  assert.equal(problem(withChange(copy => { delete copy.auditEntries })), 'damaged')
  const week = backup.weekVersions[0]
  assert.equal(problem(withChange(copy => { copy.weekVersions = [{ ...week, user_id: account.id }] })), 'damaged')
  assert.equal(problem(withChange(copy => { copy.weekVersions = [{ ...week, id: 'not-a-uuid' }] })), 'damaged')
  assert.equal(problem(withChange(copy => { copy.weekVersions = [{ ...week, period: 'MD1' }] })), 'damaged') // PL weeks are MW
  assert.equal(problem(withChange(copy => { copy.weekVersions = [week, { ...week, id: crypto.randomUUID() }] })), 'damaged')
  assert.equal(problem(withChange(copy => { copy.weekVersions = [week, week] })), 'damaged')
  assert.equal(problem(withChange(copy => { copy.keyWraps = [{ ...backup.keyWraps[0], kind: 'admin' }] })), 'damaged')
  assert.equal(problem(' '.repeat(50_000_001)), 'too-big')
})

test('Restore adds only what is missing and opens, and never key wraps', async () => {
  const server = FakeServer.from(start)
  const { tab, unlocked } = await signedIn(server, keys)
  await addSample(tab, unlocked.dataKey, 'MW2')
  const { backup } = await exported(server)

  // An insider deletes a week version and the recovery wrap.
  const week = server.rowsOf(account.id, 'week_versions')[0]
  server.insiderDelete('week_versions', week.id)
  const recoveryWrap = server.rowsOf(account.id, 'key_wraps').find(w => w.kind === 'recovery')
  if (recoveryWrap === undefined) throw new Error('no recovery wrap')
  server.insiderDelete('key_wraps', recoveryWrap.id)
  // And the file has one record that's been tampered with.
  const tampered = edited(backup, copy => {
    copy.settingsVersions.push({ ...copy.settingsVersions[0], id: crypto.randomUUID(), version_no: 99 })
  })

  const plan = await planRestore(tab, unlocked.dataKey, tampered)
  assert.deepEqual(plan.add.weekVersions.map(row => row.id), [week.id])
  assert.equal(plan.add.settingsVersions.length + plan.add.auditEntries.length, 0)
  assert.equal(plan.wontOpen, 1)
  assert.equal(plan.alreadyHere, backup.weekVersions.length - 1 + backup.settingsVersions.length)

  assert.deepEqual(await applyRestore(tab, plan.add), { added: 1, taken: 0 })
  assert.ok(server.rowsOf(account.id, 'week_versions').some(row => row.id === week.id))
  assert.equal(server.rowsOf(account.id, 'key_wraps').some(row => row.id === recoveryWrap.id), false)
  // A second restore finds nothing more to add.
  assert.equal((await planRestore(tab, unlocked.dataKey, backup)).add.weekVersions.length, 0)
})

test('Start from a backup with its password, into a fresh project', async () => {
  const { file } = await exported(FakeServer.from(start))
  const read = readBackup(file.text)
  if (!read.ok) throw new Error(read.problem)
  const fresh = new FakeServer()
  fresh.invite(EMAIL)
  const tab = fresh.tab()
  const started = await startFromBackup(tab, EMAIL, read.backup, { password: PASSWORD })
  if (started.kind !== 'started') throw new Error(started.kind)
  assert.equal(started.added, read.backup.weekVersions.length + read.backup.settingsVersions.length)
  assert.equal(started.taken + started.wontOpen, 0)
  const moved = { ...account, id: fresh.account(EMAIL)?.id ?? '' }
  assert.ok(await opensSample(fresh, moved, started.unlocked.dataKey))

  // Until steps 2 to 4 are done, sign-in sends you back to them.
  assert.equal(await whereSignInGoes(fresh, moved, keys, []), 'asks-for-a-new-key')
  assert.equal(await saveRecoveryKey(tab, started.unlocked.dataKey, started.newKey, started.prepared), 'saved')
  const newKeys = await keysOf(started.newKey)
  assert.equal(await whereSignInGoes(fresh, moved, keys, [newKeys]), 'first-backup')
  await takeBackup(tab, started.unlocked.dataKey)
  assert.equal(await whereSignInGoes(fresh, moved, keys, [newKeys]), 'app')
})

test('Start from a backup with its recovery key, a new password and a new email', async () => {
  const { backup } = await exported(FakeServer.from(start))
  const fresh = new FakeServer()
  fresh.invite('kman@new-domain.example')
  const started = await startFromBackup(fresh.tab(), 'kman@new-domain.example', backup,
    { recoveryKeyText: account.recoveryKeyText, newPassword: NEW_PASSWORD })
  if (started.kind !== 'started') throw new Error(started.kind)
  const moved = { ...account, id: fresh.account('kman@new-domain.example')?.id ?? '' }
  assert.ok(await opensSample(fresh, moved, started.unlocked.dataKey))
})

test('Start from a backup creates nothing until the file opens', async () => {
  const { backup } = await exported(FakeServer.from(start))
  const fresh = new FakeServer()
  fresh.invite(EMAIL)
  assert.deepEqual(await startFromBackup(fresh.tab(), EMAIL, backup, { password: NEW_PASSWORD }), { kind: 'wont-open' })
  // The password only opens the file with the email its account had.
  fresh.invite('someone@example.com')
  assert.deepEqual(await startFromBackup(fresh.tab(), 'someone@example.com', backup, { password: PASSWORD }), { kind: 'wont-open' })
  const otherKey = (await makeNewRecoveryKey()).groups.join(' ')
  assert.deepEqual(await startFromBackup(fresh.tab(), EMAIL, backup, { recoveryKeyText: otherKey, newPassword: NEW_PASSWORD }),
    { kind: 'wont-open' })
  assert.equal(fresh.calls, 0)
  assert.equal(fresh.state.accounts.length, 0)
})

test('Start from a backup carries on after stopping right after sign-up, but not into a used account', async () => {
  const { backup } = await exported(FakeServer.from(start))
  const fresh = new FakeServer()
  fresh.invite(EMAIL)
  fresh.breakCall(1, 'crash')
  await assert.rejects(startFromBackup(fresh.tab(), EMAIL, backup, { password: PASSWORD }))
  assert.equal(fresh.state.accounts.length, 1)
  const again = await startFromBackup(fresh.tab(), EMAIL, backup, { password: PASSWORD })
  assert.equal(again.kind, 'started')
  // Now the account has keys and records, so a third try is refused.
  assert.deepEqual(await startFromBackup(fresh.tab(), EMAIL, backup, { password: PASSWORD }), { kind: 'exists' })
})
