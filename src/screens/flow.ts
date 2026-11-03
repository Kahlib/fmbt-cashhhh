// Types the screens and App share.
import type { NewRecoveryKey, PreparedRecoveryWrap } from '../lib/account/new-recovery-key.ts'

// Which journey a new recovery key is part of. It sets the headings on the
// key screens and what happens once the key is saved.
export type KeyFlow =
  | 'first-setup'    // setup, or Start from a backup
  | 'settings'       // Settings' "Make a new recovery key"
  | 'after-recovery' // straight after Forgot password
  | 'unfinished'     // sign-in found a key change that didn't finish

// A recovery key on its way to being saved. `prepared` is its wrap, ready
// to save, or null when the password step will prepare it.
export type PendingKey = {
  flow: KeyFlow
  newKey: NewRecoveryKey
  prepared: PreparedRecoveryWrap | null
  oldProofHex?: string // Forgot password passes the old key's proof
}
