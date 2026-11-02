// Tests for scripts/check-env.ts, the guard that decides which Supabase
// values a build can see. Each test feeds it a made-up file and checks the
// answer. An empty list means "no problems".
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PRODUCTION_URL, checkProductionEnv, checkDevEnv, checkHeaders, checkProcessEnv, checkStrayFiles,
} from '../scripts/check-env.ts'

const KEY = 'sb_publishable_' + 'A'.repeat(31)
const DEV_URL = 'https://abcdefghijklmnopqrst.supabase.co'
const good = `# a comment\nVITE_SUPABASE_URL=${PRODUCTION_URL}\nVITE_SUPABASE_PUBLISHABLE_KEY=${KEY}\n`

test('a correct .env.production passes, Windows line endings included', () => {
  assert.deepEqual(checkProductionEnv(good), [])
  assert.deepEqual(checkProductionEnv(good.replaceAll('\n', '\r\n')), [])
})

test('.env.production refuses a third variable', () => {
  assert.equal(checkProductionEnv(good + 'VITE_FOOTBALL_KEY=abc\n').length, 1)
})

test('.env.production refuses a secret key', () => {
  assert.equal(checkProductionEnv(good.replace(KEY, 'sb_secret_' + 'A'.repeat(31))).length, 1)
})

test('.env.production refuses the placeholder, so a build never ships without the real key', () => {
  assert.equal(checkProductionEnv(good.replace(KEY, 'paste-production-publishable-key-here')).length, 1)
})

test('.env.production refuses another project, such as dev', () => {
  assert.equal(checkProductionEnv(good.replace(PRODUCTION_URL, DEV_URL)).length, 1)
})

test('.env.production refuses a value set twice, quotes, and a missing value', () => {
  assert.ok(checkProductionEnv(good + `VITE_SUPABASE_URL=${PRODUCTION_URL}\n`).length > 0)
  assert.ok(checkProductionEnv(good.replace(KEY, `"${KEY}"`)).length > 0)
  assert.ok(checkProductionEnv(`VITE_SUPABASE_URL=${PRODUCTION_URL}\n`).length > 0)
})

test('.env.development.local passes with dev values and refuses production', () => {
  const dev = good.replace(PRODUCTION_URL, DEV_URL)
  assert.deepEqual(checkDevEnv(dev), [])
  assert.equal(checkDevEnv(good).length, 1)
})

test("_headers must allow exactly 'self' and the production address", () => {
  const line = (sources: string) => `/*\n  Content-Security-Policy: default-src 'none'; connect-src ${sources}; base-uri 'none'\n`
  assert.deepEqual(checkHeaders(line(`'self' ${PRODUCTION_URL}`), PRODUCTION_URL), [])
  assert.equal(checkHeaders(line("'self'"), PRODUCTION_URL).length, 1)
  assert.equal(checkHeaders(line(`'self' ${PRODUCTION_URL} https://example.com`), PRODUCTION_URL).length, 1)
  assert.equal(checkHeaders('/*\n  X-Frame-Options: DENY\n', PRODUCTION_URL).length, 1)
})

test('a VITE_ variable set outside the files is refused', () => {
  assert.deepEqual(checkProcessEnv({ PATH: '/usr/bin', CI: 'true' }), [])
  assert.equal(checkProcessEnv({ VITE_SUPABASE_URL: DEV_URL }).length, 1)
})

test('env files that would change a production build are refused', () => {
  assert.deepEqual(checkStrayFiles(() => false), [])
  assert.equal(checkStrayFiles(file => file === '.env.local').length, 1)
})
