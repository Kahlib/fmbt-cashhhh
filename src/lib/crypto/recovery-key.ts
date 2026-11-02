// Recovery keys: the only way back in after a forgotten password
// (fmbt-security, section 1).
//
// A recovery key is 32 random bytes, shown once as 13 groups of 4 characters:
//
//   7KQ2 M9XD 4HTV B8WZ 3FJR N6CE P2YA 5GKM S9VQ T4HD 8XRB W3NJ 6CZE
//
// The characters are Crockford base32: digits and capitals without I, L, O
// or U, so nothing looks like anything else. Each character holds 5 bits, so
// 52 characters hold 260 bits: the key's 256, plus 4 check bits that catch
// about 15 typos in 16 before they use up one of the 5 daily recovery tries.
//
// From the key, HKDF makes two things:
//   - the recovery wrap key, which wraps the data key in key_wraps
//   - the recovery proof. Supabase keeps only its SHA-256 hash, and the
//     recover server function compares against that.
import { type Bytes, randomBytes, toHex, utf8 } from './bytes.ts'
import { hkdfBytes, hkdfWrapKey } from './kdf.ts'

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
export const GROUP_COUNT = 13
const CHARACTERS = GROUP_COUNT * 4 // 52

const WRAP_LABEL = 'fmbt-cashhhh v1 recovery wrap'
const PROOF_LABEL = 'fmbt-cashhhh v1 recovery proof'
const CHECK_LABEL = 'fmbt-cashhhh v1 recovery check'

// A new recovery key: 32 bytes from the secure random generator.
export function makeRecoveryKey(): Bytes {
  return randomBytes(32)
}

// The 4 check bits: the first 4 bits of a SHA-256 hash of the key, with its
// own label so the hash can't be confused with anything else.
async function checkBits(key: Bytes): Promise<number> {
  const label = utf8(CHECK_LABEL)
  const input = new Uint8Array(label.length + key.length)
  input.set(label)
  input.set(key, label.length)
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', input))
  return digest[0] >> 4
}

// The key as 13 groups, ready to show, copy or print.
export async function showRecoveryKey(key: Bytes): Promise<string[]> {
  if (key.length !== 32) throw new Error('A recovery key is 32 bytes.')
  // Feed the bits in 8 at a time and take them out 5 at a time.
  let text = ''
  let buffer = 0
  let bits = 0
  for (const byte of key) {
    buffer = (buffer << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      text += ALPHABET[(buffer >> bits) & 31]
    }
    buffer &= (1 << bits) - 1 // keep only the bits not used yet
  }
  // 256 bits make 51 characters with 1 bit left over. The 4 check bits join
  // it to make the 52nd.
  text += ALPHABET[(buffer << 4) | (await checkBits(key))]
  return text.match(/.{4}/g) ?? []
}

// Tidies typed text the way people write keys: capitals don't matter, spaces
// and dashes (including the long ones word processors make) are ignored, and
// the look-alikes O, I and L read as 0, 1 and 1.
export function tidyKeyText(text: string): string {
  return text.toUpperCase().replace(/[\s\-\u2010-\u2015]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1')
}

export type ReadKeyResult =
  | { ok: true; key: Bytes }
  | { ok: false; problem: 'length' | 'characters' | 'typo' }

// Reads a key someone typed. Typos stop here, in the browser, before anything
// is sent to the server.
export async function readRecoveryKey(text: string): Promise<ReadKeyResult> {
  const tidy = tidyKeyText(text)
  if (tidy.length !== CHARACTERS) return { ok: false, problem: 'length' }
  const values = Array.from(tidy, character => ALPHABET.indexOf(character))
  if (values.includes(-1)) return { ok: false, problem: 'characters' }

  // The reverse of showRecoveryKey: take the bits in 5 at a time, out 8 at a time.
  const key = new Uint8Array(32)
  let buffer = 0
  let bits = 0
  let index = 0
  for (const value of values.slice(0, CHARACTERS - 1)) {
    buffer = (buffer << 5) | value
    bits += 5
    if (bits >= 8) {
      bits -= 8
      key[index++] = (buffer >> bits) & 255
      buffer &= (1 << bits) - 1
    }
  }
  // 51 characters gave 31 bytes and 7 bits. The last character's top bit
  // finishes byte 32, and its other 4 bits are the check.
  const last = values[CHARACTERS - 1]
  key[31] = (buffer << 1) | (last >> 4)
  if ((last & 15) !== (await checkBits(key))) return { ok: false, problem: 'typo' }
  return { ok: true, key }
}

// For setup's check: the group someone types, tidied the same way.
export function tidyGroup(text: string): string {
  return tidyKeyText(text)
}

// Three different group numbers from 1 to 13, in order, for setup's check.
// A shuffle using the secure random generator picks them.
export function pickGroupsToCheck(): number[] {
  const numbers = Array.from({ length: GROUP_COUNT }, (_, i) => i + 1)
  for (let i = numbers.length - 1; i > 0; i--) {
    const j = randomBelow(i + 1)
    const swap = numbers[i]
    numbers[i] = numbers[j]
    numbers[j] = swap
  }
  return numbers.slice(0, 3).sort((a, b) => a - b)
}

// A random whole number from 0 to limit - 1, with no bias toward low numbers.
function randomBelow(limit: number): number {
  const ceiling = Math.floor(256 / limit) * limit
  for (;;) {
    const [byte] = randomBytes(1)
    if (byte < ceiling) return byte % limit
  }
}

export type RecoveryKeys = {
  wrapKey: CryptoKey    // wraps the data key; can't be read out of the browser
  proofHex: string      // sent to the recover function during Forgot password
  proofHashHex: string  // what Supabase stores, through set_recovery_proof
}

// Everything the app needs from a recovery key. Nothing here is the key itself,
// which never leaves the browser.
export async function deriveRecoveryKeys(key: Bytes): Promise<RecoveryKeys> {
  if (key.length !== 32) throw new Error('A recovery key is 32 bytes.')
  const proof = await hkdfBytes(key, PROOF_LABEL)
  const proofHash = new Uint8Array(await crypto.subtle.digest('SHA-256', proof))
  return {
    wrapKey: await hkdfWrapKey(key, WRAP_LABEL),
    proofHex: toHex(proof),
    proofHashHex: toHex(proofHash),
  }
}
