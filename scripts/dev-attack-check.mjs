// FMBT Cashhhh: attack the DEV Supabase project from the outside.
//
// The schema tests prove the rules in a copy of Postgres. This script proves
// them on the real dev project, through the same doors a stranger or a friend
// would use: the sign-up system and the Data API, holding only the public key.
//
// Before the first run, in the dev project's SQL editor:
//   insert into private.invites (email) values
//     ('test-a@fmbtcashhhh.com'), ('test-b@fmbtcashhhh.com');
//
// Run it from the repo folder in PowerShell. It asks for the dev project's URL
// and publishable key, which are public values, so nothing secret is typed:
//   node scripts/dev-attack-check.mjs
//
// It signs up two junk accounts the first time and saves their random
// passwords in private-data/dev-test-accounts.json (never committed), so later
// runs sign in instead. Never point this at the production project.

import { createInterface } from 'node:readline/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';

const ask = async question => {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(question)).trim();
  rl.close();
  return answer;
};

const url = (process.env.DEV_SUPABASE_URL || await ask('Dev project URL (https://<ref>.supabase.co): ')).replace(/\/$/, '');
const key = process.env.DEV_SUPABASE_PUBLISHABLE_KEY || await ask('Dev publishable key (sb_publishable_...): ');
if (!/^https:\/\/[a-z0-9]+\.supabase\.co$/.test(url)) throw new Error('That URL doesn\'t look like https://<ref>.supabase.co');
if (!key.startsWith('sb_publishable_')) throw new Error('Use the publishable key, never a secret key.');

const EMAIL_A = 'test-a@fmbtcashhhh.com';
const EMAIL_B = 'test-b@fmbtcashhhh.com';
const saved = 'private-data/dev-test-accounts.json';

// ---------- small helpers ----------
const results = [];
const check = (id, name, pass, detail = '') => results.push({ id, name, pass, detail });

async function call(method, path, { token, body, headers = {} } = {}) {
  const res = await fetch(url + path, {
    method,
    headers: {
      apikey: key,
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  return { status: res.status, json, text };
}

const refused = r => r.status === 401 || r.status === 403 || r.json?.code === '42501';
const say = r => `${r.status} ${(r.json?.msg || r.json?.message || r.text || '').slice(0, 120)}`;
const loginToken = () => randomBytes(32).toString('hex');     // the shape the app sends
const b64 = n => randomBytes(n).toString('base64');
const weekRow = (period, version) => ({
  id: randomUUID(), season: 2026, competition: 'PL', period, version_no: version,
  v: 1, iv: b64(12), ct: b64(1040),
});

async function signUp(email, password) {
  return call('POST', '/auth/v1/signup', { body: { email, password } });
}
async function signIn(email, password) {
  return call('POST', '/auth/v1/token?grant_type=password', { body: { email, password } });
}

// ---------- 1. Signed out, holding only the public key ----------
let r = await call('GET', '/rest/v1/week_versions?select=*');
check('D01', 'Signed out: reading week versions is refused', refused(r), say(r));
r = await call('GET', '/rest/v1/fixtures?select=*');
check('D02', 'Signed out: reading fixtures is refused', refused(r), say(r));
r = await call('POST', '/rest/v1/rpc/invite_list', { body: {} });
check('D03', 'Signed out: listing invites is refused', refused(r), say(r));
r = await call('POST', '/rest/v1/rpc/recovery_check', { body: { p_email: EMAIL_A, p_proof_hex: 'a'.repeat(64) } });
check('D04', 'Signed out: checking a recovery proof is refused', refused(r), say(r));
r = await signUp(`stranger-${randomBytes(4).toString('hex')}@fmbtcashhhh.com`, loginToken());
check('D05', 'A stranger\'s sign-up is refused by the invite check',
  r.status >= 400 && /invite/i.test(r.text), say(r));
r = await call('POST', '/graphql/v1', { body: { query: '{ __typename }' } });
check('D06', 'GraphQL is switched off', r.status === 404 || (r.status >= 400 && !/__typename/.test(r.text)), say(r));

// ---------- 2. Two accounts: sign up the first time, sign in after ----------
let accounts = existsSync(saved) ? JSON.parse(readFileSync(saved, 'utf8')) : null;
let tokenA, tokenB;
if (!accounts) {
  r = await signUp(EMAIL_A, 'short-password');
  check('D07', 'A short password is refused (Supabase only accepts 64-character login tokens)',
    r.status >= 400 && /password/i.test(r.text), say(r));
  accounts = { a: loginToken(), b: loginToken() };
  const ra = await signUp(EMAIL_A, accounts.a);
  const rb = await signUp(EMAIL_B, accounts.b);
  check('D08', 'Invited sign-ups work straight away, with no confirmation email',
    !!ra.json?.access_token && !!rb.json?.access_token, `${say(ra)} / ${say(rb)}`);
  if (ra.json?.access_token && rb.json?.access_token) {
    mkdirSync('private-data', { recursive: true });
    writeFileSync(saved, JSON.stringify(accounts, null, 2));
  }
  tokenA = ra.json?.access_token;
  tokenB = rb.json?.access_token;
} else {
  check('D07', 'Short password check (first run only)', true, 'skipped: accounts already exist');
  const ra = await signIn(EMAIL_A, accounts.a);
  const rb = await signIn(EMAIL_B, accounts.b);
  check('D08', 'The two test accounts sign in', !!ra.json?.access_token && !!rb.json?.access_token, `${say(ra)} / ${say(rb)}`);
  tokenA = ra.json?.access_token;
  tokenB = rb.json?.access_token;
}
if (!tokenA || !tokenB) {
  console.log('\nCould not get both test accounts signed in, so the rest was skipped.');
} else {
  const claims = JSON.parse(Buffer.from(tokenA.split('.')[1], 'base64url').toString());
  const life = claims.exp - claims.iat;
  check('D09', 'Access tokens last 15 minutes', life === 900, `${life} seconds`);

  // ---------- 3. Account A's rows vs account B ----------
  const latest = await call('GET', `/rest/v1/week_versions?select=version_no&period=eq.MW1&order=version_no.desc&limit=1`, { token: tokenA });
  const next = (latest.json?.[0]?.version_no ?? 0) + 1;
  const row = weekRow('MW1', next);
  r = await call('POST', '/rest/v1/week_versions', { token: tokenA, body: row, headers: { Prefer: 'return=minimal' } });
  check('D10', 'Account A adds a week version', r.status === 201, say(r));

  r = await call('POST', '/rest/v1/week_versions', {
    token: tokenA, headers: { Prefer: 'return=minimal' },
    body: { ...weekRow('MW2', 1), user_id: claims.sub },
  });
  check('D11', 'The browser can\'t set user_id, even to its own', refused(r), say(r));

  r = await call('PATCH', `/rest/v1/week_versions?id=eq.${row.id}`, { token: tokenA, body: { period: 'MW3' } });
  const del = await call('DELETE', `/rest/v1/week_versions?id=eq.${row.id}`, { token: tokenA });
  check('D12', 'Editing or deleting a saved version is refused', refused(r) && refused(del), `${say(r)} / ${say(del)}`);

  r = await call('GET', '/rest/v1/week_versions?select=id', { token: tokenB });
  const view = await call('GET', '/rest/v1/latest_week_versions?select=id', { token: tokenB });
  check('D13', 'Account B sees none of account A\'s rows, directly or through the view',
    r.status === 200 && Array.isArray(r.json) && !r.json.some(x => x.id === row.id)
    && view.status === 200 && Array.isArray(view.json) && !view.json.some(x => x.id === row.id),
    `${say(r)} / ${say(view)}`);

  r = await call('GET', `/rest/v1/week_versions?select=id&id=eq.${row.id}`, { token: tokenA });
  check('D14', 'Account A sees its own row', r.status === 200 && r.json?.length === 1, say(r));

  r = await call('POST', '/rest/v1/fixtures', {
    token: tokenA, headers: { Prefer: 'return=minimal' },
    body: { id: 999999999, competition: 'PL', season: 2026, period: 'MW1', kickoff: new Date().toISOString(), home_team_id: 1, away_team_id: 2, status: 'scheduled' },
  });
  check('D15', 'A signed-in user can\'t write fixtures', refused(r), say(r));

  r = await call('POST', '/rest/v1/rpc/invite_list', { token: tokenA, body: {} });
  check('D16', 'A non-admin can\'t see invites', r.status >= 400 && /not allowed/i.test(r.text), say(r));

  r = await call('POST', '/rest/v1/rpc/recovery_check', { token: tokenA, body: { p_email: EMAIL_A, p_proof_hex: 'a'.repeat(64) } });
  check('D17', 'A signed-in user can\'t call the recovery check', refused(r), say(r));

  r = await call('GET', '/rest/v1/invites?select=*', { token: tokenA, headers: { 'Accept-Profile': 'private' } });
  check('D18', 'The private schema can\'t be reached through the API at all', r.status >= 400, say(r));

  // ---------- 4. Emails that must never be sent ----------
  // Supabase allows one reset or sign-in link email per person per 60 seconds,
  // so each request goes to a different test account. Both must reach the hook.
  const reset = await call('POST', '/auth/v1/recover', { body: { email: EMAIL_A } });
  const link = await call('POST', '/auth/v1/otp', { body: { email: EMAIL_B, create_user: false } });
  check('D19', 'Password reset and sign-in link requests reach the hook, which then sends nothing',
    reset.status === 200 && link.status === 200, `${say(reset)} / ${say(link)}`);
}

// ---------- Report ----------
let failed = 0;
for (const t of results) {
  if (!t.pass) failed++;
  console.log(`${t.pass ? 'PASS' : 'FAIL'}  ${t.id}  ${t.name}${t.pass && !t.detail.startsWith('skipped') ? '' : '  -> ' + t.detail}`);
}
console.log(`\n${results.length - failed} of ${results.length} passed`);
console.log(`
Two checks to finish by hand in the dev project's SQL editor:
  select action, at from private.email_hook_log order by at desc limit 5;
    should list 'recovery' and 'magiclink' from just now: the hook was asked and sent nothing.
  Then run supabase/checks/permissions-report.sql and compare it with the table in the setup guide.`);
process.exit(failed ? 1 : 0);
