// Words the screens share: password hints, and what to say when something
// goes wrong. Errors say what happened and what to do, and never show
// what the server said (fmbt-design-system, "Numbers and words").
import { checkPassword, countCharacters, MIN_CHARACTERS, type PasswordProblem } from '../lib/account/password-rules.ts'
import { normalisePassword } from '../lib/crypto/kdf.ts'
import { tidyKeyText } from '../lib/crypto/recovery-key.ts'
import type { Backup, BackupCheck } from '../lib/account/backup.ts'
import { count } from '../lib/format.ts'
import type { Message } from '../components/Controls.tsx'

export const OFFLINE = "Couldn't reach the server. Check your connection and try again."
export const TOO_MANY_TRIES = 'Too many tries for now. Wait a few minutes, then try again.'
// A save found that another tab saved the same week first.
export const TAKEN = "Another tab changed this week first. It's been reloaded, so check it and try again."

export function passwordProblemText(problem: PasswordProblem, password: string): string {
  const count = countCharacters(password)
  switch (problem) {
    case 'too-short': return `${count} characters, at least ${MIN_CHARACTERS} needed`
    case 'too-long': return "That's over 256 characters. Choose something shorter."
    case 'is-email': return "That's your email. Choose something else."
    case 'is-app-name': return "That's just the app's name. Choose something else."
    case 'one-character': return "That's one character over and over. Choose something else."
    case 'common': return "That's a well-known password, so it's easy to guess. Choose something else."
  }
}

// The live hint under a new password. Too short only turns into an error
// once you try to go on (`tried`), so typing doesn't flash red.
export function newPasswordHint(password: string, email: string, tried: boolean): Message | null {
  const count = countCharacters(password)
  if (count === 0) return tried ? { tone: 'bad', text: `Choose a password of at least ${MIN_CHARACTERS} characters.` } : null
  const rules = checkPassword(password, email)
  if (rules.ok) return { tone: 'ok', text: `${count} characters, at least ${MIN_CHARACTERS} needed` }
  if (rules.problem === 'too-short' && !tried) return { tone: 'neutral', text: passwordProblemText('too-short', password) }
  return { tone: 'bad', text: passwordProblemText(rules.problem, password) }
}

// The hint under "Type it again".
export function confirmHint(password: string, again: string, tried: boolean): Message | null {
  if (again === '') return tried ? { tone: 'bad', text: 'Type the password again.' } : null
  if (normalisePassword(again) === normalisePassword(password)) return { tone: 'ok', text: 'Matches' }
  return tried ? { tone: 'bad', text: "Doesn't match the password above." } : { tone: 'neutral', text: "Doesn't match yet" }
}

// True when a new password and its repeat are both fine.
export function newPasswordReady(password: string, again: string, email: string): boolean {
  return checkPassword(password, email).ok && normalisePassword(again) === normalisePassword(password)
}

// What to say about a recovery key that didn't read.
export function keyProblemText(problem: 'length' | 'characters' | 'typo', typed: string): string {
  if (problem === 'typo') return 'This key has a typo, so nothing was sent. Compare each group with your saved copy.'
  if (problem === 'characters') return 'This key has a character recovery keys never use, like U. Compare it with your saved copy.'
  const characters = tidyKeyText(typed).length
  const has = characters % 4 === 0 ? `${characters / 4} groups` : `${characters} characters`
  return `A recovery key has 13 groups of 4 characters. This one has ${has}.`
}

// Why a file didn't check out, in one or two sentences.
export function describeCheck(check: BackupCheck, backup: Backup): string {
  const records = backup.weekVersions.length + backup.settingsVersions.length + backup.auditEntries.length
  const versions = (n: number) => count(n, 'saved version', 'saved versions')
  if (!check.keysMatch && records > 0 && check.wontOpen === records) return "Nothing in it opens with your key, so it's probably from another account."
  if (check.missing > 0) return `It's missing ${versions(check.missing)}, so it's probably an older backup.`
  if (check.changed + check.wontOpen > 0) return `${versions(check.changed + check.wontOpen)} in it ${check.changed + check.wontOpen === 1 ? 'has' : 'have'} been changed, so it can't restore everything.`
  if (check.extra > 0) return `It has ${versions(check.extra)} your account doesn't, so it isn't the one you just downloaded.`
  if (!check.keysMatch) return "Its keys don't match your account's, so it's probably from before your last password or recovery key change."
  return "It doesn't match your account."
}
