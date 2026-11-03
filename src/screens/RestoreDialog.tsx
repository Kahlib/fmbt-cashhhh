// Restore from a backup: the preview, then the restore (canvas: "Restore
// from a backup: the preview"). Restoring only ever adds.
import { useState } from 'react'
import type { AccountApi } from '../lib/account/api.ts'
import { applyRestore, type Backup, type RestorePlan, type RestoreResult } from '../lib/account/backup.ts'
import { count, formatDay } from '../lib/format.ts'
import { Button, FileButton, Note } from '../components/Controls.tsx'
import { StatusIcon } from '../components/Icons.tsx'
import { Dialog } from '../components/Overlays.tsx'
import { OFFLINE } from './messages.ts'

export function RestoreDialog({ api, fileName, backup, plan, onClose, onRestored, onChooseAnother }: {
  api: AccountApi
  fileName: string
  backup: Backup
  plan: RestorePlan
  onClose: () => void
  onRestored: (result: RestoreResult) => void
  onChooseAnother: (file: File) => void
}) {
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const toAdd = plan.add.weekVersions.length + plan.add.settingsVersions.length + plan.add.auditEntries.length
  const inFile = backup.weekVersions.length + backup.settingsVersions.length + backup.auditEntries.length
  const versions = (n: number) => count(n, 'saved version', 'saved versions')
  const otherAccount = toAdd === 0 && plan.alreadyHere === 0 && plan.wontOpen > 0

  async function restore() {
    setBusy(true)
    setProblem(null)
    try {
      onRestored(await applyRestore(api, plan.add))
    } catch {
      setProblem(OFFLINE)
      setBusy(false)
    }
  }

  return (
    <Dialog title="Restore from this backup?" wide onClose={onClose}
      sub={`${fileName}, exported ${formatDay(backup.exportedAt)}, ${versions(inFile)}.`}>
      {otherAccount ? (
        <div className="results">
          <div className="result"><StatusIcon kind="bad" /><span><b>Nothing in this backup opens with your key.</b> It's probably from another account.</span></div>
        </div>
      ) : toAdd === 0 && plan.wontOpen === 0 ? (
        <div className="results">
          <div className="result"><StatusIcon kind="good" /><span><b>Everything in this backup is already here.</b> There's nothing to add.</span></div>
        </div>
      ) : (
        <div className="results">
          {toAdd > 0 && (
            <div className="result"><StatusIcon kind="good" /><span><b>{versions(toAdd)}</b> {toAdd === 1 ? 'is' : 'are'} missing here. {toAdd === 1 ? "It'll" : "They'll"} be added back.</span></div>
          )}
          {plan.alreadyHere > 0 && (
            <div className="result"><StatusIcon kind="none" /><span><b>{plan.alreadyHere.toLocaleString('en-GB')}</b> {plan.alreadyHere === 1 ? 'is' : 'are'} already here, and stay as {plan.alreadyHere === 1 ? 'it is' : 'they are'}.</span></div>
          )}
          {plan.wontOpen > 0 && (
            <div className="result"><StatusIcon kind="bad" /><span><b>{plan.wontOpen.toLocaleString('en-GB')}</b> {plan.wontOpen === 1 ? "doesn't" : "don't"} open with your key, so {plan.wontOpen === 1 ? "it's" : "they're"} left out. The file may have been changed or damaged.</span></div>
          )}
        </div>
      )}

      {toAdd > 0 && <Note><p>Restoring only adds. It never replaces or deletes anything, and your password and recovery key stay as they are.</p></Note>}
      {problem !== null && <Note problem><p>{problem}</p></Note>}

      <div className="actions">
        {otherAccount ? (
          <>
            <Button onClick={onClose}>Cancel</Button>
            <FileButton kind="primary" onFile={onChooseAnother}>Choose another file</FileButton>
          </>
        ) : toAdd === 0 ? (
          <Button kind="primary" onClick={onClose}>Done</Button>
        ) : (
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button kind="primary" busy={busy} busyLabel="Adding…" onClick={restore}>Add {versions(toAdd)}</Button>
          </>
        )}
      </div>
    </Dialog>
  )
}
