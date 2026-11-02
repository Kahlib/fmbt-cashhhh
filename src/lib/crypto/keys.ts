// The data key: one random AES-256 key per account that encrypts every
// record. It's never stored as it is, only "wrapped" (encrypted) by the
// password wrap key and by the recovery wrap key, as rows in key_wraps.
//
// fmbt-security, section 3: after sign-in the tab holds the data key as
// non-extractable, so code in the page can use it but can't read it out, and
// Web Crypto refuses to wrap it. Only key changes (setup, a password change,
// recovery, a new recovery key) use an extractable copy, briefly, to wrap it.
import { fromBase64, randomBytes, toBase64 } from './bytes.ts'
import { aadFor, RECORD_VERSION } from './records.ts'

export type KeyWrapKind = 'password' | 'recovery'

// A key_wraps row, as the browser sends it and the database returns it.
export type KeyWrapRow = {
  id: string            // made by the browser with crypto.randomUUID()
  kind: KeyWrapKind
  version_no: number    // 1, 2, 3… for each kind. Sign-in tries the newest first.
  v: number             // crypto settings version
  iv: string            // base64, 12 bytes
  wrapped: string       // base64, the 32-byte key plus a 16-byte tamper check
}

// A new random data key. It's extractable only so setup can wrap it twice.
// The tab then drops it and keeps a non-extractable copy.
export async function makeDataKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
}

// Wraps the data key into a new key_wraps row. The row's plain columns go into
// the AAD, so a wrap copied to another row, kind or version number won't open.
export async function wrapDataKey(
  dataKey: CryptoKey,
  wrapKey: CryptoKey,
  plain: { id: string; kind: KeyWrapKind; version_no: number },
): Promise<KeyWrapRow> {
  const row = { ...plain, v: RECORD_VERSION }
  const iv = randomBytes(12)
  const wrapped = await crypto.subtle.wrapKey(
    'raw', dataKey, wrapKey, { name: 'AES-GCM', iv, additionalData: aadFor('key_wraps', row) },
  )
  return { ...row, iv: toBase64(iv), wrapped: toBase64(new Uint8Array(wrapped)) }
}

// Opens a key_wraps row. Throws if the wrap key is wrong or anything in the
// row changed. `extractable` must be chosen every time, so a reader can see
// which callers get a copy that can be wrapped again.
export async function unwrapDataKey(
  row: KeyWrapRow,
  wrapKey: CryptoKey,
  options: { extractable: boolean },
): Promise<CryptoKey> {
  if (row.v !== RECORD_VERSION) throw new Error('Unknown crypto settings version.')
  const iv = fromBase64(row.iv)
  const wrapped = fromBase64(row.wrapped)
  if (iv.length !== 12 || wrapped.length !== 48) throw new Error("The key wrap isn't the right size.")
  return crypto.subtle.unwrapKey(
    'raw', wrapped, wrapKey,
    { name: 'AES-GCM', iv, additionalData: aadFor('key_wraps', row) },
    { name: 'AES-GCM', length: 256 },
    options.extractable,
    ['encrypt', 'decrypt'],
  )
}
