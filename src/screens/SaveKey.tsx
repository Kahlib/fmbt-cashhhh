// Show a new recovery key (canvas: "Setup 2 of 4: save the recovery key",
// with its four headings). Every flow that makes a key uses this screen.
import { useState } from 'react'
import { formatDay } from '../lib/format.ts'
import { Button, Hint, Note } from '../components/Controls.tsx'
import { CheckIcon, CopyIcon, PrintIcon } from '../components/Icons.tsx'
import { OutPage, ScreenTitle, StepBar } from '../components/Layout.tsx'
import type { KeyFlow, PendingKey } from './flow.ts'

const HEADINGS: Record<KeyFlow, { title: string; sub: string }> = {
  'first-setup': { title: 'Save your recovery key', sub: "If you forget your password, this key gets you back in. It's shown once, and nobody can make you a copy later." },
  'settings': { title: 'Your new recovery key', sub: 'Save it the way you saved your first one. Your old key keeps working until this one is saved.' },
  'after-recovery': { title: 'Save your new recovery key', sub: "You're back in. The key you just used keeps working until this one is saved, then it stops." },
  'unfinished': { title: 'Save a new recovery key', sub: "The last change to your recovery key didn't finish, so here's a new one. Until it's saved, your old key still works." },
}

export function SaveKey({ email, pending, note, onContinue }: {
  email: string
  pending: PendingKey
  note?: string // a line about what just happened, like a restore's count
  onContinue: () => void
}) {
  const [saved, setSaved] = useState(false)
  const [copy, setCopy] = useState<'not-yet' | 'copied' | 'failed'>('not-yet')
  const [today] = useState(() => formatDay(new Date().toISOString()))
  const heading = HEADINGS[pending.flow]
  const groups = pending.newKey.groups

  async function copyKey() {
    try {
      await navigator.clipboard.writeText(groups.join(' '))
      setCopy('copied')
    } catch {
      setCopy('failed')
    }
  }

  return (
    <OutPage corner={`Signed in as ${email}`} wide
      footer="The key is made in this tab and never sent anywhere. Only a proof made from it is stored, so it can be checked later.">
      {pending.flow === 'first-setup' && <StepBar step={2} label="Save your recovery key" />}
      <ScreenTitle sub={heading.sub}>{heading.title}</ScreenTitle>
      {note !== undefined && <Note><p>{note}</p></Note>}

      {/* Only this part prints. The key itself goes on the page with its
          date, but not the email, so a lost printout is less use to anyone. */}
      <div className="printable">
        <p className="print-only">FMBT Cashhhh recovery key, made {today}</p>
        <div className="key" role="group" aria-label="Recovery key, 13 groups of 4 characters">
          {groups.map((group, i) => (
            <div className="group" key={i}>
              <span className="group-n">{i + 1}</span>
              <span className="group-v">{group}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="stack tight">
        <div className="btn-row">
          <Button onClick={copyKey}>
            {copy === 'copied' ? <><CheckIcon />Copied</> : <><CopyIcon />Copy key</>}
          </Button>
          <Button onClick={() => window.print()}><PrintIcon />Print</Button>
        </div>
        {copy === 'copied' && (
          <p className="hint" role="status">If this computer keeps a clipboard history, clear it once the key is saved. On Windows, press Win+V and choose Clear all.</p>
        )}
        {copy === 'failed' && <Hint tone="bad">Couldn't copy it. Select the groups and copy them yourself, or print the key.</Hint>}
      </div>

      <Note>
        <p><b>Good places:</b> your password manager, or printed and kept somewhere safe at home.</p>
        <p><b>Not:</b> email, a photo on your phone, or a file on this computer.</p>
      </Note>

      <label className="check-row">
        <input type="checkbox" checked={saved} onChange={event => setSaved(event.target.checked)} />
        <span>I've saved my recovery key somewhere safe</span>
      </label>

      <Button kind="primary" block disabled={!saved} onClick={onContinue}>Continue</Button>
    </OutPage>
  )
}
