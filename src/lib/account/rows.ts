// Checks that a row from outside this tab is exactly what the database
// stores. Rows arrive from two places this tab doesn't control: the
// server's answers, and backup files. Every one is checked here before
// anything uses it (fmbt-security, section 2).
//
// The checks copy the database's own rules, its domains and table checks in
// supabase/migrations, so a row that passes is one the database would accept.
import type { Rows, Stored, Table } from './api.ts'

type Check = (value: unknown) => boolean

export const isUuid: Check = value =>
  typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
const wholeFrom = (low: number, high: number): Check => value =>
  typeof value === 'number' && Number.isInteger(value) && value >= low && value <= high
const matches = (pattern: RegExp): Check => value => typeof value === 'string' && pattern.test(value)

const isVersionNo = wholeFrom(1, 1_000_000)
const isCryptoVersion = wholeFrom(1, 100)      // public.crypto_version
const isIv = matches(/^[A-Za-z0-9+/]{16}$/)     // public.b64_iv: 12 bytes
const isWrapped = matches(/^[A-Za-z0-9+/]{64}$/) // public.b64_wrapped_key: 48 bytes
const isCiphertext: Check = value =>             // public.b64_ciphertext
  typeof value === 'string' && value.length >= 1388 && value.length <= 350_000 && /^[A-Za-z0-9+/]+={0,2}$/.test(value)

// Each table's columns, in the order a backup writes them, with their checks.
// TypeScript checks this lists exactly the columns of each row type.
const COLUMNS: { [T in Table]: Record<keyof Rows[T], Check> } = {
  key_wraps: {
    id: isUuid, kind: value => value === 'password' || value === 'recovery',
    version_no: isVersionNo, v: isCryptoVersion, iv: isIv, wrapped: isWrapped,
  },
  week_versions: {
    id: isUuid, season: wholeFrom(2020, 2100), competition: value => value === 'PL' || value === 'UCL',
    period: matches(/^(MW([1-9]|[12][0-9]|3[0-8])|MD[1-8]|KPO|R16|QF|SF|F)$/),
    version_no: isVersionNo, v: isCryptoVersion, iv: isIv, ct: isCiphertext,
  },
  settings_versions: { id: isUuid, version_no: isVersionNo, v: isCryptoVersion, iv: isIv, ct: isCiphertext },
  audit_entries: {
    id: isUuid, seq: wholeFrom(1, 1_000_000), prev_hash: value => value === null || matches(/^[0-9a-f]{64}$/)(value),
    v: isCryptoVersion, iv: isIv, ct: isCiphertext,
  },
}

// The two table checks that compare columns.
function rowRuleHolds(table: Table, row: Record<string, unknown>): boolean {
  if (table === 'week_versions') return (row.competition === 'PL') === String(row.period).startsWith('MW')
  if (table === 'audit_entries') return (row.seq === 1) === (row.prev_hash === null)
  return true
}

export function columnNames(table: Table): string[] {
  return Object.keys(COLUMNS[table])
}

// True if `value` has exactly this table's columns, each in the right shape.
export function isRow<T extends Table>(table: T, value: unknown): value is Rows[T] {
  return hasColumns(table, value, [])
}

// The same for a row the server returns, which also has created_at.
export function isStoredRow<T extends Table>(table: T, value: unknown): value is Stored<Rows[T]> {
  return hasColumns(table, value, ['created_at']) && typeof (value as { created_at: unknown }).created_at === 'string'
}

function hasColumns(table: Table, value: unknown, extra: string[]): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  const checks: Record<string, Check> = COLUMNS[table]
  // No other columns. Object.hasOwn, not `in`, so one called "toString" can't sneak through.
  if (!Object.keys(row).every(name => Object.hasOwn(checks, name) || extra.includes(name))) return false
  // Every column there, each in its shape. A missing one is undefined, which fails its check.
  return Object.entries(checks).every(([name, check]) => check(row[name])) && rowRuleHolds(table, row)
}

// Only the columns the browser sends, in a fixed order. Backups store rows
// like this, so they can go straight back into the database.
export function pickColumns<T extends Table>(table: T, row: Rows[T]): Rows[T] {
  const source = row as Record<string, unknown>
  return Object.fromEntries(columnNames(table).map(name => [name, source[name]])) as Rows[T]
}
