// Setup step 1: create the account and its data key (fmbt-security, sections
// 1 and 4). Steps 2 and 3 show and save the recovery key with
// new-recovery-key.ts, and step 4 takes the first backup with backup.ts.
import { ServerError, type AccountApi } from './api.ts'
import { checkPassword, type PasswordProblem } from './password-rules.ts'
import { derivePasswordKeys, tidyEmail } from '../crypto/kdf.ts'
import { type KeyWrapRow, makeDataKey } from '../crypto/keys.ts'
import { makeNewRecoveryKey, prepareRecoveryWrap, type NewRecoveryKey, type PreparedRecoveryWrap } from './new-recovery-key.ts'
import { nextVersion, saveAndProveWrap, type Unlocked } from './wraps.ts'

// What steps 2 and 3 need: the unlocked tab, the new recovery key to show,
// and its wrap, ready to save once three groups have been typed back.
export type StepOneDone = { unlocked: Unlocked; newKey: NewRecoveryKey; prepared: PreparedRecoveryWrap }

export type CreateAccountResult =
  | ({ kind: 'created' } & StepOneDone)
  | { kind: 'password-rules'; problem: PasswordProblem }
  | { kind: 'not-invited' | 'exists' | 'too-many-tries' | 'unavailable' }

export async function createAccount(api: AccountApi, email: string, password: string): Promise<CreateAccountResult> {
  const rules = checkPassword(password, email)
  if (!rules.ok) return { kind: 'password-rules', problem: rules.problem }
  const keys = await derivePasswordKeys(email, password)
  // The invite check runs here, inside Supabase. No email goes out.
  const auth = await api.signUp(tidyEmail(email), keys.loginToken)
  if (!auth.ok) return { kind: auth.problem === 'wrong' ? 'unavailable' : auth.problem }
  return { kind: 'created', ...(await finishStepOne(api, tidyEmail(email), keys.wrapKey, [])) }
}

// Makes the data key, saves it wrapped by the password and proves that wrap
// opens, then gets the recovery key ready. Sign-in calls this too, if setup
// stopped right after the account was created.
export async function finishStepOne(
  api: AccountApi, email: string, passwordWrapKey: CryptoKey, existingWraps: KeyWrapRow[],
): Promise<StepOneDone> {
  // The only time a data key is made. It can be wrapped until this
  // function ends, and the tab keeps the copy that can't.
  const dataKey = await makeDataKey()
  const sessionKey = await saveAndProveWrap(api, dataKey, passwordWrapKey, {
    kind: 'password', version_no: nextVersion(existingWraps, 'password'),
  })
  if (sessionKey === null) throw new ServerError()
  const newKey = await makeNewRecoveryKey()
  const prepared = await prepareRecoveryWrap(dataKey, newKey, existingWraps)
  return { unlocked: { email, dataKey: sessionKey }, newKey, prepared }
}
