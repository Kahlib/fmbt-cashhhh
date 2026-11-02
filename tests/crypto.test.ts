// Tests for src/lib/crypto: passwords to keys, the data key and its wraps,
// and encrypted records. They try to break each rule in fmbt-security
// sections 1 to 3, and pin the exact outputs, so a change that would lock
// everyone out fails the build instead.
//
// Some tests check our Web Crypto code against Node's own crypto module,
// which is a separate implementation of the same standards.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDecipheriv, hkdfSync, pbkdf2Sync } from 'node:crypto'
import { fromBase64, fromHex, randomBytes, toBase64, toHex } from '../src/lib/crypto/bytes.ts'
import { derivePasswordKeys, hkdfWrapKey } from '../src/lib/crypto/kdf.ts'
import { type KeyWrapRow, makeDataKey, unwrapDataKey, wrapDataKey } from '../src/lib/crypto/keys.ts'
import { aadFor, decryptRecord, encryptRecord, padJson } from '../src/lib/crypto/records.ts'

const EMAIL = ' KMan@Example.com '
const PASSWORD = 'plum crane tide velvet oak'
// Worked out on 2 November 2026 by a separate script using Node's crypto.
// If this test ever fails, the change would stop every existing password
// working. Undo it, or make it a new crypto settings version.
const PINNED_LOGIN_TOKEN = '443746e37eecbc3cbf1955a3cebb26de32c713698852bd21331f9b3375d3da38'

// A quick wrap key for tests that don't need the slow password step.
const testWrapKey = () => hkdfWrapKey(randomBytes(32), 'test wrap key')

// ---------- Passwords to keys ----------

test('the same email and password always give the same login token', async () => {
  const keys = await derivePasswordKeys(EMAIL, PASSWORD)
  assert.equal(keys.loginToken, PINNED_LOGIN_TOKEN)
  assert.match(keys.loginToken, /^[0-9a-f]{64}$/)
})

test("the keys match standard PBKDF2 and HKDF, checked with Node's own crypto", async () => {
  const master = pbkdf2Sync(PASSWORD, 'fmbt-cashhhh:v1:kman@example.com', 600_000, 32, 'sha256')
  const login = Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), 'fmbt-cashhhh v1 login', 32))
  const wrap = Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), 'fmbt-cashhhh v1 wrap', 32))
  const keys = await derivePasswordKeys(EMAIL, PASSWORD)
  assert.equal(keys.loginToken, login.toString('hex'))
  assert.notEqual(login.toString('hex'), wrap.toString('hex'), 'the two labels must give different keys')

  // The wrap key can't be read out of the browser, so prove it's the HKDF
  // result another way: wrap a data key with it, then unwrap that with Node.
  const dataKey = await makeDataKey()
  const row = await wrapDataKey(dataKey, keys.wrapKey, { id: crypto.randomUUID(), kind: 'password', version_no: 1 })
  const wrapped = Buffer.from(row.wrapped, 'base64')
  const decipher = createDecipheriv('aes-256-gcm', wrap, Buffer.from(row.iv, 'base64'))
  decipher.setAAD(aadFor('key_wraps', row))
  decipher.setAuthTag(wrapped.subarray(32))
  const raw = Buffer.concat([decipher.update(wrapped.subarray(0, 32)), decipher.final()])
  assert.deepEqual(new Uint8Array(raw), new Uint8Array(await crypto.subtle.exportKey('raw', dataKey)))
})

test('the same password typed two ways gives the same token', async () => {
  // "é" as one character, and as "e" plus a combining accent.
  const one = await derivePasswordKeys(EMAIL, 'café crane tide velvet oak')
  const two = await derivePasswordKeys(EMAIL, 'café crane tide velvet oak')
  assert.equal(one.loginToken, two.loginToken)
})

test("the email gets tidied, but the password's spaces count", async () => {
  const messy = await derivePasswordKeys(' KMan@EXAMPLE.com ', PASSWORD)
  const tidy = await derivePasswordKeys('kman@example.com', PASSWORD)
  assert.equal(messy.loginToken, tidy.loginToken)
  const spaced = await derivePasswordKeys(EMAIL, PASSWORD + ' ')
  assert.notEqual(spaced.loginToken, tidy.loginToken)
})

// ---------- The data key and its wraps ----------

const wrapRow = (kind: 'password' | 'recovery' = 'password') => ({ id: crypto.randomUUID(), kind, version_no: 1 })

test('the data key opens as non-extractable, still encrypts, and refuses to be wrapped again', async () => {
  const wrapKey = await testWrapKey()
  const row = await wrapDataKey(await makeDataKey(), wrapKey, wrapRow())
  const sessionKey = await unwrapDataKey(row, wrapKey, { extractable: false })
  assert.equal(sessionKey.extractable, false)
  const plain = { id: crypto.randomUUID(), version_no: 1, v: 1 }
  const sealed = await encryptRecord('settings_versions', plain, { schema: 1 }, sessionKey)
  assert.deepEqual(await decryptRecord('settings_versions', { ...plain, ...sealed }, sessionKey), { schema: 1 })
  await assert.rejects(crypto.subtle.wrapKey('raw', sessionKey, wrapKey, { name: 'AES-GCM', iv: randomBytes(12) }))
  await assert.rejects(crypto.subtle.exportKey('raw', sessionKey))
})

test('a key wrap moved to another row, kind or version number refuses to open', async () => {
  const wrapKey = await testWrapKey()
  const row = await wrapDataKey(await makeDataKey(), wrapKey, wrapRow())
  const moved: KeyWrapRow[] = [
    { ...row, id: crypto.randomUUID() },
    { ...row, kind: 'recovery' },
    { ...row, version_no: 2 },
    { ...row, v: 2 },
  ]
  for (const changed of moved) {
    await assert.rejects(unwrapDataKey(changed, wrapKey, { extractable: false }))
  }
})

test('the wrong wrap key, or one changed byte, refuses to open', async () => {
  const wrapKey = await testWrapKey()
  const row = await wrapDataKey(await makeDataKey(), wrapKey, wrapRow())
  await assert.rejects(unwrapDataKey(row, await testWrapKey(), { extractable: false }))
  const bytes = fromBase64(row.wrapped)
  bytes[5] ^= 1
  await assert.rejects(unwrapDataKey({ ...row, wrapped: toBase64(bytes) }, wrapKey, { extractable: false }))
})

test("a key wrap fits the database's stored format, with a fresh IV each time", async () => {
  const dataKey = await makeDataKey()
  const wrapKey = await testWrapKey()
  const row = await wrapDataKey(dataKey, wrapKey, wrapRow('recovery'))
  assert.match(row.iv, /^[A-Za-z0-9+/]{16}$/)
  assert.match(row.wrapped, /^[A-Za-z0-9+/]{64}$/)
  assert.equal(row.v, 1)
  const again = await wrapDataKey(dataKey, wrapKey, { ...wrapRow('recovery'), id: row.id })
  assert.notEqual(again.iv, row.iv)
})

// ---------- Encrypted records ----------

const weekPlain = () => ({ id: crypto.randomUUID(), season: 2026, competition: 'PL', period: 'MW9', version_no: 1, v: 1 })
const weekRecord = { schema: 1, deleted: false, parlays: [{ id: 'p1', stakeCents: 2500, legs: [] }] }

test('a record comes back exactly as it went in, for every table', async () => {
  const key = await makeDataKey()
  const rows = [
    ['week_versions', weekPlain()],
    ['settings_versions', { id: crypto.randomUUID(), version_no: 3, v: 1 }],
    ['audit_entries', { id: crypto.randomUUID(), seq: 1, prev_hash: null, v: 1 }],
    ['audit_entries', { id: crypto.randomUUID(), seq: 2, prev_hash: 'a'.repeat(64), v: 1 }],
  ] as const
  for (const [table, plain] of rows) {
    const sealed = await encryptRecord(table, plain, weekRecord, key)
    assert.deepEqual(await decryptRecord(table, { ...plain, ...sealed }, key), weekRecord, table)
  }
})

test('changing any plain column makes the record refuse to open', async () => {
  const key = await makeDataKey()
  const plain = weekPlain()
  const row = { ...plain, ...(await encryptRecord('week_versions', plain, weekRecord, key)) }
  const changes = [
    { id: crypto.randomUUID() }, { season: 2027 }, { competition: 'UCL' },
    { period: 'MW10' }, { version_no: 2 }, { v: 2 },
  ]
  for (const change of changes) {
    await assert.rejects(decryptRecord('week_versions', { ...row, ...change }, key), JSON.stringify(change))
  }
})

test('a ciphertext copied into another table, or opened with the wrong key, refuses to open', async () => {
  const key = await makeDataKey()
  const plain = { id: crypto.randomUUID(), version_no: 1, v: 1 }
  const sealed = await encryptRecord('settings_versions', plain, { schema: 1 }, key)
  await assert.rejects(decryptRecord('audit_entries', { id: plain.id, seq: 1, prev_hash: null, v: 1, ...sealed }, key))
  await assert.rejects(decryptRecord('settings_versions', { ...plain, ...sealed }, await makeDataKey()))
})

test('one changed byte of ciphertext refuses to open', async () => {
  const key = await makeDataKey()
  const plain = weekPlain()
  const sealed = await encryptRecord('week_versions', plain, weekRecord, key)
  const bytes = fromBase64(sealed.ct)
  bytes[100] ^= 1
  await assert.rejects(decryptRecord('week_versions', { ...plain, iv: sealed.iv, ct: toBase64(bytes) }, key))
})

test("records are padded, so their size doesn't show how many bets they hold", async () => {
  const key = await makeDataKey()
  const bytesOf = async (record: unknown) =>
    fromBase64((await encryptRecord('settings_versions', { id: crypto.randomUUID(), version_no: 1, v: 1 }, record, key)).ct).length
  // JSON of 1, about 1,000 and about 1,100 bytes, plus the 16-byte tamper check.
  assert.equal(await bytesOf(1), 1024 + 16)
  assert.equal(await bytesOf('x'.repeat(1000)), 1024 + 16)
  assert.equal(await bytesOf('x'.repeat(1100)), 2048 + 16)
  assert.equal(padJson('{}').length, 1024)
  assert.equal(padJson('x'.repeat(1024)).length, 1024)
})

test('every encryption uses a fresh IV', async () => {
  const key = await makeDataKey()
  const plain = weekPlain()
  const first = await encryptRecord('week_versions', plain, weekRecord, key)
  const second = await encryptRecord('week_versions', plain, weekRecord, key)
  assert.notEqual(first.iv, second.iv)
  assert.notEqual(first.ct, second.ct)
  assert.match(first.iv, /^[A-Za-z0-9+/]{16}$/)
  assert.ok(first.ct.length >= 1388, 'the database refuses ciphertext shorter than a padded record')
})

test('plain columns in the wrong shape are refused before anything is encrypted', async () => {
  const key = await makeDataKey()
  const bad = [
    { ...weekPlain(), season: '2026' },              // a number sent as text
    { ...weekPlain(), id: 'not-a-uuid' },
    { ...weekPlain(), id: crypto.randomUUID().toUpperCase() },
    { ...weekPlain(), version_no: 1.5 },
  ]
  for (const plain of bad) {
    await assert.rejects(encryptRecord('week_versions', plain, weekRecord, key), JSON.stringify(plain))
  }
  assert.throws(() => aadFor('audit_entries', { id: crypto.randomUUID(), seq: 2, prev_hash: 'abc', v: 1 }))
})

test('a record too big for the database is refused', () => {
  assert.throws(() => padJson('x'.repeat(300 * 1024)))
})

// ---------- Bytes, base64 and hex ----------

test('base64 and hex round-trip, and junk is refused', () => {
  const bytes = randomBytes(33)
  assert.deepEqual(fromBase64(toBase64(bytes)), bytes)
  assert.deepEqual(fromHex(toHex(bytes)), bytes)
  for (const junk of ['abc', 'ab$=', 'a=bc', 'ab==cd==']) assert.throws(() => fromBase64(junk), junk)
  for (const junk of ['abc', 'AB', 'zz']) assert.throws(() => fromHex(junk), junk)
})
