// Saving a backup to the computer, and reading a file someone chose. Both
// stay in this tab: nothing is uploaded anywhere.
import { MAX_BACKUP_CHARACTERS, readBackup, type ReadBackupResult } from '../lib/account/backup.ts'

// Starts a download of `text`, and returns its size in bytes. Backups are
// JSON, and History's export is CSV.
export function downloadText(fileName: string, text: string, type = 'application/json'): number {
  const blob = new Blob([text], { type })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  link.click()
  // Give the download time to start before letting go of the file.
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
  return blob.size
}

// Reads a chosen file as a backup. A file bigger than any real backup is
// refused before it's read, so a huge file can't stall the tab.
export async function readBackupFile(file: File): Promise<ReadBackupResult> {
  if (file.size > MAX_BACKUP_CHARACTERS) return { ok: false, problem: 'too-big' }
  return readBackup(await file.text())
}

// What to say when a chosen file isn't a backup that can be used.
export function backupFileProblem(problem: 'too-big' | 'not-a-backup' | 'newer-format' | 'damaged'): string {
  switch (problem) {
    case 'too-big': return "That file is too big to be a backup."
    case 'not-a-backup': return "That file isn't an FMBT Cashhhh backup."
    case 'newer-format': return 'That backup was made by a newer version of the app.'
    case 'damaged': return "That backup is damaged, so it can't be used."
  }
}
