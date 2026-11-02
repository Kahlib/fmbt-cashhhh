// Turns an email and password into the two values the app needs, without
// ever storing the password (fmbt-security, section 1):
//
//   password + email
//     └ PBKDF2-SHA256, 600,000 rounds, salt "fmbt-cashhhh:v1:" + email → master secret
//         ├ HKDF, label "fmbt-cashhhh v1 login" → login token, sent to Supabase as the account password
//         └ HKDF, label "fmbt-cashhhh v1 wrap"  → password wrap key, which never leaves the browser
//
// Changing anything here would stop every existing password working, so
// tests/crypto.test.ts pins the exact output. Stronger settings later get a
// new version number instead, and v1 stays readable.
import { type Bytes, toHex, utf8 } from './bytes.ts'

// The settings for each version. "as const" tells TypeScript these values
// never change, so it can check every use of them exactly.
const KDF_SETTINGS = {
  1: {
    iterations: 600_000,             // OWASP's figure for PBKDF2-SHA256
    saltPrefix: 'fmbt-cashhhh:v1:',
    loginLabel: 'fmbt-cashhhh v1 login',
    wrapLabel: 'fmbt-cashhhh v1 wrap',
  },
} as const

export type KdfVersion = keyof typeof KDF_SETTINGS
export const NEWEST_KDF_VERSION: KdfVersion = 1

export type PasswordKeys = {
  v: KdfVersion
  loginToken: string // 64 hex characters, which Supabase sees as the password
  wrapKey: CryptoKey // locks and unlocks the data key; can't be read out of the browser
}

// The salt's email: trimmed and lowercased, so " KMan@Example.com" and
// "kman@example.com" give the same keys.
export function tidyEmail(email: string): string {
  return email.trim().toLowerCase()
}

// The password is normalised, never trimmed. NFC makes "é" give the same
// bytes whether a keyboard types it as one character or two, and spaces
// stay part of the password.
export function normalisePassword(password: string): string {
  return password.normalize('NFC')
}

// The slow part: 600,000 rounds take about a second in a browser, which is
// what makes guessing passwords expensive for an attacker.
export async function derivePasswordKeys(
  email: string,
  password: string,
  v: KdfVersion = NEWEST_KDF_VERSION,
): Promise<PasswordKeys> {
  const settings = KDF_SETTINGS[v]
  const passwordKey = await crypto.subtle.importKey(
    'raw', utf8(normalisePassword(password)), 'PBKDF2', false, ['deriveBits'],
  )
  const master = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: utf8(settings.saltPrefix + tidyEmail(email)), iterations: settings.iterations },
    passwordKey,
    256,
  ))

  // HKDF splits the master secret in two. Different labels give unrelated
  // results, so Supabase learns nothing about the wrap key from the token.
  const login = await hkdfBytes(master, settings.loginLabel)
  const wrapKey = await hkdfWrapKey(master, settings.wrapLabel)
  master.fill(0) // wipe the master secret now it's no longer needed
  return { v, loginToken: toHex(login), wrapKey }
}

// HKDF with an empty salt, which is fine here because the input is already
// random-looking. Shared with the recovery key code.
export async function hkdfBytes(secret: Bytes, label: string): Promise<Bytes> {
  const base = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveBits'])
  return new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: utf8(label) },
    base,
    256,
  ))
}

// The same, but straight into an AES-GCM key that can only wrap and unwrap
// other keys, and can't be read back out (extractable: false).
export async function hkdfWrapKey(secret: Bytes, label: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: utf8(label) },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['wrapKey', 'unwrapKey'],
  )
}
