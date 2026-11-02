// Changing your password, in two phases (fmbt-security, section 1):
//   1. Open your data key with the current password. That proves you know
//      it, right here in the browser.
//   2. Wrap the data key under the new password, save that, read it back
//      and prove it opens.
//   3. Only then change the Supabase password, which also checks the current
//      one and signs out your other sessions.
//   4. Clear the old password wraps.
// Whichever password Supabase ends up with, its wrap is already saved, so a
// change that stops partway never locks you out. Nothing is re-encrypted,
// because the data key stays the same.
import type { AccountApi } from './api.ts'
import { checkPassword, type PasswordProblem } from './password-rules.ts'
import { derivePasswordKeys, normalisePassword } from '../crypto/kdf.ts'
import { newestFirst, nextVersion, openFirst, saveAndProveWrap, type Unlocked } from './wraps.ts'

export type ChangePasswordResult =
  | { kind: 'changed' }         // the app then asks for a fresh backup
  | { kind: 'password-rules'; problem: PasswordProblem }
  | { kind: 'same' }            // the new password is the current one
  | { kind: 'wrong-current' }   // nothing changed
  | { kind: 'too-many-tries' }  // nothing changed
  | { kind: 'failed' }          // it may not have finished: either password could be the one that works

export async function changePassword(
  api: AccountApi, unlocked: Unlocked, currentPassword: string, newPassword: string,
): Promise<ChangePasswordResult> {
  const rules = checkPassword(newPassword, unlocked.email)
  if (!rules.ok) return { kind: 'password-rules', problem: rules.problem }
  if (normalisePassword(newPassword) === normalisePassword(currentPassword)) return { kind: 'same' }

  const current = await derivePasswordKeys(unlocked.email, currentPassword)
  const next = await derivePasswordKeys(unlocked.email, newPassword)
  const wraps = await api.keyWraps()

  // Phase one. The copy of the data key that can be wrapped lives only in
  // this function.
  const opened = await openFirst(newestFirst(wraps, 'password'), current.wrapKey, { extractable: true })
  if (opened === null) return { kind: 'wrong-current' }
  const proven = await saveAndProveWrap(api, opened.key, next.wrapKey, {
    kind: 'password', version_no: nextVersion(wraps, 'password'),
  })
  if (proven === null) return { kind: 'failed' }

  // Phase two. Supabase checks the current login token itself too.
  const auth = await api.changePassword(current.loginToken, next.loginToken)
  if (!auth.ok) {
    if (auth.problem === 'too-many-tries') return { kind: 'too-many-tries' }
    // If the connection dropped, the change may still have happened. Signing
    // in with the new password is the way to find out.
    if (auth.problem !== 'unavailable' || !(await api.signIn(unlocked.email, next.loginToken)).ok) return { kind: 'failed' }
  }

  // Only password wraps. Recovery wraps are cleared only once a new
  // recovery key is safely saved.
  await api.deleteOldKeyWraps('password')
  return { kind: 'changed' }
}
