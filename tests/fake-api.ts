// A fake Supabase for the account tests. It keeps every table in memory and
// follows the database's rules that the account flows depend on:
//   - sign-up needs an invite, and sign-in checks the login token
//   - a password change needs the current login token
//   - the recover function: the proof's hash, and 5 wrong tries a day
//   - set_recovery_proof: the first proof is free, and replacing one needs
//     the current proof or a password sign-in from the last 5 minutes
//   - rows in the database's shapes (checked by rows.ts), IDs unique in each
//     table, version numbers unique in each account
//   - delete_old_key_wraps(kind) clears only older wraps of that kind
//   - latest_week_versions gives each week's newest version
//   - save_week_with_audit saves its two rows together, or neither
//   - the football tables, which only signed-in users can read
//
// It can also break any one call the way a network or a closed tab would,
// so the tests can show that a flow stopping anywhere still leaves a way in.
import { createHash, randomUUID } from 'node:crypto'
import {
  ServerError, type AccountApi, type AuditRow, type AuthResult, type FixtureRow, type InviteRow, type RecordTable, type Rows, type SaveResult,
  type Stored, type SyncStatusRow, type Table, type TeamRow, type WeekKey, type WeekRow,
} from '../src/lib/account/api.ts'
import { isRow } from '../src/lib/account/rows.ts'
import { tidyEmail } from '../src/lib/crypto/kdf.ts'
import { isInviteEmail } from '../src/lib/invites.ts'
import type { KeyWrapKind } from '../src/lib/crypto/keys.ts'

// How one call can break:
//   refused  the request never arrives, and the tab hears the network failed
//   lost     the server does the work, but its answer never arrives
//   crash    the server does the work, then the tab closes, so nothing after it runs
export type Fault = 'refused' | 'lost' | 'crash'
export const FAULTS: Fault[] = ['refused', 'lost', 'crash']

// What a 'crash' throws. The flows never catch it, just as nothing runs
// after a tab closes.
export class TabClosed extends Error {}

type Account = {
  id: string
  email: string
  loginToken: string
  proofHash: string | null
  recoveryTries: { at: number; ok: boolean }[]
}
type ServerRow<T extends Table> = Stored<Rows[T]> & { user_id: string }
type State = {
  clock: number // milliseconds
  invites: { email: string; addedAt: string }[]
  admins: string[] // account IDs, as in private.app_admins
  accounts: Account[]
  rows: { [T in Table]: ServerRow<T>[] }
  football: { teams: TeamRow[]; fixtures: FixtureRow[]; syncStatus: SyncStatusRow }
}

const DAY = 24 * 60 * 60 * 1000
const HEX_64 = /^[0-9a-f]{64}$/
const UNAVAILABLE: AuthResult = { ok: false, problem: 'unavailable' }

export class FakeServer {
  state: State
  calls = 0
  private readonly faults = new Map<number, Fault>()

  constructor(state?: State) {
    this.state = state ?? {
      clock: Date.parse('2026-11-02T12:00:00.000Z'),
      invites: [],
      admins: [],
      accounts: [],
      rows: { key_wraps: [], week_versions: [], settings_versions: [], audit_entries: [] },
      football: { teams: [], fixtures: [], syncStatus: { last_attempt_at: null, last_success_at: null } },
    }
  }

  // A copy of everything, so each test run can start from the same place.
  snapshot(): State {
    return structuredClone(this.state)
  }

  static from(snapshot: State): FakeServer {
    return new FakeServer(structuredClone(snapshot))
  }

  invite(email: string): void {
    this.state.invites.push({ email: tidyEmail(email), addedAt: this.now() })
  }

  makeAdmin(email: string): void {
    const account = this.account(email)
    if (account === undefined) throw new Error(`No account for ${email}`)
    this.state.admins.push(account.id)
  }

  advance(milliseconds: number): void {
    this.state.clock += milliseconds
  }

  // A new browser tab, signed out.
  tab(): FakeTab {
    return new FakeTab(this)
  }

  // Breaks the nth call from now, counting calls from every tab.
  breakCall(n: number, fault: Fault): void {
    this.faults.set(this.calls + n, fault)
  }

  // Counts a call and says whether it should break.
  nextCall(): Fault | undefined {
    this.calls++
    return this.faults.get(this.calls)
  }

  account(email: string): Account | undefined {
    return this.state.accounts.find(account => account.email === tidyEmail(email))
  }

  // An account's rows, as its own tab would read them.
  rowsOf<T extends Table>(accountId: string, table: T): Stored<Rows[T]>[] {
    const rows = this.state.rows[table] as ServerRow<T>[]
    return rows.filter(row => row.user_id === accountId).map(({ user_id: _owner, ...row }) => row as unknown as Stored<Rows[T]>)
  }

  // What an insider with database access can do: remove any row, or add one
  // to anyone's account, skipping every rule.
  insiderDelete(table: Table, id: string): void {
    const rows: { id: string }[] = this.state.rows[table]
    const index = rows.findIndex(row => row.id === id)
    if (index === -1) throw new Error(`No ${table} row ${id}`)
    rows.splice(index, 1)
  }

  insiderAdd<T extends Table>(table: T, accountId: string, row: Rows[T]): void {
    ;(this.state.rows[table] as ServerRow<T>[]).push({ ...row, user_id: accountId, created_at: this.now() } as unknown as ServerRow<T>)
  }

  now(): string {
    return new Date(this.state.clock).toISOString()
  }
}

// The unique columns besides the ID, per account, for each table.
function versionKey(table: Table, row: Rows[Table]): string {
  const r = row as Record<string, unknown>
  if (table === 'key_wraps') return `${r.kind} ${r.version_no}`
  if (table === 'week_versions') return `${r.season} ${r.competition} ${r.period} ${r.version_no}`
  if (table === 'settings_versions') return `${r.version_no}`
  return `${r.seq}`
}

function sha256Hex(hex: string): string {
  return createHash('sha256').update(Buffer.from(hex, 'hex')).digest('hex')
}

// One browser tab: its own session, sharing the server with other tabs.
export class FakeTab implements AccountApi {
  private session: { accountId: string; signedInAt: number } | null = null
  private readonly server: FakeServer

  constructor(server: FakeServer) {
    this.server = server
  }

  // Runs one call, breaking it if the test asked for that.
  private async run<T>(work: () => T, networkFailed: () => T): Promise<T> {
    const fault = this.server.nextCall()
    if (fault === 'refused') return networkFailed()
    const answer = work()
    if (fault === 'lost') return networkFailed()
    if (fault === 'crash') throw new TabClosed()
    return answer
  }

  private me(): Account {
    const account = this.server.state.accounts.find(a => a.id === this.session?.accountId)
    if (account === undefined) throw new ServerError() // signed out: the database refuses
    return account
  }

  private signInAs(account: Account): void {
    this.session = { accountId: account.id, signedInAt: this.server.state.clock }
  }

  signUp(email: string, loginToken: string): Promise<AuthResult> {
    return this.run<AuthResult>(() => {
      const tidy = tidyEmail(email)
      if (this.server.account(tidy) !== undefined) return { ok: false, problem: 'exists' }
      if (!this.server.state.invites.some(each => each.email === tidy)) return { ok: false, problem: 'not-invited' }
      const account: Account = { id: randomUUID(), email: tidy, loginToken, proofHash: null, recoveryTries: [] }
      this.server.state.accounts.push(account)
      this.signInAs(account)
      return { ok: true }
    }, () => UNAVAILABLE)
  }

  signIn(email: string, loginToken: string): Promise<AuthResult> {
    return this.run<AuthResult>(() => {
      const account = this.server.account(email)
      if (account === undefined || account.loginToken !== loginToken) return { ok: false, problem: 'wrong' }
      this.signInAs(account)
      return { ok: true }
    }, () => UNAVAILABLE)
  }

  changePassword(currentLoginToken: string, newLoginToken: string): Promise<AuthResult> {
    return this.run<AuthResult>(() => {
      const account = this.me()
      if (account.loginToken !== currentLoginToken) return { ok: false, problem: 'wrong' }
      account.loginToken = newLoginToken
      return { ok: true }
    }, () => UNAVAILABLE)
  }

  // The recover function and recovery_check together.
  recover(email: string, proofHex: string, newLoginToken: string): Promise<boolean> {
    return this.run(() => {
      if (!HEX_64.test(proofHex) || !HEX_64.test(newLoginToken)) return false
      const account = this.server.account(email)
      if (account === undefined) return false
      const now = this.server.state.clock
      if (account.recoveryTries.filter(t => !t.ok && t.at > now - DAY).length >= 5) return false
      const ok = account.proofHash !== null && account.proofHash === sha256Hex(proofHex)
      account.recoveryTries.push({ at: now, ok })
      if (ok) account.loginToken = newLoginToken
      return ok
    }, () => {
      throw new ServerError()
    })
  }

  signOut(): Promise<void> {
    // supabase-js forgets the session even when the network fails.
    return this.run(() => {
      this.session = null
    }, () => {
      this.session = null
    })
  }

  keyWraps(): Promise<Stored<Rows['key_wraps']>[]> {
    return this.run(() => this.server.rowsOf(this.me().id, 'key_wraps'), () => {
      throw new ServerError()
    })
  }

  addKeyWrap(row: Rows['key_wraps']): Promise<SaveResult> {
    return this.run(() => this.insert('key_wraps', row), () => {
      throw new ServerError()
    })
  }

  deleteOldKeyWraps(kind: KeyWrapKind): Promise<number> {
    return this.run(() => {
      const me = this.me().id
      if (kind !== 'password' && kind !== 'recovery') throw new ServerError()
      const all = this.server.state.rows.key_wraps
      const newest = Math.max(0, ...all.filter(w => w.user_id === me && w.kind === kind).map(w => w.version_no))
      const keep = all.filter(w => !(w.user_id === me && w.kind === kind && w.version_no < newest))
      const removed = all.length - keep.length
      this.server.state.rows.key_wraps = keep
      return removed
    }, () => {
      throw new ServerError()
    })
  }

  setRecoveryProof(newProofHashHex: string, currentProofHex?: string): Promise<boolean> {
    return this.run(() => {
      const account = this.me()
      if (!HEX_64.test(newProofHashHex)) return false
      // The 5-minute rule from step 7.3, allowing a minute the other way.
      const age = (this.server.state.clock - (this.session?.signedInAt ?? -Infinity)) / 1000
      const signedInRecently = age >= -60 && age <= 300
      const knowsCurrent = currentProofHex !== undefined && HEX_64.test(currentProofHex)
        && account.proofHash === sha256Hex(currentProofHex)
      if (account.proofHash !== null && !signedInRecently && !knowsCurrent) return false
      account.proofHash = newProofHashHex
      return true
    }, () => {
      throw new ServerError()
    })
  }

  records<T extends RecordTable>(table: T): Promise<Stored<Rows[T]>[]> {
    return this.run(() => this.server.rowsOf(this.me().id, table), () => {
      throw new ServerError()
    })
  }

  addRecord<T extends RecordTable>(table: T, row: Rows[T]): Promise<SaveResult> {
    return this.run(() => this.insert(table, row), () => {
      throw new ServerError()
    })
  }

  hasRecords(): Promise<boolean> {
    return this.run(() => {
      const me = this.me().id
      return (['week_versions', 'settings_versions', 'audit_entries'] as const)
        .some(table => this.server.rowsOf(me, table).length > 0)
    }, () => {
      throw new ServerError()
    })
  }

  latestWeekVersions(): Promise<Stored<WeekRow>[]> {
    return this.run(() => {
      const newest = new Map<string, Stored<WeekRow>>()
      for (const row of this.server.rowsOf(this.me().id, 'week_versions')) {
        const week = `${row.season} ${row.competition} ${row.period}`
        const seen = newest.get(week)
        if (seen === undefined || row.version_no > seen.version_no) newest.set(week, row)
      }
      return [...newest.values()]
    }, () => {
      throw new ServerError()
    })
  }

  weekVersions(week: WeekKey): Promise<Stored<WeekRow>[]> {
    return this.run(() => this.server.rowsOf(this.me().id, 'week_versions').filter(row =>
      row.season === week.season && row.competition === week.competition && row.period === week.period), () => {
      throw new ServerError()
    })
  }

  lastAuditEntry(): Promise<Stored<AuditRow> | null> {
    return this.run(() => {
      const rows = this.server.rowsOf(this.me().id, 'audit_entries')
      return rows.reduce<Stored<AuditRow> | null>((last, row) => (last === null || row.seq > last.seq ? row : last), null)
    }, () => {
      throw new ServerError()
    })
  }

  // Both inserts in one transaction: if either is refused, neither is saved.
  saveWeekWithAudit(week: WeekRow, audit: AuditRow): Promise<SaveResult> {
    return this.run(() => {
      this.me()
      if (!isRow('week_versions', week) || !isRow('audit_entries', audit)) throw new ServerError()
      if (this.isTaken('week_versions', week) || this.isTaken('audit_entries', audit)) return 'taken'
      this.add('week_versions', week)
      this.add('audit_entries', audit)
      return 'saved'
    }, () => {
      throw new ServerError()
    })
  }

  teams(): Promise<TeamRow[]> {
    return this.run(() => {
      this.me()
      return structuredClone(this.server.state.football.teams)
    }, () => {
      throw new ServerError()
    })
  }

  fixtures(season: number): Promise<FixtureRow[]> {
    return this.run(() => {
      this.me()
      return structuredClone(this.server.state.football.fixtures.filter(row => row.season === season))
    }, () => {
      throw new ServerError()
    })
  }

  fixturesBetween(from: string, to: string): Promise<FixtureRow[]> {
    return this.run(() => {
      this.me()
      const start = Date.parse(from)
      const end = Date.parse(to)
      if (!(start < end)) throw new RangeError('A span of kick-off times runs from an earlier time to a later one.')
      return structuredClone(this.server.state.football.fixtures.filter(row => {
        const kickoff = Date.parse(row.kickoff)
        return kickoff >= start && kickoff < end
      }))
    }, () => {
      throw new ServerError()
    })
  }

  syncStatus(): Promise<SyncStatusRow> {
    return this.run(() => {
      this.me()
      return structuredClone(this.server.state.football.syncStatus)
    }, () => {
      throw new ServerError()
    })
  }

  // invite_list, invite_add and invite_remove: for app admins only, and
  // emails tidied and checked as the database does.
  inviteList(): Promise<InviteRow[] | null> {
    return this.run(() => {
      if (!this.isAdmin()) return null
      return [...this.server.state.invites].reverse().map(each => ({
        email: each.email, added_at: each.addedAt, has_account: this.server.state.accounts.some(account => account.email === each.email),
      }))
    }, () => {
      throw new ServerError()
    })
  }

  inviteAdd(email: string): Promise<boolean> {
    return this.run(() => {
      if (!this.isAdmin()) return false
      const tidy = tidyEmail(email)
      if (!isInviteEmail(tidy)) throw new ServerError() // the table's check refuses it
      if (!this.server.state.invites.some(each => each.email === tidy)) this.server.state.invites.push({ email: tidy, addedAt: this.server.now() })
      return true
    }, () => {
      throw new ServerError()
    })
  }

  inviteRemove(email: string): Promise<boolean> {
    return this.run(() => {
      if (!this.isAdmin()) return false
      const tidy = tidyEmail(email)
      this.server.state.invites = this.server.state.invites.filter(each => each.email !== tidy)
      return true
    }, () => {
      throw new ServerError()
    })
  }

  private isAdmin(): boolean {
    return this.server.state.admins.includes(this.me().id)
  }

  // An insert, with the database's checks.
  private insert<T extends Table>(table: T, row: Rows[T]): SaveResult {
    const me = this.me().id
    if (!isRow(table, row)) throw new ServerError() // a check or domain refused it
    if (this.isTaken(table, row)) return 'taken'
    if (table === 'key_wraps' && this.server.state.rows.key_wraps.filter(other => other.user_id === me).length >= 200) throw new ServerError()
    this.add(table, row)
    return 'saved'
  }

  // True if a unique rule refuses the row: its ID, or its version number in this account.
  private isTaken<T extends Table>(table: T, row: Rows[T]): boolean {
    const me = this.me().id
    const rows = this.server.state.rows[table] as ServerRow<T>[]
    return rows.some(other => other.id === row.id || (other.user_id === me && versionKey(table, other) === versionKey(table, row)))
  }

  private add<T extends Table>(table: T, row: Rows[T]): void {
    const rows = this.server.state.rows[table] as ServerRow<T>[]
    rows.push({ ...row, user_id: this.me().id, created_at: this.server.now() } as unknown as ServerRow<T>)
  }
}
