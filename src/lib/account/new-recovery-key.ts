// Making a new recovery key and saving it, which setup, Forgot password,
// Settings and Start from a backup all do the same way:
//
//   1. Make the key and show it. Ask for three groups back.
//   2. Wrap the data key with it. That needs a copy of the data key that can
//      still be wrapped, so each flow does this while it has one.
//   3. Save the wrap, read it back and prove it opens.
//   4. Save the proof's hash. Until this works, the old key (if there is
//      one) still works too.
//   5. Only then clear old recovery wraps.
//   6. Note the new wrap's ID in your settings, which tells sign-in the
//      save finished.
//
// That order means a save that stops at any point leaves a working key, and
// sign-in asks for a new one unless step 6 happened.
import type { AccountApi } from './api.ts'
import { type Bytes } from '../crypto/bytes.ts'
import { type KeyWrapRow, wrapDataKey } from '../crypto/keys.ts'
import { deriveRecoveryKeys, makeRecoveryKey, pickGroupsToCheck, showRecoveryKey, tidyGroup } from '../crypto/recovery-key.ts'
import { updateSettings } from '../records/settings.ts'
import { nextVersion, proveWrap } from './wraps.ts'

export type NewRecoveryKey = {
  key: Bytes             // the 32 bytes, kept in memory only until the key is saved
  groups: string[]       // the 13 groups to show
  checkGroups: number[]  // the three group numbers to ask for, from 1 to 13
}

export async function makeNewRecoveryKey(): Promise<NewRecoveryKey> {
  const key = makeRecoveryKey()
  return { key, groups: await showRecoveryKey(key), checkGroups: pickGroupsToCheck() }
}

// True if the typed groups, in the order of checkGroups, match the key.
export function groupsMatch(newKey: NewRecoveryKey, typed: string[]): boolean {
  return typed.length === newKey.checkGroups.length
    && newKey.checkGroups.every((n, i) => tidyGroup(typed[i]) === newKey.groups[n - 1])
}

export type PreparedRecoveryWrap = {
  row: KeyWrapRow       // the data key wrapped by the new recovery key, ready to save
  wrapKey: CryptoKey    // to prove the saved wrap opens
  proofHashHex: string  // what set_recovery_proof stores
}

// Step 2: wrap the data key with the new recovery key, in memory only.
export async function prepareRecoveryWrap(
  extractableDataKey: CryptoKey, newKey: NewRecoveryKey, existingWraps: KeyWrapRow[],
): Promise<PreparedRecoveryWrap> {
  const derived = await deriveRecoveryKeys(newKey.key)
  const row = await wrapDataKey(extractableDataKey, derived.wrapKey, {
    id: crypto.randomUUID(), kind: 'recovery', version_no: nextVersion(existingWraps, 'recovery'),
  })
  return { row, wrapKey: derived.wrapKey, proofHashHex: derived.proofHashHex }
}

export type SaveKeyResult =
  | 'saved'
  | 'needs-password' // the database wants a recent password sign-in: use replaceRecoveryKey()
  | 'failed'         // nothing changed that matters: the old key, if any, still works

// Steps 3 to 6. `currentProofHex` is the old key's proof, which Forgot
// password has. Setup's first key needs nothing. Anywhere else, the database
// accepts a password sign-in from the last 5 minutes instead.
export async function saveRecoveryKey(
  api: AccountApi, dataKey: CryptoKey, newKey: NewRecoveryKey, prepared: PreparedRecoveryWrap, currentProofHex?: string,
): Promise<SaveKeyResult> {
  // `taken` is fine if an earlier try of this same save got that far, so
  // what matters is whether a wrap with this ID is there and opens.
  await api.addKeyWrap(prepared.row)
  if ((await proveWrap(api, prepared.row.id, prepared.wrapKey)) === null) return 'failed'
  if (!(await api.setRecoveryProof(prepared.proofHashHex, currentProofHex))) return 'needs-password'
  await api.deleteOldKeyWraps('recovery')
  await updateSettings(api, dataKey, record => ({ ...record, recoveryWrapId: prepared.row.id }))
  newKey.key.fill(0) // the key itself is no longer needed in memory
  return 'saved'
}
