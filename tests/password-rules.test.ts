// The rules for a new password, in password-rules.ts.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkPassword, countCharacters } from '../src/lib/account/password-rules.ts'

const EMAIL = 'kahlib.stewart.2026@example.com'
const problem = (password: string) => {
  const result = checkPassword(password, EMAIL)
  return result.ok ? 'ok' : result.problem
}

test('15 to 256 characters, counted the way people count them', () => {
  assert.equal(problem('a'.repeat(7) + 'b'.repeat(7)), 'too-short')
  assert.equal(problem('copper ladder 9'), 'ok')
  assert.equal(problem('x'.repeat(128) + 'y'.repeat(128)), 'ok')
  assert.equal(problem('x'.repeat(128) + 'y'.repeat(129)), 'too-long')
  // "é" typed as one character or as e plus an accent counts once either way.
  assert.equal(countCharacters('café'), 4)
  assert.equal(countCharacters('café'), 4)
  assert.equal(problem('café café caf'), 'too-short')
  // Spaces count, and nothing gets trimmed.
  assert.equal(countCharacters('  two spaces  '), 14)
})

test('No rules about capitals, digits or symbols', () => {
  assert.equal(problem('all lowercase words here'), 'ok')
  assert.equal(problem('ünïcödé wörds äré fïné'), 'ok')
})

test('Not the email, not its first part, not the app name', () => {
  assert.equal(problem(EMAIL), 'is-email')
  assert.equal(problem(' Kahlib.Stewart.2026@Example.com '), 'is-email')
  assert.equal(problem('kahlib-stewart-2026'), 'is-email')
  assert.equal(problem('FMBT Cashhhh 2026!!'), 'is-app-name')
  assert.equal(problem('fmbtcashhhh parlay tracker'), 'is-app-name')
  assert.equal(problem('fmbt fans watch every match'), 'ok')
})

test('Not one character repeated, and not a well-known long password', () => {
  assert.equal(problem('aaaaaaaaaaaaaaaa'), 'one-character')
  assert.equal(problem('               '), 'one-character')
  assert.equal(problem('Correct horse battery staple!'), 'common')
  assert.equal(problem('qwertyuiopasdfgh'), 'common')
  assert.equal(problem('1234567890123456'), 'common')
  assert.equal(problem('correct horse battery stapler'), 'ok')
})
