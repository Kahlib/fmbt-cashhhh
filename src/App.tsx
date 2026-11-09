// Which screen shows, and the unlocked data key, kept in this tab's memory
// only (fmbt-security, section 3). There's no router: a refresh signs you
// out anyway, so the app only needs to know the screen it's on now. Once
// you're in, SignedIn runs the pages.
import { useEffect, useRef, useState } from 'react'
import { api, onSessionEnded } from './lib/account/connect.ts'
import { saveRecoveryKey } from './lib/account/new-recovery-key.ts'
import type { NextStep } from './lib/account/signin.ts'
import type { Unlocked } from './lib/account/wraps.ts'
import { count } from './lib/format.ts'
import { leaving } from './lib/leaving.ts'
import type { Page } from './components/Layout.tsx'
import { CheckKey } from './screens/CheckKey.tsx'
import { CreateAccount } from './screens/CreateAccount.tsx'
import { FirstBackup } from './screens/FirstBackup.tsx'
import type { KeyFlow, PendingKey } from './screens/flow.ts'
import { KeyPassword } from './screens/KeyPassword.tsx'
import { OFFLINE } from './screens/messages.ts'
import { Recover } from './screens/Recover.tsx'
import { SaveKey } from './screens/SaveKey.tsx'
import { SignedIn } from './screens/SignedIn.tsx'
import { SignIn } from './screens/SignIn.tsx'
import { StartFromBackup } from './screens/StartFromBackup.tsx'

// Shown at sign-in after Supabase ends the session by itself.
const SIGNED_OUT_NOTICE = 'You were signed out, perhaps by a password change or sign-out in another tab. Sign in again to carry on.'

// Every sign-out ends with a reload, the only sure way to clear the data key
// and everything else from memory (fmbt-security, section 3). When Supabase
// ended the session, the reload adds ?signed-out so sign-in can say why.
const signedOutElsewhere = new URLSearchParams(location.search).has('signed-out')

type Screen =
  | { name: 'sign-in'; notice?: string }
  | { name: 'recover' }
  | { name: 'create-account' }
  | { name: 'start-from-backup' }
  | { name: 'save-key'; pending: PendingKey; note?: string }
  | { name: 'check-key'; pending: PendingKey }
  | { name: 'key-password'; pending: PendingKey }
  | { name: 'first-backup' }
  | { name: 'app'; page: Page; toast?: string }

export default function App() {
  const [screen, setScreen] = useState<Screen>(signedOutElsewhere ? { name: 'sign-in', notice: SIGNED_OUT_NOTICE } : { name: 'sign-in' })
  const [unlocked, setUnlockedState] = useState<Unlocked | null>(null)
  // The same value, readable straight away by the session listener below.
  const unlockedNow = useRef<Unlocked | null>(null)

  function setUnlocked(value: Unlocked | null) {
    unlockedNow.current = value
    setUnlockedState(value)
  }

  // Take ?signed-out back off the address once the note is showing.
  useEffect(() => {
    if (signedOutElsewhere) history.replaceState(null, '', '/')
  }, [])

  // If Supabase ends the session on its own while the tab is unlocked,
  // forget the data key and reload.
  useEffect(() => onSessionEnded(() => {
    if (unlockedNow.current === null) return
    unlockedNow.current = null
    leaving.onPurpose = true
    location.replace('/?signed-out')
  }), [])

  function signOut() {
    // Forget the key first, so the session listener knows this was asked
    // for. The reload waits for Supabase, so every session really ends.
    setUnlocked(null)
    leaving.onPurpose = true
    void api.signOut().finally(() => location.replace('/'))
  }

  // Where a freshly unlocked tab goes.
  function opened(next: Unlocked, step: NextStep) {
    setUnlocked(next)
    if (step.step === 'app') setScreen({ name: 'app', page: 'parlays' })
    else if (step.step === 'first-backup') setScreen({ name: 'first-backup' })
    else setScreen({ name: 'save-key', pending: { flow: step.first ? 'first-setup' : 'unfinished', newKey: step.newKey, prepared: step.prepared } })
  }

  function keySaved(flow: KeyFlow) {
    if (flow === 'first-setup') setScreen({ name: 'first-backup' })
    else if (flow === 'after-recovery') setScreen({ name: 'app', page: 'settings', toast: 'New password and recovery key saved.' })
    else setScreen({ name: 'app', page: 'settings', toast: 'New recovery key saved. The old one no longer works.' })
  }

  // Step 3's Check button, once the three groups match.
  async function saveKey(pending: PendingKey): Promise<string | null> {
    const now = unlockedNow.current
    if (now === null) return 'Your session has ended. Sign in again.'
    if (pending.prepared === null) {
      setScreen({ name: 'key-password', pending })
      return null
    }
    try {
      const result = await saveRecoveryKey(api, now.dataKey, pending.newKey, pending.prepared, pending.oldProofHex)
      if (result === 'saved') {
        keySaved(pending.flow)
        return null
      }
      if (result === 'needs-password') {
        setScreen({ name: 'key-password', pending })
        return null
      }
      return "Couldn't save your recovery key. Nothing is lost, so try again."
    } catch {
      return OFFLINE
    }
  }

  switch (screen.name) {
    case 'sign-in':
      return (
        <SignIn api={api} notice={screen.notice} onUnlocked={opened}
          onForgot={() => setScreen({ name: 'recover' })} onSetUp={() => setScreen({ name: 'create-account' })} />
      )
    case 'recover':
      return (
        <Recover api={api} onBack={() => setScreen({ name: 'sign-in' })}
          onRecovered={(next, newKey, prepared, oldProofHex) => {
            setUnlocked(next)
            setScreen({ name: 'save-key', pending: { flow: 'after-recovery', newKey, prepared, oldProofHex } })
          }} />
      )
    case 'create-account':
      return (
        <CreateAccount api={api} onSignIn={() => setScreen({ name: 'sign-in' })}
          onStartFromBackup={() => setScreen({ name: 'start-from-backup' })}
          onCreated={(next, newKey, prepared) => {
            setUnlocked(next)
            setScreen({ name: 'save-key', pending: { flow: 'first-setup', newKey, prepared } })
          }} />
      )
    case 'start-from-backup':
      return (
        <StartFromBackup api={api} onSetUp={() => setScreen({ name: 'create-account' })} onSignIn={() => setScreen({ name: 'sign-in' })}
          onStarted={(next, newKey, prepared, summary) => {
            setUnlocked(next)
            const added = `${count(summary.added, 'saved version', 'saved versions')} from the backup ${summary.added === 1 ? 'is' : 'are'} in your new account.`
            const note = summary.skipped === 0 ? added : `${added} ${summary.skipped.toLocaleString('en-GB')} couldn't be added, so ${summary.skipped === 1 ? 'it was' : 'they were'} left out.`
            setScreen({ name: 'save-key', pending: { flow: 'first-setup', newKey, prepared }, note })
          }} />
      )
    default:
      break
  }

  // Every other screen needs the unlocked tab.
  if (unlocked === null) {
    return <SignIn api={api} onUnlocked={opened} onForgot={() => setScreen({ name: 'recover' })} onSetUp={() => setScreen({ name: 'create-account' })} />
  }

  switch (screen.name) {
    case 'save-key':
      return <SaveKey email={unlocked.email} pending={screen.pending} note={screen.note} onContinue={() => setScreen({ name: 'check-key', pending: screen.pending })} />
    case 'check-key':
      return (
        <CheckKey email={unlocked.email} pending={screen.pending} onMatched={() => saveKey(screen.pending)}
          onShowAgain={() => setScreen({ name: 'save-key', pending: screen.pending })} />
      )
    case 'key-password':
      return (
        <KeyPassword api={api} unlocked={unlocked} pending={screen.pending} onSaved={() => keySaved(screen.pending.flow)}
          onCancel={screen.pending.flow === 'settings' ? () => setScreen({ name: 'app', page: 'settings' }) : undefined} />
      )
    case 'first-backup':
      return <FirstBackup api={api} unlocked={unlocked} onDone={() => setScreen({ name: 'app', page: 'settings', toast: 'Setup is done. Your backup checked out.' })} />
    case 'app':
      return (
        <SignedIn api={api} unlocked={unlocked} firstPage={screen.page} firstToast={screen.toast} onSignOut={signOut}
          onNewKey={newKey => setScreen({ name: 'save-key', pending: { flow: 'settings', newKey, prepared: null } })} />
      )
  }
}
