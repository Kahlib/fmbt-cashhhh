// The one Supabase client the whole app shares. Nothing uses it yet: sign-in
// arrives in step 7.5.
//
// fmbt-security, section 3: the session lives in this tab's memory only.
// Nothing goes in localStorage, sessionStorage, IndexedDB or cookies, so
// closing or refreshing the tab signs you out and leaves nothing on disk.
import { createClient } from '@supabase/supabase-js'
import { readConfig } from './config.ts'

// import.meta.env holds the VITE_ values Vite copied in at build time.
const { url, publishableKey } = readConfig(import.meta.env)

export const supabase = createClient(url, publishableKey, {
  auth: {
    persistSession: false,     // keep the session in memory, never in browser storage
    autoRefreshToken: true,    // renew the 15-minute access token while the tab is open
    detectSessionInUrl: false, // never accept a sign-in from a link, since the app sends none
  },
})
