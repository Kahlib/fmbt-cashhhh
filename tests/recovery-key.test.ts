// Tests for src/lib/crypto/recovery-key.ts: making, showing and reading
// recovery keys, the typo check, and what the app makes from a key.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, hkdfSync } from 'node:crypto'
import { fromHex } from '../src/lib/crypto/bytes.ts'
import { makeDataKey, unwrapDataKey, wrapDataKey } from '../src/lib/crypto/keys.ts'
import {
  GROUP_COUNT, deriveRecoveryKeys, makeRecoveryKey, pickGroupsToCheck, readRecoveryKey, showRecoveryKey, tidyGroup,
} from '../src/lib/crypto/recovery-key.ts'

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

// A fixed key and what it must always give. Worked out on 2 November 2026 by
// a separate script using Node's crypto and a different base32 encoder.
const PINNED_KEY = fromHex('0b30557a9fc4e90e33587da2c7ec11365b80a5caef14395e83a8cdf2173c6186')
const PINNED_TEXT = '1CR5 AYMZ RKMG WCTR FPHC FV0H 6SDR 19EA XWA3 JQM3 N36Z 45SW C632'
const PINNED_PROOF = '3ba0a3349ccf633f4fbac6e08b3ccc0930cafc1edc4e90cea7e6c514c5031e8b'
const PINNED_PROOF_HASH = '47beb785fa3d9919625bad7de1646505c7089ae0792c05fdbb19311319d9b15b'

test('a recovery key shows as 13 groups of 4 characters, with no look-alikes', async () => {
  const groups = await showRecoveryKey(makeRecoveryKey())
  assert.equal(groups.length, GROUP_COUNT)
  for (const group of groups) assert.match(group, /^[0-9A-HJKMNP-TV-Z]{4}$/)
})

test('a fixed key always shows the same groups and makes the same proof', async () => {
  assert.equal((await showRecoveryKey(PINNED_KEY)).join(' '), PINNED_TEXT)
  const keys = await deriveRecoveryKeys(PINNED_KEY)
  assert.equal(keys.proofHex, PINNED_PROOF)
  assert.equal(keys.proofHashHex, PINNED_PROOF_HASH)
  // The same values from Node's own HKDF and SHA-256.
  const proof = Buffer.from(hkdfSync('sha256', PINNED_KEY, Buffer.alloc(0), 'fmbt-cashhhh v1 recovery proof', 32))
  assert.equal(proof.toString('hex'), PINNED_PROOF)
  assert.equal(createHash('sha256').update(proof).digest('hex'), PINNED_PROOF_HASH)
})

test("a shown key reads back to the same bytes, however it's typed", async () => {
  const key = makeRecoveryKey()
  const text = (await showRecoveryKey(key)).join(' ')
  const ways = [
    text,
    text.toLowerCase(),
    text.replaceAll(' ', ''),
    text.replaceAll(' ', '-'),
    text.replaceAll(' ', ' – '),   // en dashes from a word processor
    `  ${text.replaceAll(' ', '\n')}  `,
  ]
  for (const typed of ways) {
    const read = await readRecoveryKey(typed)
    assert.ok(read.ok, typed)
    assert.deepEqual(read.key, key)
  }
})

test('the look-alikes O, I and L read as 0, 1 and 1', async () => {
  assert.ok(PINNED_TEXT.includes('0') && PINNED_TEXT.includes('1'))
  for (const typed of [PINNED_TEXT.replaceAll('0', 'O').replaceAll('1', 'I'), PINNED_TEXT.replaceAll('1', 'l')]) {
    const read = await readRecoveryKey(typed)
    assert.ok(read.ok, typed)
    assert.deepEqual(read.key, PINNED_KEY)
  }
})

test('the check bits catch most single-character typos', async () => {
  // Every way of changing one character to another allowed one: 52 × 31.
  const text = PINNED_TEXT.replaceAll(' ', '')
  let tried = 0
  let missed = 0
  for (let position = 0; position < text.length; position++) {
    for (const character of ALPHABET) {
      if (character === text[position]) continue
      tried++
      const read = await readRecoveryKey(text.slice(0, position) + character + text.slice(position + 1))
      if (read.ok) missed++
    }
  }
  // Four check bits should miss about 1 in 16, which is about 6%.
  assert.equal(tried, 52 * 31)
  assert.ok(missed / tried < 0.1, `${missed} of ${tried} typos got through`)
})

test("a key that's the wrong length or has a character outside the alphabet is refused", async () => {
  const text = PINNED_TEXT.replaceAll(' ', '')
  assert.deepEqual(await readRecoveryKey(text.slice(1)), { ok: false, problem: 'length' })
  assert.deepEqual(await readRecoveryKey(text + '0'), { ok: false, problem: 'length' })
  assert.deepEqual(await readRecoveryKey('U' + text.slice(1)), { ok: false, problem: 'characters' })
  assert.deepEqual(await readRecoveryKey('!' + text.slice(1)), { ok: false, problem: 'characters' })
})

test("the recovery wrap key opens what it wrapped, and another key's doesn't", async () => {
  const key = makeRecoveryKey()
  const dataKey = await makeDataKey()
  const row = await wrapDataKey(dataKey, (await deriveRecoveryKeys(key)).wrapKey, { id: crypto.randomUUID(), kind: 'recovery', version_no: 1 })
  const opened = await unwrapDataKey(row, (await deriveRecoveryKeys(key)).wrapKey, { extractable: true })
  assert.deepEqual(await crypto.subtle.exportKey('raw', opened), await crypto.subtle.exportKey('raw', dataKey))
  await assert.rejects(unwrapDataKey(row, (await deriveRecoveryKeys(makeRecoveryKey())).wrapKey, { extractable: false }))
})

test("setup's check asks for three different groups, and typed groups get tidied", () => {
  for (let i = 0; i < 200; i++) {
    const groups = pickGroupsToCheck()
    assert.equal(groups.length, 3)
    assert.equal(new Set(groups).size, 3)
    assert.deepEqual(groups, [...groups].sort((a, b) => a - b))
    for (const n of groups) assert.ok(Number.isInteger(n) && n >= 1 && n <= GROUP_COUNT)
  }
  assert.equal(tidyGroup(' w3nj '), 'W3NJ')
  assert.equal(tidyGroup('fv-oh'), 'FV0H')
})
