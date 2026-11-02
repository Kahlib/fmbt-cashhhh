// Forgot password, and making a new recovery key from Settings
// (fmbt-security, sections 1 and 6).
import type { AccountApi } from './api.ts'
import { checkPassword, type PasswordProblem } from './password-rules.ts'
import { derivePasswordKeys, tidyEmail } from '../crypto/kdf.ts'
import { deriveRecoveryKeys, readRecoveryKey } from '../crypto/recovery-key.ts'
import { updateSettings } from '../records/settings.ts'
import {
  prepareRecoveryWrap, saveRecoveryKey, makeNewRecoveryKey, type NewRecoveryKey, type PreparedRecoveryWrap,
} from './new-recovery-key.ts'
import { newestFirst, nextVersion, openFirst, saveAndProveWrap, type Unlocked } from './wraps.ts'

export type RecoverResult =
  | { kind: 'recovered'; unlocked: Unlocked; newKey: NewRecoveryKey; prepared: PreparedRecoveryWrap; oldProofHex: string }
  | { kind: 'key-problem'; problem: 'length' | 'characters' | 'typo' }
  | { kind: 'password-rules'; problem: PasswordProblem }
  | { kind: 'refused' }        // wrong key, unknown email, or paused after 5 tries: one answer
  | { kind: 'keys-wont-open' } // the proof matched, but no recovery wrap opens with the key
  | { kind: 'unavailable' }

// Forgot password:
//   1. Read the key. Typos stop here, before a try is used.
//   2. The recover server function checks the proof and sets the new password.
//   3. Sign in with it, open a recovery wrap, and save a password wrap for
//      the new password.
//   4. Get a new recovery key ready. The screen then shows it and asks for
//      three groups, and saveRecoveryKey() saves it, passing the old proof.
//      Until then, the old key keeps working, and sign-in keeps asking for a
//      new one.
export async function recoverAccount(
  api: AccountApi, email: string, keyText: string, newPassword: string,
): Promise<RecoverResult> {
  const read = await readRecoveryKey(keyText)
  if (!read.ok) return { kind: 'key-problem', problem: read.problem }
  const rules = checkPassword(newPassword, email)
  if (!rules.ok) return { kind: 'password-rules', problem: rules.problem }

  const recovery = await deriveRecoveryKeys(read.key)
  read.key.fill(0) // only the derived keys are needed from here
  const next = await derivePasswordKeys(email, newPassword)
  if (!(await api.recover(tidyEmail(email), recovery.proofHex, next.loginToken))) return { kind: 'refused' }
  // The password has changed now, and Supabase has signed out every session.
  if (!(await api.signIn(tidyEmail(email), next.loginToken)).ok) return { kind: 'unavailable' }

  const wraps = await api.keyWraps()
  // Every recovery wrap, newest first, in case an earlier key change stopped halfway.
  const opened = await openFirst(newestFirst(wraps, 'recovery'), recovery.wrapKey, { extractable: true })
  if (opened === null) return { kind: 'keys-wont-open' }
  const sessionKey = await saveAndProveWrap(api, opened.key, next.wrapKey, {
    kind: 'password', version_no: nextVersion(wraps, 'password'),
  })
  if (sessionKey === null) return { kind: 'unavailable' }
  await api.deleteOldKeyWraps('password')
  // The key you just used should be replaced, so sign-in asks for a new one
  // until it's saved, even if you stop here.
  await updateSettings(api, sessionKey, record => ({ ...record, recoveryWrapId: null }))

  const newKey = await makeNewRecoveryKey()
  const prepared = await prepareRecoveryWrap(opened.key, newKey, wraps)
  return {
    kind: 'recovered',
    unlocked: { email: tidyEmail(email), dataKey: sessionKey },
    newKey,
    prepared,
    oldProofHex: recovery.proofHex,
  }
}

export type ReplaceKeyResult = 'saved' | 'wrong-password' | 'too-many-tries' | 'failed'

// Saving a new recovery key with your password: Settings' "Make a new
// recovery key", and the fallback when saveRecoveryKey() answers
// `needs-password`. It runs once the new key has been shown and three groups
// typed back. The password is needed twice over: to sign in again, which the
// 5-minute rule needs before a proof can be replaced, and to open a copy of
// the data key that can be wrapped.
export async function replaceRecoveryKey(
  api: AccountApi, unlocked: Unlocked, newKey: NewRecoveryKey, password: string,
): Promise<ReplaceKeyResult> {
  const keys = await derivePasswordKeys(unlocked.email, password)
  const auth = await api.signIn(unlocked.email, keys.loginToken)
  if (!auth.ok) {
    if (auth.problem === 'wrong') return 'wrong-password'
    return auth.problem === 'too-many-tries' ? 'too-many-tries' : 'failed'
  }
  const wraps = await api.keyWraps()
  const opened = await openFirst(newestFirst(wraps, 'password'), keys.wrapKey, { extractable: true })
  if (opened === null) return 'failed'
  const prepared = await prepareRecoveryWrap(opened.key, newKey, wraps)
  return (await saveRecoveryKey(api, unlocked.dataKey, newKey, prepared)) === 'saved' ? 'saved' : 'failed'
}
