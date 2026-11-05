// supabase-api.ts with the real supabase-js client, talking to a fake
// network. These pin how each kind of answer from Supabase is read, so an
// upgrade of supabase-js that changes it fails here first.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createClient } from '@supabase/supabase-js'
import { ServerError, type AuthResult } from '../src/lib/account/api.ts'
import { supabaseApi } from '../src/lib/account/supabase-api.ts'

const PROJECT = 'https://abcdefghijklmnopqrst.supabase.co'
const KEY = 'sb_publishable_test-key'
const TOKEN = 'a'.repeat(64)
const USER_ID = '6f1b2a3c-4d5e-4f60-8a7b-9c0d1e2f3a4b'
// Supabase Auth reads error codes from the body's `code` when this is sent.
const API_VERSION = { 'x-supabase-api-version': '2024-01-01' }

type Seen = { method: string; path: string; query: URLSearchParams; headers: Headers; body: string }
type Reply = { status: number; body?: unknown; headers?: Record<string, string> } | 'network-error'

// An AccountApi whose every request goes to `route` instead of the network.
function harness(route: (request: Seen) => Reply) {
  const requests: Seen[] = []
  const fetchFn: typeof fetch = async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    const seen = { method: request.method, path: url.pathname, query: url.searchParams, headers: request.headers, body: await request.text() }
    requests.push(seen)
    const reply = route(seen)
    if (reply === 'network-error') throw new TypeError('fetch failed')
    const body = reply.body === undefined || reply.status === 204 ? null : JSON.stringify(reply.body)
    return new Response(body, { status: reply.status, headers: { 'Content-Type': 'application/json', ...reply.headers } })
  }
  const client = createClient(PROJECT, KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: fetchFn },
  })
  return { api: supabaseApi(client, { url: PROJECT, publishableKey: KEY }, fetchFn), requests }
}

// A session like the one Supabase Auth returns after a sign-in.
function session() {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const now = Math.floor(Date.now() / 1000)
  return {
    access_token: `${part({ alg: 'HS256', typ: 'JWT' })}.${part({ sub: USER_ID, exp: now + 900, iat: now, role: 'authenticated' })}.c2ln`,
    token_type: 'bearer', expires_in: 900, expires_at: now + 900, refresh_token: 'refresh-token',
    user: { id: USER_ID, aud: 'authenticated', role: 'authenticated', email: 'kman@example.com', app_metadata: {}, user_metadata: {}, created_at: '2026-11-02T12:00:00Z' },
  }
}
const authError = (status: number, code: string, message: string): Reply => ({ status, body: { code, message }, headers: API_VERSION })

const WRONG: AuthResult = { ok: false, problem: 'wrong' }
const UNAVAILABLE: AuthResult = { ok: false, problem: 'unavailable' }

test('Sign-in answers sort into the few the flows know', async () => {
  const cases: [Reply, AuthResult][] = [
    [{ status: 200, body: session() }, { ok: true }],
    [authError(400, 'invalid_credentials', 'Invalid login credentials'), WRONG],
    [authError(429, 'over_request_rate_limit', 'Request rate limit reached'), { ok: false, problem: 'too-many-tries' }],
    [{ status: 503, body: { message: 'down' } }, UNAVAILABLE],
    ['network-error', UNAVAILABLE],
  ]
  for (const [reply, expected] of cases) {
    const { api, requests } = harness(() => reply)
    assert.deepEqual(await api.signIn('kman@example.com', TOKEN), expected)
    assert.equal(requests[0].path, '/auth/v1/token')
    assert.equal(requests[0].query.get('grant_type'), 'password')
    assert.equal(JSON.parse(requests[0].body).password, TOKEN)
  }
})

test('Sign-up answers: no invite, already an account, and a new signed-in account', async () => {
  const cases: [Reply, AuthResult][] = [
    [{ status: 200, body: session() }, { ok: true }],
    // The invite hook's refusal comes back as a 403 with its own message.
    [authError(403, 'unknown', "This email doesn't have an invite."), { ok: false, problem: 'not-invited' }],
    [authError(422, 'user_already_exists', 'User already registered'), { ok: false, problem: 'exists' }],
    // No session would mean "Confirm email" got turned on.
    [{ status: 200, body: session().user }, UNAVAILABLE],
  ]
  for (const [reply, expected] of cases) {
    const { api } = harness(() => reply)
    assert.deepEqual(await api.signUp('kman@example.com', TOKEN), expected)
  }
})

test('A password change sends the current login token, and a wrong one is "wrong"', async () => {
  for (const [reply, expected] of [
    [{ status: 200, body: session().user }, { ok: true }],
    [authError(400, 'current_password_invalid', 'Current password required when setting new password.'), WRONG],
  ] as [Reply, AuthResult][]) {
    const { api, requests } = harness(request => (request.path === '/auth/v1/token' ? { status: 200, body: session() } : reply))
    await api.signIn('kman@example.com', TOKEN)
    assert.deepEqual(await api.changePassword(TOKEN, 'b'.repeat(64)), expected)
    const update = requests[1]
    assert.equal(update.method, 'PUT')
    assert.equal(update.path, '/auth/v1/user')
    const body = JSON.parse(update.body) as Record<string, unknown>
    assert.equal(body.password, 'b'.repeat(64))
    assert.equal(body.current_password, TOKEN)
  }
})

test('The recover function gets only two headers, and only its 200 means yes', async () => {
  const { api, requests } = harness(() => ({ status: 200, body: { ok: true } }))
  assert.equal(await api.recover('kman@example.com', 'c'.repeat(64), TOKEN), true)
  assert.equal(requests[0].path, '/functions/v1/recover')
  assert.deepEqual([...requests[0].headers.keys()].sort(), ['apikey', 'content-type'])
  assert.equal(requests[0].headers.get('apikey'), KEY)
  assert.deepEqual(JSON.parse(requests[0].body), { email: 'kman@example.com', proof: 'c'.repeat(64), loginToken: TOKEN })

  assert.equal(await harness(() => ({ status: 400, body: { error: 'Recovery failed.' } })).api.recover('kman@example.com', 'c'.repeat(64), TOKEN), false)
  await assert.rejects(harness(() => ({ status: 200, body: { ok: 'maybe' } })).api.recover('kman@example.com', 'c'.repeat(64), TOKEN), ServerError)
  await assert.rejects(harness(() => ({ status: 500, body: {} })).api.recover('kman@example.com', 'c'.repeat(64), TOKEN), ServerError)
  await assert.rejects(harness(() => 'network-error').api.recover('kman@example.com', 'c'.repeat(64), TOKEN), ServerError)
})

// A key wrap with an ID that sorts in order of n.
const wrap = (n: number) => ({
  id: `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`, kind: 'password', version_no: n + 1, v: 1,
  iv: 'A'.repeat(16), wrapped: 'B'.repeat(64), created_at: '2026-11-02T12:00:00.123456+00:00',
})

test('Rows come back in pages until an empty one, each page after the last ID', async () => {
  const all = Array.from({ length: 1001 }, (_, n) => wrap(n))
  const { api, requests } = harness(request => {
    const after = request.query.get('id')?.replace('gt.', '') ?? ''
    return { status: 200, body: all.filter(row => row.id > after).slice(0, 1000) }
  })
  assert.equal((await api.keyWraps()).length, 1001)
  assert.equal(requests.length, 3)
  assert.equal(requests[0].query.get('order'), 'id.asc')
  assert.equal(requests[0].query.get('select'), 'id,kind,version_no,v,iv,wrapped,created_at')
  assert.equal(requests[1].query.get('id'), `gt.${all[999].id}`)
})

test('A row in the wrong shape, or out of order, is refused', async () => {
  const pages = (body: unknown[]) => harness(request => ({ status: 200, body: request.query.has('id') ? [] : body })).api
  await assert.rejects(pages([{ ...wrap(1), kind: 'admin' }]).keyWraps(), ServerError)
  await assert.rejects(pages([{ ...wrap(1), user_id: USER_ID }]).keyWraps(), ServerError)
  await assert.rejects(pages([wrap(2), wrap(1)]).keyWraps(), ServerError)
  await assert.rejects(harness(() => ({ status: 401, body: { message: 'JWT expired' } })).api.keyWraps(), ServerError)
})

test('Saving a row: saved, taken by a unique rule, or an error', async () => {
  const { created_at: _time, ...row } = wrap(1)
  const save = (reply: Reply) => harness(() => reply).api.addKeyWrap(row as Parameters<ReturnType<typeof supabaseApi>['addKeyWrap']>[0])
  assert.equal(await save({ status: 201 }), 'saved')
  assert.equal(await save({ status: 409, body: { code: '23505', message: 'duplicate key value violates unique constraint' } }), 'taken')
  await assert.rejects(save({ status: 400, body: { code: '23514', message: 'violates check constraint' } }), ServerError)
  await assert.rejects(save('network-error'), ServerError)
})

test('The two functions get their arguments by name, and a refused proof is false', async () => {
  const { api, requests } = harness(request => (request.path.endsWith('delete_old_key_wraps') ? { status: 200, body: 2 } : { status: 204 }))
  assert.equal(await api.deleteOldKeyWraps('password'), 2)
  assert.deepEqual(JSON.parse(requests[0].body), { only_kind: 'password' })
  assert.equal(await api.setRecoveryProof('d'.repeat(64)), true)
  assert.deepEqual(JSON.parse(requests[1].body), { new_proof_hash_hex: 'd'.repeat(64), current_proof_hex: null })

  const refused = harness(() => ({ status: 400, body: { code: 'P0001', message: 'Bad recovery proof.' } })).api
  assert.equal(await refused.setRecoveryProof('d'.repeat(64), 'e'.repeat(64)), false)
  await assert.rejects(harness(() => ({ status: 500, body: { code: 'XX000' } })).api.setRecoveryProof('d'.repeat(64)), ServerError)
})

test('Looking for records stops at the first table with any', async () => {
  const { api, requests } = harness(request => ({ status: 200, body: request.path.endsWith('settings_versions') ? [{ id: USER_ID }] : [] }))
  assert.equal(await api.hasRecords(), true)
  assert.deepEqual(requests.map(r => r.path), ['/rest/v1/week_versions', '/rest/v1/settings_versions'])
})

test('Signing out ends every session, and never throws, even offline', async () => {
  const online = harness(request => (request.path === '/auth/v1/token' ? { status: 200, body: session() } : { status: 204 }))
  await online.api.signIn('kman@example.com', TOKEN)
  await online.api.signOut()
  assert.equal(online.requests[1].path, '/auth/v1/logout')
  assert.equal(online.requests[1].query.get('scope'), 'global')

  const offline = harness(request => (request.path === '/auth/v1/token' ? { status: 200, body: session() } : 'network-error'))
  await offline.api.signIn('kman@example.com', TOKEN)
  await offline.api.signOut()
  // Signed out here anyway, so the next call goes out without the session's token.
  await assert.rejects(offline.api.keyWraps(), ServerError)
  assert.ok(!(offline.requests.at(-1)?.headers.get('authorization') ?? '').startsWith('Bearer eyJ'))
})

// ---------------------------------------------------------------------------
// Weeks, the audit log and the football tables (step 9)
// ---------------------------------------------------------------------------

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
const CT = 'B'.repeat(1388) // the smallest ciphertext the database takes
const weekRow = (n: number, change: Record<string, unknown> = {}) => ({
  id: id(n), season: 2026, competition: 'PL', period: 'MW11', version_no: n + 1, v: 1, iv: 'A'.repeat(16), ct: CT,
  created_at: '2026-11-02T12:00:00.123456+00:00', ...change,
})
const auditRow = (seq: number) => ({
  id: id(seq), seq, prev_hash: seq === 1 ? null : 'c'.repeat(64), v: 1, iv: 'A'.repeat(16), ct: CT, created_at: '2026-11-02T12:00:00+00:00',
})
const WEEK_COLUMNS = 'id,season,competition,period,version_no,v,iv,ct,created_at'

test("each week's newest version comes from the view, in pages", async () => {
  const all = Array.from({ length: 1001 }, (_, n) => weekRow(n, { period: `MW${(n % 38) + 1}`, season: 2026 + Math.floor(n / 38) }))
  const { api, requests } = harness(request => {
    const after = request.query.get('id')?.replace('gt.', '') ?? ''
    return { status: 200, body: all.filter(row => row.id > after).slice(0, 1000) }
  })
  assert.equal((await api.latestWeekVersions()).length, 1001)
  assert.equal(requests[0]?.path, '/rest/v1/latest_week_versions')
  assert.equal(requests[0]?.query.get('select'), WEEK_COLUMNS)
  assert.equal(requests[0]?.query.get('order'), 'id.asc')
  assert.equal(requests[1]?.query.get('id'), `gt.${all[999]?.id}`)
})

test("one week's versions: asked for by week, and a row from another week is refused", async () => {
  const { api, requests } = harness(request => ({ status: 200, body: request.query.has('id') ? [] : [weekRow(1), weekRow(2)] }))
  assert.equal((await api.weekVersions({ season: 2026, competition: 'PL', period: 'MW11' })).length, 2)
  assert.equal(requests[0]?.path, '/rest/v1/week_versions')
  assert.deepEqual(['season', 'competition', 'period'].map(name => requests[0]?.query.get(name)), ['eq.2026', 'eq.PL', 'eq.MW11'])
  for (const other of [{ period: 'MW12' }, { season: 2027 }, { competition: 'UCL', period: 'MD4' }]) {
    const stray = harness(request => ({ status: 200, body: request.query.has('id') ? [] : [weekRow(1), weekRow(2, other)] })).api
    await assert.rejects(stray.weekVersions({ season: 2026, competition: 'PL', period: 'MW11' }), ServerError, JSON.stringify(other))
  }
})

test('the last audit entry: the highest number, or null when there is none', async () => {
  const { api, requests } = harness(() => ({ status: 200, body: [auditRow(7)] }))
  assert.equal((await api.lastAuditEntry())?.seq, 7)
  assert.equal(requests[0]?.path, '/rest/v1/audit_entries')
  assert.equal(requests[0]?.query.get('order'), 'seq.desc')
  assert.equal(requests[0]?.query.get('limit'), '1')
  assert.equal(requests[0]?.query.get('select'), 'id,seq,prev_hash,v,iv,ct,created_at')
  assert.equal(await harness(() => ({ status: 200, body: [] })).api.lastAuditEntry(), null)
  await assert.rejects(harness(() => ({ status: 200, body: [{ ...auditRow(2), prev_hash: null }] })).api.lastAuditEntry(), ServerError)
  await assert.rejects(harness(() => ({ status: 200, body: [auditRow(2), auditRow(1)] })).api.lastAuditEntry(), ServerError)
  await assert.rejects(harness(() => ({ status: 500, body: {} })).api.lastAuditEntry(), ServerError)
})

test('saving a week with its audit entry sends every argument by name', async () => {
  const { created_at: _week, ...week } = weekRow(2)
  const { created_at: _audit, ...audit } = auditRow(3)
  const save = (reply: Reply) => {
    const { api, requests } = harness(() => reply)
    return { result: api.saveWeekWithAudit(week, audit), requests }
  }
  const ok = save({ status: 204 })
  assert.equal(await ok.result, 'saved')
  assert.equal(ok.requests[0]?.path, '/rest/v1/rpc/save_week_with_audit')
  assert.deepEqual(JSON.parse(ok.requests[0]?.body ?? '{}'), {
    week_id: week.id, week_season: 2026, week_competition: 'PL', week_period: 'MW11', week_version_no: 3, week_v: 1, week_iv: week.iv, week_ct: CT,
    audit_id: audit.id, audit_seq: 3, audit_prev_hash: 'c'.repeat(64), audit_v: 1, audit_iv: audit.iv, audit_ct: CT,
  })
  assert.equal(await save({ status: 409, body: { code: '23505', message: 'duplicate key value violates unique constraint' } }).result, 'taken')
  await assert.rejects(save({ status: 400, body: { code: '23514', message: 'violates check constraint' } }).result, ServerError)
  await assert.rejects(save('network-error').result, ServerError)
})

test('the football tables: their columns and filters, and every row checked', async () => {
  const team = { id: 9001, name: 'Manchester City FC', short_name: 'Man City', code: 'MCI' }
  const fixture = {
    id: 900_001, competition: 'PL', season: 2026, period: 'MW11', tie_leg: null, kickoff: '2026-11-07T17:30:00+00:00',
    home_team_id: 9001, away_team_id: 9002, status: 'scheduled', minute: null, home_90: null, away_90: null,
    home_ht: null, away_ht: null, home_et: null, away_et: null, home_pens: null, away_pens: null,
  }
  const status = { last_attempt_at: '2026-11-07T17:31:02.123456+00:00', last_success_at: null }
  const { api, requests } = harness(request => {
    if (request.query.has('id')) return { status: 200, body: [] }
    if (request.path.endsWith('/teams')) return { status: 200, body: [team] }
    if (request.path.endsWith('/fixtures')) return { status: 200, body: [fixture] }
    return { status: 200, body: [status] }
  })
  assert.deepEqual(await api.teams(), [team])
  assert.equal(requests[0]?.query.get('select'), 'id,name,short_name,code')
  assert.deepEqual(await api.fixtures(2026), [fixture])
  const fixtureRequest = requests.find(request => request.path === '/rest/v1/fixtures')
  assert.equal(fixtureRequest?.query.get('season'), 'eq.2026')
  assert.equal(fixtureRequest?.query.get('select'),
    'id,competition,season,period,tie_leg,kickoff,home_team_id,away_team_id,status,minute,home_90,away_90,home_ht,away_ht,home_et,away_et,home_pens,away_pens')
  assert.deepEqual(await api.syncStatus(), status)
  assert.equal(requests.at(-1)?.path, '/rest/v1/sync_status')
  assert.equal(requests.at(-1)?.query.get('select'), 'last_attempt_at,last_success_at')

  const answering = (body: unknown[]) => harness(request => ({ status: 200, body: request.query.has('id') ? [] : body })).api
  await assert.rejects(answering([{ ...team, code: 'mci' }]).teams(), ServerError)
  await assert.rejects(answering([{ ...fixture, status: 'FINISHED' }]).fixtures(2026), ServerError)
  await assert.rejects(answering([{ ...fixture, kickoff: '2026-02-30T17:30:00+00:00' }]).fixtures(2026), ServerError)
  for (const body of [[], [status, status], [{ ...status, last_success_at: 'never' }]]) {
    await assert.rejects(answering(body).syncStatus(), ServerError, JSON.stringify(body))
  }
})
