// Change password (canvas: "Change password").
import { useState, type FormEvent } from 'react'
import type { AccountApi } from '../lib/account/api.ts'
import { changePassword } from '../lib/account/password.ts'
import type { Unlocked } from '../lib/account/wraps.ts'
import { Button, Note, PasswordField, type Message } from '../components/Controls.tsx'
import { Dialog } from '../components/Overlays.tsx'
import { confirmHint, newPasswordHint, newPasswordReady, OFFLINE, passwordProblemText, TOO_MANY_TRIES } from './messages.ts'

export function ChangePasswordDialog({ api, unlocked, onClose, onChanged }: {
  api: AccountApi
  unlocked: Unlocked
  onClose: () => void
  onChanged: () => void
}) {
  const [current, setCurrent] = useState('')
  const [password, setPassword] = useState('')
  const [again, setAgain] = useState('')
  const [tried, setTried] = useState(false)
  const [busy, setBusy] = useState(false)
  const [currentMessage, setCurrentMessage] = useState<Message | null>(null)
  const [newMessage, setNewMessage] = useState<Message | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    setTried(true)
    setCurrentMessage(null)
    setNewMessage(null)
    setProblem(null)
    if (current === '') {
      setCurrentMessage({ tone: 'bad', text: 'Type your current password.' })
      return
    }
    if (!newPasswordReady(password, again, unlocked.email)) return
    setBusy(true)
    try {
      const result = await changePassword(api, unlocked, current, password)
      switch (result.kind) {
        case 'changed':
          onChanged()
          return
        case 'wrong-current':
          setCurrentMessage({ tone: 'bad', text: "That isn't your current password. Nothing has changed." })
          break
        case 'same':
          setNewMessage({ tone: 'bad', text: "That's your current password. Choose a new one." })
          break
        case 'password-rules':
          setNewMessage({ tone: 'bad', text: passwordProblemText(result.problem, password) })
          break
        case 'too-many-tries':
          setProblem(TOO_MANY_TRIES)
          break
        case 'failed':
          setProblem('The change may not have finished. Sign out, then sign in with your new password, or your current one if that doesn\'t work.')
      }
    } catch {
      setProblem(OFFLINE)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog title="Change password" onClose={onClose}
      sub="Type your current password first. It proves it's you, and it unlocks your data key so it can be locked again under the new one.">
      <form className="stack" onSubmit={submit} noValidate>
        {/* Password managers look for the account's name next to its password. */}
        <input type="email" autoComplete="username" value={unlocked.email} readOnly hidden />
        <div className="form">
          <PasswordField label="Current password" autoComplete="current-password" value={current} onChange={setCurrent} message={currentMessage} />
          <PasswordField label="New password" autoComplete="new-password" value={password} onChange={setPassword}
            message={newMessage ?? newPasswordHint(password, unlocked.email, tried)} />
          <PasswordField label="Type it again" autoComplete="new-password" value={again} onChange={setAgain}
            message={confirmHint(password, again, tried)} />
        </div>
        <Note><p>If anything goes wrong partway through, your current password keeps working.</p></Note>
        {problem !== null && <Note problem><p>{problem}</p></Note>}
        <div className="actions">
          <Button onClick={onClose}>Cancel</Button>
          <Button kind="primary" type="submit" busy={busy} busyLabel="Changing…">Change password</Button>
        </div>
      </form>
    </Dialog>
  )
}
