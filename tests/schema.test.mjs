// FMBT Cashhhh: tests that try to break the database (step 5, 26 October 2026).
// Runs every migration in supabase/migrations, oldest first, in a real
// Postgres (PGlite, PostgreSQL 17) on top of a small stand-in for what a
// fresh Supabase project already has. Then it checks every access rule from
// the outside: signed out, as you, as a friend, with a secret key, as
// Supabase's sign-up system, and as the owner.
//
// Run it with `npm run test:schema`, which `npm run check` does.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, randomUUID, createHash } from 'node:crypto';

// Stand-in for a fresh Supabase project: its roles, its permissive defaults
// and a minimal auth schema. Not part of the migration. It has its own file
// so the sync function's tests can build the same database.
const SUPABASE_STAND_IN = readFileSync(new URL('./supabase-stand-in.sql', import.meta.url), 'utf8');

// A folder runs every .sql file in it, in name order, which is date order.
// A single file still works, for running one migration on its own.
const schemaPath = process.argv[2] ?? 'supabase/migrations';
const migrations = statSync(schemaPath).isDirectory()
  ? readdirSync(schemaPath).filter(name => name.endsWith('.sql')).sort().map(name => join(schemaPath, name))
  : [schemaPath];
const db = new PGlite();
await db.exec(SUPABASE_STAND_IN);
for (const file of migrations) await db.exec(readFileSync(file, 'utf8'));

const A = randomUUID();   // the owner (app admin)
const B = randomUUID();   // a friend
await db.query('insert into auth.users (id, email) values ($1, $2), ($3, $4)',
  [A, 'owner@example.com', B, 'friend@example.com']);
await db.query('insert into private.app_admins (user_id) values ($1)', [A]);

const b64 = n => randomBytes(n).toString('base64');
const iv = () => b64(12);
const ct = (n = 1040) => b64(n);
const wrapped = () => b64(48);

// `claims` stands in for the rest of the sign-in token, such as its amr list.
async function as(role, uid, sql, params = [], claims = null) {
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [uid ?? '']);
  await db.query("select set_config('request.jwt.claims', $1, false)", [claims ? JSON.stringify({ sub: uid, ...claims }) : '']);
  if (role !== 'postgres') await db.exec(`set role ${role}`);
  try {
    const r = await db.query(sql, params);
    return { ok: true, rows: r.rows, affected: r.affectedRows ?? 0 };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    await db.exec('reset role');
  }
}

const results = [];
function check(id, name, pass, detail = '') {
  results.push({ id, name, pass, detail });
}
const denied = r => !r.ok && /permission denied/.test(r.error);
const failsWith = (r, re) => !r.ok && re.test(r.error);

// ---------- Signed out (anon) ----------
for (const [id, name, sql, params] of [
  ['T01', 'Signed out: read fixtures', 'select * from public.fixtures'],
  ['T02', 'Signed out: read week versions', 'select * from public.week_versions'],
  ['T03', 'Signed out: add a week version', 'insert into public.week_versions (id, season, competition, period, version_no, v, iv, ct) values ($1, 2026, $2, $3, 1, 1, $4, $5)', [randomUUID(), 'PL', 'MW1', iv(), ct()]],
  ['T04', 'Signed out: set a recovery proof', "select public.set_recovery_proof(repeat('a', 64))"],
  ['T05', 'Signed out: check a recovery proof', "select public.recovery_check('owner@example.com', repeat('a', 64))"],
  ['T06', 'Signed out: list invites', 'select * from public.invite_list()'],
  ['T07', 'Signed out: read the latest-versions view', 'select * from public.latest_week_versions'],
  ['T08', 'Signed out: read key wraps', 'select * from public.key_wraps'],
]) {
  const r = await as('anon', null, sql, params ?? []);
  check(id, name + ' is refused', denied(r), r.error ?? 'was allowed');
}

// ---------- Your rows vs a friend's ----------
const wk = (period = 'MW9', version = 1, extra = {}) => ({
  id: randomUUID(), season: 2026, competition: 'PL', period, version_no: version, v: 1, iv: iv(), ct: ct(), ...extra,
});
const insertWeek = (uid, w) => as('authenticated', uid,
  'insert into public.week_versions (id, season, competition, period, version_no, v, iv, ct) values ($1,$2,$3,$4,$5,$6,$7,$8)',
  [w.id, w.season, w.competition, w.period, w.version_no, w.v, w.iv, w.ct]);

let r = await insertWeek(A, wk('MW9', 1));
check('T10', 'You add a week version', r.ok, r.error);
r = await as('postgres', null, 'select user_id from public.week_versions');
check('T10b', 'The database fills in your user ID itself', r.ok && r.rows.length === 1 && r.rows[0].user_id === A);

r = await as('authenticated', A,
  'insert into public.week_versions (id, user_id, season, competition, period, version_no, v, iv, ct) values ($1,$2,2026,$3,$4,1,1,$5,$6)',
  [randomUUID(), B, 'PL', 'MW10', iv(), ct()]);
check('T11', "Adding a row under a friend's user ID is refused", denied(r), r.error);
r = await as('authenticated', A,
  'insert into public.week_versions (id, user_id, season, competition, period, version_no, v, iv, ct) values ($1,$2,2026,$3,$4,1,1,$5,$6)',
  [randomUUID(), A, 'PL', 'MW10', iv(), ct()]);
check('T12', 'The browser can\'t set user_id at all, even its own', denied(r), r.error);
r = await as('authenticated', A,
  "insert into public.week_versions (id, season, competition, period, version_no, v, iv, ct, created_at) values ($1,2026,'PL','MW10',1,1,$2,$3,'2030-01-01')",
  [randomUUID(), iv(), ct()]);
check('T13', 'The browser can\'t set created_at', denied(r), r.error);

r = await as('authenticated', B, 'select * from public.week_versions');
check('T14', "A friend sees none of your week versions", r.ok && r.rows.length === 0, r.error);
r = await as('authenticated', B, 'select * from public.latest_week_versions');
check('T15', "A friend sees none of yours through the view", r.ok && r.rows.length === 0, r.error);
r = await as('authenticated', A, 'select * from public.week_versions');
check('T16', 'You see your own', r.ok && r.rows.length === 1, r.error);

r = await as('authenticated', A, "update public.week_versions set period = 'MW8'");
check('T17', 'Editing a saved version is refused', denied(r), r.error);
r = await as('authenticated', A, 'delete from public.week_versions');
check('T18', 'Deleting a saved version is refused', denied(r), r.error);
r = await as('authenticated', A, 'truncate public.week_versions');
check('T19', 'Emptying the table is refused', denied(r), r.error);

r = await insertWeek(A, wk('MW9', 1));
check('T20', 'Two saves with the same version number: the second is refused (two-tab conflict)', failsWith(r, /duplicate key|unique/), r.error);
r = await insertWeek(A, wk('MD3', 1));
check('T21', 'A Premier League row with a Champions League stage is refused', failsWith(r, /check constraint/), r.error);
r = await insertWeek(A, wk('MW11', 1, { ct: b64(600) }));
check('T22', 'An unpadded (too small) ciphertext is refused', failsWith(r, /violates check constraint|b64_ciphertext/), r.error);
r = await insertWeek(A, wk('MW11', 1, { iv: 'short' }));
check('T23', 'A malformed IV is refused', failsWith(r, /violates check constraint|b64_iv/), r.error);

await insertWeek(A, wk('MW9', 2));
await insertWeek(A, wk('MW9', 3));
await insertWeek(B, wk('MW9', 1));
r = await as('authenticated', A, 'select period, version_no from public.latest_week_versions');
check('T24', 'The view gives only your newest version of each week', r.ok && r.rows.length === 1 && r.rows[0].version_no === 3, JSON.stringify(r.rows ?? r.error));

// ---------- Key wraps ----------
const addWrap = (uid, kind, version) => as('authenticated', uid,
  'insert into public.key_wraps (id, kind, version_no, v, iv, wrapped) values ($1,$2,$3,1,$4,$5) returning id',
  [randomUUID(), kind, version, iv(), wrapped()]);
const p1 = (await addWrap(A, 'password', 1)).rows[0].id;
const p2 = (await addWrap(A, 'password', 2)).rows[0].id;
const rc1 = (await addWrap(A, 'recovery', 1)).rows[0].id;
r = await as('authenticated', A, 'delete from public.key_wraps where id = $1', [p1]);
check('T31', 'Deleting a key wrap directly is refused', denied(r), r.error ?? `deleted ${r.affected}`);
// Since step 7.4, each key change clears only its own kind of wrap.
r = await as('authenticated', A, "select public.delete_old_key_wraps('password') as n");
let left1 = await as('postgres', null, 'select id from public.key_wraps where user_id = $1', [A]);
const ids1 = left1.rows.map(x => x.id);
check('T32', 'Clearing old password wraps removes only the older password wrap',
  r.ok && r.rows[0].n === 1 && ids1.includes(p2) && ids1.includes(rc1) && !ids1.includes(p1), r.error ?? JSON.stringify(ids1));
r = await as('authenticated', A, "select public.delete_old_key_wraps('password') as n");
const again = await as('authenticated', A, "select public.delete_old_key_wraps('recovery') as n");
check('T33', 'Clearing again removes nothing: your newest of each kind always survives',
  r.ok && r.rows[0].n === 0 && again.ok && again.rows[0].n === 0, r.error ?? again.error);
await addWrap(A, 'password', 3);
r = await as('authenticated', B, "select public.delete_old_key_wraps('password') as n");
left1 = await as('postgres', null, 'select id from public.key_wraps where user_id = $1', [A]);
check('T34', "A friend clearing their old wraps doesn't touch yours", r.ok && r.rows[0].n === 0 && left1.rows.some(x => x.id === p2), r.error);
r = await as('authenticated', A, "update public.key_wraps set kind = 'recovery' where id = $1", [p2]);
check('T35', 'Editing a key wrap is refused', denied(r), r.error);
r = await as('anon', null, "select public.delete_old_key_wraps('password')");
check('T36', 'Signed out: clearing key wraps is refused', denied(r), r.error);
const rc2 = (await addWrap(A, 'recovery', 2)).rows[0].id;
r = await as('authenticated', A, "select public.delete_old_key_wraps('password') as n");
let kinds = await as('postgres', null, "select id from public.key_wraps where user_id = $1 and kind = 'recovery'", [A]);
const keptBoth = kinds.rows.some(x => x.id === rc1) && kinds.rows.some(x => x.id === rc2);
r = await as('authenticated', A, "select public.delete_old_key_wraps('recovery') as n");
kinds = await as('postgres', null, "select id from public.key_wraps where user_id = $1 and kind = 'recovery'", [A]);
check('T37', 'Clearing password wraps never touches recovery wraps, and clearing recovery wraps keeps the newest',
  keptBoth && r.ok && r.rows[0].n === 1 && kinds.rows.length === 1 && kinds.rows[0].id === rc2, r.error ?? JSON.stringify(kinds.rows));
const unknownKind = await as('authenticated', A, "select public.delete_old_key_wraps('both')");
const noKind = await as('authenticated', A, 'select public.delete_old_key_wraps(null)');
const oldStyle = await as('authenticated', A, 'select public.delete_old_key_wraps()');
check('T38', 'An unknown kind or no kind is refused, and the old clear-everything version is gone',
  failsWith(unknownKind, /Unknown key wrap kind/) && failsWith(noKind, /Unknown key wrap kind/) && failsWith(oldStyle, /does not exist/),
  [unknownKind.error, noKind.error, oldStyle.error].join(' / '));

// ---------- Audit log ----------
const addAudit = (uid, seq, prev) => as('authenticated', uid,
  'insert into public.audit_entries (id, seq, prev_hash, v, iv, ct) values ($1,$2,$3,1,$4,$5)',
  [randomUUID(), seq, prev, iv(), ct()]);
r = await addAudit(A, 1, null);
const r2 = await addAudit(A, 2, createHash('sha256').update('x').digest('hex'));
check('T40', 'You add audit entries 1 and 2', r.ok && r2.ok, r.error ?? r2.error);
r = await addAudit(A, 3, null);
check('T41', 'An entry after the first without the previous hash is refused', failsWith(r, /check constraint/), r.error);
r = await addAudit(A, 2, createHash('sha256').update('y').digest('hex'));
check('T42', 'A second entry 2 is refused', failsWith(r, /duplicate key|unique/), r.error);
r = await as('authenticated', A, 'delete from public.audit_entries');
const r3 = await as('authenticated', A, "update public.audit_entries set seq = 9");
check('T43', 'You can\'t edit or delete audit entries', denied(r) && denied(r3), (r.error ?? '') + ' / ' + (r3.error ?? ''));
{
  const call = (seq, prev) => as('authenticated', A,
    'select public.save_week_with_audit($1, 2026::smallint, $2, $3, $4, 1::smallint, $5, $6, $7, $8, $9, 1::smallint, $10, $11)',
    [randomUUID(), 'PL', 'MW20', seq === 3 ? 1 : 2, iv(), ct(), randomUUID(), seq, prev, iv(), ct()]);
  const ok = await call(3, createHash('sha256').update('z').digest('hex'));
  const both = await as('postgres', null, "select (select count(*) from public.week_versions where period = 'MW20')::int as w, (select count(*) from public.audit_entries where user_id = $1 and seq = 3)::int as a", [A]);
  check('T47', 'An Admin-mode edit saves the week and its audit entry together', ok.ok && both.rows[0].w === 1 && both.rows[0].a === 1, ok.error ?? JSON.stringify(both.rows));
  const bad = await call(3, createHash('sha256').update('w').digest('hex'));   // seq 3 already used
  const after = await as('postgres', null, "select count(*)::int as w from public.week_versions where period = 'MW20'");
  check('T48', 'If the audit entry fails, the week version is not saved either', !bad.ok && after.rows[0].w === 1, bad.error ?? 'was allowed');
  const anonCall = await as('anon', null, "select public.save_week_with_audit(null, null, null, null, null, null, null, null, null, null, null, null, null, null)");
  check('T49', 'Signed out: the combined save is refused', denied(anonCall), anonCall.error);
}

r = await as('postgres', null, 'delete from public.audit_entries');
check('T44', 'Even the owner can\'t delete audit entries', failsWith(r, /only be added/), r.error ?? 'owner deleted them');
r = await as('postgres', null, 'truncate public.audit_entries');
check('T45', 'Even the owner can\'t empty the audit log', failsWith(r, /only be added/), r.error ?? 'owner truncated it');
r = await as('postgres', null, "update public.week_versions set period = 'MW1'");
check('T46', 'Even the owner can\'t edit saved week versions', failsWith(r, /only be added/), r.error ?? 'owner edited them');

// ---------- Football data ----------
r = await as('service_role', null,
  "insert into public.teams (id, name, short_name, code) values (65, 'Manchester City FC', 'Man City', 'MCI'), (57, 'Arsenal FC', 'Arsenal', 'ARS')");
const rf = await as('service_role', null,
  "insert into public.fixtures (id, competition, season, period, kickoff, home_team_id, away_team_id, status) values (1001, 'PL', 2026, 'MW9', now(), 65, 57, 'scheduled')");
const ru = await as('service_role', null, "update public.fixtures set status = 'finished', home_90 = 2, away_90 = 1 where id = 1001");
check('T52', 'The sync (secret key) can write teams and fixtures', r.ok && rf.ok && ru.ok, r.error ?? rf.error ?? ru.error);
r = await as('authenticated', B, 'select * from public.fixtures');
check('T50', 'Anyone signed in can read fixtures', r.ok && r.rows.length === 1, r.error);
r = await as('authenticated', B, "insert into public.fixtures (id, competition, season, period, kickoff, home_team_id, away_team_id, status) values (1002, 'PL', 2026, 'MW9', now(), 57, 65, 'scheduled')");
check('T51', 'A signed-in user can\'t write fixtures', denied(r), r.error);
r = await as('service_role', null, 'select * from public.week_versions');
check('T53', 'A secret key can\'t read your week versions', denied(r), r.error);
r = await as('service_role', null, 'delete from public.key_wraps');
check('T54', 'A secret key can\'t delete your key wraps', denied(r), r.error);
r = await as('service_role', null, "insert into public.fixtures (id, competition, season, period, kickoff, home_team_id, away_team_id, status) values (1003, 'PL', 2026, 'MW9', now(), 65, 65, 'scheduled')");
const rs = await as('service_role', null, "insert into public.fixtures (id, competition, season, period, kickoff, home_team_id, away_team_id, status, home_90) values (1004, 'PL', 2026, 'MW9', now(), 65, 57, 'live', 1)");
check('T55', 'Nonsense fixtures (a team playing itself, half a score) are refused', failsWith(r, /check constraint/) && failsWith(rs, /check constraint/), (r.error ?? '') + ' / ' + (rs.error ?? ''));

// ---------- Hooks ----------
await as('postgres', null, "insert into private.invites (email) values ('friend2@example.com')");
r = await as('supabase_auth_admin', null, 'select private.before_user_created($1::jsonb) as out',
  [JSON.stringify({ user: { email: '  Friend2@Example.com ' } })]);
check('T60', 'Sign-up check allows an invited email, whatever its case or spaces', r.ok && JSON.stringify(r.rows[0].out) === '{}', JSON.stringify(r.rows?.[0]?.out ?? r.error));
r = await as('supabase_auth_admin', null, 'select private.before_user_created($1::jsonb) as out',
  [JSON.stringify({ user: { email: 'stranger@example.com' } })]);
check('T61', 'Sign-up check rejects an uninvited email', r.ok && r.rows[0].out?.error?.http_code === 403, JSON.stringify(r.rows?.[0]?.out ?? r.error));
r = await as('supabase_auth_admin', null, 'select private.before_user_created($1::jsonb) as out', [JSON.stringify({ user: {} })]);
check('T62', 'Sign-up check rejects a sign-up with no email', r.ok && r.rows[0].out?.error?.http_code === 403, JSON.stringify(r.rows?.[0]?.out ?? r.error));
r = await as('authenticated', A, 'select private.before_user_created($1::jsonb) as out', [JSON.stringify({ user: { email: 'x@y.z' } })]);
check('T63', 'A signed-in user can\'t call the sign-up check', denied(r), r.error);
r = await as('supabase_auth_admin', null, 'select private.send_email($1::jsonb) as out',
  [JSON.stringify({ user: { id: A, email: 'owner@example.com' }, email_data: { email_action_type: 'recovery', token: '123456', token_hash: 'secret-hash', redirect_to: 'https://evil.example' } })]);
const log = await as('postgres', null, 'select * from private.email_hook_log');
check('T64', 'The email hook says "sent", sends nothing, and logs only who and what kind',
  r.ok && JSON.stringify(r.rows[0].out) === '{}' && log.rows.length === 1 && log.rows[0].action === 'recovery'
  && !JSON.stringify(log.rows).includes('123456') && !JSON.stringify(log.rows).includes('secret-hash'),
  JSON.stringify(log.rows ?? r.error));
r = await as('supabase_auth_admin', null, 'select private.send_email($1::jsonb) as out', [JSON.stringify({ user: { id: 'not-a-uuid' } })]);
check('T65', 'A garbled payload still gets "sent" back, never an error that could fall back to email', r.ok && JSON.stringify(r.rows[0].out) === '{}', r.error);
r = await as('authenticated', A, 'select * from private.invites');
check('T66', 'Signed-in users can\'t read the invite list directly', denied(r), r.error);

// ---------- Recovery ----------
const proof = randomBytes(32);
const proofHex = proof.toString('hex');
const proofHashHex = createHash('sha256').update(proof).digest('hex');
r = await as('authenticated', A, 'select public.set_recovery_proof($1)', [proofHashHex]);
check('T70', 'You save your first recovery proof', r.ok, r.error);
r = await as('authenticated', A, 'select public.set_recovery_proof($1)', ['b'.repeat(64)]);
check('T71', 'Replacing it without the current proof is refused', failsWith(r, /Bad recovery proof/), r.error ?? 'was allowed');
r = await as('authenticated', A, 'select public.set_recovery_proof($1, $2)', ['b'.repeat(64), 'c'.repeat(64)]);
check('T72', 'Replacing it with a wrong current proof is refused', failsWith(r, /Bad recovery proof/), r.error ?? 'was allowed');
const proof2 = randomBytes(32);
r = await as('authenticated', A, 'select public.set_recovery_proof($1, $2)', [createHash('sha256').update(proof2).digest('hex'), proofHex]);
check('T73', 'Replacing it with the right current proof works', r.ok, r.error);
r = await as('service_role', null, 'select public.recovery_check($1, $2) as id', ['Owner@Example.com', proof2.toString('hex')]);
check('T74', 'Recovery check accepts the right proof', r.ok && r.rows[0].id === A, JSON.stringify(r.rows ?? r.error));
const wrong = await as('service_role', null, 'select public.recovery_check($1, $2) as id', ['owner@example.com', 'd'.repeat(64)]);
const unknown = await as('service_role', null, 'select public.recovery_check($1, $2) as id', ['nobody@example.com', proof2.toString('hex')]);
const garbage = await as('service_role', null, 'select public.recovery_check($1, $2) as id', ['owner@example.com', 'zz']);
check('T75', 'Wrong proof, unknown email and garbage all get the same empty answer',
  wrong.ok && unknown.ok && garbage.ok && wrong.rows[0].id === null && unknown.rows[0].id === null && garbage.rows[0].id === null);
for (let i = 0; i < 4; i++) await as('service_role', null, 'select public.recovery_check($1, $2)', ['owner@example.com', 'e'.repeat(64)]);
r = await as('service_role', null, 'select public.recovery_check($1, $2) as id', ['owner@example.com', proof2.toString('hex')]);
check('T76', 'After 5 wrong tries, even the right proof is refused for 24 hours', r.ok && r.rows[0].id === null, JSON.stringify(r.rows ?? r.error));
r = await as('authenticated', A, 'select public.recovery_check($1, $2)', ['owner@example.com', proof2.toString('hex')]);
check('T77', 'A signed-in user can\'t call the recovery check', denied(r), r.error);
r = await as('postgres', null, 'select count(*)::int as n from private.recovery_attempts where user_id is null');
check('T78', 'Tries against unknown emails leave nothing behind', r.ok && r.rows[0].n === 0);

// ---------- A new recovery key after a recent password sign-in (step 7.3) ----------
// The friend's account sets a first proof, then tries to replace it with
// different sign-in claims. now() is fixed for the whole query, so "seconds
// ago" means seconds before the test runs.
const hashOf = () => createHash('sha256').update(randomBytes(32)).digest('hex');
const secondsAgo = s => Math.floor(Date.now() / 1000) - s;
const amr = (method, timestamp) => ({ amr: [{ method, timestamp }] });
r = await as('authenticated', B, 'select public.set_recovery_proof($1)', [hashOf()]);
const freshSignIn = await as('authenticated', B, 'select public.set_recovery_proof($1)', [hashOf()], amr('password', secondsAgo(60)));
check('T79', 'A password sign-in in the last 5 minutes can replace the proof', r.ok && freshSignIn.ok, r.error ?? freshSignIn.error);
r = await as('authenticated', B, 'select public.set_recovery_proof($1)', [hashOf()], amr('password', secondsAgo(400)));
check('T79a', 'A sign-in from more than 5 minutes ago can\'t', failsWith(r, /Bad recovery proof/), r.error ?? 'was allowed');
const odd = [
  amr('otp', secondsAgo(10)),                                  // another sign-in method
  amr('password', secondsAgo(-3600)),                          // a time an hour from now
  amr('password', String(secondsAgo(10))),                     // a time written as text
  { amr: 'password' },                                         // not a list
  { amr: [{ method: 'password' }] },                           // no time at all
];
const oddResults = [];
for (const claims of odd) oddResults.push(await as('authenticated', B, 'select public.set_recovery_proof($1)', [hashOf()], claims));
check('T79b', 'Another sign-in method, a future time or a garbled claim can\'t', oddResults.every(x => failsWith(x, /Bad recovery proof/)),
  JSON.stringify(oddResults.map(x => x.error ?? 'allowed')));
r = await as('postgres', null, `select
  has_function_privilege('anon', 'public.set_recovery_proof(text, text)', 'execute') as anon_f,
  has_function_privilege('authenticated', 'public.set_recovery_proof(text, text)', 'execute') as auth_f,
  has_function_privilege('service_role', 'public.set_recovery_proof(text, text)', 'execute') as svc_f`);
check('T79c', 'The new version keeps exactly its old permissions: signed-in users only', r.ok && !r.rows[0].anon_f && r.rows[0].auth_f && !r.rows[0].svc_f, JSON.stringify(r.rows?.[0] ?? r.error));

// ---------- Invites ----------
r = await as('authenticated', B, 'select * from public.invite_list()');
check('T80', 'A friend can\'t see or manage invites', failsWith(r, /Not allowed/), r.error ?? 'was allowed');
r = await as('authenticated', A, 'select public.invite_add($1)', ['  New.Friend@Example.com ']);
const list = await as('authenticated', A, 'select * from public.invite_list()');
check('T81', 'You (admin) add an invite, stored tidied up', r.ok && list.ok && list.rows.some(x => x.email === 'new.friend@example.com'), r.error ?? list.error);
r = await as('authenticated', A, 'select public.invite_add($1)', ['not an email']);
check('T82', 'A malformed email is refused', failsWith(r, /check constraint/), r.error ?? 'was allowed');
r = await as('authenticated', A, 'select public.invite_remove($1)', ['new.friend@example.com']);
const list2 = await as('authenticated', A, 'select * from public.invite_list()');
check('T83', 'You remove an invite', r.ok && !list2.rows.some(x => x.email === 'new.friend@example.com'), r.error);

// ---------- Storage limits ----------
// Adds wraps until the limit stops them, then checks it stopped at exactly 200.
let capHit = null;
for (let i = 4; i <= 300 && !capHit; i++) {
  const x = await addWrap(A, 'password', i);
  if (!x.ok) capHit = { i, error: x.error };
}
const wrapCount = await as('postgres', null, 'select count(*)::int as n from public.key_wraps where user_id = $1', [A]);
check('T90', 'Key wraps stop at 200 per account', capHit && /Storage limit/.test(capHit.error) && wrapCount.rows[0].n === 200,
  JSON.stringify({ capHit, wraps: wrapCount.rows[0]?.n }));
let byteHit = null;
const big = b64(262000);                                  // 349,336 base64 characters
const fits = Math.floor(2000000 / big.length);            // 5 rows fit under 2 MB
for (let i = 1; i <= fits + 2 && !byteHit; i++) {
  const x = await as('authenticated', B, 'insert into public.settings_versions (id, version_no, v, iv, ct) values ($1,$2,1,$3,$4)', [randomUUID(), i, iv(), big]);
  if (!x.ok) byteHit = { i, error: x.error };
}
check('T91', `Settings stop at 2 MB per account (row ${fits + 1} of the largest size is refused)`, byteHit && byteHit.i === fits + 1 && /Storage limit/.test(byteHit.error), JSON.stringify(byteHit));

// ---------- Deleting a whole account ----------
await addAudit(B, 1, null);
await addWrap(B, 'password', 1);
r = await as('postgres', null, 'delete from auth.users where id = $1', [B]);
const left = await as('postgres', null, `select
  (select count(*) from public.week_versions where user_id = $1) +
  (select count(*) from public.settings_versions where user_id = $1) +
  (select count(*) from public.key_wraps where user_id = $1) +
  (select count(*) from public.audit_entries where user_id = $1) as n`, [B]);
check('T95', "Deleting a friend's account removes all their rows, audit log included", r.ok && Number(left.rows[0].n) === 0, r.error ?? JSON.stringify(left.rows));

// ---------- Future tables start closed ----------
await as('postgres', null, 'create table public.later_table (x int)');
await as('postgres', null, 'create function public.later_fn() returns int language sql as $$ select 1 $$');
r = await as('postgres', null, `select
  has_table_privilege('anon', 'public.later_table', 'select') as anon_t,
  has_table_privilege('authenticated', 'public.later_table', 'select') as auth_t,
  has_table_privilege('service_role', 'public.later_table', 'select') as svc_t,
  has_function_privilege('anon', 'public.later_fn()', 'execute') as anon_f,
  has_function_privilege('authenticated', 'public.later_fn()', 'execute') as auth_f`);
const p = r.rows[0];
check('T99', 'A table or function added later starts with no access for anyone', !p.anon_t && !p.auth_t && !p.svc_t && !p.anon_f && !p.auth_f, JSON.stringify(p));

// ---------- End to end with real Web Crypto ----------
{
  const { subtle } = globalThis.crypto;
  const enc = new TextEncoder();
  const toB64 = buf => Buffer.from(buf).toString('base64');
  const fromB64 = s => new Uint8Array(Buffer.from(s, 'base64'));
  const C = randomUUID();
  await db.query('insert into auth.users (id, email) values ($1, $2)', [C, 'e2e@example.com']);

  // Wrap a data key the way setup will, and save it.
  const wrapKey = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['wrapKey', 'unwrapKey']);
  const dataKey = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const wrapId = randomUUID();
  const wrapAad = enc.encode(JSON.stringify(['fmbt-cashhhh', 'key_wraps', wrapId, 'password', 1, 1]));
  const wIv = crypto.getRandomValues(new Uint8Array(12));
  const wrappedKey = await subtle.wrapKey('raw', dataKey, wrapKey, { name: 'AES-GCM', iv: wIv, additionalData: wrapAad });
  let x = await as('authenticated', C, 'insert into public.key_wraps (id, kind, version_no, v, iv, wrapped) values ($1, $2, 1, 1, $3, $4)',
    [wrapId, 'password', toB64(wIv), toB64(wrappedKey)]);
  check('T100', 'A key wrapped by Web Crypto fits the stored format exactly', x.ok, x.error);

  // Encrypt a padded week record the way the app will, save, load, decrypt.
  const rowId = randomUUID();
  const aadFor = row => enc.encode(JSON.stringify(['fmbt-cashhhh', 'week_versions', row.id, row.season, row.competition, row.period, row.version_no, row.v]));
  const row = { id: rowId, season: 2026, competition: 'PL', period: 'MW9', version_no: 1, v: 1 };
  let json = JSON.stringify({ schema: 1, deleted: false, parlays: [{ id: randomUUID(), stakeCents: 2500, legs: [{ fixtureId: 1001, pick: 'H', odds: -150, confidence: 4, settlement: null }] }] });
  const len = enc.encode(json).length;
  json += ' '.repeat(Math.ceil(len / 1024) * 1024 - len);
  const rIv = crypto.getRandomValues(new Uint8Array(12));
  const k = await subtle.unwrapKey('raw', wrappedKey, wrapKey, { name: 'AES-GCM', iv: wIv, additionalData: wrapAad },
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const ctBuf = await subtle.encrypt({ name: 'AES-GCM', iv: rIv, additionalData: aadFor(row) }, k, enc.encode(json));
  x = await as('authenticated', C, 'insert into public.week_versions (id, season, competition, period, version_no, v, iv, ct) values ($1,$2,$3,$4,$5,$6,$7,$8)',
    [row.id, row.season, row.competition, row.period, row.version_no, row.v, toB64(rIv), toB64(ctBuf)]);
  const back = await as('authenticated', C, 'select * from public.latest_week_versions');
  let opened = null;
  try {
    const got = back.rows[0];
    const plain = await subtle.decrypt({ name: 'AES-GCM', iv: fromB64(got.iv), additionalData: aadFor(got) }, k, fromB64(got.ct));
    opened = JSON.parse(new TextDecoder().decode(plain));
  } catch (e) { opened = { error: e.message }; }
  check('T101', 'A padded record encrypted by Web Crypto saves, loads and decrypts', x.ok && opened?.parlays?.[0]?.legs?.[0]?.odds === -150, x.error ?? JSON.stringify(opened));

  // Someone copies that ciphertext into a different week's row: it must not open.
  const moved = { id: randomUUID(), season: 2026, competition: 'PL', period: 'MW10', version_no: 1, v: 1 };
  await as('authenticated', C, 'insert into public.week_versions (id, season, competition, period, version_no, v, iv, ct) values ($1,$2,$3,$4,$5,$6,$7,$8)',
    [moved.id, moved.season, moved.competition, moved.period, moved.version_no, moved.v, toB64(rIv), toB64(ctBuf)]);
  const mv = await as('authenticated', C, "select * from public.week_versions where period = 'MW10'");
  let movedOpened = true;
  try {
    const got = mv.rows[0];
    await subtle.decrypt({ name: 'AES-GCM', iv: fromB64(got.iv), additionalData: aadFor(got) }, k, fromB64(got.ct));
  } catch { movedOpened = false; }
  check('T102', 'The same ciphertext copied into another week refuses to open', !movedOpened);
}

// ---------- Report ----------
results.sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
let failed = 0;
for (const t of results) {
  if (!t.pass) failed++;
  console.log(`${t.pass ? 'PASS' : 'FAIL'}  ${t.id}  ${t.name}${t.pass ? '' : '  -> ' + t.detail}`);
}
console.log(`\n${results.length - failed} of ${results.length} passed`);
process.exit(failed ? 1 : 0);
