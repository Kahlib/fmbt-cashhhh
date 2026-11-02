// The two public values the app needs to reach Supabase: the project's
// address and its publishable key. Vite copies them in when it builds, from
// .env.production for the live site or .env.development.local for
// `npm run dev`. Both end up in the page's JavaScript, so neither is a secret.
//
// The checks below stop the app starting with a missing or wrong value, or
// with a secret key pasted in by mistake (fmbt-security, sections 4 and 7).

// A "type" describes the shape of a value. TypeScript checks every use of it
// when the app builds, and it disappears from the JavaScript that runs.
export type SupabaseConfig = {
  url: string            // https://<project id>.supabase.co
  publishableKey: string // sb_publishable_...
}

// Takes Vite's env values and returns the checked config, or throws an error.
// `Record<string, unknown>` means "an object with any names, whose values
// could be anything", so the function has to check each value before using it.
export function readConfig(env: Record<string, unknown>): SupabaseConfig {
  const url = env.VITE_SUPABASE_URL
  const publishableKey = env.VITE_SUPABASE_PUBLISHABLE_KEY

  // Exactly a project's address: https, the 20-character project ID, and
  // nothing after .co, so a typo can't send requests somewhere else.
  if (typeof url !== 'string' || !/^https:\/\/[a-z0-9]{20}\.supabase\.co$/.test(url)) {
    throw new Error("VITE_SUPABASE_URL is missing or isn't a Supabase project address.")
  }

  // Only a publishable key. A secret key skips every access rule, so one must
  // never be built into the page. Supabase refuses secret keys from browsers too.
  if (typeof publishableKey !== 'string' || !/^sb_publishable_[A-Za-z0-9_-]+$/.test(publishableKey)) {
    throw new Error("VITE_SUPABASE_PUBLISHABLE_KEY is missing or isn't a publishable key.")
  }

  return { url, publishableKey }
}
