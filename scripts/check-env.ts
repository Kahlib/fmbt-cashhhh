// FMBT Cashhhh: check which Supabase values a build can see.
//
// Vite copies every variable whose name starts with VITE_ into the public
// JavaScript. So the only ones allowed are production's address and
// publishable key, which are public anyway. This runs in every
// `npm run check`, on your computer and in Cloudflare's build, and stops the
// build if:
//   - .env.production holds anything else, or points at another project
//   - public/_headers doesn't allow exactly that address in connect-src
//   - a VITE_ variable is set outside the files (in the terminal, or in
//     Cloudflare's build settings), which would quietly override them
//   - an env file exists that would make your build differ from Cloudflare's
//   - .env.development.local, if this computer has one, points at production
//
// Run it on its own with: node scripts/check-env.ts

import { existsSync, readFileSync } from 'node:fs'

// Production's address. If production ever moves to a new project, change
// this, .env.production and public/_headers together.
export const PRODUCTION_URL = 'https://gxminxbyiuzueomsdgem.supabase.co'

// The only two names allowed, and the shape each value must have.
const NAMES = ['VITE_SUPABASE_URL', 'VITE_SUPABASE_PUBLISHABLE_KEY']
const URL_SHAPE = /^https:\/\/[a-z0-9]{20}\.supabase\.co$/   // nothing after .co
const KEY_SHAPE = /^sb_publishable_[A-Za-z0-9_-]+$/           // never sb_secret_

// Reads an env file's NAME=value lines, skipping blank lines and # comments.
// Anything fancier (quotes, spaces, "export") gets reported, so the file
// stays simple enough to check by eye.
export function readEnvFile(text: string, file: string) {
  const values = new Map<string, string>()
  const problems: string[] = []
  text.split(/\r?\n/).forEach((line, i) => {
    if (line.trim() === '' || line.trimStart().startsWith('#')) return
    const match = /^([A-Z0-9_]+)=(\S+)$/.exec(line)
    if (!match) {
      problems.push(`${file} line ${i + 1} isn't a plain NAME=value line.`)
      return
    }
    const [, name, value] = match
    if (values.has(name)) problems.push(`${file} sets ${name} twice.`)
    values.set(name, value)
  })
  return { values, problems }
}

// Both names set, nothing else set, and both values the right shape.
function checkValues(values: Map<string, string>, file: string): string[] {
  const problems: string[] = []
  for (const name of values.keys()) {
    if (!NAMES.includes(name)) problems.push(`${file} sets ${name}. Only ${NAMES.join(' and ')} are allowed.`)
  }
  const url = values.get('VITE_SUPABASE_URL')
  const key = values.get('VITE_SUPABASE_PUBLISHABLE_KEY')
  if (url === undefined || !URL_SHAPE.test(url)) {
    problems.push(`${file} needs VITE_SUPABASE_URL=https://<project id>.supabase.co, with nothing after .co.`)
  }
  if (key === undefined || !KEY_SHAPE.test(key)) {
    problems.push(`${file} needs VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_... (the publishable key, never a secret key).`)
  }
  return problems
}

// .env.production: the two values, pointing at production.
export function checkProductionEnv(text: string): string[] {
  const { values, problems } = readEnvFile(text, '.env.production')
  problems.push(...checkValues(values, '.env.production'))
  const url = values.get('VITE_SUPABASE_URL')
  if (url !== undefined && URL_SHAPE.test(url) && url !== PRODUCTION_URL) {
    problems.push(`.env.production points at ${url}, not production (${PRODUCTION_URL}).`)
  }
  return problems
}

// .env.development.local: the two values, pointing anywhere but production.
export function checkDevEnv(text: string): string[] {
  const { values, problems } = readEnvFile(text, '.env.development.local')
  problems.push(...checkValues(values, '.env.development.local'))
  if (values.get('VITE_SUPABASE_URL') === PRODUCTION_URL) {
    problems.push('.env.development.local points at production. npm run dev must only ever use the dev project.')
  }
  return problems
}

// The content security policy's connect-src must be 'self' plus exactly that
// address, so the page can talk to the site itself and Supabase, and nothing else.
export function checkHeaders(text: string, url: string): string[] {
  const csp = text.split(/\r?\n/).map(line => line.trim()).find(line => line.startsWith('Content-Security-Policy:'))
  if (csp === undefined) return ['public/_headers has no Content-Security-Policy line.']
  const directive = csp
    .slice('Content-Security-Policy:'.length)
    .split(';')
    .map(part => part.trim().split(/\s+/))
    .find(words => words[0] === 'connect-src')
  const sources = directive?.slice(1) ?? []
  const expected = ["'self'", url]
  const matches = sources.length === expected.length && expected.every(source => sources.includes(source))
  return matches ? [] : [`public/_headers should have "connect-src 'self' ${url}" but has "connect-src ${sources.join(' ')}".`]
}

// A VITE_ variable set outside the env files would override them in the build.
export function checkProcessEnv(env: Record<string, string | undefined>): string[] {
  return Object.keys(env)
    .filter(name => name.startsWith('VITE_'))
    .map(name => `${name} is set outside the env files (in the terminal or Cloudflare's build settings). Remove it, so .env.production is the only source.`)
}

// Vite would also read these files into a production build. Cloudflare never
// has them, so your build would quietly differ from the live one.
export const STRAY_FILES = ['.env', '.env.local', '.env.production.local']
export function checkStrayFiles(exists: (file: string) => boolean): string[] {
  return STRAY_FILES
    .filter(file => exists(file))
    .map(file => `${file} exists. Vite would read it into production builds, so delete it. Dev values go in .env.development.local.`)
}

// Run every check, and stop the build if any of them fail.
if (import.meta.main) {
  const read = (file: string) => readFileSync(file, 'utf8')
  const problems: string[] = []
  if (existsSync('.env.production')) {
    problems.push(...checkProductionEnv(read('.env.production')))
    problems.push(...checkHeaders(read('public/_headers'), PRODUCTION_URL))
  } else {
    problems.push('.env.production is missing.')
  }
  problems.push(...checkProcessEnv(process.env))
  problems.push(...checkStrayFiles(existsSync))
  if (existsSync('.env.development.local')) problems.push(...checkDevEnv(read('.env.development.local')))

  if (problems.length > 0) {
    console.error('Env check failed:\n' + problems.map(problem => `  - ${problem}`).join('\n'))
    process.exit(1)
  }
  console.log("Env check passed: builds can only see production's address and publishable key.")
}
