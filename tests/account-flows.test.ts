// The account flows end to end, against the fake server in fake-api.ts:
// sign-in, setup, changing the password, Forgot password and a new recovery
// key. The crash tests break every server call each flow makes, in each of
// three ways, and check that the account still opens afterwards.
//
// Each password costs 600,000 rounds to turn into keys, so the tests work
// out keys once and sign in with signInWithKeys wherever they can.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { changePassword } from '../src/lib/account/password.ts'
import { replaceRecoveryKey, recoverAccount } from '../src/lib/account/recovery.ts'
import { makeNewRecoveryKey, saveRecoveryKey, type NewRecoveryKey } from '../src/lib/account/new-recovery-key.ts'
import { createAccount } from '../src/lib/account/setup.ts'
import { signIn, signInWithKeys } from '../src/lib/account/signin.ts'
import { recordBackup } from '../src/lib/account/backup.ts'
import { randomBytes, toBase64 } from '../src/lib/crypto/bytes.ts'
import { derivePasswordKeys } from '../src/lib/crypto/kdf.ts'
import { readRecoveryKey, type RecoveryKeys } from '../src/lib/crypto/recovery-key.ts'
import { loadSettings } from '../src/lib/records/settings.ts'
import {
  EMAIL, everyFault, keysOf, NEW_PASSWORD, opensSample, PASSWORD, passwordOpens, recoveryKeyWorks,
  setUpAccount, signedIn, takeBackup, whereSignInGoes,
} from './accounts.ts'
import { FakeServer, TabClosed } from './fake-api.ts'

const keys = { old: await derivePasswordKeys(EMAIL, PASSWORD), new: await derivePasswordKeys(EMAIL, NEW_PASSWORD) }

// One account, set up once. Each test starts from a copy of it.
const ready = new FakeServer()
const account = await setUpAccount(ready)
const start = ready.snapshot()

const junkWrap = (kind: 'password' | 'recovery', version_no: number) => ({
  id: crypto.randomUUID(), kind, version_no, v: 1, iv: toBase64(randomBytes(12)), wrapped: toBase64(randomBytes(48)),
})

// ---------- Sign-in ----------

test('Sign-in opens the data key, and a wrong password gets the one answer', async () => {
  const server = FakeServer.from(start)
  const result = await signIn(server.tab(), ' KMan@Example.com ', PASSWORD)
  assert.equal(result.kind, 'unlocked')
  if (result.kind !== 'unlocked') return
  assert.equal(result.next.step, 'app')
  assert.equal(result.unlocked.email, EMAIL)
  assert.ok(await opensSample(server, account, result.unlocked.dataKey))
  // The tab's copy can be used but never read out or wrapped again.
  assert.equal(result.unlocked.dataKey.extractable, false)

  assert.equal((await signInWithKeys(server.tab(), EMAIL, keys.new)).kind, 'wrong')
  assert.equal((await signInWithKeys(server.tab(), 'nobody@example.com', keys.old)).kind, 'wrong')
})

test('Sign-in skips a newer password wrap that does not open, and stops when none do', async () => {
  const server = FakeServer.from(start)
  server.insiderAdd('key_wraps', account.id, junkWrap('password', 50))
  assert.ok(await passwordOpens(server, account, keys.old))

  for (const wrap of server.rowsOf(account.id, 'key_wraps').filter(w => w.kind === 'password' && w.version_no !== 50)) {
    server.insiderDelete('key_wraps', wrap.id)
  }
  const tab = server.tab()
  assert.equal((await signInWithKeys(tab, EMAIL, keys.old)).kind, 'keys-wont-open')
  // It signed out, so the tab can't read anything.
  await assert.rejects(tab.keyWraps())
})

test('Sign-in stops when the password wraps are gone but records are not', async () => {
  const server = FakeServer.from(start)
  for (const wrap of server.rowsOf(account.id, 'key_wraps')) server.insiderDelete('key_wraps', wrap.id)
  assert.equal((await signInWithKeys(server.tab(), EMAIL, keys.old)).kind, 'keys-missing')
})

test('Sign-in asks for a new recovery key when the newest recovery wrap is not the saved one', async () => {
  const server = FakeServer.from(start)
  server.insiderAdd('key_wraps', account.id, junkWrap('recovery', 50))
  assert.equal(await whereSignInGoes(server, account, keys.old, [account.recovery]), 'asks-for-a-new-key')
})

// ---------- Setup ----------

test('Setup refuses a weak password before calling the server, and needs an invite', async () => {
  const server = new FakeServer()
  const tab = server.tab()
  assert.deepEqual(await createAccount(tab, EMAIL, 'too short'), { kind: 'password-rules', problem: 'too-short' })
  assert.equal(server.calls, 0)
  assert.equal((await createAccount(tab, EMAIL, PASSWORD)).kind, 'not-invited')
  assert.equal((await createAccount(FakeServer.from(start).tab(), EMAIL, NEW_PASSWORD)).kind, 'exists')
})

test('Setup that stops after any call carries on at the right step at the next sign-in', async () => {
  const fresh = new FakeServer()
  fresh.invite(EMAIL)
  await everyFault(
    fresh.snapshot(),
    async server => ({ tab: server.tab() }),
    async ({ tab }) => {
      const created = await createAccount(tab, EMAIL, PASSWORD)
      if (created.kind !== 'created') return created
      const saved = await saveRecoveryKey(tab, created.unlocked.dataKey, created.newKey, created.prepared)
      if (saved !== 'saved') return saved
      await takeBackup(tab, created.unlocked.dataKey)
      return 'finished'
    },
    async (server, _context, outcome, label) => {
      if (server.account(EMAIL) === undefined) {
        // The sign-up itself never arrived, so there's nothing to carry on.
        assert.equal((await signInWithKeys(server.tab(), EMAIL, keys.old)).kind, 'wrong', label)
        return
      }
      // Keep signing in and doing whatever step sign-in asks for, as someone
      // would. It must end in the app within three goes, and straight away
      // if setup had finished.
      for (let go = 0; go < 3; go++) {
        const tab = server.tab()
        const result = await signInWithKeys(tab, EMAIL, keys.old)
        assert.equal(result.kind, 'unlocked', label)
        if (result.kind !== 'unlocked' || result.next.step === 'app') return
        assert.notEqual(outcome, 'finished', `${label}: setup finished, so sign-in should go straight to the app`)
        if (result.next.step === 'save-recovery-key') {
          assert.equal(await saveRecoveryKey(tab, result.unlocked.dataKey, result.next.newKey, result.next.prepared), 'saved', label)
        } else {
          await takeBackup(tab, result.unlocked.dataKey)
        }
      }
      assert.fail(`${label}: setup never finished`)
    },
  )
})

// ---------- Changing the password ----------

test('Changing the password: the old one stops working, the new one opens the same data key', async () => {
  const server = FakeServer.from(start)
  const { tab, unlocked } = await signedIn(server, keys.old)
  assert.deepEqual(await changePassword(tab, unlocked, PASSWORD, NEW_PASSWORD), { kind: 'changed' })
  assert.equal(await passwordOpens(server, account, keys.old), false)
  assert.ok(await passwordOpens(server, account, keys.new))
  // Only the old password wrap went. The recovery key still works.
  assert.equal(server.rowsOf(account.id, 'key_wraps').filter(w => w.kind === 'password').length, 1)
  assert.ok(await recoveryKeyWorks(server, account, account.recovery))
})

test('Changing the password refuses a wrong current password, the same password and weak ones', async () => {
  const server = FakeServer.from(start)
  const { tab, unlocked } = await signedIn(server, keys.old)
  const wrapsBefore = server.rowsOf(account.id, 'key_wraps').length
  assert.deepEqual(await changePassword(tab, unlocked, 'not my password at all', NEW_PASSWORD), { kind: 'wrong-current' })
  assert.deepEqual(await changePassword(tab, unlocked, PASSWORD, PASSWORD), { kind: 'same' })
  assert.deepEqual(await changePassword(tab, unlocked, PASSWORD, 'aaaaaaaaaaaaaaaa'), { kind: 'password-rules', problem: 'one-character' })
  assert.equal(server.rowsOf(account.id, 'key_wraps').length, wrapsBefore)
  assert.ok(await passwordOpens(server, account, keys.old))
})

test('A password change that stops after any call leaves exactly one password working', async () => {
  const calls = await everyFault(
    start,
    server => signedIn(server, keys.old),
    ({ tab, unlocked }) => changePassword(tab, unlocked, PASSWORD, NEW_PASSWORD),
    async (server, _context, outcome, label) => {
      const oldOpens = await passwordOpens(server, account, keys.old)
      const newOpens = await passwordOpens(server, account, keys.new)
      assert.notEqual(oldOpens, newOpens, `${label}: old ${oldOpens}, new ${newOpens}`)
      // "Changed" must be true, and so must "nothing changed". With only one
      // fault, the check after a lost answer always gets through, so
      // "failed" here also means the old password still works.
      const kind = (outcome as { kind?: string }).kind
      if (kind === 'changed') assert.ok(newOpens, label)
      if (kind === 'failed' || kind === 'wrong-current' || kind === 'too-many-tries') assert.ok(oldOpens, label)
      assert.ok(await recoveryKeyWorks(server, account, account.recovery), `${label}: the recovery key`)
    },
  )
  assert.equal(calls, 5)
})

// ---------- Forgot password ----------

test('Forgot password catches a typo before anything is sent', async () => {
  const server = FakeServer.from(start)
  // A changed character that the check bits catch. They catch about 15 in
  // 16, so this tries replacements until it finds one.
  let typo: string | undefined
  for (const character of '0123456789ABCDEFGHJKMNPQRSTVWXYZ') {
    const text = account.recoveryKeyText.slice(0, 20) + character + account.recoveryKeyText.slice(21)
    if (text !== account.recoveryKeyText && (await readRecoveryKey(text)).ok === false) {
      typo = text
      break
    }
  }
  if (typo === undefined) throw new Error('No caught typo found')
  assert.deepEqual(await recoverAccount(server.tab(), EMAIL, typo, NEW_PASSWORD), { kind: 'key-problem', problem: 'typo' })
  const missingGroup = account.recoveryKeyText.slice(5)
  assert.deepEqual(await recoverAccount(server.tab(), EMAIL, missingGroup, NEW_PASSWORD), { kind: 'key-problem', problem: 'length' })
  assert.equal(server.calls, 0)
  assert.equal(server.account(EMAIL)?.recoveryTries.length, 0)
})

test('Forgot password: after 5 wrong keys in a day, even the right key waits 24 hours', async () => {
  const server = FakeServer.from(start)
  const someoneElses = (await makeNewRecoveryKey()).groups.join(' ')
  for (let i = 0; i < 5; i++) assert.equal((await recoverAccount(server.tab(), EMAIL, someoneElses, NEW_PASSWORD)).kind, 'refused')
  assert.equal((await recoverAccount(server.tab(), EMAIL, account.recoveryKeyText, NEW_PASSWORD)).kind, 'refused')
  assert.ok(await passwordOpens(server, account, keys.old))
  server.advance(24 * 60 * 60 * 1000 + 1000)
  assert.equal((await recoverAccount(server.tab(), EMAIL, account.recoveryKeyText, NEW_PASSWORD)).kind, 'recovered')
})

test('Forgot password: the old key works until the new one is saved, then only the new one does', async () => {
  const server = FakeServer.from(start)
  const tab = server.tab()
  const result = await recoverAccount(tab, EMAIL, account.recoveryKeyText, NEW_PASSWORD)
  if (result.kind !== 'recovered') throw new Error(result.kind)
  assert.equal(await passwordOpens(server, account, keys.old), false)
  assert.ok(await passwordOpens(server, account, keys.new))
  // Stopped here, the old key still works, and sign-in asks for a new one.
  assert.ok(await recoveryKeyWorks(server, account, account.recovery))
  assert.equal(await whereSignInGoes(server, account, keys.new, [account.recovery]), 'asks-for-a-new-key')

  const newKeys = await keysOf(result.newKey)
  // More than 5 minutes later, so only the old proof lets the save through.
  server.advance(10 * 60 * 1000)
  assert.equal(await saveRecoveryKey(tab, result.unlocked.dataKey, result.newKey, result.prepared, result.oldProofHex), 'saved')
  assert.equal(await recoveryKeyWorks(server, account, account.recovery), false)
  assert.ok(await recoveryKeyWorks(server, account, newKeys))
  assert.equal(await whereSignInGoes(server, account, keys.new, [newKeys]), 'app')
})

test('Forgot password that stops after any call leaves the old key working, or the new password and key', async () => {
  type Context = { tab: ReturnType<FakeServer['tab']>; newKeys?: RecoveryKeys }
  await everyFault<Context>(
    start,
    async server => ({ tab: server.tab() }),
    async context => {
      const result = await recoverAccount(context.tab, EMAIL, account.recoveryKeyText, NEW_PASSWORD)
      if (result.kind !== 'recovered') return result
      context.newKeys = await keysOf(result.newKey)
      return saveRecoveryKey(context.tab, result.unlocked.dataKey, result.newKey, result.prepared, result.oldProofHex)
    },
    async (server, context, outcome, label) => {
      const oldKey = await recoveryKeyWorks(server, account, account.recovery)
      const newKey = await recoveryKeyWorks(server, account, context.newKeys)
      const newPassword = await passwordOpens(server, account, keys.new)
      assert.ok(oldKey || (newPassword && newKey), `${label}: old key ${oldKey}, new key ${newKey}, new password ${newPassword}`)
      if (outcome === 'saved') assert.ok(newKey && newPassword && !oldKey, label)
      const working = newPassword ? keys.new : keys.old
      if (newPassword || (await passwordOpens(server, account, keys.old))) {
        const goes = await whereSignInGoes(server, account, working, [account.recovery, context.newKeys])
        assert.notEqual(goes, 'trusts-a-key-that-does-not-work', label)
      }
    },
  )
})

// ---------- A new recovery key from Settings ----------

test('A new recovery key needs the password, and the old key stops working once it is saved', async () => {
  const server = FakeServer.from(start)
  const { tab, unlocked } = await signedIn(server, keys.old)
  const newKey = await makeNewRecoveryKey()
  const newKeys = await keysOf(newKey)
  assert.equal(await replaceRecoveryKey(tab, unlocked, newKey, NEW_PASSWORD), 'wrong-password')
  assert.ok(await recoveryKeyWorks(server, account, account.recovery))
  assert.equal(await replaceRecoveryKey(tab, unlocked, newKey, PASSWORD), 'saved')
  assert.equal(await recoveryKeyWorks(server, account, account.recovery), false)
  assert.ok(await recoveryKeyWorks(server, account, newKeys))
  assert.equal(await whereSignInGoes(server, account, keys.old, [newKeys]), 'app')
})

test('Saving a replacement key more than 5 minutes after signing in asks for the password', async () => {
  const server = FakeServer.from(start)
  // A recovery wrap that isn't the saved one, so sign-in asks for a new key.
  server.insiderAdd('key_wraps', account.id, junkWrap('recovery', 50))
  const tab = server.tab()
  const resumed = await signInWithKeys(tab, EMAIL, keys.old)
  if (resumed.kind !== 'unlocked' || resumed.next.step !== 'save-recovery-key') throw new Error('expected a new key')
  const { newKey, prepared } = resumed.next
  const newKeys = await keysOf(newKey)
  server.advance(6 * 60 * 1000)
  assert.equal(await saveRecoveryKey(tab, resumed.unlocked.dataKey, newKey, prepared), 'needs-password')
  assert.ok(await recoveryKeyWorks(server, account, account.recovery))
  assert.equal(await replaceRecoveryKey(tab, resumed.unlocked, newKey, PASSWORD), 'saved')
  assert.equal(await recoveryKeyWorks(server, account, account.recovery), false)
  assert.ok(await recoveryKeyWorks(server, account, newKeys))
  assert.equal(await whereSignInGoes(server, account, keys.old, [newKeys]), 'app')
})

test('A new recovery key that stops after any call leaves the old or the new key working', async () => {
  type Context = { tab: ReturnType<FakeServer['tab']>; unlocked: Awaited<ReturnType<typeof signedIn>>['unlocked']; newKey: NewRecoveryKey; newKeys: RecoveryKeys }
  const calls = await everyFault<Context>(
    start,
    async server => {
      const { tab, unlocked } = await signedIn(server, keys.old)
      const newKey = await makeNewRecoveryKey()
      return { tab, unlocked, newKey, newKeys: await keysOf(newKey) }
    },
    ({ tab, unlocked, newKey }) => replaceRecoveryKey(tab, unlocked, newKey, PASSWORD),
    async (server, { newKeys }, outcome, label) => {
      assert.ok(await passwordOpens(server, account, keys.old), `${label}: the password`)
      const oldKey = await recoveryKeyWorks(server, account, account.recovery)
      const newKey = await recoveryKeyWorks(server, account, newKeys)
      assert.ok(oldKey !== newKey, `${label}: old key ${oldKey}, new key ${newKey}`)
      if (outcome === 'saved') assert.ok(newKey, label)
      const goes = await whereSignInGoes(server, account, keys.old, [account.recovery, newKeys])
      assert.notEqual(goes, 'trusts-a-key-that-does-not-work', label)
    },
  )
  assert.equal(calls, 8)
})

test('A password change after a half-saved recovery key leaves the old recovery key working', async () => {
  const server = FakeServer.from(start)
  const { tab, unlocked } = await signedIn(server, keys.old)
  // The new key's wrap is saved (call 3), then the tab closes before its proof.
  server.breakCall(3, 'crash')
  await assert.rejects(replaceRecoveryKey(tab, unlocked, await makeNewRecoveryKey(), PASSWORD), TabClosed)
  const again = await signedIn(server, keys.old)
  assert.deepEqual(await changePassword(again.tab, again.unlocked, PASSWORD, NEW_PASSWORD), { kind: 'changed' })
  // The password change cleared only password wraps, so the old key's wrap is still there.
  assert.ok(await recoveryKeyWorks(server, account, account.recovery))
  assert.equal(await whereSignInGoes(server, account, keys.new, [account.recovery]), 'asks-for-a-new-key')
})

test('Forgot password after a half-saved recovery key still works with the key you have', async () => {
  const server = FakeServer.from(start)
  const { tab, unlocked } = await signedIn(server, keys.old)
  server.breakCall(3, 'crash')
  await assert.rejects(replaceRecoveryKey(tab, unlocked, await makeNewRecoveryKey(), PASSWORD), TabClosed)
  // The newest recovery wrap is now one your key can't open, so recovery
  // has to try the older one too.
  const result = await recoverAccount(server.tab(), EMAIL, account.recoveryKeyText, NEW_PASSWORD)
  assert.equal(result.kind, 'recovered')
  // Stopped before saving the new key, the one you used still works, and
  // only the new password's wrap is left.
  assert.ok(await recoveryKeyWorks(server, account, account.recovery))
  assert.ok(await passwordOpens(server, account, keys.new))
  assert.equal(server.rowsOf(account.id, 'key_wraps').filter(w => w.kind === 'password').length, 1)
})

// ---------- Several tabs ----------

test('Two tabs saving settings at the same moment both get saved', async () => {
  const server = FakeServer.from(start)
  const first = await signedIn(server, keys.old)
  const second = await signedIn(server, keys.old)
  const before = await loadSettings(first.tab, first.unlocked.dataKey)
  await Promise.all([
    recordBackup(first.tab, first.unlocked.dataKey, new Date('2026-11-03T09:00:00.000Z')),
    recordBackup(second.tab, second.unlocked.dataKey, new Date('2026-11-03T09:00:01.000Z')),
  ])
  const after = await loadSettings(first.tab, first.unlocked.dataKey)
  assert.equal(after.newestVersion, before.newestVersion + 2)
  assert.equal(after.unreadable, 0)
  assert.ok(after.record.lastBackupAt?.startsWith('2026-11-03T09:00:0'))
  assert.equal(after.record.recoveryWrapId, before.record.recoveryWrapId)
})
