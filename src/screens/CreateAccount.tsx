// Setup step 1 (canvas: "Setup 1 of 4: create your account").
import { useState, type FormEvent } from 'react'
import type { AccountApi } from '../lib/account/api.ts'
import type { NewRecoveryKey, PreparedRecoveryWrap } from '../lib/account/new-recovery-key.ts'
import { createAccount } from '../lib/account/setup.ts'
import type { Unlocked } from '../lib/account/wraps.ts'
import { Button, Hint, LinkButton, Note, PasswordField, TextField, type Message } from '../components/Controls.tsx'
import { OutPage, ScreenTitle, StepBar } from '../components/Layout.tsx'
import { confirmHint, newPasswordHint, newPasswordReady, OFFLINE, passwordProblemText, TOO_MANY_TRIES } from './messages.ts'

export function CreateAccount({ api, onCreated, onSignIn, onStartFromBackup }: {
  api: AccountApi
  onCreated: (unlocked: Unlocked, newKey: NewRecoveryKey, prepared: PreparedRecoveryWrap) => void
  onSignIn: () => void
  onStartFromBackup: () => void
}) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [again, setAgain] = useState('')
  const [tried, setTried] = useState(false)
  const [busy, setBusy] = useState(false)
  const [emailMessage, setEmailMessage] = useState<Message | null>(null)
  const [passwordMessage, setPasswordMessage] = useState<Message | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    setTried(true)
    setEmailMessage(null)
    setPasswordMessage(null)
    setProblem(null)
    if (!newPasswordReady(password, again, email)) return
    setBusy(true)
    try {
      const result = await createAccount(api, email, password)
      switch (result.kind) {
        case 'created':
          onCreated(result.unlocked, result.newKey, result.prepared)
          return
        case 'not-invited':
          setEmailMessage({ tone: 'bad', text: "This email doesn't have an invite. Check it's the address you were invited with." })
          break
        case 'exists':
          setEmailMessage({ tone: 'bad', text: <>There's already an account with this email. <LinkButton onClick={onSignIn}>Sign in</LinkButton> instead.</> })
          break
        case 'password-rules':
          setPasswordMessage({ tone: 'bad', text: passwordProblemText(result.problem, password) })
          break
        case 'too-many-tries':
          setProblem(TOO_MANY_TRIES)
          break
        case 'unavailable':
          setProblem(OFFLINE)
      }
    } catch {
      setProblem(OFFLINE)
    } finally {
      setBusy(false)
    }
  }

  return (
    <OutPage corner="Invite only" wide footer="Supabase only ever receives a token made from your password, never the password itself.">
      <StepBar step={1} label="Create your account" />
      <ScreenTitle sub="You need an invite. Your password never leaves this browser. It becomes the key that locks your bets.">Set up your account</ScreenTitle>

      <form className="stack" onSubmit={submit} noValidate>
        <div className="form">
          <TextField label="Email" type="email" autoComplete="username" value={email} onChange={setEmail} message={emailMessage} />
          <PasswordField label="Password" autoComplete="new-password" value={password} onChange={setPassword}
            message={passwordMessage ?? newPasswordHint(password, email, tried)}
            extra={<Hint>A password manager, or five random words, both work well. No rules about capitals or symbols.</Hint>} />
          <PasswordField label="Type it again" autoComplete="new-password" value={again} onChange={setAgain}
            message={confirmHint(password, again, tried)} />
        </div>

        <Note><p><b>There's no password reset by email.</b> If you forget your password, the recovery key you'll save next is the only way back in.</p></Note>
        {problem !== null && <Note problem><p>{problem}</p></Note>}

        <Button kind="primary" type="submit" block busy={busy} busyLabel="Creating your account…">Create account</Button>
      </form>

      <div className="links">
        <LinkButton onClick={onSignIn}>Back to sign in</LinkButton>
        <LinkButton onClick={onStartFromBackup}>Start from a backup instead</LinkButton>
      </div>
    </OutPage>
  )
}
