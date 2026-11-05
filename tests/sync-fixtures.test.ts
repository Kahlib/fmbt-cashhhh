// Tests for supabase/functions/sync-fixtures/index.ts (fmbt-security,
// section 6). They run the function in Node against a fake football-data and
// a real copy of our tables behind a stand-in for Supabase's API
// (tests/fake-postgrest.ts), so every row it saves meets the database's own
// rules. scripts/dev-attack-check.mjs then tries the real thing on dev.
//
// Every match here is written by hand in football-data's shape, never copied
// from its answers: the repo is public, and its terms bar using the data once
// a subscription ends.
import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import type { PGlite } from '@electric-sql/pglite'
import { type Scores, describeBatch, gapAfter, handle, mapMatch, mapMatches, readEnv, readScore, sameBytes, seasonFor, teamCode } from '../supabase/functions/sync-fixtures/index.ts'
import { answerApi, resetDatabase, startDatabase } from './fake-postgrest.ts'

// ---------------------------------------------------------------------------
// Made-up settings in the right shapes. Not a real project, key or secret.
// ---------------------------------------------------------------------------

const SUPABASE_URL = 'https://abcdefghijklmnopqrst.supabase.co'
const FEED = 'https://api.football-data.org'
const SECRET_KEY = 'sb_secret_' + 'S'.repeat(31)
const OTHER_KEY = 'sb_secret_' + 'D'.repeat(31)
const SYNC_SECRET = 'Sync' + 'q'.repeat(44)
const FOOTBALL_KEY = 'Feed' + 'k'.repeat(28)
// What football-data's x-authenticated-client header might hold. It must
// never reach the log.
const ACCOUNT = 'friend@example.com'

const SETTINGS: Record<string, string> = {
  SUPABASE_URL,
  SUPABASE_SECRET_KEYS: JSON.stringify({ default: OTHER_KEY, sync_fixtures: SECRET_KEY }),
  SYNC_SECRET,
  FOOTBALL_DATA_KEY: FOOTBALL_KEY,
}
const settingsFrom = (values: Record<string, string>) => (name: string): string | undefined => values[name]
const without = (name: string) => Object.fromEntries(Object.entries(SETTINGS).filter(([key]) => key !== name))

const SECOND = 1000
const MINUTE = 60 * SECOND

// ---------------------------------------------------------------------------
// Matches in football-data's shape
// ---------------------------------------------------------------------------

type Sample = Record<string, unknown>

const ARSENAL = { id: 57, name: 'Arsenal FC', shortName: 'Arsenal', tla: 'ARS', crest: 'https://crests.example/57.png' }
const CITY = { id: 65, name: 'Manchester City FC', shortName: 'Man City', tla: 'MCI', crest: 'https://crests.example/65.png' }
const CHELSEA = { id: 61, name: 'Chelsea FC', shortName: 'Chelsea', tla: 'CHE', crest: null }
const INTER = { id: 108, name: 'FC Internazionale Milano', shortName: 'Inter', tla: 'INT', crest: null }
// The two codes the feed check found that break the badge rule.
const BODO = { id: 5721, name: 'FK Bodø/Glimt', shortName: 'Bodø/Glimt', tla: 'FK', crest: null }
const LEVERKUSEN = { id: 3, name: 'Bayer 04 Leverkusen', shortName: 'Leverkusen', tla: 'B04', crest: null }
// A knockout place before the draw.
const NOT_DRAWN = { id: null, name: null, shortName: null, tla: null, crest: null }

const pair = (home: number | null = null, away: number | null = null) => ({ home, away })
const unplayed = () => ({ winner: null, duration: 'REGULAR', fullTime: pair(), halfTime: pair() })

let lastId = 800_000
// A Premier League match, still to be played unless `overrides` says otherwise.
function match(overrides: Sample = {}): Sample {
  lastId += 1
  return {
    area: { id: 1, name: 'England', code: 'ENG' },
    competition: { id: 1, name: 'Premier League', code: 'PL', type: 'LEAGUE' },
    season: { id: 1, startDate: '2026-08-21', endDate: '2027-05-30', currentMatchday: 11, winner: null },
    id: lastId,
    utcDate: '2026-11-07T15:00:00Z',
    status: 'TIMED',
    matchday: 11,
    stage: 'REGULAR_SEASON',
    group: null,
    lastUpdated: '2026-11-06T09:30:00Z',
    homeTeam: ARSENAL,
    awayTeam: CITY,
    score: unplayed(),
    odds: { msg: 'Odds are a paid extra.' },
    referees: [],
    ...overrides,
  }
}

// A Champions League match, in the league phase unless `overrides` says otherwise.
function cl(overrides: Sample = {}): Sample {
  return match({
    competition: { id: 2, name: 'UEFA Champions League', code: 'CL', type: 'CUP' },
    stage: 'LEAGUE_STAGE',
    matchday: 4,
    utcDate: '2026-11-04T20:00:00Z',
    homeTeam: INTER,
    awayTeam: BODO,
    ...overrides,
  })
}

// A score that ended in normal time.
const ended = (home: number, away: number, half: [number, number] = [0, 0]) => ({
  status: 'FINISHED',
  score: { winner: home > away ? 'HOME_TEAM' : home < away ? 'AWAY_TEAM' : 'DRAW', duration: 'REGULAR', fullTime: pair(home, away), halfTime: pair(...half) },
})

// football-data's answer: the matches, plus the headers it sends.
function answer(matches: Sample[], headers: Record<string, string> = {}): Response {
  return Response.json({ filters: {}, resultSet: { count: matches.length }, matches }, {
    headers: {
      'x-api-version': 'v4',
      'x-requests-available-minute': '9',
      'x-requestcounter-reset': '60',
      'x-authenticated-client': ACCOUNT,
      ...headers,
    },
  })
}

// A football-data that answers each competition with these matches, whatever
// the season or dates asked for.
function feedOf(pl: Sample[], ucl: Sample[]) {
  return (url: URL): Response => {
    if (url.pathname === '/v4/competitions/PL/matches') return answer(pl)
    if (url.pathname === '/v4/competitions/CL/matches') return answer(ucl)
    return Response.json({ message: 'Not found' }, { status: 404 })
  }
}

// This season so far: one result, and two matches still to come.
const PL_SEASON = [
  match({ ...ended(2, 1, [1, 0]), matchday: 10, utcDate: '2026-11-01T16:30:00Z' }),
  match({ matchday: 11, utcDate: '2026-11-07T15:00:00Z', homeTeam: CHELSEA, awayTeam: ARSENAL }),
  match({ matchday: 12, utcDate: '2026-11-21T17:30:00Z', homeTeam: CITY, awayTeam: CHELSEA }),
]
const UCL_SEASON = [
  cl({ ...ended(3, 1, [1, 1]) }),
  cl({ matchday: 5, utcDate: '2026-11-25T20:00:00Z', homeTeam: LEVERKUSEN, awayTeam: ARSENAL }),
]
const KICKOFF = PL_SEASON[1] // the match the live-window tests watch

// ---------------------------------------------------------------------------
// The world each test runs in
// ---------------------------------------------------------------------------

type Call = { url: URL; method: string; headers: Headers; redirect: RequestRedirect | undefined }

// Everything the function logs, so tests can check it and the test output
// stays quiet.
const logged = { info: [] as string[], errors: [] as string[] }
const { log: originalLog, error: originalError } = console

let db: PGlite
before(async () => {
  db = await startDatabase()
  console.log = (...args: unknown[]) => logged.info.push(args.map(String).join(' '))
  console.error = (...args: unknown[]) => logged.errors.push(args.map(String).join(' '))
})
after(async () => {
  console.log = originalLog
  console.error = originalError
  await db.close()
})
beforeEach(async () => {
  await resetDatabase(db)
  logged.info.length = 0
  logged.errors.length = 0
})

function world(start = '2026-11-07T12:30:00Z') {
  let now = new Date(start)
  let feed: (url: URL) => Response | Promise<Response> = feedOf(PL_SEASON, UCL_SEASON)
  // Lets a test answer for the database instead, to break it.
  let database: ((url: URL) => Response) | null = null
  const calls: Call[] = []
  const fetchFn = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input))
    calls.push({ url, method: init.method ?? 'GET', headers: new Headers(init.headers), redirect: init.redirect })
    if (url.origin === FEED) return feed(url)
    if (url.origin === SUPABASE_URL) return database !== null ? database(url) : answerApi(db, SECRET_KEY, url, init)
    throw new TypeError(`fetch failed: nothing should call ${url.origin}`)
  }) as typeof fetch
  const deps = { fetch: fetchFn, now: () => now }
  return {
    calls,
    deps,
    setFeed(next: typeof feed) {
      feed = next
    },
    setDatabase(next: typeof database) {
      database = next
    },
    at(time: string) {
      now = new Date(time)
    },
    later(ms: number) {
      now = new Date(now.getTime() + ms)
    },
    feedCalls: () => calls.filter(call => call.url.origin === FEED).map(call => call.url.pathname.replace('/v4', '') + call.url.search),
    forget() {
      calls.length = 0
    },
    async run(request: Request = schedulerCall()): Promise<{ status: number; body: unknown }> {
      const response = await handle(request, settingsFrom(SETTINGS), deps)
      const text = await response.text()
      return { status: response.status, body: text === '' ? null : JSON.parse(text) }
    },
  }
}

function schedulerCall({ secret = SYNC_SECRET, method = 'POST', body = '{}' }: { secret?: string | null; method?: string; body?: string } = {}): Request {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (secret !== null) headers['X-Sync-Secret'] = secret
  return new Request(`${SUPABASE_URL}/functions/v1/sync-fixtures`, { method, headers, ...(method === 'POST' ? { body } : {}) })
}

// Waits until `done` is true, for tests that run two calls at once.
async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !done(); i++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.ok(done(), 'timed out waiting')
}

type Row = Record<string, unknown>
const fixtures = async () => (await db.query<Row>('select * from public.fixtures order by id')).rows
const fixture = async (id: unknown) => (await db.query<Row>('select * from public.fixtures where id = $1', [id])).rows[0]
const teams = async () => (await db.query<Row>('select id, name, short_name, code from public.teams order by id')).rows
const syncStatus = async () => {
  const row = (await db.query<{ last_attempt_at: Date | null; last_success_at: Date | null }>('select last_attempt_at, last_success_at from public.sync_status')).rows[0]
  return { attempt: row.last_attempt_at?.toISOString() ?? null, success: row.last_success_at?.toISOString() ?? null }
}

// Fills the tables with a full refresh, as the first run on a new project does.
async function filled(start = '2026-11-07T12:30:00Z') {
  const w = world(start)
  const first = await w.run()
  assert.equal(first.status, 200, JSON.stringify(first.body))
  w.forget()
  return w
}

// ---------------------------------------------------------------------------
// Who gets in
// ---------------------------------------------------------------------------

test('only a POST with the scheduler secret gets anywhere, and everything else gets a bare 401', async () => {
  const w = world()
  const turnedAway: Array<[string, Request]> = [
    ['no secret', schedulerCall({ secret: null })],
    ['a wrong secret', schedulerCall({ secret: 'Sync' + 'x'.repeat(44) })],
    ['the secret plus a letter', schedulerCall({ secret: SYNC_SECRET + 'q' })],
    ['the secret less a letter', schedulerCall({ secret: SYNC_SECRET.slice(0, -1) })],
    ['the secret key instead', schedulerCall({ secret: SECRET_KEY })],
    ['a GET', schedulerCall({ method: 'GET' })],
    ['an OPTIONS', schedulerCall({ method: 'OPTIONS' })],
    ['the secret as a Bearer token', new Request(`${SUPABASE_URL}/functions/v1/sync-fixtures`, {
      method: 'POST', headers: { Authorization: `Bearer ${SYNC_SECRET}` }, body: '{}',
    })],
  ]
  for (const [name, request] of turnedAway) {
    const response = await w.run(request)
    assert.equal(response.status, 401, name)
    assert.equal(response.body, null, name)
  }
  assert.equal(w.calls.length, 0, 'nothing reached the database or football-data')

  // With a setting missing or malformed, even the right secret gets nowhere.
  for (const values of [without('SYNC_SECRET'), without('FOOTBALL_DATA_KEY'), without('SUPABASE_SECRET_KEYS'), { ...SETTINGS, SYNC_SECRET: 'q'.repeat(42) }]) {
    const response = await handle(schedulerCall(), settingsFrom(values), w.deps)
    assert.equal(response.status, 401)
  }
  assert.equal(w.calls.length, 0)

  const allowed = await w.run()
  assert.equal(allowed.status, 200)
})

test('the secret comparison looks at every byte', () => {
  const bytes = (...values: number[]) => new Uint8Array(values)
  assert.equal(sameBytes(bytes(1, 2, 3, 4), bytes(1, 2, 3, 4)), true)
  assert.equal(sameBytes(bytes(9, 2, 3, 4), bytes(1, 2, 3, 4)), false, 'the first byte')
  assert.equal(sameBytes(bytes(1, 2, 3, 9), bytes(1, 2, 3, 4)), false, 'the last byte')
  assert.equal(sameBytes(bytes(1, 2, 3), bytes(1, 2, 3, 4)), false, 'a different length')
})

test('it reads only the secret key named sync_fixtures, and refuses to start without every setting', () => {
  assert.deepEqual(readEnv(settingsFrom(SETTINGS)), {
    env: { supabaseUrl: SUPABASE_URL, secretKey: SECRET_KEY, syncSecret: SYNC_SECRET, footballKey: FOOTBALL_KEY },
    problems: [],
  })
  const key = 'the secret key named sync_fixtures'
  const broken: Array<[Record<string, string>, string]> = [
    [{ ...SETTINGS, SUPABASE_SECRET_KEYS: JSON.stringify({ default: OTHER_KEY }) }, key],
    [{ ...SETTINGS, SUPABASE_SECRET_KEYS: JSON.stringify({ sync_fixtures: 'sb_publishable_x' }) }, key],
    [{ ...SETTINGS, SUPABASE_SECRET_KEYS: 'not json' }, key],
    [{ ...SETTINGS, SUPABASE_SECRET_KEYS: 'null' }, key],
    [without('SUPABASE_SECRET_KEYS'), key],
    [{ ...SETTINGS, SUPABASE_URL: 'http://abcdefghijklmnopqrst.supabase.co' }, 'SUPABASE_URL'],
    [without('SUPABASE_URL'), 'SUPABASE_URL'],
    [{ ...SETTINGS, SYNC_SECRET: 'q'.repeat(42) }, 'SYNC_SECRET'],
    [{ ...SETTINGS, SYNC_SECRET: 'q'.repeat(43) + '!' }, 'SYNC_SECRET'],
    [without('SYNC_SECRET'), 'SYNC_SECRET'],
    [{ ...SETTINGS, FOOTBALL_DATA_KEY: 'k'.repeat(15) }, 'FOOTBALL_DATA_KEY'],
    [{ ...SETTINGS, FOOTBALL_DATA_KEY: FOOTBALL_KEY + ' ' }, 'FOOTBALL_DATA_KEY'],
    [without('FOOTBALL_DATA_KEY'), 'FOOTBALL_DATA_KEY'],
  ]
  for (const [values, problem] of broken) {
    assert.deepEqual(readEnv(settingsFrom(values)), { env: null, problems: [problem] }, problem)
  }
})

// ---------------------------------------------------------------------------
// When it asks football-data
// ---------------------------------------------------------------------------

test('an empty table gets both whole seasons straight away', async () => {
  const w = world('2026-11-07T12:30:00Z')
  const response = await w.run()
  assert.deepEqual(response, { status: 200, body: { ran: 'full', fixtures: 5, skipped: 0 } })
  assert.deepEqual(w.feedCalls(), ['/competitions/PL/matches?season=2026', '/competitions/CL/matches?season=2026'])
  assert.equal((await fixtures()).length, 5)
  assert.deepEqual(await syncStatus(), { attempt: '2026-11-07T12:30:00.000Z', success: '2026-11-07T12:30:00.000Z' })
})

test('after that it asks at 7 minutes past each hour, or for a match in its live window', async () => {
  const w = await filled('2026-11-07T12:30:00Z')

  w.at('2026-11-07T12:31:00Z')
  assert.deepEqual((await w.run()).body, { ran: 'nothing' })
  w.at('2026-11-07T13:07:00Z')
  assert.deepEqual((await w.run()).body, { ran: 'full', fixtures: 5, skipped: 0 })
  assert.deepEqual(w.feedCalls(), ['/competitions/PL/matches?season=2026', '/competitions/CL/matches?season=2026'])
  w.forget()

  // Chelsea v Arsenal kicks off at 15:00. Its window opens at 14:55.
  w.at('2026-11-07T14:54:00Z')
  assert.deepEqual((await w.run()).body, { ran: 'nothing' })
  w.at('2026-11-07T14:55:00Z')
  assert.deepEqual((await w.run()).body, { ran: 'live', fixtures: 3, skipped: 0 })
  assert.deepEqual(w.feedCalls(), ['/competitions/PL/matches?dateFrom=2026-11-07&dateTo=2026-11-08'])
  w.forget()

  // Once football-data says it's finished, its window closes.
  w.setFeed(feedOf([PL_SEASON[0], { ...KICKOFF, ...ended(1, 1, [0, 1]) }, PL_SEASON[2]], UCL_SEASON))
  w.at('2026-11-07T16:52:00Z')
  assert.deepEqual((await w.run()).body, { ran: 'live', fixtures: 3, skipped: 0 })
  assert.equal((await fixture(KICKOFF.id)).status, 'finished')
  w.at('2026-11-07T16:53:00Z')
  assert.deepEqual((await w.run()).body, { ran: 'nothing' })
  assert.deepEqual(w.feedCalls(), ['/competitions/PL/matches?dateFrom=2026-11-07&dateTo=2026-11-08'])
})

test('a match the feed never finishes stops being asked about 3½ hours after kick-off', async () => {
  const w = await filled('2026-11-07T12:30:00Z')
  await db.query("update public.fixtures set status = 'live' where id = $1", [KICKOFF.id])
  w.at('2026-11-07T18:30:00Z')
  assert.deepEqual((await w.run()).body, { ran: 'live', fixtures: 3, skipped: 0 })
  await db.query("update public.fixtures set status = 'live' where id = $1", [KICKOFF.id])
  w.at('2026-11-07T18:31:00Z')
  assert.deepEqual((await w.run()).body, { ran: 'nothing' })
})

test('a live window that runs past midnight still asks for the day of the kick-off, and only for its own competition', async () => {
  const late = cl({ utcDate: '2026-11-25T23:30:00Z', matchday: 5, homeTeam: CHELSEA, awayTeam: INTER })
  const w = world('2026-11-25T12:30:00Z')
  w.setFeed(feedOf(PL_SEASON, [...UCL_SEASON, late]))
  await w.run()
  w.forget()
  w.at('2026-11-26T01:00:00Z')
  assert.deepEqual((await w.run()).body, { ran: 'live', fixtures: 3, skipped: 0 })
  assert.deepEqual(w.feedCalls(), ['/competitions/CL/matches?dateFrom=2026-11-25&dateTo=2026-11-26'])
})

test('with both competitions live at once, it asks for each', async () => {
  const midweek = match({ matchday: 13, utcDate: '2026-12-01T20:00:00Z', homeTeam: CHELSEA, awayTeam: CITY })
  const sameNight = cl({ matchday: 6, utcDate: '2026-12-01T20:00:00Z', homeTeam: ARSENAL, awayTeam: INTER })
  const w = world('2026-12-01T12:30:00Z')
  w.setFeed(feedOf([...PL_SEASON, midweek], [...UCL_SEASON, sameNight]))
  await w.run()
  w.forget()
  w.at('2026-12-01T20:30:00Z')
  assert.deepEqual((await w.run()).body, { ran: 'live', fixtures: 7, skipped: 0 })
  assert.deepEqual(w.feedCalls(), [
    '/competitions/PL/matches?dateFrom=2026-12-01&dateTo=2026-12-02',
    '/competitions/CL/matches?dateFrom=2026-12-01&dateTo=2026-12-02',
  ])
})

test('it never takes instructions from the call', async () => {
  const w = world('2026-11-07T12:30:00Z')
  const response = await w.run(schedulerCall({ body: JSON.stringify({ season: 1999, path: '/competitions/WC/matches', url: 'https://evil.example' }) }))
  assert.deepEqual(response.body, { ran: 'full', fixtures: 5, skipped: 0 })
  assert.deepEqual(w.feedCalls(), ['/competitions/PL/matches?season=2026', '/competitions/CL/matches?season=2026'])
})

test('the season switches on 1 July', () => {
  assert.equal(seasonFor(new Date('2027-06-30T23:59:59Z')), 2026)
  assert.equal(seasonFor(new Date('2027-07-01T00:00:00Z')), 2027)
  assert.equal(seasonFor(new Date('2026-11-07T15:00:00Z')), 2026)
  assert.equal(seasonFor(new Date('2027-01-01T00:00:00Z')), 2026)
})

// ---------------------------------------------------------------------------
// The 50-second rule, the back-off and failures
// ---------------------------------------------------------------------------

test('two calls at once run once, and runs are at least 50 seconds apart', async () => {
  const w = await filled('2026-11-07T12:30:00Z')
  w.at('2026-11-07T14:56:00Z')
  const both = await Promise.all([w.run(), w.run()])
  assert.deepEqual(both.map(response => (response.body as { ran: string }).ran).sort(), ['live', 'waiting'])
  assert.equal(w.feedCalls().length, 1)

  w.later(49 * SECOND)
  assert.deepEqual((await w.run()).body, { ran: 'waiting' })
  w.later(1 * SECOND)
  assert.deepEqual((await w.run()).body, { ran: 'live', fixtures: 3, skipped: 0 })
  assert.equal(w.feedCalls().length, 2)
})

test('a slow run that ends after a newer one never moves the success time back', async () => {
  const w = await filled('2026-11-07T12:30:00Z')
  w.at('2026-11-07T14:54:00Z')
  assert.deepEqual((await w.run()).body, { ran: 'nothing' })

  // The 14:55 run's answer takes over a minute to arrive.
  let release = () => {}
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  w.setFeed(async url => {
    await gate
    return feedOf(PL_SEASON, UCL_SEASON)(url)
  })
  w.at('2026-11-07T14:55:00Z')
  const slow = w.run()
  await until(() => w.feedCalls().length === 1)

  // Meanwhile the 14:56 run starts and finishes.
  w.setFeed(feedOf(PL_SEASON, UCL_SEASON))
  w.at('2026-11-07T14:56:00Z')
  assert.deepEqual((await w.run()).body, { ran: 'live', fixtures: 3, skipped: 0 })
  release()
  assert.equal((await slow).status, 200)
  assert.deepEqual(await syncStatus(), { attempt: '2026-11-07T14:56:00.000Z', success: '2026-11-07T14:56:00.000Z' })
})

test('while runs keep failing, the gaps double up to 15 minutes, and one success ends it', async () => {
  const t = Date.parse('2026-11-07T15:00:00Z')
  assert.equal(gapAfter(t, t), 50 * SECOND)
  assert.equal(gapAfter(t, t + MINUTE), 50 * SECOND)
  assert.equal(gapAfter(t, null), 50 * SECOND, 'no back-off before the first success')
  assert.equal(gapAfter(t, t - 10 * SECOND), 50 * SECOND)
  assert.equal(gapAfter(t, t - MINUTE), MINUTE)
  assert.equal(gapAfter(t, t - 4 * MINUTE), 4 * MINUTE)
  assert.equal(gapAfter(t, t - 2 * 60 * MINUTE), 15 * MINUTE)

  // football-data fails for an hour while a match is live. A call comes
  // every minute, as the scheduler's would.
  const w = await filled('2026-11-07T12:30:00Z')
  w.at('2026-11-07T14:55:00Z')
  await w.run()
  w.forget()
  w.setFeed(() => Response.json({ message: 'Down for maintenance' }, { status: 503 }))
  const tried: number[] = []
  for (let minute = 1; minute <= 61; minute++) {
    w.at(new Date(Date.parse('2026-11-07T14:55:00Z') + minute * MINUTE).toISOString())
    const before = w.feedCalls().length
    const response = await w.run()
    if (w.feedCalls().length > before) {
      tried.push(minute)
      assert.equal(response.status, 502)
    } else {
      assert.deepEqual(response.body, { ran: 'waiting' })
    }
  }
  assert.deepEqual(tried, [1, 2, 4, 8, 16, 31, 46, 61])

  // It works again, and the next minute is back to normal.
  w.setFeed(feedOf(PL_SEASON, UCL_SEASON))
  w.later(15 * MINUTE)
  assert.equal((await w.run()).status, 200)
  w.later(MINUTE)
  assert.equal((await w.run()).status, 200)
})

test('a 429, an error or a bad answer leaves the saved fixtures alone and doesn\'t count as a run that worked', async () => {
  const bad: Array<[string, (url: URL) => Response | Promise<Response>, RegExp]> = [
    ['too many requests', () => Response.json({ message: 'Slow down' }, { status: 429 }), /answered 429, too many requests/],
    ['a server error', () => new Response('oops', { status: 500 }), /answered 500/],
    ['a refused key', () => Response.json({ message: 'Bad token' }, { status: 403 }), /answered 403/],
    ['no list of matches', () => Response.json({ matches: 'none' }), /no list of matches/],
    ['too many matches', () => answer(Array.from({ length: 1001 }, () => ({}))), /no list of matches, or too many/],
    ['not JSON', () => new Response('<html>maintenance</html>'), /wasn't JSON/],
    ['over 4 MB', () => new Response('x'.repeat(4 * 1024 * 1024 + 1)), /over 4 MB/],
    ['not reachable', () => Promise.reject(new TypeError('fetch failed')), /couldn't reach football-data \(TypeError\)/],
  ]
  for (const [name, feed, expected] of bad) {
    await resetDatabase(db)
    const w = await filled('2026-11-07T12:30:00Z')
    const before = await fixtures()
    const status = await syncStatus()
    w.setFeed(feed)
    w.at('2026-11-07T14:55:00Z')
    logged.errors.length = 0
    const response = await w.run()
    assert.deepEqual(response, { status: 502, body: { error: 'The sync failed. Its log says why.' } }, name)
    assert.ok(logged.errors.some(line => expected.test(line)), `${name}: ${logged.errors.join(' | ')}`)
    assert.deepEqual(await fixtures(), before, name)
    assert.deepEqual(await syncStatus(), { attempt: '2026-11-07T14:55:00.000Z', success: status.success }, name)
  }
})

test('when football-data says no requests are left this minute, the second request waits', async () => {
  const w = world('2026-11-07T12:30:00Z')
  w.setFeed(url => (url.pathname.includes('/PL/') ? answer(PL_SEASON, { 'x-requests-available-minute': '0' }) : answer(UCL_SEASON)))
  const response = await w.run()
  assert.equal(response.status, 502)
  assert.deepEqual(w.feedCalls(), ['/competitions/PL/matches?season=2026'])
  assert.equal((await fixtures()).length, 3, 'the Premier League answer still got saved')
  assert.equal((await syncStatus()).success, null)
})

test('a database that refuses a save fails the run, and says which rule', async () => {
  const w = world('2026-11-07T12:30:00Z')
  // The first answer saves fine. Then someone's changed the schema so the
  // second can't, which the log should name.
  await db.exec('alter table public.teams add constraint no_inter check (id <> 108)')
  try {
    assert.equal((await w.run()).status, 502)
  } finally {
    await db.exec('alter table public.teams drop constraint no_inter')
  }
  assert.match(logged.errors.join(' '), /the database refused POST teams with 400 \(23514: new row for relation "teams" violates check constraint "no_inter"\)/)
})

test('an unexpected error logs only its name, never its message', async () => {
  const w = world('2026-11-07T12:30:00Z')
  // A database answer that isn't JSON. The error that makes repeats the start
  // of the answer, which could hold anything.
  w.setDatabase(() => new Response(`${SECRET_KEY} is not JSON`, { status: 200 }))
  assert.deepEqual(await w.run(), { status: 502, body: { error: 'The sync failed. Its log says why.' } })
  assert.deepEqual(logged.errors, ['sync-fixtures: failed (SyntaxError)'])
})

// ---------------------------------------------------------------------------
// Checking every match
// ---------------------------------------------------------------------------

// Maps one hand-made match and returns the fixture row, or the reason it was skipped.
function mapped(sample: Sample, competition: 'PL' | 'UCL' = 'PL', season: number | null = 2026) {
  const result = mapMatch(sample, competition, season)
  return result.ok ? result.fixture : result.reason
}

test('normal time, extra time and a shootout each give the right 90-minute score', () => {
  const score = (sample: Sample) => readScore(sample)
  const scores = (ninety: [number, number] | null, half: [number, number] | null, extra: [number, number] | null = null, pens: [number, number] | null = null): Scores => ({ ninety, half, extra, pens })

  // Not started, under way, and finished in normal time.
  assert.deepEqual(score(unplayed()), scores(null, null))
  assert.deepEqual(score({ duration: 'REGULAR', fullTime: pair(1, 0), halfTime: pair(1, 0) }), scores([1, 0], [1, 0]))
  assert.deepEqual(score(ended(2, 1, [1, 0]).score), scores([2, 1], [1, 0]))
  // Extra time: fullTime adds the extra-time goals, so the 90 minutes come from regularTime.
  assert.deepEqual(score({ duration: 'EXTRA_TIME', fullTime: pair(2, 1), halfTime: pair(0, 0), regularTime: pair(1, 1), extraTime: pair(1, 0) }),
    scores([1, 1], [0, 0], [1, 0]))
  // Just into extra time, before football-data fills in extraTime.
  assert.deepEqual(score({ duration: 'EXTRA_TIME', fullTime: pair(1, 1), halfTime: pair(0, 1), regularTime: pair(1, 1) }),
    scores([1, 1], [0, 1]))
  // A shootout: fullTime adds the penalties too.
  assert.deepEqual(score({ duration: 'PENALTY_SHOOTOUT', fullTime: pair(6, 5), halfTime: pair(0, 0), regularTime: pair(0, 0), extraTime: pair(1, 1), penalties: pair(5, 4) }),
    scores([0, 0], [0, 0], [1, 1], [5, 4]))

  const bad: Array<[string, unknown]> = [
    ['parts that don\'t add up', { duration: 'EXTRA_TIME', fullTime: pair(3, 1), halfTime: pair(0, 0), regularTime: pair(1, 1), extraTime: pair(1, 0) }],
    ['a shootout fullTime without the penalties', { duration: 'PENALTY_SHOOTOUT', fullTime: pair(1, 1), halfTime: pair(0, 0), regularTime: pair(1, 1), extraTime: pair(0, 0), penalties: pair(4, 3) }],
    ['extra time without regularTime', { duration: 'EXTRA_TIME', fullTime: pair(2, 1), halfTime: pair(0, 0), extraTime: pair(1, 0) }],
    ['a shootout without regularTime', { duration: 'PENALTY_SHOOTOUT', fullTime: pair(5, 4), halfTime: pair(0, 0), penalties: pair(4, 3) }],
    ['normal time with extra-time goals', { duration: 'REGULAR', fullTime: pair(2, 1), halfTime: pair(0, 0), extraTime: pair(1, 0) }],
    ['extra time with penalties', { duration: 'EXTRA_TIME', fullTime: pair(5, 4), halfTime: pair(0, 0), regularTime: pair(1, 1), extraTime: pair(0, 0), penalties: pair(4, 3) }],
    ['regularTime that disagrees with fullTime', { duration: 'REGULAR', fullTime: pair(2, 1), halfTime: pair(0, 0), regularTime: pair(1, 1) }],
    ['half a score', { duration: 'REGULAR', fullTime: pair(1, null), halfTime: pair() }],
    ['21 goals', { duration: 'REGULAR', fullTime: pair(21, 0), halfTime: pair() }],
    ['a negative score', { duration: 'REGULAR', fullTime: pair(-1, 0), halfTime: pair() }],
    ['a fraction', { duration: 'REGULAR', fullTime: pair(1.5, 0), halfTime: pair() }],
    ['a score as text', { duration: 'REGULAR', fullTime: { home: '2', away: '1' }, halfTime: pair() }],
    ['a part as text', { duration: 'REGULAR', fullTime: '2-1', halfTime: pair() }],
    ['a part as a list', { duration: 'REGULAR', fullTime: [2, 1], halfTime: pair() }],
    ['an unknown duration', { duration: 'GOLDEN_GOAL', fullTime: pair(1, 0), halfTime: pair() }],
    ['no duration', { fullTime: pair(1, 0), halfTime: pair() }],
    ['no score at all', null],
  ]
  for (const [name, sample] of bad) assert.equal(score(sample as Sample), 'bad', name)

  // And whole matches: a finished match must have a score.
  assert.equal(mapped(match({ status: 'FINISHED', score: unplayed() })), 'score')
})

test('the saved row keeps every part of the score in its own place', async () => {
  const shootout = cl({
    stage: 'QUARTER_FINALS', matchday: 2, utcDate: '2027-04-14T19:00:00Z', homeTeam: ARSENAL, awayTeam: INTER, status: 'FINISHED',
    score: { winner: 'HOME_TEAM', duration: 'PENALTY_SHOOTOUT', fullTime: pair(6, 5), halfTime: pair(0, 1), regularTime: pair(1, 1), extraTime: pair(0, 0), penalties: pair(5, 4) },
  })
  const w = world('2026-11-07T12:30:00Z')
  w.setFeed(feedOf(PL_SEASON, [...UCL_SEASON, shootout]))
  await w.run()
  const row = await fixture(shootout.id)
  assert.equal(row.period, 'QF')
  assert.equal(row.tie_leg, 2)
  assert.equal(row.status, 'finished')
  assert.deepEqual([row.home_90, row.away_90, row.home_ht, row.away_ht, row.home_et, row.away_et, row.home_pens, row.away_pens], [1, 1, 0, 1, 0, 0, 5, 4])
})

test('stages and matchdays become our weeks and stages, with the leg of each tie', () => {
  assert.deepEqual(
    [mapped(match({ matchday: 1 })), mapped(match({ matchday: 38 }))].map(row => typeof row === 'string' ? row : [row.period, row.tie_leg]),
    [['MW1', null], ['MW38', null]],
  )
  const ucl = (overrides: Sample) => {
    const row = mapped(cl(overrides), 'UCL')
    return typeof row === 'string' ? row : [row.period, row.tie_leg]
  }
  assert.deepEqual(ucl({ matchday: 1 }), ['MD1', null])
  assert.deepEqual(ucl({ matchday: 8 }), ['MD8', null])
  assert.deepEqual(ucl({ stage: 'PLAYOFFS', matchday: 1, utcDate: '2027-02-16T20:00:00Z' }), ['KPO', 1])
  assert.deepEqual(ucl({ stage: 'LAST_16', matchday: 2, utcDate: '2027-03-17T20:00:00Z' }), ['R16', 2])
  assert.deepEqual(ucl({ stage: 'QUARTER_FINALS', matchday: 1, utcDate: '2027-04-06T19:00:00Z' }), ['QF', 1])
  assert.deepEqual(ucl({ stage: 'SEMI_FINALS', matchday: 2, utcDate: '2027-05-05T19:00:00Z' }), ['SF', 2])
  assert.deepEqual(ucl({ stage: 'FINAL', matchday: null, utcDate: '2027-05-29T19:00:00Z' }), ['F', null])

  // What doesn't fit gets skipped.
  assert.equal(mapped(match({ matchday: 0 })), 'matchday')
  assert.equal(mapped(match({ matchday: 39 })), 'matchday')
  assert.equal(mapped(match({ matchday: '11' })), 'matchday')
  assert.equal(mapped(match({ stage: 'LEAGUE_STAGE' })), 'stage', 'a Champions League stage in the Premier League')
  assert.equal(ucl({ matchday: 9 }), 'matchday')
  assert.equal(ucl({ stage: 'REGULAR_SEASON', matchday: 4 }), 'stage')
  assert.equal(ucl({ stage: 'GROUP_STAGE', matchday: 4 }), 'stage', 'the old format')
  assert.equal(ucl({ stage: 'LAST_16', matchday: 3 }), 'matchday')
  assert.equal(ucl({ stage: 'LAST_16', matchday: null }), 'matchday')
  assert.equal(ucl({ stage: 'constructor', matchday: 1 }), 'stage')
  // Qualifying rounds are left out on purpose, not logged as problems.
  assert.equal(ucl({ stage: 'QUALIFICATION_ROUND_2', matchday: 1, utcDate: '2026-07-22T18:00:00Z' }), 'not tracked')
  assert.equal(ucl({ stage: 'PLAYOFF_ROUND', matchday: 1, utcDate: '2026-08-19T19:00:00Z' }), 'not tracked')
})

test('teams: real codes kept, missing ones made from the short name, and anything odd skipped', () => {
  assert.equal(teamCode('ARS', 'Arsenal'), 'ARS')
  assert.equal(teamCode('FK', 'Bodø/Glimt'), 'BOD')
  assert.equal(teamCode('B04', 'Leverkusen'), 'LEV')
  assert.equal(teamCode(null, 'St. Pauli'), 'STP')
  assert.equal(teamCode('ars', 'Arsenal'), 'ARS', 'a lower-case code gets remade, the same')
  assert.equal(teamCode('', 'Ö1'), null)

  const result = mapMatch(cl({ homeTeam: LEVERKUSEN, awayTeam: BODO }), 'UCL', 2026)
  assert.ok(result.ok)
  assert.deepEqual(result.teams.map(team => team.code), ['LEV', 'BOD'])
  assert.deepEqual(result.madeCodes.map(team => team.id), [3, 5721])

  const team = (overrides: Sample) => mapped(match({ homeTeam: { ...ARSENAL, ...overrides } }))
  for (const [name, overrides] of [
    ['an ID as text', { id: '57' }],
    ['a zero ID', { id: 0 }],
    ['a fractional ID', { id: 57.5 }],
    ['an ID too big for the table', { id: 2 ** 31 }],
    ['no short name', { shortName: undefined }],
    ['an empty short name', { shortName: '   ' }],
    ['no name', { name: null }],
    ['a name over 80 characters', { name: 'A'.repeat(81) }],
    ['a short name over 40 characters', { shortName: 'B'.repeat(41) }],
    ['a name with a right-to-left override', { name: 'Arsenal‮FC' }],
    ['a name with a zero-width space', { name: 'Arse​nal FC' }],
    ['a name with a control character', { name: 'Arsenal\u0000FC' }],
    ['a name with a broken character', { name: 'Arsenal \uD800FC' }],
    ['a name with a line separator', { name: 'Arsenal FC' }],
    ['no usable short name for a code', { tla: null, shortName: 'Ö1' }],
  ] as Array<[string, Sample]>) {
    assert.equal(team(overrides), 'team', name)
  }
  assert.equal(mapped(match({ homeTeam: 'Arsenal' })), 'team', 'a team as text')
  assert.equal(mapped(match({ homeTeam: undefined })), 'team', 'no team at all')
  assert.equal(mapped(match({ homeTeam: CITY, awayTeam: CITY })), 'same team')
  // Names keep their letters, ø included, without the spaces round them.
  const kept = mapMatch(match({ homeTeam: { ...BODO, name: '  FK Bodø/Glimt ' } }), 'PL', 2026)
  assert.ok(kept.ok)
  assert.equal(kept.teams[0].name, 'FK Bodø/Glimt')

  // A knockout place before the draw waits, without a log line.
  assert.equal(mapped(cl({ stage: 'LAST_16', matchday: 1, utcDate: '2027-03-09T20:00:00Z', homeTeam: NOT_DRAWN }), 'UCL'), 'not drawn')
  assert.equal(mapped(cl({ stage: 'FINAL', matchday: null, utcDate: '2027-05-29T19:00:00Z', homeTeam: NOT_DRAWN, awayTeam: NOT_DRAWN }), 'UCL'), 'not drawn')
  assert.equal(mapped(cl({ stage: 'FINAL', matchday: null, utcDate: '2027-05-29T19:00:00Z', homeTeam: null }), 'UCL'), 'not drawn')
})

test('IDs, kick-offs, statuses and minutes', () => {
  for (const id of ['800001', 0, -1, 1.5, null, Number.MAX_SAFE_INTEGER + 1]) assert.equal(mapped(match({ id })), 'id', String(id))
  for (const utcDate of ['2026-02-30T15:00:00Z', '2026-11-07 15:00:00', '2026-11-07T15:00:00+01:00', 'tomorrow', 1793977200000, null]) {
    assert.equal(mapped(match({ utcDate })), 'kickoff', String(utcDate))
  }
  // A full refresh asks for one season, so a match from another is skipped.
  assert.equal(mapped(match({ utcDate: '2026-06-15T15:00:00Z' })), 'season')
  assert.equal(mapped(match({ utcDate: '2027-08-21T15:00:00Z' })), 'season')
  // A live request can span two seasons, so it takes the season from the
  // kick-off, as long as the table can hold it.
  const may = mapped(match({ utcDate: '2027-05-23T15:00:00Z', matchday: 38 }), 'PL', null)
  assert.equal(typeof may === 'string' ? may : may.season, 2026)
  assert.equal(mapped(match({ utcDate: '2019-11-07T15:00:00Z' }), 'PL', null), 'season')
  assert.equal(mapped(match({ utcDate: '2101-11-07T15:00:00Z' }), 'PL', null), 'season')

  const statuses: Array<[string, string]> = [
    ['SCHEDULED', 'scheduled'], ['TIMED', 'scheduled'], ['IN_PLAY', 'live'], ['PAUSED', 'half_time'], ['EXTRA_TIME', 'extra_time'],
    ['PENALTY_SHOOTOUT', 'penalties'], ['POSTPONED', 'postponed'], ['SUSPENDED', 'suspended'], ['CANCELLED', 'cancelled'],
    ['CANCELED', 'cancelled'], ['AWARDED', 'awarded'],
  ]
  for (const [feed, ours] of statuses) {
    const row = mapped(match({ status: feed }))
    assert.equal(typeof row === 'string' ? row : row.status, ours, feed)
  }
  for (const status of ['LIVE', 'finished', 'constructor', 'toString', '__proto__', null, 3]) assert.equal(mapped(match({ status })), 'status', String(status))

  const minute = (value: unknown) => {
    const row = mapped(match({ status: 'IN_PLAY', minute: value, score: { duration: 'REGULAR', fullTime: pair(0, 0), halfTime: pair() } }))
    return typeof row === 'string' ? row : row.minute
  }
  assert.equal(minute(67), 67)
  assert.equal(minute(0), 0)
  assert.equal(minute(131), null, 'an odd minute is dropped, and the match kept')
  assert.equal(minute('45+2'), null)
  assert.equal(minute(undefined), null)

  const row = mapped(match({ lastUpdated: 'yesterday' }))
  assert.equal(typeof row === 'string' ? row : row.feed_updated_at, null, 'a bad lastUpdated is dropped')
})

test('a skipped match leaves the rest of the answer saved, and the log names it', async () => {
  const good = [match({ matchday: 13 }), match({ matchday: 14 }), match({ matchday: 15 })]
  const odd = [match({ status: 'LIVE' }), match({ homeTeam: CITY, awayTeam: CITY }), match({ score: { duration: 'REGULAR', fullTime: pair(25, 0), halfTime: pair() } })]
  const twin = { ...good[0], matchday: 16 }
  const w = world('2026-11-07T12:30:00Z')
  w.setFeed(feedOf([...good, ...odd, twin], [cl({ stage: 'LAST_16', matchday: 1, utcDate: '2027-03-09T20:00:00Z', homeTeam: NOT_DRAWN })]))
  assert.deepEqual((await w.run()).body, { ran: 'full', fixtures: 3, skipped: 4 })
  assert.deepEqual((await fixtures()).map(row => row.id), good.map(sample => sample.id))
  assert.equal((await fixture(good[0].id)).period, 'MW13', 'the first of two copies counts')
  assert.deepEqual(logged.info, [
    `sync-fixtures: PL 2026: 7 matches, 3 saved, skipped 1 (status: ${odd[0].id}), skipped 1 (same team: ${odd[1].id}), skipped 1 (score: ${odd[2].id}), skipped 1 (duplicate: ${good[0].id})`,
    'sync-fixtures: CL 2026: 1 match, 0 saved, left out 1 (not drawn)',
  ])
})

test('the log line lists at most 10 IDs for each reason, and the codes it made', () => {
  const batch = mapMatches({ matches: [...Array.from({ length: 12 }, (_, i) => match({ id: 700_000 + i, status: 'LIVE' })), cl({ homeTeam: LEVERKUSEN })] }, 'UCL', 2026)
  assert.ok(batch !== null)
  assert.equal(describeBatch(batch),
    '13 matches, 1 saved, skipped 12 (stage: 700000, 700001, 700002, 700003, 700004, 700005, 700006, 700007, 700008, 700009, and 2 more), made codes for 3 LEV, 5721 BOD')
  // Only the answer's own fields count, never ones it inherits.
  assert.equal(mapMatches(Object.create({ matches: [match()] }), 'PL', 2026), null)
  assert.equal(mapMatches({ matches: {} }, 'PL', 2026), null)
  assert.equal(mapMatches([], 'PL', 2026), null)
  assert.equal(mapMatches(null, 'PL', 2026), null)
})

test('every row it builds fits the real tables, teams saved first', async () => {
  // One of everything at once: each status, each stage, each kind of score.
  const everything = [
    ...['SCHEDULED', 'TIMED', 'POSTPONED', 'SUSPENDED', 'CANCELLED'].map((status, i) => match({ status, matchday: 20 + i })),
    match({ status: 'IN_PLAY', minute: 30, score: { duration: 'REGULAR', fullTime: pair(1, 0), halfTime: pair() } }),
    match({ status: 'PAUSED', score: { duration: 'REGULAR', fullTime: pair(1, 1), halfTime: pair(1, 1) } }),
    match({ status: 'AWARDED', score: { duration: 'REGULAR', fullTime: pair(3, 0), halfTime: pair() } }),
    match({ ...ended(0, 0), matchday: 38, utcDate: '2027-05-30T15:00:00Z', homeTeam: CHELSEA, awayTeam: CITY }),
  ]
  const knockouts = [
    cl({ stage: 'PLAYOFFS', matchday: 1, utcDate: '2027-02-16T20:00:00Z', status: 'EXTRA_TIME', homeTeam: BODO, awayTeam: CHELSEA,
      score: { duration: 'EXTRA_TIME', fullTime: pair(2, 1), halfTime: pair(1, 0), regularTime: pair(1, 1), extraTime: pair(1, 0) } }),
    cl({ stage: 'LAST_16', matchday: 2, utcDate: '2027-03-17T20:00:00Z', status: 'PENALTY_SHOOTOUT', homeTeam: LEVERKUSEN, awayTeam: INTER,
      score: { duration: 'PENALTY_SHOOTOUT', fullTime: pair(3, 2), halfTime: pair(0, 0), regularTime: pair(0, 0), extraTime: pair(0, 0), penalties: pair(3, 2) } }),
    cl({ stage: 'FINAL', matchday: null, utcDate: '2027-05-29T19:00:00Z', homeTeam: ARSENAL, awayTeam: INTER }),
  ]
  const w = world('2026-11-07T12:30:00Z')
  w.setFeed(feedOf([...PL_SEASON, ...everything], [...UCL_SEASON, ...knockouts]))
  assert.deepEqual((await w.run()).body, { ran: 'full', fixtures: 17, skipped: 0 })
  assert.equal((await fixtures()).length, 17)
  assert.deepEqual(await teams(), [
    { id: 3, name: 'Bayer 04 Leverkusen', short_name: 'Leverkusen', code: 'LEV' },
    { id: 57, name: 'Arsenal FC', short_name: 'Arsenal', code: 'ARS' },
    { id: 61, name: 'Chelsea FC', short_name: 'Chelsea', code: 'CHE' },
    { id: 65, name: 'Manchester City FC', short_name: 'Man City', code: 'MCI' },
    { id: 108, name: 'FC Internazionale Milano', short_name: 'Inter', code: 'INT' },
    { id: 5721, name: 'FK Bodø/Glimt', short_name: 'Bodø/Glimt', code: 'BOD' },
  ])
  const saves = w.calls.filter(call => call.method === 'POST').map(call => call.url.pathname.replace('/rest/v1/', ''))
  assert.deepEqual(saves, ['teams', 'fixtures', 'teams', 'fixtures'])

  // Running again changes the rows in place rather than adding more.
  w.at('2026-11-07T13:07:00Z')
  assert.equal((await w.run()).status, 200)
  assert.equal((await fixtures()).length, 17)
})

// ---------------------------------------------------------------------------
// Where the secrets go
// ---------------------------------------------------------------------------

test('the football-data key goes only to football-data, and the secret key only to Supabase, in the apikey header', async () => {
  const w = world('2026-11-07T12:30:00Z')
  await w.run()
  w.at('2026-11-07T14:55:00Z')
  await w.run()
  assert.ok(w.calls.length > 5)
  for (const call of w.calls) {
    const where = `${call.method} ${call.url.pathname}`
    assert.equal(call.redirect, 'error', `${where} must refuse redirects`)
    if (call.url.origin === FEED) {
      assert.equal(call.headers.get('x-auth-token'), FOOTBALL_KEY, where)
      assert.equal(call.headers.get('apikey'), null, where)
      assert.equal(call.method, 'GET', where)
      assert.match(call.url.pathname, /^\/v4\/competitions\/(PL|CL)\/matches$/, where)
    } else {
      assert.equal(call.url.origin, SUPABASE_URL, where)
      assert.match(call.url.pathname, /^\/rest\/v1\/(teams|fixtures|sync_status)$/, where)
      assert.equal(call.headers.get('apikey'), SECRET_KEY, where)
      assert.equal(call.headers.get('x-auth-token'), null, where)
    }
    assert.equal(call.headers.get('authorization'), null, where)
    assert.ok(!call.url.href.includes(FOOTBALL_KEY) && !call.url.href.includes(SECRET_KEY) && !call.url.href.includes(SYNC_SECRET), where)
  }
})

test('the log never holds a key, the secret or football-data\'s headers', async () => {
  const w = world('2026-11-07T12:30:00Z')
  await w.run()                                                  // a full refresh
  w.at('2026-11-07T14:55:00Z')
  await w.run()                                                  // a live request
  w.setFeed(() => answer([], { 'x-requests-available-minute': '0' }))
  w.at('2026-11-07T15:07:00Z')
  await w.run()                                                  // no requests left
  w.setFeed(() => Response.json({ message: `Your token ${FOOTBALL_KEY} is wrong` }, { status: 400 }))
  w.at('2026-11-07T15:30:00Z')
  await w.run()                                                  // an error that repeats the key
  await w.run(schedulerCall({ secret: 'Sync' + 'x'.repeat(44) }))  // a wrong secret
  await handle(schedulerCall(), settingsFrom(without('FOOTBALL_DATA_KEY')), w.deps)
  const all = [...logged.info, ...logged.errors].join('\n')
  assert.ok(all.includes('sync-fixtures: PL 2026: 3 matches, 3 saved'), all)
  assert.ok(all.includes('no requests left this minute') && all.includes('answered 400') && all.includes('refused a call'), all)
  assert.ok(all.includes('refusing every call until these are set up: FOOTBALL_DATA_KEY'), all)
  for (const secret of [FOOTBALL_KEY, SECRET_KEY, OTHER_KEY, SYNC_SECRET, ACCOUNT, 'x-authenticated-client']) {
    assert.ok(!all.includes(secret), `the log mentions ${secret.slice(0, 12)}…`)
  }
})
