// Forgot password (canvas: "Forgot password: use the recovery key").
import { useState, type FormEvent } from 'react'
import type { AccountApi } from '../lib/account/api.ts'
import type { NewRecoveryKey, PreparedRecoveryWrap } from '../lib/account/new-recovery-key.ts'
import { recoverAccount } from '../lib/account/recovery.ts'
import type { Unlocked } from '../lib/account/wraps.ts'
import { Button, KeyField, LinkButton, Note, PasswordField, TextField, type Message } from '../components/Controls.tsx'
import { OutPage, ScreenTitle } from '../components/Layout.tsx'
import { confirmHint, keyProblemText, newPasswordHint, newPasswordReady, OFFLINE, passwordProblemText } from './messages.ts'

export function Recover({ api, onRecovered, onBack }: {
  api: AccountApi
  onRecovered: (unlocked: Unlocked, newKey: NewRecoveryKey, prepared: PreparedRecoveryWrap, oldProofHex: string) => void
  onBack: () => void
}) {
  const [email, setEmail] = useState('')
  const [keyText, setKeyText] = useState('')
  const [password, setPassword] = useState('')
  const [again, setAgain] = useState('')
  const [tried, setTried] = useState(false)
  const [busy, setBusy] = useState(false)
  const [keyMessage, setKeyMessage] = useState<Message | null>(null)
  const [passwordMessage, setPasswordMessage] = useState<Message | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    setTried(true)
    setKeyMessage(null)
    setPasswordMessage(null)
    setProblem(null)
    if (!newPasswordReady(password, again, email)) return
    setBusy(true)
    try {
      const result = await recoverAccount(api, email, keyText, password)
      switch (result.kind) {
        case 'recovered':
          onRecovered(result.unlocked, result.newKey, result.prepared, result.oldProofHex)
          return
        case 'key-problem':
          setKeyMessage({ tone: 'bad', text: keyProblemText(result.problem, keyText) })
          break
        case 'password-rules':
          setPasswordMessage({ tone: 'bad', text: passwordProblemText(result.problem, password) })
          break
        case 'refused':
          setKeyMessage({ tone: 'bad', text: 'The email or the key is wrong. Check both against your saved copy.' })
          break
        case 'keys-wont-open':
          setProblem('Your key was accepted and your new password is set, but the key doesn\'t open your data key. Someone may have changed your account. The way back is to start from a backup, once the account has been deleted.')
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
    <OutPage corner="Invite only" wide footer="After 5 wrong tries, recovery for this email pauses for 24 hours.">
      <ScreenTitle sub="Set a new password with the recovery key you saved at setup. Your bets stay exactly as they are.">Use your recovery key</ScreenTitle>

      <form className="stack" onSubmit={submit} noValidate>
        <div className="form">
          <TextField label="Email" type="email" autoComplete="username" value={email} onChange={setEmail} />
          <KeyField label="Recovery key" value={keyText} onChange={setKeyText}
            message={keyMessage ?? { tone: 'neutral', text: "Spaces, dashes and capitals don't matter." }} />
          <PasswordField label="New password" autoComplete="new-password" value={password} onChange={setPassword}
            message={passwordMessage ?? newPasswordHint(password, email, tried)} />
          <PasswordField label="Type it again" autoComplete="new-password" value={again} onChange={setAgain}
            message={confirmHint(password, again, tried)} />
        </div>

        <Note><p>This also makes you a <b>new recovery key</b>, and the one you just used stops working. You'll save the new one next.</p></Note>
        {problem !== null && <Note problem><p>{problem}</p></Note>}

        <Button kind="primary" type="submit" block busy={busy} busyLabel="Checking your key…">Set new password</Button>
      </form>

      <div className="links">
        <LinkButton onClick={onBack}>Back to sign in</LinkButton>
      </div>
    </OutPage>
  )
}
