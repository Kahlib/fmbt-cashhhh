// Tests for supabase/functions/recover/index.ts, run in Node against a fake
// Supabase. They check the rules in fmbt-security section 6: one answer for
// every failure, nothing secret in the logs, and the secret key sent only
// where it belongs. scripts/dev-attack-check.mjs then tries the real thing
// on the dev project.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { type Env, handle, readEnv } from '../supabase/functions/recover/index.ts'

// Made-up values in the right shapes. Not a real project or account.
const ENV: Env = { supabaseUrl: 'https://abcdefghijklmnopqrst.supabase.co', secretKey: 'sb_secret_' + 'S'.repeat(31) }
const EMAIL = 'friend@example.com'
const PROOF = 'a'.repeat(64)
const TOKEN = 'b'.repeat(64)
const ACCOUNT = '6f1c7a3e-1b2c-4d5e-8f90-1234567890ab'
const GOOD = { email: EMAIL, proof: PROOF, loginToken: TOKEN }

type Call = { url: string; method: string; headers: Headers; body: unknown }

// A fake Supabase. It answers recovery_check with `check` and the password
// change with `updateStatus`, and records every request it gets.
function fakeSupabase(options: { check?: unknown; checkStatus?: number; updateStatus?: number; down?: boolean } = {}) {
  const calls: Call[] = []
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    if (options.down) throw new TypeError('fetch failed')
    const url = String(input)
    calls.push({ url, method: init?.method ?? 'GET', headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) })
    if (url.endsWith('/rest/v1/rpc/recovery_check')) return Response.json(options.check ?? null, { status: options.checkStatus ?? 200 })
    return Response.json({ id: ACCOUNT, email: EMAIL }, { status: options.updateStatus ?? 200 })
  }) as typeof fetch
  return { calls, fetchFn }
}

// A request the way the app will send it.
function request(body: unknown, { method = 'POST', origin = 'https://fmbtcashhhh.com' } = {}) {
  return new Request('https://abcdefghijklmnopqrst.supabase.co/functions/v1/recover', {
    method,
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    ...(method === 'POST' ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  })
}

test('the right proof sets the new password, with the secret key only in the apikey header', async () => {
  const { calls, fetchFn } = fakeSupabase({ check: ACCOUNT })
  const response = await handle(request(GOOD), ENV, fetchFn)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true })

  assert.equal(calls.length, 2)
  assert.equal(calls[0].url, `${ENV.supabaseUrl}/rest/v1/rpc/recovery_check`)
  assert.deepEqual(calls[0].body, { p_email: EMAIL, p_proof_hex: PROOF })
  assert.equal(calls[1].url, `${ENV.supabaseUrl}/auth/v1/admin/users/${ACCOUNT}`)
  assert.equal(calls[1].method, 'PUT')
  assert.deepEqual(calls[1].body, { password: TOKEN })
  for (const call of calls) {
    assert.equal(call.headers.get('apikey'), ENV.secretKey)
    assert.equal(call.headers.get('authorization'), null)
  }
})

test('every failure gets exactly the same answer', async () => {
  const cases: Array<[string, Request, Env | null, ReturnType<typeof fakeSupabase>]> = [
    ['wrong proof', request(GOOD), ENV, fakeSupabase({ check: null })],
    ['check returns junk', request(GOOD), ENV, fakeSupabase({ check: 'not-an-id' })],
    ['check refused', request(GOOD), ENV, fakeSupabase({ checkStatus: 401 })],
    ['password change refused', request(GOOD), ENV, fakeSupabase({ check: ACCOUNT, updateStatus: 422 })],
    ['Supabase down', request(GOOD), ENV, fakeSupabase({ down: true })],
    ['no secret key', request(GOOD), null, fakeSupabase()],
    ['not JSON', request('not json'), ENV, fakeSupabase()],
    ['a list', request([GOOD]), ENV, fakeSupabase()],
    ['missing field', request({ email: EMAIL, proof: PROOF }), ENV, fakeSupabase()],
    ['extra field', request({ ...GOOD, admin: true }), ENV, fakeSupabase()],
    ['capital hex', request({ ...GOOD, proof: PROOF.toUpperCase() }), ENV, fakeSupabase()],
    ['short token', request({ ...GOOD, loginToken: 'b'.repeat(63) }), ENV, fakeSupabase()],
    ['not an email', request({ ...GOOD, email: 'nobody' }), ENV, fakeSupabase()],
    ['too long an email', request({ ...GOOD, email: 'x'.repeat(400) + '@example.com' }), ENV, fakeSupabase()],
    ['over 2 KB', request(JSON.stringify(GOOD) + ' '.repeat(3000)), ENV, fakeSupabase({ check: ACCOUNT })],
  ]
  for (const [name, req, env, fake] of cases) {
    const response = await handle(req, env, fake.fetchFn)
    assert.equal(response.status, 400, name)
    assert.equal(await response.text(), '{"error":"Recovery failed."}', name)
  }
  // From "no secret key" on, nothing should even have reached the database.
  for (const [name, , , fake] of cases.slice(5)) assert.equal(fake.calls.length, 0, name)
})

test('junk never reaches the database, and a wrong proof never changes a password', async () => {
  const junk = fakeSupabase()
  await handle(request({ ...GOOD, proof: 'zz' }), ENV, junk.fetchFn)
  assert.equal(junk.calls.length, 0)

  const wrong = fakeSupabase({ check: null })
  await handle(request(GOOD), ENV, wrong.fetchFn)
  assert.equal(wrong.calls.length, 1, 'only recovery_check, never the password change')
})

test('only FMBTCashhhh.com and localhost:5173 get permission to read the answer', async () => {
  const { fetchFn } = fakeSupabase({ check: ACCOUNT })
  for (const origin of ['https://fmbtcashhhh.com', 'http://localhost:5173']) {
    const preflight = await handle(request(null, { method: 'OPTIONS', origin }), ENV, fetchFn)
    assert.equal(preflight.status, 204)
    assert.equal(preflight.headers.get('access-control-allow-origin'), origin)
  }
  for (const origin of ['https://evil.example', 'https://fmbtcashhhh.com.evil.example', 'null']) {
    const preflight = await handle(request(null, { method: 'OPTIONS', origin }), ENV, fetchFn)
    assert.equal(preflight.headers.get('access-control-allow-origin'), null, origin)
    const answer = await handle(request(GOOD, { origin }), ENV, fakeSupabase({ check: ACCOUNT }).fetchFn)
    assert.equal(answer.headers.get('access-control-allow-origin'), null, origin)
  }
})

test('it only takes POST, and its answers are never cached', async () => {
  const get = await handle(request(null, { method: 'GET' }), ENV, fakeSupabase().fetchFn)
  assert.equal(get.status, 405)
  const answer = await handle(request(GOOD), ENV, fakeSupabase({ check: ACCOUNT }).fetchFn)
  assert.equal(answer.headers.get('cache-control'), 'no-store')
  assert.equal(answer.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(answer.headers.get('vary'), 'Origin')
})

test('the logs never hold the email, the proof, the token or the secret key', async t => {
  const log = t.mock.method(console, 'log', () => {})
  const error = t.mock.method(console, 'error', () => {})
  await handle(request(GOOD), ENV, fakeSupabase({ check: ACCOUNT }).fetchFn)
  await handle(request(GOOD), ENV, fakeSupabase({ checkStatus: 500 }).fetchFn)
  await handle(request(GOOD), ENV, fakeSupabase({ check: ACCOUNT, updateStatus: 422 }).fetchFn)
  await handle(request(GOOD), ENV, fakeSupabase({ down: true }).fetchFn)
  await handle(request(GOOD), null, fakeSupabase().fetchFn)
  const logged = [...log.mock.calls, ...error.mock.calls].map(call => call.arguments.map(String).join(' ')).join('\n')
  assert.ok(logged.length > 0, 'something should have been logged')
  for (const secret of [EMAIL, PROOF, TOKEN, ENV.secretKey, ACCOUNT]) {
    assert.ok(!logged.includes(secret), `the log mentions ${secret.slice(0, 12)}…`)
  }
})

test('it uses the secret key named "recover", and refuses to run without one', () => {
  const settings = (values: Record<string, string>) => (name: string) => values[name]
  const keys = JSON.stringify({ default: 'sb_secret_default', recover: 'sb_secret_recover' })
  assert.deepEqual(readEnv(settings({ SUPABASE_URL: ENV.supabaseUrl, SUPABASE_SECRET_KEYS: keys })),
    { supabaseUrl: ENV.supabaseUrl, secretKey: 'sb_secret_recover' })
  const refused: Array<Record<string, string>> = [
    { SUPABASE_URL: ENV.supabaseUrl, SUPABASE_SECRET_KEYS: JSON.stringify({ default: 'sb_secret_default' }) },
    { SUPABASE_URL: ENV.supabaseUrl, SUPABASE_SECRET_KEYS: JSON.stringify({ recover: 'sb_publishable_x' }) },
    { SUPABASE_URL: ENV.supabaseUrl, SUPABASE_SECRET_KEYS: 'not json' },
    { SUPABASE_URL: ENV.supabaseUrl },
    { SUPABASE_URL: 'http://abcdefghijklmnopqrst.supabase.co', SUPABASE_SECRET_KEYS: keys },
    { SUPABASE_SECRET_KEYS: keys },
  ]
  for (const values of refused) assert.equal(readEnv(settings(values)), null, JSON.stringify(values))
})
