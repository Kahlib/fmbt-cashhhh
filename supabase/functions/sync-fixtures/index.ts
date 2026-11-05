// FMBT Cashhhh: the sync-fixtures server function (fmbt-security, section 6).
//
// Fills `teams` and `fixtures` from football-data.org and keeps the scores
// current. pg_cron calls it every minute (supabase/setup/schedule-sync.sql),
// and each time it decides for itself whether football-data needs asking:
//   - at 7 minutes past each hour, or whenever `fixtures` is empty, it
//     fetches both competitions' whole seasons
//   - otherwise, while a match is in its live window (5 minutes before
//     kick-off until it's final, or 3½ hours after kick-off at most), it
//     fetches that competition's matches for those days
//   - otherwise it does nothing
//
// The rules it follows:
//   - Only a POST carrying the scheduler secret gets anywhere. Everything else
//     gets a bare 401. The secret is compared in constant time.
//   - It takes no instructions. It never reads the request body, and it only
//     fetches fixed football-data addresses, filled in from the clock and our
//     own fixtures.
//   - At most one run every 50 seconds, however often it's called, so even a
//     leaked scheduler secret can't use up football-data's 10 requests a
//     minute. While runs keep failing, they space out to one every 15
//     minutes.
//   - Every field from the feed gets checked. A match that doesn't fit is
//     skipped, and its ID and the reason go in the log. Nothing is guessed.
//   - The log never holds the football-data key, the scheduler secret, the
//     secret key or any response header.
//   - Its secret key is the one named "sync_fixtures", which Supabase hands
//     every function in SUPABASE_SECRET_KEYS. It goes in the apikey header
//     only.
//
// Supabase runs this file (with Deno). Paste the whole file into the
// dashboard's editor to deploy it, with JWT verification off, because the
// scheduler isn't a signed-in user. tests/sync-fixtures.test.ts runs the same
// code in Node, against a fake football-data and a real copy of our tables.

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

// The only place the football-data key is ever sent.
const FEED = 'https://api.football-data.org/v4'

// football-data's code for each competition, and ours.
const COMPETITIONS = [
  { feed: 'PL', ours: 'PL' },
  { feed: 'CL', ours: 'UCL' },
] as const
type Competition = (typeof COMPETITIONS)[number]
type CompetitionCode = Competition['ours']

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE

const MIN_GAP = 50 * SECOND             // the shortest time between two runs
const MAX_GAP = 15 * MINUTE             // the longest, while runs keep failing
const FULL_REFRESH_MINUTE = 7           // minutes past each hour
const LIVE_BEFORE = 5 * MINUTE          // a live window opens 5 minutes before kick-off
const LIVE_AFTER = 3.5 * HOUR           // and closes 3½ hours after, if the match isn't final by then
const FEED_TIMEOUT = 15 * SECOND        // two of these still fit in the scheduler's 30 seconds
const DATABASE_TIMEOUT = 10 * SECOND
const MAX_FEED_BYTES = 4 * 1024 * 1024  // a whole season is about half a megabyte
const MAX_MATCHES = 1000                // a whole season has 380 at most
const MAX_GOALS = 20                    // fmbt-security, section 6

// ---------------------------------------------------------------------------
// The function's settings, read on every call so a changed secret counts at once
// ---------------------------------------------------------------------------

export type Env = { supabaseUrl: string; secretKey: string; syncSecret: string; footballKey: string }

// Returns the settings, or null and the names of the ones that are missing or
// the wrong shape. Names only, never values, so they're safe to log.
export function readEnv(get: (name: string) => string | undefined): { env: Env | null; problems: string[] } {
  const problems: string[] = []

  const supabaseUrl = get('SUPABASE_URL') ?? ''
  if (!supabaseUrl.startsWith('https://')) problems.push('SUPABASE_URL')

  let secretKey: unknown
  try {
    secretKey = (JSON.parse(get('SUPABASE_SECRET_KEYS') ?? '{}') as Record<string, unknown>).sync_fixtures
  } catch {
    secretKey = undefined
  }
  if (typeof secretKey !== 'string' || !secretKey.startsWith('sb_secret_')) problems.push('the secret key named sync_fixtures')

  // The scheduler secret: 43 or more letters and digits from the password
  // manager, the fewest that hold 32 random bytes' worth.
  const syncSecret = get('SYNC_SECRET') ?? ''
  if (!/^[A-Za-z0-9]{43,200}$/.test(syncSecret)) problems.push('SYNC_SECRET')

  const footballKey = get('FOOTBALL_DATA_KEY') ?? ''
  if (!/^[A-Za-z0-9]{16,128}$/.test(footballKey)) problems.push('FOOTBALL_DATA_KEY')

  if (problems.length > 0) return { env: null, problems }
  return { env: { supabaseUrl, secretKey: secretKey as string, syncSecret, footballKey }, problems }
}

// ---------------------------------------------------------------------------
// Answering a call
// ---------------------------------------------------------------------------

// What the function talks to. The tests pass in fakes.
export type Deps = { fetch: typeof fetch; now: () => Date }

export async function handle(
  request: Request,
  settings: (name: string) => string | undefined,
  deps: Deps = { fetch, now: () => new Date() },
): Promise<Response> {
  const { env, problems } = readEnv(settings)
  if (env === null) {
    console.error(`sync-fixtures: refusing every call until these are set up: ${problems.join(', ')}`)
    return refused()
  }
  if (request.method !== 'POST' || !(await fromScheduler(request, env.syncSecret))) {
    console.error('sync-fixtures: refused a call without the scheduler secret')
    return refused()
  }

  const now = deps.now()
  try {
    if (!(await claimRun(env, deps, now))) {
      console.log('sync-fixtures: waiting, because the last run was too recent, or runs are failing')
      return reply(200, { ran: 'waiting' })
    }
    const plan = await choosePlan(env, deps, now)
    if (plan.kind === 'nothing') {
      // Nothing needed asking, which still counts as a run that worked.
      await recordSuccess(env, deps, now)
      return reply(200, { ran: 'nothing' })
    }
    const result = await runPlan(env, deps, plan, now)
    await recordSuccess(env, deps, now)
    return reply(200, { ran: plan.kind, ...result })
  } catch (error) {
    // Our own errors say what failed in safe words. Anything else gets only
    // its name, in case its message holds something it shouldn't.
    console.error(`sync-fixtures: ${error instanceof SyncError ? error.message : `failed (${errorName(error)})`}`)
    return reply(502, { error: 'The sync failed. Its log says why.' })
  }
}

// An error whose message is safe to log: it never holds a key, a secret or a
// response header.
class SyncError extends Error {}

const errorName = (error: unknown) => (error instanceof Error ? error.name : 'unknown error')

// The answer to anything that isn't the scheduler: no body, nothing to learn.
function refused(): Response {
  return new Response(null, { status: 401 })
}

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })
}

// Checks the X-Sync-Secret header against SYNC_SECRET in constant time.
// Both get hashed first, so the comparison always walks the same 32 bytes and
// its timing says nothing about how much of a guess was right.
async function fromScheduler(request: Request, secret: string): Promise<boolean> {
  const given = request.headers.get('x-sync-secret')
  if (given === null || given.length > 512) return false
  const encoder = new TextEncoder()
  const [a, b] = await Promise.all([given, secret].map(value => crypto.subtle.digest('SHA-256', encoder.encode(value))))
  return sameBytes(new Uint8Array(a), new Uint8Array(b))
}

// True if both hold the same bytes. It looks at every byte whatever it finds,
// rather than stopping at the first difference.
export function sameBytes(x: Uint8Array, y: Uint8Array): boolean {
  if (x.length !== y.length) return false
  let difference = 0
  for (let i = 0; i < x.length; i++) difference |= x[i] ^ y[i]
  return difference === 0
}

// ---------------------------------------------------------------------------
// Deciding what to fetch
// ---------------------------------------------------------------------------

type LiveRequest = { competition: Competition; dateFrom: string; dateTo: string }
type Plan = { kind: 'full'; season: number } | { kind: 'live'; requests: LiveRequest[] } | { kind: 'nothing' }

// The season that starts this year from 1 July, otherwise the one that
// started last year. 2026 means 2026/27.
export function seasonFor(date: Date): number {
  return date.getUTCMonth() >= 6 ? date.getUTCFullYear() : date.getUTCFullYear() - 1
}

async function choosePlan(env: Env, deps: Deps, now: Date): Promise<Plan> {
  const season = seasonFor(now)
  if (now.getUTCMinutes() === FULL_REFRESH_MINUTE) return { kind: 'full', season }
  const any = await readRows(env, deps, 'fixtures', [['select', 'id'], ['limit', '1']])
  if (any.length === 0) return { kind: 'full', season }

  // Matches in their live window: kick-off between 3½ hours ago and 5 minutes
  // from now, and not final yet.
  const open = await readRows(env, deps, 'fixtures', [
    ['select', 'competition,kickoff'],
    ['kickoff', `gte.${new Date(now.getTime() - LIVE_AFTER).toISOString()}`],
    ['kickoff', `lte.${new Date(now.getTime() + LIVE_BEFORE).toISOString()}`],
    ['status', 'not.in.(finished,postponed,cancelled,awarded)'],
    ['limit', '100'],
  ])
  const requests: LiveRequest[] = []
  for (const competition of COMPETITIONS) {
    const kickoffs = open
      .filter(row => field(row, 'competition') === competition.ours)
      .map(row => Date.parse(String(field(row, 'kickoff'))))
      .filter(Number.isFinite)
    if (kickoffs.length === 0) continue
    // football-data's dateTo may leave out its own day, so it's the day after
    // the last kick-off. A day's extra matches do no harm.
    requests.push({
      competition,
      dateFrom: utcDay(Math.min(...kickoffs)),
      dateTo: utcDay(Math.max(...kickoffs) + 24 * HOUR),
    })
  }
  return requests.length === 0 ? { kind: 'nothing' } : { kind: 'live', requests }
}

const utcDay = (time: number) => new Date(time).toISOString().slice(0, 10)

// ---------------------------------------------------------------------------
// The 50-second rule and the back-off
// ---------------------------------------------------------------------------

// How long after the last run the next may start. Normally 50 seconds, so a
// call every minute always gets through. Every run either works or fails, so
// a failed last run has been failing since the last one that worked. The gap
// is that long, up to 15 minutes, so the gaps double: 1, 2, 4, 8, then 15
// minutes. Before the first run that works there's no back-off, so a sync
// being set up shows a fix within a minute.
export function gapAfter(lastAttempt: number, lastSuccess: number | null): number {
  if (lastSuccess === null || lastSuccess >= lastAttempt) return MIN_GAP
  return Math.min(MAX_GAP, Math.max(MIN_GAP, lastAttempt - lastSuccess))
}

// Claims this run with one conditional update of sync_status, so two calls at
// once can't both run: whichever updates first wins, and the other finds the
// row already changed. Returns false if the gap isn't over yet.
async function claimRun(env: Env, deps: Deps, now: Date): Promise<boolean> {
  const rows = await readRows(env, deps, 'sync_status', [['select', 'last_attempt_at,last_success_at'], ['id', 'eq.true']])
  const lastAttempt = databaseTime(field(rows[0], 'last_attempt_at'))
  const lastSuccess = databaseTime(field(rows[0], 'last_success_at'))
  if (lastAttempt === undefined || lastSuccess === undefined) throw new SyncError('sync_status doesn\'t have its one row')
  const notTooSoon: [string, string] = lastAttempt === null
    ? ['last_attempt_at', 'is.null']
    : ['last_attempt_at', `lte.${new Date(now.getTime() - gapAfter(lastAttempt, lastSuccess)).toISOString()}`]
  const claimed = await writeRows(env, deps, 'PATCH', 'sync_status', [['id', 'eq.true'], notTooSoon],
    { last_attempt_at: now.toISOString() }, 'return=representation')
  return Array.isArray(claimed) && claimed.length === 1
}

// Marks the run as one that worked, which the app can show as when the sync
// last ran. Only if the last attempt is still this run's.
async function recordSuccess(env: Env, deps: Deps, now: Date): Promise<void> {
  const started = now.toISOString()
  await writeRows(env, deps, 'PATCH', 'sync_status', [['id', 'eq.true'], ['last_attempt_at', `eq.${started}`]],
    { last_success_at: started }, 'return=minimal')
}

// A time from the database: a number, null if empty, or undefined if it's
// something else.
function databaseTime(value: unknown): number | null | undefined {
  if (value === null) return null
  const time = typeof value === 'string' ? Date.parse(value) : Number.NaN
  return Number.isFinite(time) ? time : undefined
}

// ---------------------------------------------------------------------------
// Fetching and saving
// ---------------------------------------------------------------------------

type FeedRequest = { competition: Competition; path: string; season: number | null; label: string }

async function runPlan(env: Env, deps: Deps, plan: Plan, now: Date): Promise<{ fixtures: number; skipped: number }> {
  const requests: FeedRequest[] = plan.kind === 'full'
    ? COMPETITIONS.map(competition => ({
        competition,
        path: `/competitions/${competition.feed}/matches?season=${plan.season}`,
        season: plan.season,
        label: `${competition.feed} ${plan.season}`,
      }))
    : plan.kind === 'live'
      ? plan.requests.map(({ competition, dateFrom, dateTo }) => ({
          competition,
          path: `/competitions/${competition.feed}/matches?dateFrom=${dateFrom}&dateTo=${dateTo}`,
          season: null,
          label: `${competition.feed} ${dateFrom} to ${dateTo}`,
        }))
      : []

  let fixtures = 0
  let skipped = 0
  for (const [index, request] of requests.entries()) {
    const { body, left } = await askFeed(env, deps, request)
    const batch = mapMatches(body, request.competition.ours, request.season)
    if (batch === null) throw new SyncError(`${request.label}: the answer had no list of matches, or too many`)
    await save(env, deps, batch, now)
    console.log(`sync-fixtures: ${request.label}: ${describeBatch(batch)}`)
    fixtures += batch.fixtures.length
    skipped += [...batch.skipped.values()].reduce((sum, ids) => sum + ids.length, 0)
    // football-data counts what's left this minute. If it's none, asking
    // again now would only get a 429.
    if (index < requests.length - 1 && left !== null && left <= 0) {
      throw new SyncError('football-data has no requests left this minute, so the rest waits')
    }
  }
  return { fixtures, skipped }
}

// One request to football-data. The key goes in its X-Auth-Token header, to
// the fixed address only: redirects are refused, so the key can't be carried
// anywhere else. The answer is read with a size cap.
async function askFeed(env: Env, deps: Deps, request: FeedRequest): Promise<{ body: unknown; left: number | null }> {
  let response: Response
  try {
    response = await deps.fetch(FEED + request.path, {
      headers: { 'X-Auth-Token': env.footballKey },
      redirect: 'error',
      signal: AbortSignal.timeout(FEED_TIMEOUT),
    })
  } catch (error) {
    throw new SyncError(`${request.label}: couldn't reach football-data (${errorName(error)})`)
  }
  if (!response.ok) {
    await response.body?.cancel()
    throw new SyncError(`${request.label}: football-data answered ${response.status}${response.status === 429 ? ', too many requests' : ''}`)
  }
  const text = await readCapped(response, MAX_FEED_BYTES)
  if (text === null) throw new SyncError(`${request.label}: the answer was over 4 MB, or not text`)
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    throw new SyncError(`${request.label}: the answer wasn't JSON`)
  }
  const left = Number.parseInt(response.headers.get('x-requests-available-minute') ?? '', 10)
  return { body, left: Number.isFinite(left) ? left : null }
}

// Reads a response body, stopping as soon as it passes the size limit.
async function readCapped(response: Response, maxBytes: number): Promise<string | null> {
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > maxBytes) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

// Saves the teams first, since fixtures point at them, then the fixtures.
// Both are upserts on football-data's IDs, so a match that changed is updated
// and nothing is ever deleted.
async function save(env: Env, deps: Deps, batch: Batch, now: Date): Promise<void> {
  const updated_at = now.toISOString()
  const upsert = 'resolution=merge-duplicates,return=minimal'
  if (batch.teams.length > 0) {
    await writeRows(env, deps, 'POST', 'teams', [['on_conflict', 'id']], batch.teams.map(team => ({ ...team, updated_at })), upsert)
  }
  if (batch.fixtures.length > 0) {
    await writeRows(env, deps, 'POST', 'fixtures', [['on_conflict', 'id']], batch.fixtures.map(fixture => ({ ...fixture, updated_at })), upsert)
  }
}

// ---------------------------------------------------------------------------
// Talking to our database, through Supabase's API with the sync's own key
// ---------------------------------------------------------------------------

type Query = Array<[string, string]>

async function database(env: Env, deps: Deps, method: string, table: string, query: Query, body?: unknown, prefer?: string): Promise<Response> {
  const headers: Record<string, string> = { apikey: env.secretKey, 'Content-Type': 'application/json' }
  if (prefer !== undefined) headers.Prefer = prefer
  let response: Response
  try {
    response = await deps.fetch(`${env.supabaseUrl}/rest/v1/${table}?${new URLSearchParams(query)}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(DATABASE_TIMEOUT),
    })
  } catch (error) {
    throw new SyncError(`couldn't reach the database (${errorName(error)})`)
  }
  if (!response.ok) {
    // Postgres's own error code and message say which rule a row broke.
    const problem: unknown = await response.json().catch(() => null)
    const code = field(problem, 'code')
    const message = field(problem, 'message')
    const detail = typeof code === 'string' ? ` (${code}${typeof message === 'string' ? `: ${message.slice(0, 200)}` : ''})` : ''
    throw new SyncError(`the database refused ${method} ${table} with ${response.status}${detail}`)
  }
  return response
}

async function readRows(env: Env, deps: Deps, table: string, query: Query): Promise<unknown[]> {
  const rows: unknown = await (await database(env, deps, 'GET', table, query)).json()
  if (!Array.isArray(rows)) throw new SyncError(`the database's answer about ${table} wasn't a list`)
  return rows
}

async function writeRows(env: Env, deps: Deps, method: 'POST' | 'PATCH', table: string, query: Query, body: unknown, prefer: string): Promise<unknown> {
  const response = await database(env, deps, method, table, query, body, prefer)
  return prefer.includes('return=representation') ? response.json() : null
}

// ---------------------------------------------------------------------------
// Checking the feed. Everything in it is untrusted.
// ---------------------------------------------------------------------------

type Status = 'scheduled' | 'live' | 'half_time' | 'extra_time' | 'penalties' | 'finished' | 'postponed' | 'suspended' | 'cancelled' | 'awarded'

export type TeamRow = { id: number; name: string; short_name: string; code: string }
export type FixtureRow = {
  id: number
  competition: CompetitionCode
  season: number
  period: string
  tie_leg: 1 | 2 | null
  kickoff: string
  home_team_id: number
  away_team_id: number
  status: Status
  minute: number | null
  home_90: number | null
  away_90: number | null
  home_ht: number | null
  away_ht: number | null
  home_et: number | null
  away_et: number | null
  home_pens: number | null
  away_pens: number | null
  feed_updated_at: string | null
}

// Why a match was skipped. These get logged with the match's ID.
export type Skip = 'id' | 'stage' | 'matchday' | 'team' | 'same team' | 'kickoff' | 'season' | 'status' | 'score' | 'duplicate'
// Matches left out on purpose, which only get counted: qualifying rounds,
// which the app doesn't track, and knockout ties before the draw.
export type LeftOut = 'not tracked' | 'not drawn'

// A Map, never a plain object, so a status like "constructor" can't find
// something that isn't in the list.
const STATUSES = new Map<unknown, Status>([
  ['SCHEDULED', 'scheduled'],
  ['TIMED', 'scheduled'],
  ['IN_PLAY', 'live'],
  ['PAUSED', 'half_time'],
  ['EXTRA_TIME', 'extra_time'],
  ['PENALTY_SHOOTOUT', 'penalties'],
  ['FINISHED', 'finished'],
  ['POSTPONED', 'postponed'],
  ['SUSPENDED', 'suspended'],
  ['CANCELLED', 'cancelled'],
  ['CANCELED', 'cancelled'],
  ['AWARDED', 'awarded'],
])

// The Champions League's knockout rounds. All have two legs except the final.
const KNOCKOUTS = new Map<unknown, string>([
  ['PLAYOFFS', 'KPO'],
  ['LAST_16', 'R16'],
  ['QUARTER_FINALS', 'QF'],
  ['SEMI_FINALS', 'SF'],
  ['FINAL', 'F'],
])
// Qualifying rounds' stage names, such as QUALIFICATION_ROUND_2. Not
// PLAYOFFS, which is the knockout play-off in February.
const QUALIFYING = /^(QUALIFICATION|PRELIMINARY|PLAYOFF_ROUND)/

// Reads one of an object's own fields, whatever was sent.
function field(value: unknown, name: string): unknown {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.hasOwn(value, name)
    ? (value as Record<string, unknown>)[name]
    : undefined
}

function isWhole(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
}

// Control, invisible formatting, broken surrogate, private-use and line
// separator characters. Names with any of these are skipped.
const UNSAFE_TEXT = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}]/u

// Text with no unsafe characters, 1 to `max` characters long once trimmed.
function readText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  const length = [...text].length
  return length >= 1 && length <= max && !UNSAFE_TEXT.test(text) ? text : null
}

// A time like 2026-11-07T15:00:00Z. The round trip catches dates that don't
// exist, which Date would quietly roll over (30 February becomes 2 March).
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/
function readTime(value: unknown): string | null {
  if (typeof value !== 'string' || !ISO_UTC.test(value)) return null
  const time = new Date(value)
  if (Number.isNaN(time.getTime()) || time.toISOString().slice(0, 19) !== value.slice(0, 19)) return null
  return time.toISOString()
}

// The badge code: football-data's three-letter code when it has one, or else
// the first three letters from A to Z in the short name. Bodø/Glimt's "FK"
// becomes BOD, and Leverkusen's "B04" becomes LEV. It's only a label, and
// nothing settles on it.
export function teamCode(tla: unknown, shortName: string): string | null {
  if (typeof tla === 'string' && /^[A-Z]{3}$/.test(tla)) return tla
  const letters = shortName.toUpperCase().replace(/[^A-Z]/g, '')
  return letters.length >= 3 ? letters.slice(0, 3) : null
}

// A team, or 'not drawn' for a knockout place football-data sends empty
// before the draw.
function readTeam(value: unknown): TeamRow | 'not drawn' | 'team' {
  if (value === null) return 'not drawn'
  if (typeof value !== 'object' || Array.isArray(value)) return 'team'
  const id = field(value, 'id')
  if (id === null || id === undefined) return 'not drawn'
  if (!isWhole(id, 1, 2_147_483_647)) return 'team'
  const name = readText(field(value, 'name'), 80)
  const shortName = readText(field(value, 'shortName'), 40)
  if (name === null || shortName === null) return 'team'
  const code = teamCode(field(value, 'tla'), shortName)
  return code === null ? 'team' : { id, name, short_name: shortName, code }
}

// The week or stage, and the leg of a two-legged tie.
function placeFor(competition: CompetitionCode, stage: unknown, matchday: unknown): { period: string; leg: 1 | 2 | null } | Skip | LeftOut {
  if (competition === 'PL') {
    if (stage !== 'REGULAR_SEASON') return 'stage'
    return isWhole(matchday, 1, 38) ? { period: `MW${matchday}`, leg: null } : 'matchday'
  }
  if (stage === 'LEAGUE_STAGE') return isWhole(matchday, 1, 8) ? { period: `MD${matchday}`, leg: null } : 'matchday'
  if (typeof stage === 'string' && QUALIFYING.test(stage)) return 'not tracked'
  const period = KNOCKOUTS.get(stage)
  if (period === undefined) return 'stage'
  if (period === 'F') return { period, leg: null }
  // In a two-legged round, football-data's matchday is the leg.
  return matchday === 1 || matchday === 2 ? { period, leg: matchday } : 'matchday'
}

type Pair = [number, number]
export type Scores = { ninety: Pair | null; half: Pair | null; extra: Pair | null; pens: Pair | null }

// One part of a score, such as fullTime: null when both sides are empty, the
// two numbers when both are whole numbers from 0 to 20, and 'bad' otherwise,
// including half a score.
function readPair(value: unknown): Pair | null | 'bad' {
  if (value === undefined || value === null) return null
  if (typeof value !== 'object' || Array.isArray(value)) return 'bad'
  const home = field(value, 'home') ?? null
  const away = field(value, 'away') ?? null
  if (home === null && away === null) return null
  return isWhole(home, 0, MAX_GOALS) && isWhole(away, 0, MAX_GOALS) ? [home, away] : 'bad'
}

const hasGoals = (pair: Pair | null) => pair !== null && (pair[0] > 0 || pair[1] > 0)

// Bets settle on the 90-minute score only, and football-data's fullTime stops
// being that once a match goes past 90 minutes: it adds the extra-time goals,
// and even the shootout. So the 90-minute score comes from regularTime once
// there's extra time, and every part has to add up to fullTime.
export function readScore(score: unknown): Scores | 'bad' {
  if (typeof score !== 'object' || score === null || Array.isArray(score)) return 'bad'
  const full = readPair(field(score, 'fullTime'))
  const half = readPair(field(score, 'halfTime'))
  const regular = readPair(field(score, 'regularTime'))
  const extra = readPair(field(score, 'extraTime'))
  const pens = readPair(field(score, 'penalties'))
  if (full === 'bad' || half === 'bad' || regular === 'bad' || extra === 'bad' || pens === 'bad') return 'bad'

  let scores: Scores
  const duration = field(score, 'duration')
  if (duration === 'REGULAR') {
    // Normal time, so fullTime is the 90-minute score, or the running score.
    if (hasGoals(extra) || hasGoals(pens)) return 'bad'
    scores = { ninety: regular ?? full, half, extra: null, pens: null }
  } else if (duration === 'EXTRA_TIME') {
    if (regular === null || hasGoals(pens)) return 'bad'
    scores = { ninety: regular, half, extra, pens: null }
  } else if (duration === 'PENALTY_SHOOTOUT') {
    if (regular === null) return 'bad'
    scores = { ninety: regular, half, extra, pens }
  } else {
    return 'bad'
  }

  if (full !== null && scores.ninety !== null) {
    const home = scores.ninety[0] + (scores.extra?.[0] ?? 0) + (scores.pens?.[0] ?? 0)
    const away = scores.ninety[1] + (scores.extra?.[1] ?? 0) + (scores.pens?.[1] ?? 0)
    if (home !== full[0] || away !== full[1]) return 'bad'
  }
  return scores
}

type Mapped = { ok: true; fixture: FixtureRow; teams: [TeamRow, TeamRow]; madeCodes: TeamRow[] } | { ok: false; reason: Skip | LeftOut }

// Checks one match and turns it into a fixture row. `season` is the season
// the request asked for, or null for a live request, which can span two.
export function mapMatch(match: unknown, competition: CompetitionCode, season: number | null): Mapped {
  const skip = (reason: Skip | LeftOut): Mapped => ({ ok: false, reason })

  const id = field(match, 'id')
  if (!isWhole(id, 1, Number.MAX_SAFE_INTEGER)) return skip('id')

  const place = placeFor(competition, field(match, 'stage'), field(match, 'matchday'))
  if (typeof place === 'string') return skip(place)

  const homeTeam = field(match, 'homeTeam')
  const awayTeam = field(match, 'awayTeam')
  const home = readTeam(homeTeam)
  const away = readTeam(awayTeam)
  if (home === 'not drawn' || away === 'not drawn') return skip('not drawn')
  if (home === 'team' || away === 'team') return skip('team')
  if (home.id === away.id) return skip('same team')

  const kickoff = readTime(field(match, 'utcDate'))
  if (kickoff === null) return skip('kickoff')
  const matchSeason = seasonFor(new Date(kickoff))
  if (matchSeason < 2020 || matchSeason > 2100 || (season !== null && matchSeason !== season)) return skip('season')

  const status = STATUSES.get(field(match, 'status'))
  if (status === undefined) return skip('status')

  const scores = readScore(field(match, 'score'))
  if (scores === 'bad' || (status === 'finished' && scores.ninety === null)) return skip('score')

  // The minute is a nice-to-have, so an odd one is dropped rather than
  // costing the match.
  const minute = field(match, 'minute')

  // Teams whose code came from their short name, for the log.
  const madeCodes: TeamRow[] = []
  if (field(homeTeam, 'tla') !== home.code) madeCodes.push(home)
  if (field(awayTeam, 'tla') !== away.code) madeCodes.push(away)

  return {
    ok: true,
    teams: [home, away],
    madeCodes,
    fixture: {
      id,
      competition,
      season: matchSeason,
      period: place.period,
      tie_leg: place.leg,
      kickoff,
      home_team_id: home.id,
      away_team_id: away.id,
      status,
      minute: isWhole(minute, 0, 130) ? minute : null,
      home_90: scores.ninety?.[0] ?? null,
      away_90: scores.ninety?.[1] ?? null,
      home_ht: scores.half?.[0] ?? null,
      away_ht: scores.half?.[1] ?? null,
      home_et: scores.extra?.[0] ?? null,
      away_et: scores.extra?.[1] ?? null,
      home_pens: scores.pens?.[0] ?? null,
      away_pens: scores.pens?.[1] ?? null,
      feed_updated_at: readTime(field(match, 'lastUpdated')),
    },
  }
}

export type Batch = {
  seen: number
  fixtures: FixtureRow[]
  teams: TeamRow[]
  skipped: Map<Skip, number[]>   // match IDs, or 0 for a match without one
  leftOut: Map<LeftOut, number>
  madeCodes: TeamRow[]
}

// Checks every match in one answer. Returns null if the answer isn't a list
// of matches, or is far bigger than a season.
export function mapMatches(body: unknown, competition: CompetitionCode, season: number | null): Batch | null {
  const matches = field(body, 'matches')
  if (!Array.isArray(matches) || matches.length > MAX_MATCHES) return null
  const fixtures = new Map<number, FixtureRow>()
  const teams = new Map<number, TeamRow>()
  const madeCodes = new Map<number, TeamRow>()
  const skipped = new Map<Skip, number[]>()
  const leftOut = new Map<LeftOut, number>()

  const skip = (reason: Skip, id: unknown) => {
    const ids = skipped.get(reason) ?? []
    ids.push(isWhole(id, 1, Number.MAX_SAFE_INTEGER) ? id : 0)
    skipped.set(reason, ids)
  }

  for (const match of matches) {
    const result = mapMatch(match, competition, season)
    if (!result.ok) {
      if (result.reason === 'not tracked' || result.reason === 'not drawn') {
        leftOut.set(result.reason, (leftOut.get(result.reason) ?? 0) + 1)
      } else {
        skip(result.reason, field(match, 'id'))
      }
      continue
    }
    // The same match twice would make the database refuse the whole save,
    // so only the first one counts.
    if (fixtures.has(result.fixture.id)) {
      skip('duplicate', result.fixture.id)
      continue
    }
    fixtures.set(result.fixture.id, result.fixture)
    for (const team of result.teams) if (!teams.has(team.id)) teams.set(team.id, team)
    for (const team of result.madeCodes) madeCodes.set(team.id, team)
  }
  return {
    seen: matches.length,
    fixtures: [...fixtures.values()],
    teams: [...teams.values()],
    skipped,
    leftOut,
    madeCodes: [...madeCodes.values()],
  }
}

// One log line per answer: "380 matches, 380 saved", then any skips with up
// to 10 match IDs each, matches left out on purpose, and codes made from
// short names.
export function describeBatch(batch: Batch): string {
  const parts = [`${batch.seen} ${batch.seen === 1 ? 'match' : 'matches'}, ${batch.fixtures.length} saved`]
  for (const [reason, ids] of batch.skipped) {
    const shown = ids.slice(0, 10).join(', ')
    parts.push(`skipped ${ids.length} (${reason}: ${shown}${ids.length > 10 ? `, and ${ids.length - 10} more` : ''})`)
  }
  for (const [reason, count] of batch.leftOut) parts.push(`left out ${count} (${reason})`)
  if (batch.madeCodes.length > 0) {
    parts.push(`made codes for ${batch.madeCodes.map(team => `${team.id} ${team.code}`).join(', ')}`)
  }
  return parts.join(', ')
}

// ---------------------------------------------------------------------------
// Supabase runs this part. `Deno` only exists there, so the tests skip it.
// ---------------------------------------------------------------------------

type DenoLike = {
  serve(handler: (request: Request) => Promise<Response>): unknown
  env: { get(name: string): string | undefined }
}
const deno = (globalThis as unknown as { Deno?: DenoLike }).Deno
if (deno !== undefined) deno.serve(request => handle(request, name => deno.env.get(name)))
