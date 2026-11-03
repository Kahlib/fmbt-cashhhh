// Sign in (canvas: "Sign in" and "Sign in: when it doesn't work").
import { useState, type FormEvent } from 'react'
import type { AccountApi } from '../lib/account/api.ts'
import { signIn, type NextStep } from '../lib/account/signin.ts'
import type { Unlocked } from '../lib/account/wraps.ts'
import { Button, LinkButton, Note, PasswordField, TextField } from '../components/Controls.tsx'
import { OutPage, ScreenTitle } from '../components/Layout.tsx'
import { OFFLINE, TOO_MANY_TRIES } from './messages.ts'

type Problem = 'wrong' | 'too-many-tries' | 'offline' | 'keys-wont-open' | 'keys-missing'

export function SignIn({ api, notice, onUnlocked, onForgot, onSetUp }: {
  api: AccountApi
  notice?: string
  onUnlocked: (unlocked: Unlocked, next: NextStep) => void
  onForgot: () => void
  onSetUp: () => void
}) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<Problem | null>(null)

  async function submit(event: FormEvent<HTMLFormElement>) {
    // The app handles the form itself, so nothing is posted anywhere. If a
    // native submit ever slipped through, method="post" keeps the fields out
    // of the address, and the content security policy (form-action 'none')
    // refuses to send it at all.
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setProblem(null)
    try {
      const result = await signIn(api, email, password)
      if (result.kind === 'unlocked') {
        onUnlocked(result.unlocked, result.next)
        return
      }
      setProblem(result.kind === 'unavailable' ? 'offline' : result.kind)
    } catch {
      setProblem('offline')
    } finally {
      // The password has done its job, so it doesn't stay in the field.
      setPassword('')
      setBusy(false)
    }
  }

  const fieldError =
    problem === 'wrong' ? "Email or password is wrong. Check both, or use your recovery key if you've forgotten your password."
      : problem === 'too-many-tries' ? TOO_MANY_TRIES
        : problem === 'offline' ? OFFLINE
          : null

  return (
    <OutPage corner="Invite only" footer="Closing or refreshing this tab signs you out. Nothing is saved on this computer.">
      <ScreenTitle focus={false} sub="Your password unlocks your bets in this tab. Everywhere else, they stay encrypted.">Sign in</ScreenTitle>
      {notice !== undefined && <Note><p>{notice}</p></Note>}

      <form className="stack" method="post" onSubmit={submit} noValidate>
        <div className="form">
          <TextField label="Email" type="email" autoComplete="username" autoFocus value={email} onChange={setEmail} />
          <PasswordField label="Password" autoComplete="current-password" value={password} onChange={setPassword}
            message={fieldError === null ? null : { tone: 'bad', text: fieldError }} />
        </div>

        {problem === 'keys-wont-open' && (
          <Note problem>
            <p><b>Your password worked, but it doesn't open your data key.</b> That happens if a recovery didn't finish, or if someone changed your account. Use your recovery key to set a new password.</p>
            <p><LinkButton onClick={onForgot}>Use your recovery key</LinkButton></p>
          </Note>
        )}
        {problem === 'keys-missing' && (
          <Note problem>
            <p><b>Your account's keys are missing.</b> Try your recovery key first. If that doesn't work either, the account has to be deleted and set up again from a backup.</p>
            <p><LinkButton onClick={onForgot}>Use your recovery key</LinkButton></p>
          </Note>
        )}

        <div className="stack tight">
          <Button kind="primary" type="submit" block busy={busy} busyLabel="Unlocking…">Sign in</Button>
          {busy && <p className="hint center">Turning your password into your keys. This takes about a second.</p>}
        </div>
      </form>

      <div className="links">
        <LinkButton onClick={onForgot}>Forgot your password?</LinkButton>
        <LinkButton onClick={onSetUp}>Set up your account</LinkButton>
      </div>
    </OutPage>
  )
}

