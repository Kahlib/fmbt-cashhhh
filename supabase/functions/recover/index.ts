// FMBT Cashhhh: the recover server function (fmbt-security, sections 1 and 6).
//
// Forgot password, step 2. The browser sends the email, the recovery proof
// made from the recovery key, and the login token made from the new
// password. This checks the proof with recovery_check, and on a match sets
// the account's password to the new login token. Supabase then signs out
// every session the account had.
//
// The rules it follows:
//   - Every failure gets the same answer, so nobody can learn whether an
//     email has an account or what went wrong.
//   - It logs what happened, never the email, the proof or the token.
//   - Its secret key is the one named "recover", which Supabase hands every
//     function in SUPABASE_SECRET_KEYS. Nobody copies it anywhere.
//   - JWT verification is off, because Supabase's check doesn't understand
//     the new keys and the people calling this are signed out anyway. It
//     checks everything itself instead.
//
// Supabase runs this file (with Deno). Paste the whole file into the
// dashboard's editor to deploy it. tests/recover-function.test.ts runs the
// same code in Node against a fake Supabase.

// Only these pages may read the answer. Anyone can still send a request,
// but without a proof from a real recovery key it gets nowhere.
const ALLOWED_ORIGINS = new Set(['https://fmbtcashhhh.com', 'http://localhost:5173'])

// Three short fields fit easily in 2 KB, so anything bigger is junk.
const MAX_BODY_BYTES = 2048

const HEX_64 = /^[0-9a-f]{64}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export type Env = { supabaseUrl: string; secretKey: string }
type Input = { email: string; proof: string; loginToken: string }

// Reads the function's settings. Returns null if anything is missing or the
// wrong kind of key, so the function then refuses everything.
export function readEnv(get: (name: string) => string | undefined): Env | null {
  const supabaseUrl = get('SUPABASE_URL')
  let secretKey: unknown
  try {
    secretKey = (JSON.parse(get('SUPABASE_SECRET_KEYS') ?? '{}') as Record<string, unknown>).recover
  } catch {
    secretKey = undefined
  }
  if (typeof supabaseUrl !== 'string' || !supabaseUrl.startsWith('https://')) return null
  if (typeof secretKey !== 'string' || !secretKey.startsWith('sb_secret_')) return null
  return { supabaseUrl, secretKey }
}

// Answers one request. `env` and `fetchFn` are passed in so the tests can
// use a fake Supabase.
export async function handle(request: Request, env: Env | null, fetchFn: typeof fetch = fetch): Promise<Response> {
  const cors = corsHeaders(request.headers.get('Origin'))
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors })
  if (request.method !== 'POST') return answer(405, { error: 'Use POST.' }, cors)
  if (env === null) {
    console.error('recover: SUPABASE_URL or the secret key named "recover" is missing')
    return failed(cors)
  }

  const input = await readInput(request)
  if (input === null) return failed(cors)

  try {
    const account = await recoveryCheck(env, input, fetchFn)
    if (account === null) return failed(cors)
    if (!(await setPassword(env, account, input.loginToken, fetchFn))) return failed(cors)
    console.log('recover: a password was reset')
    return answer(200, { ok: true }, cors)
  } catch {
    console.error('recover: Supabase could not be reached')
    return failed(cors)
  }
}

// The body must be JSON with exactly these three fields, in these shapes.
async function readInput(request: Request): Promise<Input | null> {
  const text = await readCapped(request, MAX_BODY_BYTES)
  if (text === null) return null
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null
  const { email, proof, loginToken, ...extra } = body as Record<string, unknown>
  if (Object.keys(extra).length > 0) return null
  if (typeof email !== 'string' || email.length < 3 || email.length > 320 || !email.includes('@')) return null
  if (typeof proof !== 'string' || !HEX_64.test(proof)) return null
  if (typeof loginToken !== 'string' || !HEX_64.test(loginToken)) return null
  return { email, proof, loginToken }
}

// Reads the body, stopping as soon as it passes the size limit, so a huge
// request can't tie the function up.
async function readCapped(request: Request, maxBytes: number): Promise<string | null> {
  if (request.body === null) return ''
  const reader = request.body.getReader()
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

// Asks the database whether the proof is right. It returns the account's ID,
// or null for every kind of failure, and counts wrong tries (5 a day).
async function recoveryCheck(env: Env, input: Input, fetchFn: typeof fetch): Promise<string | null> {
  const response = await fetchFn(`${env.supabaseUrl}/rest/v1/rpc/recovery_check`, {
    method: 'POST',
    headers: serverHeaders(env),
    body: JSON.stringify({ p_email: input.email, p_proof_hex: input.proof }),
  })
  if (!response.ok) {
    console.error(`recover: recovery_check answered ${response.status}`)
    return null
  }
  const account: unknown = await response.json()
  return typeof account === 'string' && UUID.test(account) ? account : null
}

// Sets the new login token as the account's password, through Supabase's
// admin API. That also signs out every session the account had.
async function setPassword(env: Env, account: string, loginToken: string, fetchFn: typeof fetch): Promise<boolean> {
  const response = await fetchFn(`${env.supabaseUrl}/auth/v1/admin/users/${account}`, {
    method: 'PUT',
    headers: serverHeaders(env),
    body: JSON.stringify({ password: loginToken }),
  })
  // The response describes the account, so only its status gets logged.
  if (!response.ok) console.error(`recover: the password change answered ${response.status}`)
  return response.ok
}

// New-style secret keys go in the apikey header only, never as a Bearer token.
function serverHeaders(env: Env): Record<string, string> {
  return { apikey: env.secretKey, 'Content-Type': 'application/json' }
}

// CORS headers, so the browser lets our pages read the answer. Any other
// page gets none, and its browser hides the answer from it.
function corsHeaders(origin: string | null): Record<string, string> {
  const headers: Record<string, string> = { Vary: 'Origin' }
  if (origin !== null && ALLOWED_ORIGINS.has(origin)) {
    headers['Access-Control-Allow-Origin'] = origin
    headers['Access-Control-Allow-Methods'] = 'POST, OPTIONS'
    headers['Access-Control-Allow-Headers'] = 'apikey, content-type'
    headers['Access-Control-Max-Age'] = '600'
  }
  return headers
}

function answer(status: number, body: unknown, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  })
}

// The one answer every failure gets.
function failed(cors: Record<string, string>): Response {
  return answer(400, { error: 'Recovery failed.' }, cors)
}

// Supabase runs this part. `Deno` only exists there, so the tests skip it.
type DenoLike = {
  serve(handler: (request: Request) => Promise<Response>): unknown
  env: { get(name: string): string | undefined }
}
const deno = (globalThis as unknown as { Deno?: DenoLike }).Deno
if (deno !== undefined) {
  const env = readEnv(name => deno.env.get(name))
  deno.serve(request => handle(request, env))
}
