// Tests for step 10.5: the invite list (src/lib/invites.ts, and the three
// invite calls on the tests' fake server, which follow the database's
// functions), and the line at the top of Settings' audit log (auditCheck in
// src/lib/bets/view.ts). The database's own refusals are tested in
// tests/schema.test.mjs, and supabase-api.ts's in tests/supabase-api.test.ts.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ServerError, type InviteRow } from '../src/lib/account/api.ts'
import type { AuditEntry } from '../src/lib/bets/audit.ts'
import { auditCheck } from '../src/lib/bets/view.ts'
import { inviteProblem, inviteSummary, isInviteEmail } from '../src/lib/invites.ts'
import { FakeServer } from './fake-api.ts'

const row = (email: string, has_account = false): InviteRow => ({ email, added_at: '2026-11-08T12:00:00+00:00', has_account })

test("An invite's email: the table's rule, tidied first, and not already on the list", () => {
  assert.equal(isInviteEmail('sam@example.com'), true)
  assert.equal(isInviteEmail('sam@example'), false)            // no dot after the @
  assert.equal(isInviteEmail('sam @example.com'), false)
  assert.equal(isInviteEmail('sam@@example.com'), false)
  assert.equal(isInviteEmail(`${'a'.repeat(242)}@example.com`), true)  // 254 characters, the most
  assert.equal(isInviteEmail(`${'a'.repeat(243)}@example.com`), false)
  const list = [row('jordan@example.com', true)]
  assert.equal(inviteProblem('  Sam@Example.com ', list), null)
  assert.equal(inviteProblem('   ', list), 'Enter an email.')
  assert.equal(inviteProblem('sam', list), 'Enter an email like name@example.com.')
  assert.equal(inviteProblem('JORDAN@example.com', list), 'That email is already on the list.')
  assert.equal(inviteSummary([]), 'No invites yet.')
  assert.equal(inviteSummary([row('a@example.com', true), row('b@example.com'), row('c@example.com', true)]), '3 invites, 2 with an account.')
  assert.equal(inviteSummary([row('a@example.com', true), row('b@example.com', true)]), '2 invites, all with an account.')
  assert.equal(inviteSummary([row('a@example.com')]), '1 invite, 0 with an account.')
})

test('Only an app admin gets the list, and adds or removes invites', async () => {
  const server = new FakeServer()
  for (const email of ['kman@example.com', 'jordan@example.com']) {
    server.invite(email)
    assert.deepEqual(await server.tab().signUp(email, 'a'.repeat(64)), { ok: true })
  }
  server.makeAdmin('kman@example.com')
  const admin = server.tab()
  await admin.signIn('kman@example.com', 'a'.repeat(64))
  const friend = server.tab()
  await friend.signIn('jordan@example.com', 'a'.repeat(64))

  // Anyone else is refused: no list, and nothing added or removed.
  assert.equal(await friend.inviteList(), null)
  assert.equal(await friend.inviteAdd('sam@example.com'), false)
  assert.equal(await friend.inviteRemove('jordan@example.com'), false)
  assert.equal(server.state.invites.length, 2)

  server.advance(60_000)
  assert.equal(await admin.inviteAdd(' Sam@Example.com '), true)
  assert.equal(await admin.inviteAdd('sam@example.com'), true) // already there: nothing changes
  assert.deepEqual((await admin.inviteList())?.map(each => [each.email, each.has_account]),
    [['sam@example.com', false], ['jordan@example.com', true], ['kman@example.com', true]])
  await assert.rejects(admin.inviteAdd('not an email'), ServerError)

  // Removing an invite leaves the account it led to.
  assert.equal(await admin.inviteRemove('jordan@example.com'), true)
  assert.deepEqual((await admin.inviteList())?.map(each => each.email), ['sam@example.com', 'kman@example.com'])
  assert.notEqual(server.account('jordan@example.com'), undefined)
  assert.deepEqual(await server.tab().signUp('jordan2@example.com', 'a'.repeat(64)), { ok: false, problem: 'not-invited' })
})

test("The audit log's top line: it checks out, or the first thing wrong", () => {
  const entries = (n: number): AuditEntry[] => Array.from({ length: n }, (_, i) => ({ seq: i + 1, savedAt: '2026-11-22T14:41:00Z', record: null }))
  const backups = ' Your backups hold their own copy of the log.'
  assert.equal(auditCheck([], []), null)
  assert.deepEqual(auditCheck(entries(1), []), { ok: true, text: 'Its 1 entry opens and checks out.' })
  assert.deepEqual(auditCheck(entries(4), []), { ok: true, text: 'All 4 entries open and check out, and each is linked to the one before it.' })
  assert.deepEqual(auditCheck(entries(4), [{ kind: 'broken', seq: 3 }]),
    { ok: false, text: `Entry 3 doesn't link to entry 2, so something in the log changed after it was saved.${backups}` })
  assert.equal(auditCheck(entries(2), [{ kind: 'missing', from: 2, to: 3 }])?.text, `Entries 2 to 3 are missing, so something in the log changed after it was saved.${backups}`)
  assert.equal(auditCheck(entries(2), [{ kind: 'missing', from: 1, to: 1 }])?.text.startsWith('Entry 1 is missing,'), true)
  assert.equal(auditCheck(entries(3), [{ kind: 'unreadable', seq: 2 }, { kind: 'broken', seq: 3 }, { kind: 'unreadable', seq: 3 }])?.text,
    `Entry 2 doesn't open, so something in the log changed after it was saved. It has 2 other problems too.${backups}`)
})
