// The password step for a new recovery key (canvas: "New recovery key:
// confirm with your password"). Settings always ends here, and so does any
// key save the database turns down for want of a recent sign-in.
import { useState, type FormEvent } from 'react'
import type { AccountApi } from '../lib/account/api.ts'
import { replaceRecoveryKey } from '../lib/account/recovery.ts'
import type { Unlocked } from '../lib/account/wraps.ts'
import { Button, LinkButton, Note, PasswordField, type Message } from '../components/Controls.tsx'
import { OutPage, ScreenTitle } from '../components/Layout.tsx'
import type { PendingKey } from './flow.ts'
import { OFFLINE, TOO_MANY_TRIES } from './messages.ts'

export function KeyPassword({ api, unlocked, pending, onSaved, onCancel }: {
  api: AccountApi
  unlocked: Unlocked
  pending: PendingKey
  onSaved: () => void
  onCancel?: () => void
}) {
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<Message | null>(null)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setMessage(null)
    try {
      const result = await replaceRecoveryKey(api, unlocked, pending.newKey, password)
      if (result === 'saved') {
        onSaved()
        return
      }
      setMessage({
        tone: 'bad',
        text: result === 'wrong-password' ? "That password is wrong. Your new key isn't saved yet, and your old one still works."
          : result === 'too-many-tries' ? TOO_MANY_TRIES
            : "Couldn't save your new key. Your old one still works, so try again.",
      })
    } catch {
      setMessage({ tone: 'bad', text: OFFLINE })
    } finally {
      setPassword('')
      setBusy(false)
    }
  }

  return (
    <OutPage corner={`Signed in as ${unlocked.email}`}
      footer="A new recovery key needs a password sign-in from the last 5 minutes, which is why it asks again.">
      <ScreenTitle sub="The app signs in again with it, so your new recovery key can replace the old one.">Confirm with your password</ScreenTitle>
      <form className="stack" onSubmit={submit} noValidate>
        {/* Password managers look for the account's name next to its password. */}
        <input type="email" autoComplete="username" value={unlocked.email} readOnly hidden />
        <div className="form">
          <PasswordField label="Password" autoComplete="current-password" autoFocus value={password} onChange={setPassword} message={message} />
        </div>
        <Note><p>Once it's saved, your old recovery key stops working. Backups from before then still open with it, so you'll be asked for a fresh one.</p></Note>
        <Button kind="primary" type="submit" block busy={busy} busyLabel="Saving…">Save new recovery key</Button>
      </form>
      {onCancel !== undefined && (
        <div className="links"><LinkButton onClick={onCancel}>Cancel</LinkButton></div>
      )}
    </OutPage>
  )
}
