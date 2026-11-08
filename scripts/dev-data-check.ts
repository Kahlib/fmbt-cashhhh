// FMBT Cashhhh: run step 9's code against the DEV project (step 9.3).
//
// The unit tests run the bets code against a fake server. This runs the same
// code, unchanged, against the real dev project, signed in as junk account A
// from the attack check, with the fixtures dev's sync has filled:
//   - loads the fixtures and every week, checking every row on the way in
//   - adds a parlay on finished matches, saves it, and reads it back in a
//     second tab, whose own save then makes the first tab's save find its
//     version number taken
//   - settles the parlays from the 90-minute scores, which locks them, and
//     checks a boosted one's return
//   - edits a locked parlay with an audit entry, then shows that a stale
//     tab's edit saves neither of its two rows
//   - deletes the week with an audit entry, and reads it all back, the audit
//     log's chain included
//   - checks junk account B sees none of it
//
// Every run makes a new random data key and keeps it in memory, the way the
// app keeps yours, so an earlier run's records don't open in a later one.
// The check expects that, and counts those records along with the attack
// check's junk rows. Nothing on dev can delete rows, so every run leaves a
// few more versions and audit entries in junk account A, and nothing else.
//
// Run it from the repo folder in PowerShell, once the attack check has run,
// since it reads the junk accounts' passwords from
// private-data/dev-test-accounts.json:
//   node scripts/dev-data-check.ts
// It refuses to run against the production project, and it never prints a
// password, token or key.
import { existsSync, readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import type { AccountApi, AuditRow, Stored } from '../src/lib/account/api.ts'
import { supabaseApi } from '../src/lib/account/supabase-api.ts'
import { chainHash, loadAuditLog, sealAuditEntry } from '../src/lib/bets/audit.ts'
import { isParlayLocked, parlayOutcome } from '../src/lib/bets/settle.ts'
import { addParlay, byScoreFor, EMPTY_WEEK, resultOf, type NewLeg, type Pick, type Week, type WeekRecord } from '../src/lib/bets/week-record.ts'
import { deleteWeek, loadWeek, loadWeeks, newWeek, saveWeek, settleWeeks, visibleWeeks, type LoadedWeek } from '../src/lib/bets/weeks.ts'
import { byId, loadFixtures, loadSyncStatus, type Fixture } from '../src/lib/fixtures.ts'

const EMAIL_A = 'test-a@fmbtcashhhh.com'
const EMAIL_B = 'test-b@fmbtcashhhh.com'
const ACCOUNTS = 'private-data/dev-test-accounts.json'

function stop(message: string): never {
  console.log(message)
  process.exit(1)
}

// npm run dev's file holds the dev project's two values, which are public.
const readValue = (file: string, name: string) =>
  existsSync(file) ? readFileSync(file, 'utf8').match(new RegExp(`^${name}=(\\S+)$`, 'm'))?.[1] : undefined
const url = (process.env.DEV_SUPABASE_URL ?? readValue('.env.development.local', 'VITE_SUPABASE_URL') ?? '').replace(/\/$/, '')
const key = process.env.DEV_SUPABASE_PUBLISHABLE_KEY ?? readValue('.env.development.local', 'VITE_SUPABASE_PUBLISHABLE_KEY') ?? ''
if (!/^https:\/\/[a-z0-9]+\.supabase\.co$/.test(url)) stop("The dev project's URL is missing from .env.development.local, or doesn't look like https://<ref>.supabase.co.")
if (!key.startsWith('sb_publishable_')) stop('Use the publishable key, never a secret key.')
if (url === readValue('.env.production', 'VITE_SUPABASE_URL')) stop("That's the production project. This check only ever runs against dev.")

if (!existsSync(ACCOUNTS)) stop('Run node scripts/dev-attack-check.mjs first. It makes the junk accounts this check signs in as.')
const accounts: unknown = JSON.parse(readFileSync(ACCOUNTS, 'utf8'))
const loginToken = (name: 'a' | 'b'): string => {
  const value = typeof accounts === 'object' && accounts !== null ? (accounts as Record<string, unknown>)[name] : undefined
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) stop(`${ACCOUNTS} doesn't hold account ${name.toUpperCase()}'s password.`)
  return value
}

// A new browser tab, signed in, with the app's own server calls.
async function tab(email: string, token: string): Promise<AccountApi> {
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } })
  const api = supabaseApi(client, { url, publishableKey: key })
  const result = await api.signIn(email, token)
  if (!result.ok) stop(`Couldn't sign in as ${email}: ${result.problem}. Run the attack check, then this again.`)
  return api
}

const now = () => new Date().toISOString()
const results: { id: string; name: string; pass: boolean; detail: string }[] = []
const check = (id: string, name: string, pass: boolean, detail: string) => results.push({ id, name, pass, detail })

function report(): never {
  const failed = results.filter(result => !result.pass).length
  for (const result of results) console.log(`${result.pass ? 'PASS' : 'FAIL'}  ${result.id}  ${result.name}  -> ${result.detail}`)
  console.log(`\n${results.length - failed} of ${results.length} passed`)
  process.exit(failed > 0 || results.length < 10 ? 1 : 0)
}

// Runs one step. If it throws, the check fails with the error's name and the
// app's own message, which never repeats what the server said, and the
// steps after it, which build on it, don't run.
async function step<T>(id: string, name: string, work: () => Promise<{ pass: boolean; detail: string; value: T }>): Promise<T> {
  try {
    const { pass, detail, value } = await work()
    check(id, name, pass, detail)
    if (!pass) report()
    return value
  } catch (error) {
    check(id, name, false, error instanceof Error ? `${error.name}: ${error.message}` : 'it stopped')
    report()
  }
}

const sameWeek = (a: Week, b: Week) => a.season === b.season && a.competition === b.competition && a.period === b.period
const savedWeek = (result: Awaited<ReturnType<typeof saveWeek>>): LoadedWeek | null => (result.result === 'saved' ? result.week : null)
const otherThan = (pick: Pick): Pick => (pick === 'H' ? 'A' : 'H')

// The season starting this year from 1 July, otherwise the one that started
// last year. 2026 means 2026/27.
const today = new Date()
const SEASON = today.getUTCMonth() >= 6 ? today.getUTCFullYear() : today.getUTCFullYear() - 1

const dataKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
const a = await tab(EMAIL_A, loginToken('a'))

// W01: the football tables, as the app reads them.
const fixtures = await step('W01', 'The fixtures, teams and sync status load, every row passing the checks', async () => {
  const loaded = await loadFixtures(a, SEASON)
  const status = await loadSyncStatus(a)
  const finished = loaded.fixtures.filter(each => each.status === 'finished').length
  return {
    pass: loaded.fixtures.length > 0 && loaded.teams.size > 0 && status.lastSuccessAt !== null,
    detail: `${loaded.fixtures.length} fixtures in ${SEASON}, ${finished} finished, ${loaded.teams.size} teams, last synced ${status.lastSuccessAt}`,
    value: loaded.fixtures,
  }
})

// The latest Premier League matchweek with a finished match, and up to two of its finished matches.
const finished = fixtures
  .filter(each => each.competition === 'PL' && each.status === 'finished' && each.home_90 !== null && each.away_90 !== null)
  .sort((x, y) => y.kickoff.localeCompare(x.kickoff))
const latest = finished[0]
if (latest === undefined) stop('Dev has no finished Premier League match yet, so there is nothing to settle.')
const WEEK: Week = { season: SEASON, competition: 'PL', period: latest.period }
const games: Fixture[] = finished.filter(each => each.period === WEEK.period).slice(0, 2)
const scoreOf = (game: Fixture): [number, number] => [game.home_90 ?? 0, game.away_90 ?? 0]

// W02: every week, with this run's new key.
const start = await step('W02', 'Every week loads, skipping versions this key can\'t open', async () => {
  const loaded = await loadWeeks(a, dataKey)
  const unreadable = loaded.warnings.reduce((sum, warning) => sum + warning.unreadable, 0)
  return {
    pass: true,
    detail: `${loaded.weeks.length} weeks, ${unreadable} versions that don't open with this run's key (earlier runs, and the attack check's junk)`,
    value: loaded.weeks.find(each => sameWeek(each.week, WEEK)) ?? newWeek(WEEK),
  }
})

// W03: add a parlay the way Build parlay will, save it, and read it in another tab.
const legs: NewLeg[] = games.map((game, i) => {
  const result = resultOf(scoreOf(game))
  return { fixtureId: game.id, pick: i === 0 ? result : otherThan(result), odds: i === 0 ? 150 : -110, confidence: 3 }
})
const a2 = await tab(EMAIL_A, loginToken('a'))
const first = await step('W03', 'A parlay on finished games saves as the next version, and another tab reads it back', async () => {
  const added = addParlay(start.record.deleted ? EMPTY_WEEK : start.record, WEEK, fixtures, { stakeCents: 2500, boostBps: 0, legs })
  if (!added.ok) return { pass: false, detail: `the parlay was refused: ${added.problem}`, value: start }
  const week = savedWeek(await saveWeek(a, dataKey, start, added.record, now()))
  const back = (await loadWeek(a2, dataKey, WEEK)).week
  return {
    pass: week !== null && week.version === start.newestVersion + 1 && JSON.stringify(back.record) === JSON.stringify(week.record),
    detail: `${WEEK.period}, version ${week?.version}, ${legs.length} legs: ${games.map(g => `${g.home} v ${g.away} ${scoreOf(g).join('-')}`).join(', ')}`,
    value: week ?? start,
  }
})

// W04: two tabs. The other tab adds a $10 single on the first game, the
// one picked right, with a 2.5% boost.
const twoTabs = await step('W04', "When another tab saves first, this tab's save finds its version number taken", async () => {
  const more = addParlay(first.record, WEEK, fixtures, { stakeCents: 1000, boostBps: 250, legs: legs.slice(0, 1) })
  if (!more.ok) return { pass: false, detail: `the parlay was refused: ${more.problem}`, value: first }
  const theirs = savedWeek(await saveWeek(a2, dataKey, first, more.record, now()))
  const mine = await saveWeek(a, dataKey, first, more.record, now())
  const reloaded = (await loadWeek(a, dataKey, WEEK)).week
  return {
    pass: theirs !== null && mine.result === 'taken' && reloaded.version === theirs.version,
    detail: `the other tab saved version ${theirs?.version}, and this one's save was ${mine.result}`,
    value: reloaded,
  }
})

// W05: settle from dev's real 90-minute scores. The boosted single won at
// +150, so it returns $10 × 2.5 = $25, plus 2.5% of the $15 profit, $0.375,
// which rounds down to $25.37.
const locked = await step('W05', 'Settling from the 90-minute scores saves a version, locks each parlay, and the boosted single returns $25.37', async () => {
  const [result] = await settleWeeks(a, dataKey, [twoTabs], byId(fixtures), now())
  if (result === undefined) return { pass: false, detail: 'nothing came back', value: twoTabs }
  const parlays = result.week.record.parlays
  const allRight = parlays.flatMap(p => p.legs).every(l => {
    const game = games.find(g => g.id === l.fixtureId)
    return game !== undefined && l.settlement?.how === 'auto' && l.settlement.outcome === byScoreFor(l.pick, scoreOf(game))
  })
  const lockedCount = parlays.filter(isParlayLocked).length
  const single = parlays.at(-1)
  const returned = single === undefined ? null : parlayOutcome(single).payoutCents
  return {
    pass: allRight && lockedCount === parlays.length && single?.boostBps === 250 && returned === 2537
      && result.week.version === twoTabs.newestVersion + 1,
    detail: `${result.settled} legs settled, version ${result.week.version}, ${lockedCount} of ${parlays.length} parlays locked, `
      + `the boosted single returns ${returned === null ? 'nothing' : `$${(returned / 100).toFixed(2)}`}`,
    value: result.week,
  }
})

// The week with its first leg's odds changed: an edit.
function withOdds(record: WeekRecord, odds: number): WeekRecord {
  const copy = structuredClone(record)
  const leg = copy.parlays[0]?.legs[0]
  if (leg !== undefined) leg.odds = odds
  return copy
}
const auditBefore = await a.lastAuditEntry()

// W06: an edit to a locked parlay.
const edited = await step('W06', "A locked parlay's edit needs a reason, and saves its audit entry with it, chained to the last", async () => {
  const refused = await saveWeek(a, dataKey, locked, withOdds(locked.record, 160), now()).then(() => false, (error: unknown) => error instanceof RangeError)
  const week = savedWeek(await saveWeek(a, dataKey, locked, withOdds(locked.record, 160), now(), 'Dev data check: odds corrected'))
  const entry = await a.lastAuditEntry()
  const chained = entry !== null && entry.seq === (auditBefore?.seq ?? 0) + 1
    && entry.prev_hash === (auditBefore === null ? null : await chainHash(auditBefore.ct))
  return {
    pass: refused && week !== null && chained,
    detail: `without a reason: ${refused ? 'refused' : 'saved'}; with one: version ${week?.version}, audit entry ${entry?.seq}`,
    value: week ?? locked,
  }
})

// W07: two tabs editing a locked parlay, both ways round.
await step('W07', "A stale tab's locked edit saves neither its week version nor its audit entry", async () => {
  // A stale week version: the other tab still has the week from before W06.
  const entryBefore = await a.lastAuditEntry()
  const staleWeek = await saveWeek(a2, dataKey, locked, withOdds(locked.record, 170), now(), 'Dev data check: stale tab')
  const entryAfter = await a.lastAuditEntry()
  // A stale audit number: the other tab adds an entry between this tab's two calls.
  const stray: { entry: Stored<AuditRow> | null } = { entry: null }
  const interrupted: AccountApi = new Proxy(a, {
    get: (target, prop, receiver) => (prop !== 'lastAuditEntry' ? Reflect.get(target, prop, receiver) : async () => {
      const last = await target.lastAuditEntry()
      const record = {
        schema: 1 as const, at: now(), week: WEEK, fromVersion: edited.version, toVersion: edited.version + 1,
        changes: [{ what: 'Dev data check: an entry from another tab', from: null, to: null }], reason: 'Dev data check: another tab',
      }
      if ((await a2.addRecord('audit_entries', await sealAuditEntry(record, last, dataKey))) === 'saved') stray.entry = await a2.lastAuditEntry()
      return last
    }),
  })
  const staleNumber = await saveWeek(interrupted, dataKey, edited, withOdds(edited.record, 180), now(), 'Dev data check: this tab')
  const versions = (await a.weekVersions(WEEK)).length
  const newest = (await loadWeek(a, dataKey, WEEK)).week
  return {
    pass: staleWeek.result === 'taken' && entryAfter?.seq === entryBefore?.seq && stray.entry !== null
      && staleNumber.result === 'taken' && newest.newestVersion === edited.version,
    detail: `stale version: ${staleWeek.result}, audit entries unchanged at ${entryAfter?.seq}; `
      + `stale audit number: ${staleNumber.result}, and the week still ends at version ${newest.newestVersion} (${versions} versions)`,
    value: null,
  }
})

// W08: delete it, as Admin mode will.
const deleted = await step('W08', 'Deleting the week, with its locked parlays, saves a tombstone and its audit entry', async () => {
  const current = (await loadWeek(a, dataKey, WEEK)).week
  const entryBefore = await a.lastAuditEntry()
  const week = savedWeek(await deleteWeek(a, dataKey, current, now(), 'Dev data check: tidying up'))
  const entryAfter = await a.lastAuditEntry()
  return {
    pass: week !== null && week.record.deleted && entryAfter?.seq === (entryBefore?.seq ?? 0) + 1,
    detail: `version ${week?.version}, audit entry ${entryAfter?.seq}`,
    value: week ?? current,
  }
})

// W09: everything, read back in a new tab.
await step('W09', "Everything reads back: the week is deleted and hidden, and this run's audit entries open, with the chain whole", async () => {
  const fresh = await tab(EMAIL_A, loginToken('a'))
  const weeks = (await loadWeeks(fresh, dataKey)).weeks
  const week = weeks.find(each => sameWeek(each.week, WEEK))
  const log = await loadAuditLog(fresh, dataKey)
  const firstThisRun = (auditBefore?.seq ?? 0) + 1
  const mine = log.entries.filter(entry => entry.seq >= firstThisRun)
  const chainProblems = log.problems.filter(problem => problem.kind !== 'unreadable')
  const unreadableNow = log.problems.filter(problem => problem.kind === 'unreadable' && problem.seq >= firstThisRun)
  const earlier = log.problems.filter(problem => problem.kind === 'unreadable' && problem.seq < firstThisRun).length
  return {
    pass: week?.version === deleted.version && week.record.deleted && !visibleWeeks(weeks).includes(week)
      && mine.length === 3 && mine.every(entry => entry.record !== null) && chainProblems.length === 0 && unreadableNow.length === 0,
    detail: `${WEEK.period} at version ${week?.version}, deleted; ${log.entries.length} audit entries, ${mine.length} from this run, `
      + `${earlier} from earlier runs that this key can't open, gaps or broken links: ${chainProblems.length}`,
    value: null,
  }
})

// W10: the other junk account.
await step('W10', 'Account B sees none of it', async () => {
  const b = await tab(EMAIL_B, loginToken('b'))
  const versions = await b.weekVersions(WEEK)
  const entry = await b.lastAuditEntry()
  const audit = await a.lastAuditEntry()
  return {
    pass: versions.length === 0 && (entry === null || entry.id !== audit?.id),
    detail: `${versions.length} of A's versions of ${WEEK.period}, and ${entry === null ? 'no' : 'only its own'} audit entries`,
    value: null,
  }
})

report()
