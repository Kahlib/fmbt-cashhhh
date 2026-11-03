// Taking a backup: download it, then choose the file so the app can check
// it opens and matches the account. Setup step 4 and Settings both use it.
// Only a backup that checks out counts, and resets the 30-day reminder.
import { useState } from 'react'
import type { AccountApi } from '../lib/account/api.ts'
import { checkBackup, exportBackup, recordBackup } from '../lib/account/backup.ts'
import type { Unlocked } from '../lib/account/wraps.ts'
import { formatSize } from '../lib/format.ts'
import { Button, FileButton } from '../components/Controls.tsx'
import { DownloadIcon, FolderIcon, StatusIcon } from '../components/Icons.tsx'
import { backupFileProblem, downloadText, readBackupFile } from '../components/files.ts'
import { describeCheck, OFFLINE } from './messages.ts'

type Downloaded = { fileName: string; size: number }
type Checked = { kind: 'checked' } | { kind: 'mismatch'; text: string } | null

export function BackupSteps({ api, unlocked, finishLabel, onFinish }: {
  api: AccountApi
  unlocked: Unlocked
  finishLabel: string
  onFinish: () => void
}) {
  const [downloaded, setDownloaded] = useState<Downloaded | null>(null)
  const [checked, setChecked] = useState<Checked>(null)
  const [busy, setBusy] = useState<'download' | 'check' | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  async function download() {
    setBusy('download')
    setProblem(null)
    try {
      const file = await exportBackup(api)
      setDownloaded({ fileName: file.fileName, size: downloadText(file.fileName, file.text) })
      setChecked(null)
    } catch {
      setProblem(OFFLINE)
    } finally {
      setBusy(null)
    }
  }

  async function check(file: File) {
    setBusy('check')
    setProblem(null)
    try {
      const read = await readBackupFile(file)
      if (!read.ok) {
        setChecked({ kind: 'mismatch', text: backupFileProblem(read.problem) })
        return
      }
      const result = await checkBackup(api, unlocked.dataKey, read.backup)
      if (!result.ok) {
        setChecked({ kind: 'mismatch', text: describeCheck(result, read.backup) })
        return
      }
      await recordBackup(api, unlocked.dataKey, read.backup)
      setChecked({ kind: 'checked' })
    } catch {
      setProblem(OFFLINE)
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      {downloaded === null ? (
        <div className="task current">
          <div className="task-head"><span className="task-num" aria-hidden="true">1</span>Download your backup</div>
          <p>Your whole account in one encrypted file. It goes to your Downloads folder.</p>
        </div>
      ) : (
        <div className="task">
          <div className="task-head"><StatusIcon kind="good" />Backup downloaded</div>
          <p>{downloaded.fileName}, {formatSize(downloaded.size)}, in your Downloads folder.</p>
          <div className="btn-row">
            <Button onClick={download} busy={busy === 'download'} busyLabel="Downloading…"><DownloadIcon />Download again</Button>
          </div>
        </div>
      )}

      {/* Before the download, show what comes after it. */}
      {downloaded === null && (
        <div className="task later">
          <div className="task-head"><span className="task-num" aria-hidden="true">2</span>Check that it opens</div>
        </div>
      )}
      {downloaded !== null && checked === null && (
        <div className="task current">
          <div className="task-head"><span className="task-num" aria-hidden="true">2</span>Check that it opens</div>
          <p>Choose the file you just downloaded. The app reads it back and checks it matches your account. Nothing gets uploaded.</p>
        </div>
      )}
      {checked?.kind === 'checked' && (
        <div className="task" role="status">
          <div className="task-head"><StatusIcon kind="good" />Backup checked</div>
          <p>It opens and matches your account. Keep it somewhere other than this computer too, like a USB stick or your cloud drive.</p>
        </div>
      )}
      {checked?.kind === 'mismatch' && (
        <div className="task current" role="alert">
          <div className="task-head"><StatusIcon kind="bad" />This file doesn't match your account</div>
          <p>{checked.text} Choose the file you just downloaded, or download it again.</p>
        </div>
      )}
      {problem !== null && (
        <div className="task current" role="alert">
          <div className="task-head"><StatusIcon kind="bad" />That didn't work</div>
          <p>{problem}</p>
        </div>
      )}

      {downloaded === null && (
        <Button kind="primary" block onClick={download} busy={busy === 'download'} busyLabel="Downloading…"><DownloadIcon />Download backup</Button>
      )}
      {downloaded !== null && checked?.kind !== 'checked' && (
        <FileButton kind="primary" block onFile={check} busy={busy === 'check'} busyLabel="Checking…">
          <FolderIcon />{checked?.kind === 'mismatch' ? 'Choose another file' : 'Choose the backup file'}
        </FileButton>
      )}
      {checked?.kind === 'checked' && <Button kind="primary" block onClick={onFinish}>{finishLabel}</Button>}
    </>
  )
}
