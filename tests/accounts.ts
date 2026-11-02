// Helpers the account tests share: a test account set up the way the app
// sets one up, and the checks behind "can this person still get in?".
import assert from 'node:assert/strict'
import { ServerError } from '../src/lib/account/api.ts'
import { checkBackup, exportBackup, readBackup, recordBackup } from '../src/lib/account/backup.ts'
import { saveRecoveryKey, type NewRecoveryKey } from '../src/lib/account/new-recovery-key.ts'
import { createAccount } from '../src/lib/account/setup.ts'
import { signInWithKeys } from '../src/lib/account/signin.ts'
import { newestFirst, openFirst, type Unlocked } from '../src/lib/account/wraps.ts'
import type { PasswordKeys } from '../src/lib/crypto/kdf.ts'
import { decryptRecord, encryptRecord, RECORD_VERSION } from '../src/lib/crypto/records.ts'
import { deriveRecoveryKeys, readRecoveryKey, type RecoveryKeys } from '../src/lib/crypto/recovery-key.ts'
import { FAULTS, FakeServer, TabClosed, type FakeTab } from './fake-api.ts'

export const EMAIL = 'kman@example.com'
export const PASSWORD = 'copper ladder sunrise fence'
export const NEW_PASSWORD = 'violet harbour quiet engine'
const SAMPLE = { note: 'A junk week, so there is something to open' }

export type TestAccount = {
  id: string               // the account's ID on the fake server
  recoveryKeyText: string  // the key as someone would type it back
  recovery: RecoveryKeys   // its proof and wrap key, worked out once
  sampleId: string         // a week record saved with the data key
}

// The recovery key's proof and wrap key, from its 13 groups.
export async function keysOf(key: NewRecoveryKey | string): Promise<RecoveryKeys> {
  const read = await readRecoveryKey(typeof key === 'string' ? key : key.groups.join(' '))
  if (!read.ok) throw new Error('That recovery key text should read.')
  return deriveRecoveryKeys(read.key)
}

// Sets up an account the way the app does: setup steps 1 to 4, then one
// encrypted week record to open later.
export async function setUpAccount(server: FakeServer, email = EMAIL, password = PASSWORD): Promise<TestAccount> {
  server.invite(email)
  const tab = server.tab()
  const created = await createAccount(tab, email, password)
  if (created.kind !== 'created') throw new Error(`Setup said ${created.kind}`)
  const recoveryKeyText = created.newKey.groups.join(' ')
  const recovery = await keysOf(recoveryKeyText)
  assert.equal(await saveRecoveryKey(tab, created.unlocked.dataKey, created.newKey, created.prepared), 'saved')
  const sampleId = await addSample(tab, created.unlocked.dataKey)
  await takeBackup(tab, created.unlocked.dataKey)
  const account = server.account(email)
  if (account === undefined) throw new Error('The account should exist.')
  return { id: account.id, recoveryKeyText, recovery, sampleId }
}

// Export, check and record a backup, like setup step 4.
export async function takeBackup(tab: FakeTab, dataKey: CryptoKey): Promise<string> {
  const exported = await exportBackup(tab)
  const read = readBackup(exported.text)
  if (!read.ok) throw new Error(`The backup didn't read: ${read.problem}`)
  assert.ok((await checkBackup(tab, dataKey, read.backup)).ok)
  await recordBackup(tab, dataKey)
  return exported.text
}

export async function addSample(tab: FakeTab, dataKey: CryptoKey, period = 'MW1'): Promise<string> {
  const plain = { id: crypto.randomUUID(), season: 2026, competition: 'PL', period, version_no: 1, v: RECORD_VERSION }
  const sealed = await encryptRecord('week_versions', plain, SAMPLE, dataKey)
  assert.equal(await tab.addRecord('week_versions', { ...plain, ...sealed }), 'saved')
  return plain.id
}

// True if this data key opens the sample record.
export async function opensSample(server: FakeServer, account: TestAccount, dataKey: CryptoKey): Promise<boolean> {
  const row = server.rowsOf(account.id, 'week_versions').find(r => r.id === account.sampleId)
  if (row === undefined) return false
  try {
    return JSON.stringify(await decryptRecord('week_versions', row, dataKey)) === JSON.stringify(SAMPLE)
  } catch {
    return false
  }
}

// A tab signed in with these keys, and what it unlocked.
export async function signedIn(server: FakeServer, keys: PasswordKeys, email = EMAIL): Promise<{ tab: FakeTab; unlocked: Unlocked }> {
  const tab = server.tab()
  const result = await signInWithKeys(tab, email, keys)
  if (result.kind !== 'unlocked') throw new Error(`Sign-in said ${result.kind}`)
  return { tab, unlocked: result.unlocked }
}

// True if this password signs in and opens the same data key as before.
export async function passwordOpens(server: FakeServer, account: TestAccount, keys: PasswordKeys): Promise<boolean> {
  const result = await signInWithKeys(server.tab(), EMAIL, keys)
  return result.kind === 'unlocked' && (await opensSample(server, account, result.unlocked.dataKey))
}

// True if this recovery key would get through Forgot password: the server
// holds its proof's hash, and a recovery wrap opens with it to the same data key.
export async function recoveryKeyWorks(server: FakeServer, account: TestAccount, keys: RecoveryKeys | undefined): Promise<boolean> {
  if (keys === undefined) return false
  const state = server.state.accounts.find(a => a.id === account.id)
  if (state?.proofHash !== keys.proofHashHex) return false
  const opened = await openFirst(newestFirst(server.rowsOf(account.id, 'key_wraps'), 'recovery'), keys.wrapKey, { extractable: false })
  return opened !== null && (await opensSample(server, account, opened.key))
}

// Where sign-in sends you. When it doesn't ask for a new recovery key, it's
// trusting the newest recovery wrap, so that wrap's key must really work:
// it must open the wrap, and its proof must be the one the server holds.
export async function whereSignInGoes(
  server: FakeServer, account: TestAccount, keys: PasswordKeys, recoveryKeys: (RecoveryKeys | undefined)[],
): Promise<string> {
  const result = await signInWithKeys(server.tab(), EMAIL, keys)
  if (result.kind !== 'unlocked') return result.kind
  if (result.next.step === 'save-recovery-key') return 'asks-for-a-new-key'
  const newest = newestFirst(server.rowsOf(account.id, 'key_wraps'), 'recovery')[0]
  for (const candidate of recoveryKeys) {
    if (candidate === undefined || newest === undefined) continue
    const opens = (await openFirst([newest], candidate.wrapKey, { extractable: false })) !== null
    if (opens && (await recoveryKeyWorks(server, account, candidate))) return result.next.step
  }
  return 'trusts-a-key-that-does-not-work'
}

// Runs `flow` once cleanly to count its server calls, then once for every
// call and every way it can break, each from a fresh copy of `start`.
// `prepare` runs first each time (signing in, say) and is never broken.
// `check` looks at the server after each run, with what the flow returned
// or threw.
export async function everyFault<C>(
  start: ReturnType<FakeServer['snapshot']>,
  prepare: (server: FakeServer) => Promise<C>,
  flow: (context: C) => Promise<unknown>,
  check: (server: FakeServer, context: C, outcome: unknown, label: string) => Promise<void>,
): Promise<number> {
  const run = async (n: number, fault: (typeof FAULTS)[number] | undefined) => {
    const server = FakeServer.from(start)
    const context = await prepare(server)
    const before = server.calls
    if (fault !== undefined) server.breakCall(n, fault)
    let outcome: unknown
    try {
      outcome = await flow(context)
    } catch (error) {
      if (!(error instanceof TabClosed) && !(error instanceof ServerError)) throw error
      outcome = error
    }
    const calls = server.calls - before
    await check(server, context, outcome, fault === undefined ? 'no fault' : `call ${n} ${fault}`)
    return calls
  }
  const calls = await run(0, undefined)
  const runs: Promise<number>[] = []
  for (let n = 1; n <= calls; n++) for (const fault of FAULTS) runs.push(run(n, fault))
  await Promise.all(runs)
  return calls
}
