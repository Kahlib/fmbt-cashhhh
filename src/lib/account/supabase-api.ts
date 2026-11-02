// The real AccountApi: the account code's server calls, made with the
// Supabase client (fmbt-security, sections 3 and 6).
//
// Every answer becomes one of the few results the flows understand, and
// anything unexpected becomes a ServerError, whose message never repeats
// what the server said. Every row that comes back is checked before use.
import type { AuthError, SupabaseClient } from '@supabase/supabase-js'
import { ServerError, type AccountApi, type AuthResult, type Rows, type SaveResult, type Stored, type Table } from './api.ts'
import { columnNames, isStoredRow } from './rows.ts'
import type { SupabaseConfig } from '../config.ts'

// Rows come back this many at a time.
const PAGE_SIZE = 1000

const OK: AuthResult = { ok: true }
const UNAVAILABLE: AuthResult = { ok: false, problem: 'unavailable' }

// `client` is the app's one client from supabase.ts. The tests pass in a
// client and a fetch that talk to a fake server.
export function supabaseApi(
  client: SupabaseClient, config: SupabaseConfig, fetchFn: typeof fetch = (input, init) => fetch(input, init),
): AccountApi {
  return {
    async signUp(email, loginToken) {
      try {
        const { data, error } = await client.auth.signUp({ email, password: loginToken })
        if (error !== null) return authProblem(error)
        // "Confirm email" is off, so a new account is signed in straight away.
        return data.session === null ? UNAVAILABLE : OK
      } catch {
        return UNAVAILABLE
      }
    },

    async signIn(email, loginToken) {
      try {
        const { error } = await client.auth.signInWithPassword({ email, password: loginToken })
        return error === null ? OK : authProblem(error)
      } catch {
        return UNAVAILABLE
      }
    },

    async changePassword(currentLoginToken, newLoginToken) {
      try {
        const { error } = await client.auth.updateUser({ password: newLoginToken, current_password: currentLoginToken })
        return error === null ? OK : authProblem(error)
      } catch {
        return UNAVAILABLE
      }
    },

    async recover(email, proofHex, newLoginToken) {
      let response: Response
      try {
        // Plain fetch with just these two headers, which are all the
        // function's CORS answer allows.
        response = await fetchFn(`${config.url}/functions/v1/recover`, {
          method: 'POST',
          headers: { apikey: config.publishableKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, proof: proofHex, loginToken: newLoginToken }),
        })
      } catch {
        throw new ServerError()
      }
      // The function answers 400 to every kind of refusal, so that's all
      // anyone can learn from it.
      if (response.status === 400) return false
      const body: unknown = response.status === 200 ? await response.json().catch(() => null) : null
      if (typeof body === 'object' && body !== null && (body as { ok?: unknown }).ok === true) return true
      throw new ServerError()
    },

    async signOut() {
      try {
        // Every session the account has, which is Supabase's default and the
        // plan's choice: another open tab signs out within 15 minutes.
        // supabase-js forgets this tab's session even if the server can't
        // be reached.
        await client.auth.signOut()
      } catch {
        // Nothing to do: the session only ever lived in this tab's memory.
      }
    },

    keyWraps: () => allRows(client, 'key_wraps'),
    addKeyWrap: row => insert(client, 'key_wraps', row),

    async deleteOldKeyWraps(kind) {
      const { data, error } = await client.rpc('delete_old_key_wraps', { only_kind: kind })
      if (error !== null || typeof data !== 'number') throw new ServerError()
      return data
    },

    async setRecoveryProof(newProofHashHex, currentProofHex) {
      const { error } = await client.rpc('set_recovery_proof', {
        new_proof_hash_hex: newProofHashHex,
        current_proof_hex: currentProofHex ?? null,
      })
      if (error === null) return true
      // P0001 is the function refusing on purpose ("Bad recovery proof.").
      if (error.code === 'P0001') return false
      throw new ServerError()
    },

    records: table => allRows(client, table),
    addRecord: (table, row) => insert(client, table, row),

    async hasRecords() {
      for (const table of ['week_versions', 'settings_versions', 'audit_entries'] as const) {
        const { data, error } = await client.from(table).select('id').limit(1)
        if (error !== null || !Array.isArray(data)) throw new ServerError()
        if (data.length > 0) return true
      }
      return false
    },
  }
}

// Sorts a sign-in system error into the answers the flows know.
function authProblem(error: AuthError): AuthResult {
  const code = error.code ?? ''
  if (error.status === 429 || code === 'over_request_rate_limit') return { ok: false, problem: 'too-many-tries' }
  if (code === 'invalid_credentials' || code === 'current_password_invalid' || code === 'current_password_required') {
    return { ok: false, problem: 'wrong' }
  }
  if (code === 'user_already_exists' || code === 'email_exists') return { ok: false, problem: 'exists' }
  // The invite check's own refusal, from private.before_user_created.
  if (error.status === 403 && error.message.includes('invite')) return { ok: false, problem: 'not-invited' }
  return UNAVAILABLE
}

// Every row of one table, in pages ordered by ID. Each page starts after the
// last ID of the one before, and the loop stops at an empty page, so no
// row-limit setting on the server can cut the list short.
async function allRows<T extends Table>(client: SupabaseClient, table: T): Promise<Stored<Rows[T]>[]> {
  const rows: Stored<Rows[T]>[] = []
  const columns = [...columnNames(table), 'created_at'].join(',')
  for (;;) {
    const last = rows.at(-1)
    let query = client.from(table).select(columns).order('id').limit(PAGE_SIZE)
    if (last !== undefined) query = query.gt('id', last.id)
    const { data, error } = await query
    const page: unknown = data
    if (error !== null || !Array.isArray(page)) throw new ServerError()
    if (page.length === 0) return rows
    for (const row of page) {
      // Each ID must come after the last, or the server isn't answering what
      // was asked, and the loop could repeat rows forever.
      if (!isStoredRow(table, row) || (rows.length > 0 && row.id <= rows[rows.length - 1].id)) throw new ServerError()
      rows.push(row)
    }
  }
}

async function insert(client: SupabaseClient, table: Table, row: Rows[Table]): Promise<SaveResult> {
  // The client has no table types, so it's handed a plain object.
  const { error } = await client.from(table).insert(row as Record<string, unknown>)
  if (error === null) return 'saved'
  // 23505 is Postgres's "unique violation": that ID or version number is taken.
  if (error.code === '23505') return 'taken'
  throw new ServerError()
}
