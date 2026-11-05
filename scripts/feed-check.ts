// FMBT Cashhhh: what football-data.org's feed really sends (step 8.1).
//
// The sync function in step 8.2 turns football-data's matches into our
// fixtures. Its docs don't name the Champions League's league phase, or say
// whether the free plan sends a live minute, so this asks the real feed once
// and prints what came back:
//   - how many matches each request returned, by stage, with matchday ranges
//   - every status, and every way a score ended (normal time, extra time or
//     a shootout), with one example of each
//   - teams missing a three-letter code or a short name
//   - whether any match has a minute, and the rate-limit headers
//
// It makes three requests: this season's Premier League and Champions
// League, and last season's Champions League, whose knockouts had extra time
// and shootouts. It prints counts and football facts only. It never prints
// the key, and it saves nothing.
//
// Run it with the key in FOOTBALL_DATA_KEY. The step 8 guide shows how to
// paste the key into a hidden prompt, so it never lands in your terminal's
// history:
//   node scripts/feed-check.ts

const API = 'https://api.football-data.org/v4'

// Headers whose values are safe to print. Any other x- header is named only,
// in case it describes the account.
const SHOWN_HEADERS = ['x-api-version', 'x-requests-available-minute', 'x-requestcounter-reset', 'retry-after']

// The season starting this year from 1 July, otherwise the one that started
// last year. 2026 means 2026/27.
export function seasonFor(date: Date): number {
  const year = date.getUTCFullYear()
  return date.getUTCMonth() >= 6 ? year : year - 1
}

// Reads an object's field, whatever was sent. Feed data is untrusted, so
// nothing below assumes a field exists or has the right type.
function field(value: unknown, name: string): unknown {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[name] : undefined
}

const text = (value: unknown) => (typeof value === 'string' ? value : value === undefined ? 'missing' : JSON.stringify(value))
const matchesText = (n: number) => `${n} ${n === 1 ? 'match' : 'matches'}`

// Counts values, then lists them most common first: "FINISHED 72, TIMED 72".
class Tally {
  private counts = new Map<string, number>()
  add(value: string) {
    this.counts.set(value, (this.counts.get(value) ?? 0) + 1)
  }
  get size() {
    return this.counts.size
  }
  toString() {
    return [...this.counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([value, n]) => `${value} ${n}`).join(', ') || 'none'
  }
}

type StageSummary = { matches: number; matchdays: Set<number>; statuses: Tally; groups: Set<string>; first: string; last: string }

// Everything worth knowing about one response's matches.
export function summarise(body: unknown): string[] {
  const matches = field(body, 'matches')
  if (!Array.isArray(matches)) {
    const keys = typeof body === 'object' && body !== null ? Object.keys(body).join(', ') : typeof body
    return [`No list of matches. The response's fields: ${keys}`]
  }

  const lines: string[] = []
  const resultSet = field(body, 'resultSet')
  if (resultSet !== undefined) lines.push(`Result set: ${JSON.stringify(resultSet)}`)
  const season = field(matches[0], 'season')
  if (season !== undefined) lines.push(`Season: ${JSON.stringify(season)}`)

  const matchFields = new Set<string>()
  const scoreFields = new Set<string>()
  const stages = new Map<string, StageSummary>()
  const statuses = new Tally()
  const endings = new Map<string, { count: number; example: unknown; exampleStatus: string }>()
  const oddTeams = new Map<string, string>()
  const minutes: string[] = []
  let withMinute = 0
  let withInjuryTime = 0
  let undrawn = 0
  let withoutLastUpdated = 0

  for (const match of matches) {
    if (typeof match === 'object' && match !== null) Object.keys(match).forEach(key => matchFields.add(key))
    const stage = text(field(match, 'stage'))
    const status = text(field(match, 'status'))
    const kickoff = text(field(match, 'utcDate'))
    statuses.add(status)

    let summary = stages.get(stage)
    if (summary === undefined) {
      summary = { matches: 0, matchdays: new Set(), statuses: new Tally(), groups: new Set(), first: kickoff, last: kickoff }
      stages.set(stage, summary)
    }
    summary.matches++
    summary.statuses.add(status)
    const matchday = field(match, 'matchday')
    if (typeof matchday === 'number') summary.matchdays.add(matchday)
    const group = field(match, 'group')
    if (group !== null && group !== undefined) summary.groups.add(text(group))
    if (kickoff < summary.first) summary.first = kickoff
    if (kickoff > summary.last) summary.last = kickoff

    const minute = field(match, 'minute')
    if (minute !== null && minute !== undefined) {
      withMinute++
      if (minutes.length < 5) minutes.push(`${text(minute)} (${status})`)
    }
    const injuryTime = field(match, 'injuryTime')
    if (injuryTime !== null && injuryTime !== undefined) withInjuryTime++
    if (field(match, 'lastUpdated') === undefined) withoutLastUpdated++

    for (const side of ['homeTeam', 'awayTeam']) {
      const team = field(match, side)
      const id = field(team, 'id')
      if (id === null || id === undefined) {
        undrawn++
        continue
      }
      const name = field(team, 'name')
      const shortName = field(team, 'shortName')
      const tla = field(team, 'tla')
      const fine = typeof tla === 'string' && /^[A-Z]{3}$/.test(tla) && typeof shortName === 'string' && shortName.trim() !== ''
        && typeof name === 'string' && name.trim() !== ''
      if (!fine) oddTeams.set(text(id), `${text(id)}: name ${text(name)}, short name ${text(shortName)}, code ${text(tla)}`)
    }

    const score = field(match, 'score')
    if (typeof score === 'object' && score !== null) Object.keys(score).forEach(key => scoreFields.add(key))
    const duration = text(field(score, 'duration'))
    const ending = endings.get(duration) ?? { count: 0, example: undefined, exampleStatus: '' }
    ending.count++
    // Prefer a finished match as the example, since its score is complete.
    if (ending.example === undefined || (ending.exampleStatus !== 'FINISHED' && status === 'FINISHED')) {
      ending.example = score
      ending.exampleStatus = status
    }
    endings.set(duration, ending)
  }

  lines.push(`Match fields: ${[...matchFields].sort().join(', ')}`)
  lines.push(`Statuses: ${statuses}`)
  lines.push('Stages:')
  for (const [stage, s] of [...stages].sort((a, b) => a[1].first.localeCompare(b[1].first))) {
    const days = [...s.matchdays].sort((a, b) => a - b)
    const range = days.length === 0 ? 'no matchdays' : `matchdays ${days[0]} to ${days[days.length - 1]}`
    const groups = s.groups.size === 0 ? '' : `, groups ${[...s.groups].sort().join(' ')}`
    lines.push(`  ${stage}: ${matchesText(s.matches)}, ${range}${groups}, ${s.first.slice(0, 10)} to ${s.last.slice(0, 10)}`)
    lines.push(`    statuses ${s.statuses}`)
  }
  lines.push(`Team places not filled yet (knockouts not drawn): ${undrawn}`)
  lines.push(oddTeams.size === 0
    ? 'Teams missing a three-letter code, a short name or a name: none'
    : `Teams missing a three-letter code, a short name or a name:\n${[...oddTeams.values()].map(line => `  ${line}`).join('\n')}`)
  lines.push(`Matches with a minute: ${withMinute}${minutes.length > 0 ? `, e.g. ${minutes.join(', ')}` : ''}`)
  lines.push(`Matches with injury time: ${withInjuryTime}`)
  lines.push(`Matches without lastUpdated: ${withoutLastUpdated}`)
  lines.push(`Score fields: ${[...scoreFields].sort().join(', ')}`)
  lines.push('Ways a score ended:')
  for (const [duration, ending] of endings) {
    lines.push(`  ${duration}: ${ending.count}, e.g. (${ending.exampleStatus}) ${JSON.stringify(ending.example)}`)
  }
  return lines
}

// The headers worth seeing, with values only for the ones in SHOWN_HEADERS.
export function describeHeaders(headers: Headers): string {
  const shown: string[] = []
  const named: string[] = []
  headers.forEach((value, name) => {
    const lower = name.toLowerCase()
    if (SHOWN_HEADERS.includes(lower)) shown.push(`${lower}=${value}`)
    else if (lower.startsWith('x-')) named.push(lower)
  })
  return `${shown.sort().join(', ') || 'no rate-limit headers'}${named.length > 0 ? `. Also sent, values not shown: ${named.sort().join(', ')}` : ''}`
}

async function check(label: string, path: string, key: string): Promise<boolean> {
  console.log(`\n== ${label}`)
  let response: Response
  try {
    // Redirects are refused, so the key can't be carried to any other address.
    response = await fetch(API + path, { headers: { 'X-Auth-Token': key }, redirect: 'error', signal: AbortSignal.timeout(30_000) })
  } catch (error) {
    console.log(`Couldn't reach football-data.org: ${error instanceof Error ? error.message : 'unknown error'}`)
    return false
  }
  console.log(`Answer: ${response.status} ${response.statusText}`)
  console.log(`Headers: ${describeHeaders(response.headers)}`)
  const body = await response.text()
  let json: unknown
  try {
    json = JSON.parse(body)
  } catch {
    console.log(`Not JSON. It starts: ${body.slice(0, 120)}`)
    return false
  }
  if (!response.ok) {
    console.log(`Message: ${text(field(json, 'message')).slice(0, 300)}`)
    return false
  }
  for (const line of summarise(json)) console.log(line)
  return true
}

async function main() {
  const key = process.env.FOOTBALL_DATA_KEY ?? ''
  if (!/^[A-Za-z0-9]{16,128}$/.test(key)) {
    console.error('FOOTBALL_DATA_KEY isn\'t set, or has something besides letters and digits in it. Run the first line of the guide\'s step again.')
    process.exit(1)
  }
  const season = seasonFor(new Date())
  const requests: [string, string][] = [
    [`Premier League ${season}`, `/competitions/PL/matches?season=${season}`],
    [`Champions League ${season}`, `/competitions/CL/matches?season=${season}`],
    [`Champions League ${season - 1}`, `/competitions/CL/matches?season=${season - 1}`],
  ]
  let worked = 0
  for (const [label, path] of requests) {
    if (await check(label, path, key)) worked++
  }
  console.log(`\nDone: ${requests.length} requests, ${worked} answered. Nothing was saved.`)
  process.exit(worked === 0 ? 1 : 0)
}

if (import.meta.main) await main()
