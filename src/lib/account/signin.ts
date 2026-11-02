// Signing in (fmbt-security, sections 1 and 3):
//   1. Work out the login token and wrap key from the email and password.
//   2. Sign in with the token. Every failure looks the same to the user.
//   3. Try the password wraps newest first. The first that opens gives the
//      data key, as non-extractable.
//   4. Carry on with setup if it stopped partway, or go to the app.
import type { AccountApi } from './api.ts'
import { derivePasswordKeys, tidyEmail, type PasswordKeys } from '../crypto/kdf.ts'
import { unwrapDataKey } from '../crypto/keys.ts'
import { loadSettings } from '../records/settings.ts'
import { makeNewRecoveryKey, prepareRecoveryWrap, type NewRecoveryKey, type PreparedRecoveryWrap } from './new-recovery-key.ts'
import { finishStepOne } from './setup.ts'
import { newestFirst, openFirst, type Unlocked } from './wraps.ts'

// Where the app goes once the tab is unlocked.
export type NextStep =
  | { step: 'app' }
  | { step: 'save-recovery-key'; newKey: NewRecoveryKey; prepared: PreparedRecoveryWrap } // setup steps 2 and 3
  | { step: 'first-backup' }                                                              // setup step 4

export type SignInResult =
  | { kind: 'unlocked'; unlocked: Unlocked; next: NextStep }
  | { kind: 'wrong' }          // "Email or password is wrong."
  | { kind: 'too-many-tries' }
  | { kind: 'unavailable' }
  | { kind: 'keys-missing' }   // the account has data but no password wrap
  | { kind: 'keys-wont-open' } // password wraps exist, but none opens with this password

export async function signIn(api: AccountApi, email: string, password: string): Promise<SignInResult> {
  return signInWithKeys(api, email, await derivePasswordKeys(email, password))
}

// The same, once the keys are worked out. The tests call this directly, so
// each check doesn't spend another 600,000 rounds.
export async function signInWithKeys(api: AccountApi, email: string, keys: PasswordKeys): Promise<SignInResult> {
  const auth = await api.signIn(tidyEmail(email), keys.loginToken)
  if (!auth.ok) {
    if (auth.problem === 'too-many-tries' || auth.problem === 'unavailable') return { kind: auth.problem }
    return { kind: 'wrong' }
  }
  return unlock(api, tidyEmail(email), keys.wrapKey)
}

// Opens the data key once Supabase has accepted the login token.
async function unlock(api: AccountApi, email: string, wrapKey: CryptoKey): Promise<SignInResult> {
  const wraps = await api.keyWraps()
  const passwordWraps = newestFirst(wraps, 'password')

  if (passwordWraps.length === 0) {
    // No data key at all, and nothing saved: setup stopped right after the
    // account was created, so finish step 1 now. Anything else means the
    // keys went missing, and only the recovery key or a backup can help.
    if (wraps.length > 0 || (await api.hasRecords())) {
      await api.signOut()
      return { kind: 'keys-missing' }
    }
    const done = await finishStepOne(api, email, wrapKey, wraps)
    return { kind: 'unlocked', unlocked: done.unlocked, next: { step: 'save-recovery-key', newKey: done.newKey, prepared: done.prepared } }
  }

  const opened = await openFirst(passwordWraps, wrapKey, { extractable: false })
  if (opened === null) {
    // Supabase accepted the password, yet none of its wraps open with it.
    // Someone may have changed the account, or a recovery stopped halfway.
    await api.signOut()
    return { kind: 'keys-wont-open' }
  }
  const unlocked: Unlocked = { email, dataKey: opened.key }
  const settings = await loadSettings(api, opened.key)

  // Your settings name the recovery wrap of the key you saved. If the newest
  // recovery wrap isn't that one, there's no recovery key yet, or the last
  // save stopped before it finished, so make a fresh one to save.
  const newestRecovery = newestFirst(wraps, 'recovery')[0]
  if (newestRecovery === undefined || newestRecovery.id !== settings.record.recoveryWrapId) {
    // Wrapping it needs a copy of the data key that can be wrapped, briefly.
    const extractable = await unwrapDataKey(opened.row, wrapKey, { extractable: true })
    const newKey = await makeNewRecoveryKey()
    const prepared = await prepareRecoveryWrap(extractable, newKey, wraps)
    return { kind: 'unlocked', unlocked, next: { step: 'save-recovery-key', newKey, prepared } }
  }

  if (settings.record.lastBackupAt === null) return { kind: 'unlocked', unlocked, next: { step: 'first-backup' } }
  return { kind: 'unlocked', unlocked, next: { step: 'app' } }
}
