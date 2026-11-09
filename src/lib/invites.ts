// The invite list, for app admins (step 10.5). Only an email on the list can
// make an account: the database's sign-up hook checks it. The database
// refuses the list to anyone who isn't an app admin, and that refusal is how
// Settings knows to leave Invites out. The app never emails anyone: an admin
// tells their friends themselves. Invited emails stay on the server, and the
// page holds them only while Settings is open.
import type { InviteRow } from './account/api.ts'
import { tidyEmail } from './crypto/kdf.ts'
import { count } from './format.ts'

export const MAX_EMAIL = 254

// The rule private.invites checks: at most 254 characters, no spaces, and
// something@something.something. The database also lowercases and trims it.
export function isInviteEmail(email: string): boolean {
  return email.length <= MAX_EMAIL && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)
}

// What's wrong with an email typed into Invites, or null when it can go on.
export function inviteProblem(typed: string, list: readonly InviteRow[]): string | null {
  const email = tidyEmail(typed)
  if (email === '') return 'Enter an email.'
  if (!isInviteEmail(email)) return 'Enter an email like name@example.com.'
  if (list.some(each => each.email === email)) return 'That email is already on the list.'
  return null
}

// "3 invites, 2 with an account."
export function inviteSummary(list: readonly InviteRow[]): string {
  if (list.length === 0) return 'No invites yet.'
  const joined = list.filter(each => each.has_account).length
  return `${count(list.length, 'invite', 'invites')}, ${joined === list.length && joined > 1 ? 'all' : joined} with an account.`
}
