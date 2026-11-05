// Checks that a row from outside this tab is exactly what the database
// stores. Rows arrive from two places this tab doesn't control: the
// server's answers, and backup files. Every one is checked here before
// anything uses it (fmbt-security, section 2).
//
// The checks copy the database's own rules, its domains and table checks in
// supabase/migrations, so a row that passes is one the database would accept.
import type { FixtureRow, Rows, Stored, SyncStatusRow, Table, TeamRow, WeekKey } from './api.ts'

type Check = (value: unknown) => boolean

export const isUuid: Check = value =>
  typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
const wholeFrom = (low: number, high: number): Check => value =>
  typeof value === 'number' && Number.isInteger(value) && value >= low && value <= high
const matches = (pattern: RegExp): Check => value => typeof value === 'string' && pattern.test(value)

const isSeason = wholeFrom(2020, 2100)          // public.season_year
const isCompetition: Check = value => value === 'PL' || value === 'UCL'
const isPeriod = matches(/^(MW([1-9]|[12][0-9]|3[0-8])|MD[1-8]|KPO|R16|QF|SF|F)$/) // public.period_code
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
    id: isUuid, season: isSeason, competition: isCompetition, period: isPeriod,
    version_no: isVersionNo, v: isCryptoVersion, iv: isIv, ct: isCiphertext,
  },
  settings_versions: { id: isUuid, version_no: isVersionNo, v: isCryptoVersion, iv: isIv, ct: isCiphertext },
  audit_entries: {
    id: isUuid, seq: wholeFrom(1, 1_000_000), prev_hash: value => value === null || matches(/^[0-9a-f]{64}$/)(value),
    v: isCryptoVersion, iv: isIv, ct: isCiphertext,
  },
}

// The Premier League's periods are matchweeks, and only its periods are.
const fitsCompetition = (row: Record<string, unknown>) => (row.competition === 'PL') === String(row.period).startsWith('MW')

// The two table checks that compare columns.
function rowRuleHolds(table: Table, row: Record<string, unknown>): boolean {
  if (table === 'week_versions') return fitsCompetition(row)
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
  return hasExactColumns(value, COLUMNS[table], extra) && rowRuleHolds(table, value as Record<string, unknown>)
}

// True if `value` has exactly these columns, plus any in `extra`, each one
// passing its check.
function hasExactColumns(value: unknown, checks: Record<string, Check>, extra: string[]): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  // No other columns. Object.hasOwn, not `in`, so one called "toString" can't sneak through.
  if (!Object.keys(row).every(name => Object.hasOwn(checks, name) || extra.includes(name))) return false
  // Every column there, each in its shape. A missing one is undefined, which fails its check.
  return Object.entries(checks).every(([name, check]) => check(row[name]))
}

// True for a week the way week_versions files it, such as 2026, PL, MW11.
export function isWeekKey(value: unknown): value is WeekKey {
  return hasExactColumns(value, { season: isSeason, competition: isCompetition, period: isPeriod }, [])
    && fitsCompetition(value as Record<string, unknown>)
}

// Only the columns the browser sends, in a fixed order. Backups store rows
// like this, so they can go straight back into the database.
export function pickColumns<T extends Table>(table: T, row: Rows[T]): Rows[T] {
  const source = row as Record<string, unknown>
  return Object.fromEntries(columnNames(table).map(name => [name, source[name]])) as Rows[T]
}

// ---------------------------------------------------------------------------
// The football tables
// ---------------------------------------------------------------------------
// Only the sync function writes these, and it checks everything first
// (fmbt-security, section 6). The app checks them again on the way in,
// since bets settle on them and the pages show them.

// Control, invisible formatting, broken surrogate, private-use and line
// separator characters. The sync function never saves a name with any.
const UNSAFE_TEXT = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}]/u

// A trimmed name of 1 to `most` characters, counted the way the database counts them.
const isName = (most: number): Check => value => {
  if (typeof value !== 'string' || value.trim() !== value || UNSAFE_TEXT.test(value)) return false
  const length = [...value].length
  return length >= 1 && length <= most
}

// A time as the database writes it, such as 2026-11-07T15:00:00+00:00, with
// up to six decimal places on the seconds. Supabase's databases run in UTC,
// but any offset reads correctly. Returns the time the way toISOString()
// writes it, 2026-11-07T15:00:00.000Z, or null for anything else. Working the
// time back to the date and hour it gave refuses times that don't exist,
// which Date would quietly roll over: 30 February would become 2 March.
const DATABASE_TIME = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d{1,6})?(Z|([+-])(\d{2}):(\d{2}))$/
export function fromDatabaseTime(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const match = DATABASE_TIME.exec(value)
  const time = new Date(value)
  if (match === null || Number.isNaN(time.getTime())) return null
  const [, local, , zone, sign, hours, minutes] = match
  const offsetMinutes = zone === 'Z' ? 0 : (sign === '-' ? -1 : 1) * (Number(hours) * 60 + Number(minutes))
  if (new Date(time.getTime() + offsetMinutes * 60_000).toISOString().slice(0, 19) !== local) return null
  return time.toISOString()
}

const isTime: Check = value => fromDatabaseTime(value) !== null
const isTimeOrNull: Check = value => value === null || isTime(value)
const isGoals: Check = value => value === null || wholeFrom(0, 30)(value) // public.goal_count
const isTeamId = wholeFrom(1, 2_147_483_647)

export const FIXTURE_STATUSES = [
  'scheduled', 'live', 'half_time', 'extra_time', 'penalties', 'finished', 'postponed', 'suspended', 'cancelled', 'awarded',
] as const
const STATUSES = new Set<unknown>(FIXTURE_STATUSES)

const TEAM_COLUMNS: Record<keyof TeamRow, Check> = {
  id: isTeamId, name: isName(80), short_name: isName(40), code: matches(/^[A-Z]{3}$/),
}
const FIXTURE_COLUMNS: Record<keyof FixtureRow, Check> = {
  id: wholeFrom(1, Number.MAX_SAFE_INTEGER), competition: isCompetition, season: isSeason, period: isPeriod,
  tie_leg: value => value === null || value === 1 || value === 2, kickoff: isTime,
  home_team_id: isTeamId, away_team_id: isTeamId, status: value => STATUSES.has(value),
  minute: value => value === null || wholeFrom(0, 130)(value),
  home_90: isGoals, away_90: isGoals, home_ht: isGoals, away_ht: isGoals,
  home_et: isGoals, away_et: isGoals, home_pens: isGoals, away_pens: isGoals,
}
const SYNC_STATUS_COLUMNS: Record<keyof SyncStatusRow, Check> = { last_attempt_at: isTimeOrNull, last_success_at: isTimeOrNull }

// The columns each football read asks for, in order.
export const FOOTBALL_COLUMNS = {
  teams: Object.keys(TEAM_COLUMNS),
  fixtures: Object.keys(FIXTURE_COLUMNS),
  sync_status: Object.keys(SYNC_STATUS_COLUMNS),
}

export const isTeamRow = (value: unknown): value is TeamRow => hasExactColumns(value, TEAM_COLUMNS, [])

// The table's own checks too: the competition fits the period, a team never
// plays itself, and each score is both numbers or neither.
export function isFixtureRow(value: unknown): value is FixtureRow {
  if (!hasExactColumns(value, FIXTURE_COLUMNS, [])) return false
  const row = value as FixtureRow
  const pairs: [number | null, number | null][] = [
    [row.home_90, row.away_90], [row.home_ht, row.away_ht], [row.home_et, row.away_et], [row.home_pens, row.away_pens],
  ]
  return fitsCompetition(row) && row.home_team_id !== row.away_team_id && pairs.every(([home, away]) => (home === null) === (away === null))
}

export const isSyncStatusRow = (value: unknown): value is SyncStatusRow => hasExactColumns(value, SYNC_STATUS_COLUMNS, [])
