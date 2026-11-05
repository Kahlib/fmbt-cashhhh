// A stand-in for Supabase's API in front of a real copy of our tables, for
// the sync function's tests. The tables come from the migrations, run in
// PGlite (PostgreSQL 17) on top of tests/supabase-stand-in.sql, so every
// rule they have applies: check constraints, foreign keys and grants.
//
// It understands only the requests the sync function makes: reads with
// filters, updates with filters, and upserts on `id`. It runs each one as
// service_role, the role Supabase gives a secret key, and refuses any other
// key. Anything else throws, so the tests notice.
import { PGlite } from '@electric-sql/pglite'
import { readdirSync, readFileSync } from 'node:fs'

export async function startDatabase(): Promise<PGlite> {
  const db = new PGlite()
  await db.exec(readFileSync(new URL('./supabase-stand-in.sql', import.meta.url), 'utf8'))
  const migrations = new URL('../supabase/migrations/', import.meta.url)
  for (const name of readdirSync(migrations).filter(name => name.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(new URL(name, migrations), 'utf8'))
  }
  // Supabase's databases run in UTC, so times come back as +00:00.
  await db.exec("set timezone = 'UTC'")
  return db
}

// Empties the football tables between tests. Run as the owner, since the
// sync's own role can't delete.
export async function resetDatabase(db: PGlite): Promise<void> {
  await db.exec('delete from public.fixtures; delete from public.teams; update public.sync_status set last_attempt_at = null, last_success_at = null')
}

const NAME = /^[a-z_0-9]+$/
const COMPARE: Record<string, string> = { eq: '=', lt: '<', lte: '<=', gt: '>', gte: '>=' }

function name(value: string): string {
  if (!NAME.test(value)) throw new Error(`the fake API doesn't take the name ${value}`)
  return value
}

// A value as a quoted SQL literal, which Postgres turns into the column's
// type, as it does for Supabase's API.
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`

// Turns one request into SQL and runs it. Returns what Supabase's API would.
export async function answerApi(db: PGlite, secretKey: string, url: URL, init: RequestInit): Promise<Response> {
  const headers = new Headers(init.headers)
  if (headers.get('apikey') !== secretKey) return Response.json({ message: 'Invalid API key' }, { status: 401 })
  const table = name(url.pathname.replace(/^\/rest\/v1\//, ''))
  const method = init.method ?? 'GET'
  const prefer = headers.get('prefer') ?? ''

  const where: string[] = []
  let select = '*'
  let limit = ''
  let onConflict: string | null = null
  for (const [key, value] of url.searchParams) {
    if (key === 'select') select = value.split(',').map(name).join(', ')
    else if (key === 'limit') limit = ` limit ${Number.parseInt(value, 10)}`
    else if (key === 'on_conflict') onConflict = name(value)
    else {
      const column = name(key)
      const [operator] = value.split('.', 1)
      const operand = value.slice(operator.length + 1)
      if (Object.hasOwn(COMPARE, operator)) {
        where.push(`t.${column} ${COMPARE[operator]} ${literal(operand)}`)
      } else if (operator === 'is' && operand === 'null') {
        where.push(`t.${column} is null`)
      } else if (operator === 'not' && operand.startsWith('in.(') && operand.endsWith(')')) {
        const items = operand.slice(4, -1).split(',').map(literal)
        where.push(`t.${column} not in (${items.join(', ')})`)
      } else {
        throw new Error(`the fake API doesn't understand ${key}=${value}`)
      }
    }
  }
  const filter = where.length > 0 ? ` where ${where.join(' and ')}` : ''
  const body: unknown = init.body === undefined || init.body === null ? undefined : JSON.parse(String(init.body))

  let sql: string
  if (method === 'GET') {
    sql = `select coalesce(json_agg(found), '[]'::json) as rows from (select ${select} from public.${table} t${filter}${limit}) found`
  } else if (method === 'PATCH' && typeof body === 'object' && body !== null && !Array.isArray(body)) {
    const columns = Object.keys(body).map(name)
    const set = columns.map(column => `${column} = r.${column}`).join(', ')
    sql = `with changed as (update public.${table} t set ${set} from json_populate_record(null::public.${table}, ${literal(JSON.stringify(body))}::json) r${filter} returning t.*)
      select coalesce(json_agg(changed), '[]'::json) as rows from changed`
  } else if (method === 'POST' && Array.isArray(body) && onConflict !== null && prefer.includes('resolution=merge-duplicates')) {
    const columns = Object.keys(body[0] as object).map(name)
    const list = columns.join(', ')
    const update = columns.map(column => `${column} = excluded.${column}`).join(', ')
    sql = `with saved as (insert into public.${table} (${list}) select ${list} from json_populate_recordset(null::public.${table}, ${literal(JSON.stringify(body))}::json)
      on conflict (${onConflict}) do update set ${update} returning *) select coalesce(json_agg(saved), '[]'::json) as rows from saved`
  } else {
    throw new Error(`the fake API doesn't understand ${method} ${url.pathname}`)
  }

  try {
    const rows = await db.transaction(async tx => {
      await tx.exec('set local role service_role')
      const result = await tx.query<{ rows: unknown }>(sql)
      return result.rows[0].rows
    })
    if (method === 'GET' || prefer.includes('return=representation')) return Response.json(rows)
    return new Response(null, { status: method === 'POST' ? 201 : 204 })
  } catch (error) {
    // Postgres's error, in the shape Supabase's API sends it.
    const problem = error as { code?: string; message?: string }
    const status = problem.code === '42501' ? 403 : problem.code === '23503' || problem.code === '23505' ? 409 : 400
    return Response.json({ code: problem.code, message: problem.message, details: null, hint: null }, { status })
  }
}
