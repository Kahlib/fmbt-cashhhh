// The rules a new password must meet (fmbt-security, section 1):
//   - at least 15 characters, NIST's 2025 minimum when a password is the only
//     sign-in step, and at most 256
//   - no rules about capitals, digits or symbols
//   - not the email, not the app's name, not one character repeated, and not
//     on a short list of well-known long passwords
//
// Only the browser ever sees the real password, so these checks happen here.
// Supabase only gets the 64-character login token.
import { normalisePassword, tidyEmail } from '../crypto/kdf.ts'

export const MIN_CHARACTERS = 15
export const MAX_CHARACTERS = 256

export type PasswordProblem = 'too-short' | 'too-long' | 'is-email' | 'is-app-name' | 'one-character' | 'common'

// Long passwords that show up again and again in leaked password lists,
// written without spaces or capitals.
const COMMON = new Set([
  '123456789012345', '1234567890123456', '12345678901234567890', '098765432109876',
  'qwertyuiopasdfg', 'qwertyuiopasdfgh', 'qwertyuiopasdfghjkl', 'qwertyuiopasdfghjklzxcvbnm',
  'asdfghjklqwertyuiop', 'zxcvbnmasdfghjkl', '1q2w3e4r5t6y7u8i', '1q2w3e4r5t6y7u8i9o0p',
  'qazwsxedcrfvtgbyhn', 'abcdefghijklmnop', 'abcdefghijklmnopqrstuvwxyz', 'passwordpassword',
  'password12345678', 'password1234567', 'iloveyouiloveyou', 'letmeinletmein1',
  'correcthorsebatterystaple', 'thequickbrownfoxjumpsoverthelazydog', 'trustno1trustno1',
  'mypasswordismypassword', 'changemechangeme',
])

// Characters as people count them: "é" is one, however it was typed.
export function countCharacters(password: string): number {
  return [...normalisePassword(password)].length
}

export function checkPassword(password: string, email: string): { ok: true } | { ok: false; problem: PasswordProblem } {
  const count = countCharacters(password)
  if (count < MIN_CHARACTERS) return { ok: false, problem: 'too-short' }
  if (count > MAX_CHARACTERS) return { ok: false, problem: 'too-long' }

  // Compare without spaces, punctuation or capitals, so "Correct horse
  // battery staple!" counts as the well-known one it is.
  const plain = lettersAndDigits(normalisePassword(password).toLowerCase())
  const [localPart] = tidyEmail(email).split('@')
  if (plain === lettersAndDigits(tidyEmail(email)) || plain === lettersAndDigits(localPart)) {
    return { ok: false, problem: 'is-email' }
  }
  // Nothing but the app's name and numbers, like "FMBT Cashhhh 2026".
  if (/fmbt|cashhhh/.test(plain) && plain.replace(/fmbt|cashhhh|cash|parlay|tracker/g, '').replace(/\d/g, '') === '') {
    return { ok: false, problem: 'is-app-name' }
  }
  if (new Set(normalisePassword(password)).size === 1) return { ok: false, problem: 'one-character' }
  if (COMMON.has(plain)) return { ok: false, problem: 'common' }
  return { ok: true }
}

// Just the letters and digits, in any alphabet.
function lettersAndDigits(text: string): string {
  return text.replace(/[^\p{L}\p{N}]/gu, '')
}
