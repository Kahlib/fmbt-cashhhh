// Settings' Invites, for app admins only (step 10.5, and the canvas "FMBT
// Settings: invites and audit log"). It asks the database for the list when
// Settings opens, and shows nothing when the database refuses, which it does
// for anyone who isn't an app admin. Invited emails are never saved in the
// browser: they're held only while Settings is open.
import { useEffect, useState, type FormEvent } from 'react'
import { Button, Note, TextField } from '../components/Controls.tsx'
import { Dialog } from '../components/Overlays.tsx'
import type { AccountApi, InviteRow } from '../lib/account/api.ts'
import { tidyEmail } from '../lib/crypto/kdf.ts'
import { formatDay } from '../lib/format.ts'
import { inviteProblem, inviteSummary, MAX_EMAIL } from '../lib/invites.ts'
import { OFFLINE } from './messages.ts'

export function Invites({ api, myEmail, onToast }: { api: AccountApi; myEmail: string; onToast: (message: string) => void }) {
  const [list, setList] = useState<InviteRow[] | null>(null)
  const [typed, setTyped] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [removing, setRemoving] = useState<string | null>(null)
  const [version, setVersion] = useState(0)

  useEffect(() => {
    let current = true
    void (async () => {
      try {
        const rows = await api.inviteList()
        if (current) setList(rows)
      } catch {
        // Without the list there's no telling an admin from anyone else, so
        // Invites stays out until Settings opens again.
        if (current) setList(null)
      }
    })()
    return () => {
      current = false
    }
  }, [api, version])

  if (list === null) return null
  const me = tidyEmail(myEmail)

  async function add(event: FormEvent) {
    event.preventDefault()
    if (list === null) return
    const found = inviteProblem(typed, list)
    setProblem(found)
    setFailed(false)
    if (found !== null) return
    const email = tidyEmail(typed)
    setBusy(true)
    try {
      // False means the database no longer counts you as an app admin, and
      // the reload below takes Invites away.
      if (await api.inviteAdd(email)) {
        setTyped('')
        onToast(`Invited ${email}. Tell them to sign up with this email.`)
      }
      setVersion(v => v + 1)
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  async function remove(email: string) {
    setBusy(true)
    setFailed(false)
    try {
      if (await api.inviteRemove(email)) onToast(`Removed ${email}'s invite.`)
      setVersion(v => v + 1)
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
      setRemoving(null)
    }
  }

  return (
    <section className="panel span-12" aria-labelledby="invite-title">
      <div>
        <div className="ph-row"><h2 className="ptitle" id="invite-title">Invites</h2><span className="count">Only app admins see this</span></div>
        <p className="sub">Only an email on this list can make an account. The app doesn't send anything, so tell them yourself, and they sign up with that email.</p>
      </div>
      <form className="invite-add" onSubmit={event => void add(event)} noValidate>
        <TextField label="Email" type="email" value={typed} autoComplete="off" maxLength={MAX_EMAIL} onChange={value => {
          setTyped(value)
          setProblem(null)
        }} message={problem === null ? null : { tone: 'bad', text: problem }} />
        <Button kind="primary" type="submit" busy={busy && removing === null} busyLabel="Adding…">Add invite</Button>
      </form>
      {failed && <Note problem><p>{OFFLINE}</p></Note>}
      {list.length > 0 && (
        <div className="table-box">
          <table className="hist invites">
            <thead>
              <tr><th>Email</th><th>Added</th><th>Account</th><th className="r"><span className="sr-only">Remove</span></th></tr>
            </thead>
            <tbody>
              {list.map(each => (
                <tr key={each.email}>
                  <td>{each.email}{each.email === me && <span className="tag">You</span>}</td>
                  <td>{formatDay(each.added_at)}</td>
                  <td className={each.has_account ? undefined : 'muted'}>{each.has_account ? 'Has an account' : 'Not signed up yet'}</td>
                  <td className="r">
                    {each.email !== me && <button type="button" className="btn btn-danger btn-sm" onClick={() => setRemoving(each.email)}>Remove</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="hint">{inviteSummary(list)} Removing an invite stops that email making an account. An account already made stays, with everything in it.</p>

      {removing !== null && (
        <Dialog title={`Remove ${removing}'s invite?`} onClose={() => setRemoving(null)}
          sub="They won't be able to make an account. If they already have one, it stays, with everything in it.">
          <div className="actions">
            <Button onClick={() => setRemoving(null)}>Cancel</Button>
            <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void remove(removing)}>Remove invite</button>
          </div>
        </Dialog>
      )}
    </section>
  )
}
