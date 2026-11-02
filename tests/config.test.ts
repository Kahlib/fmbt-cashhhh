// Tests for src/lib/config.ts: the app must refuse to start with a wrong
// Supabase value. Run with `npm run test:unit`, which `npm run check` does.
//
// Each test() is one claim. assert.throws passes only if the code inside
// throws an error, and assert.deepEqual compares two values field by field.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readConfig } from '../src/lib/config.ts'

// Made-up values with the right shapes. Not a real project.
const URL = 'https://abcdefghijklmnopqrst.supabase.co'
const KEY = 'sb_publishable_' + 'A'.repeat(31)

test('accepts a project address and a publishable key', () => {
  assert.deepEqual(
    readConfig({ VITE_SUPABASE_URL: URL, VITE_SUPABASE_PUBLISHABLE_KEY: KEY }),
    { url: URL, publishableKey: KEY },
  )
})

test('refuses a secret key, so one can never be built into the page', () => {
  assert.throws(() => readConfig({ VITE_SUPABASE_URL: URL, VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_secret_' + 'A'.repeat(31) }))
})

test('refuses the old JWT-style keys, which we no longer use', () => {
  assert.throws(() => readConfig({ VITE_SUPABASE_URL: URL, VITE_SUPABASE_PUBLISHABLE_KEY: 'eyJhbGciOiJIUzI1NiJ9.e30.x' }))
})

test("refuses anything that isn't exactly a project address", () => {
  const bad = [
    'http://abcdefghijklmnopqrst.supabase.co',               // not https
    'https://abcdefghijklmnopqrst.supabase.co/rest/v1/',     // has a path
    'https://abcdefghijklmnopqrst.supabase.co.example.com',  // someone else's site
    'https://short.supabase.co',                             // not a project ID
    'https://example.com',
  ]
  for (const url of bad) {
    assert.throws(() => readConfig({ VITE_SUPABASE_URL: url, VITE_SUPABASE_PUBLISHABLE_KEY: KEY }), Error, url)
  }
})

test('refuses missing values', () => {
  assert.throws(() => readConfig({}))
  assert.throws(() => readConfig({ VITE_SUPABASE_URL: URL }))
  assert.throws(() => readConfig({ VITE_SUPABASE_PUBLISHABLE_KEY: KEY }))
})
