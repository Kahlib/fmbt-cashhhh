// Encrypting and decrypting one row of your data (fmbt-security, section 2).
//
// Each row is AES-256-GCM ciphertext beside a few plain columns that file it,
// such as the season and week. Three rules make a ciphertext useless anywhere
// but its own row:
//   - a fresh random 12-byte IV for every encryption, never reused
//   - AAD ("additional authenticated data"): the plain columns go into the
//     encryption's tamper check, so copying a ciphertext to another row,
//     week, table or version number makes it refuse to open
//   - padding to multiples of 1,024 bytes, so a row's size doesn't show how
//     many bets it holds
import { type Bytes, fromBase64, fromUtf8, randomBytes, toBase64, utf8 } from './bytes.ts'

export type AadTable = 'week_versions' | 'settings_versions' | 'key_wraps' | 'audit_entries'

// Every plain column except user_id and created_at, in a fixed order.
// user_id stays out so a backup can restore into a fresh project, where the
// account gets a new ID. Each column has a check, so a value arriving in the
// wrong shape (a number sent as text, say) fails loudly here, not as a
// mysterious decryption failure.
type Check = (value: unknown) => boolean
const isUuid: Check = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
const isWhole: Check = value => Number.isInteger(value)
const isText: Check = value => typeof value === 'string'
const isHashOrNull: Check = value => value === null || (typeof value === 'string' && /^[0-9a-f]{64}$/.test(value))

const AAD_COLUMNS: Record<AadTable, ReadonlyArray<readonly [column: string, check: Check]>> = {
  week_versions: [['id', isUuid], ['season', isWhole], ['competition', isText], ['period', isText], ['version_no', isWhole], ['v', isWhole]],
  settings_versions: [['id', isUuid], ['version_no', isWhole], ['v', isWhole]],
  key_wraps: [['id', isUuid], ['kind', isText], ['version_no', isWhole], ['v', isWhole]],
  audit_entries: [['id', isUuid], ['seq', isWhole], ['prev_hash', isHashOrNull], ['v', isWhole]],
}

// The one shared function that builds AAD. Never join AAD strings by hand.
export function aadFor(table: AadTable, row: Record<string, unknown>): Bytes {
  const values = AAD_COLUMNS[table].map(([column, check]) => {
    const value = row[column]
    if (!check(value)) throw new Error(`${table}.${column} isn't in the expected shape.`)
    return value
  })
  return utf8(JSON.stringify(['fmbt-cashhhh', table, ...values]))
}

// The only crypto settings version so far. A row with any other `v` is refused.
export const RECORD_VERSION = 1

// Records are padded to a multiple of this. The database refuses anything smaller.
export const PAD_TO = 1024

// The biggest padded record the database's 350,000-character limit can hold.
export const MAX_RECORD_BYTES = 256 * 1024

// Adds spaces to the end of the JSON up to the next multiple of 1,024 bytes.
// JSON.parse ignores them when the record is opened again.
export function padJson(json: string): Bytes {
  const length = utf8(json).length
  const target = Math.max(PAD_TO, Math.ceil(length / PAD_TO) * PAD_TO)
  if (target > MAX_RECORD_BYTES) throw new Error('This record is too big to save.')
  return utf8(json + ' '.repeat(target - length))
}

export type Encrypted = { iv: string; ct: string }

// Encrypts one record for one row. `plain` holds that row's plain columns,
// which become its AAD.
export async function encryptRecord(
  table: Exclude<AadTable, 'key_wraps'>,
  plain: Record<string, unknown>,
  record: unknown,
  dataKey: CryptoKey,
): Promise<Encrypted> {
  if (plain.v !== RECORD_VERSION) throw new Error('Unknown crypto settings version.')
  const iv = randomBytes(12)
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aadFor(table, plain) },
    dataKey,
    padJson(JSON.stringify(record)),
  )
  return { iv: toBase64(iv), ct: toBase64(new Uint8Array(ct)) }
}

// Opens one row as it came back from the database. Throws if anything about
// it has changed: a single byte of ciphertext, any plain column, or the key.
// What comes out is untrusted until the caller checks its shape
// (fmbt-security, section 2: validate after decrypting).
export async function decryptRecord(
  table: Exclude<AadTable, 'key_wraps'>,
  row: Record<string, unknown>,
  dataKey: CryptoKey,
): Promise<unknown> {
  if (row.v !== RECORD_VERSION) throw new Error('Unknown crypto settings version.')
  if (typeof row.iv !== 'string' || typeof row.ct !== 'string') throw new Error('The row has no ciphertext.')
  const iv = fromBase64(row.iv)
  const ct = fromBase64(row.ct)
  // AES-GCM adds a 16-byte tamper check, so a padded record is 16 bytes over
  // a multiple of 1,024.
  if (iv.length !== 12 || ct.length < PAD_TO + 16 || (ct.length - 16) % PAD_TO !== 0) {
    throw new Error("The row's ciphertext isn't the right size.")
  }
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aadFor(table, row) }, dataKey, ct)
  return JSON.parse(fromUtf8(new Uint8Array(plain)))
}
