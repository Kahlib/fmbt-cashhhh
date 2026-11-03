// The app's one connection to Supabase: the AccountApi every screen uses,
// and a way to hear when the session ends without the app asking.
import { readConfig } from '../config.ts'
import { supabase } from '../supabase.ts'
import { supabaseApi } from './supabase-api.ts'

export const api = supabaseApi(supabase, readConfig(import.meta.env))

// Calls `listener` when Supabase ends the session by itself. That happens
// when this tab's session can't renew, for example after another tab
// signed out or changed the password. Returns a function that stops it.
export function onSessionEnded(listener: () => void): () => void {
  const { data } = supabase.auth.onAuthStateChange(event => {
    if (event === 'SIGNED_OUT') listener()
  })
  return () => data.subscription.unsubscribe()
}
