// Check the new recovery key (canvas: "Setup 3 of 4: check the recovery
// key"). Three groups typed back from the saved copy prove it's readable.
import { useState, type FormEvent } from 'react'
import { tidyGroup } from '../lib/crypto/recovery-key.ts'
import { Button, LinkButton, Note, TextField } from '../components/Controls.tsx'
import { OutPage, ScreenTitle, StepBar } from '../components/Layout.tsx'
import type { PendingKey } from './flow.ts'

export function CheckKey({ email, pending, onMatched, onShowAgain }: {
  email: string
  pending: PendingKey
  // Saves the key, or moves on to the password step. Returns an error to
  // show, or null once it has moved on.
  onMatched: () => Promise<string | null>
  onShowAgain: () => void
}) {
  const numbers = pending.newKey.checkGroups
  const [typed, setTyped] = useState(['', '', ''])
  const [wrong, setWrong] = useState<number | null>(null) // which group didn't match
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    setProblem(null)
    const mismatch = numbers.findIndex((n, i) => tidyGroup(typed[i] ?? '') !== pending.newKey.groups[n - 1])
    if (mismatch !== -1) {
      setWrong(mismatch)
      return
    }
    setWrong(null)
    setBusy(true)
    try {
      setProblem(await onMatched())
    } finally {
      setBusy(false)
    }
  }

  const first = pending.flow === 'first-setup'
  return (
    <OutPage corner={`Signed in as ${email}`} wide
      footer="If a group doesn't match, look at the copy you saved before going on. A wrong copy can't get you back in.">
      {first && <StepBar step={3} label="Check your recovery key" />}
      <ScreenTitle sub="Type three groups from the copy you saved, so you know it's readable before you need it.">
        {first ? 'Check your recovery key' : 'Check your new recovery key'}
      </ScreenTitle>

      <form className="stack" onSubmit={submit} noValidate>
        <div className="form">
          <div className="groups-in">
            {numbers.map((n, i) => (
              <TextField key={n} label={`Group ${n}`} code maxLength={4} autoComplete="off" autoFocus={i === 0}
                value={typed[i] ?? ''} onChange={value => setTyped(typed.map((old, j) => (j === i ? value : old)))}
                message={wrong === i ? { tone: 'bad', text: "Doesn't match" } : null} />
            ))}
          </div>
          <p className="hint">Capitals don't matter. The groups are numbered 1 to 13 on the key.</p>
        </div>
        {wrong !== null && <Note problem><p>Group {numbers[wrong]} doesn't match your key. Look at your saved copy again.</p></Note>}
        {problem !== null && <Note problem><p>{problem}</p></Note>}
        <Button kind="primary" type="submit" block busy={busy} busyLabel="Saving your key…">Check</Button>
      </form>

      <div className="links">
        <LinkButton onClick={onShowAgain}>Show the key again</LinkButton>
      </div>
    </OutPage>
  )
}
