// Settings: security and backups (canvas: "Settings: security and backups"
// and "Settings: after a key change"), then the audit log and, for app
// admins, the invite list (step 10.5). The signed-in frame round it is
// SignedIn's, from step 10.
import { useCallback, useEffect, useState } from 'react'
import type { AccountApi, Stored, WeekRow } from '../lib/account/api.ts'
import { backupStatus, planRestore, type Backup, type BackupStatus, type RestorePlan, type RestoreResult } from '../lib/account/backup.ts'
import type { KeyWrapRow } from '../lib/crypto/keys.ts'
import { makeNewRecoveryKey, type NewRecoveryKey } from '../lib/account/new-recovery-key.ts'
import { newestFirst, type Unlocked } from '../lib/account/wraps.ts'
import { count, daysAgo, formatDay } from '../lib/format.ts'
import { loadSettings, type SettingsRecord } from '../lib/records/settings.ts'
import { Button, FileButton, Hint, Note } from '../components/Controls.tsx'
import { DownloadIcon, UploadIcon } from '../components/Icons.tsx'
import { Reminder } from '../components/Reminder.tsx'
import { useAdmin } from '../components/admin.ts'
import { PageHead } from '../components/Layout.tsx'
import { Dialog, Toast } from '../components/Overlays.tsx'
import { backupFileProblem, readBackupFile } from '../components/files.ts'
import { AuditLog } from './AuditLog.tsx'
import { BackupSteps } from './BackupSteps.tsx'
import { ChangePasswordDialog } from './ChangePasswordDialog.tsx'
import { Invites } from './Invites.tsx'
import { OFFLINE } from './messages.ts'
import { RestoreDialog } from './RestoreDialog.tsx'

type Loaded = { settings: SettingsRecord; wraps: Stored<KeyWrapRow>[]; weeks: Stored<WeekRow>[]; versions: number }
type Open =
  | { kind: 'change-password' }
  | { kind: 'export' }
  | { kind: 'restore'; fileName: string; backup: Backup; plan: RestorePlan }
  | null

export function Settings({ api, unlocked, toast: firstToast, onSignOut, onNewKey, onWeeksChanged }: {
  api: AccountApi
  unlocked: Unlocked
  toast?: string
  onSignOut: () => void
  onNewKey: (newKey: NewRecoveryKey) => void
  onWeeksChanged: () => void    // a restore or the demo season added weeks, so My parlays reloads
}) {
  const admin = useAdmin()
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [loadProblem, setLoadProblem] = useState(false)
  const [open, setOpen] = useState<Open>(null)
  const [toast, setToast] = useState<string | null>(firstToast ?? null)
  const [restoreProblem, setRestoreProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState<'restore' | 'new-key' | 'demo' | null>(null)

  // What the panels show, fetched when the page opens and again after
  // anything changes it. Bumping `version` fetches it again.
  const [version, setVersion] = useState(0)
  const load = useCallback(() => setVersion(v => v + 1), [])
  useEffect(() => {
    let current = true // false once a newer fetch or leaving the page makes this one stale
    const fetchAll = async () => {
      try {
        const wraps = await api.keyWraps()
        const settings = (await loadSettings(api, unlocked.dataKey)).record
        const weeks = await api.records('week_versions')
        // Every saved version, counted the way a backup counts them: weeks,
        // settings and the audit log.
        const versions = weeks.length + (await api.records('settings_versions')).length + (await api.records('audit_entries')).length
        if (current) {
          setLoaded({ settings, wraps, weeks, versions })
          setLoadProblem(false)
        }
      } catch {
        if (current) setLoadProblem(true)
      }
    }
    void fetchAll()
    return () => {
      current = false
    }
  }, [api, unlocked, version])

  async function chooseRestoreFile(file: File) {
    setRestoreProblem(null)
    setBusy('restore')
    try {
      const read = await readBackupFile(file)
      if (!read.ok) {
        setOpen(null)
        setRestoreProblem(backupFileProblem(read.problem))
        return
      }
      const plan = await planRestore(api, unlocked.dataKey, read.backup)
      setOpen({ kind: 'restore', fileName: file.name, backup: read.backup, plan })
    } catch {
      setRestoreProblem(OFFLINE)
    } finally {
      setBusy(null)
    }
  }

  function restored(result: RestoreResult) {
    setOpen(null)
    const added = `Added ${count(result.added, 'saved version', 'saved versions')}.`
    setToast(result.taken === 0 ? added : `${added} ${result.taken.toLocaleString('en-GB')} skipped, because a newer one took ${result.taken === 1 ? 'its' : 'their'} place.`)
    load()
    onWeeksChanged()
  }

  async function newKey() {
    setBusy('new-key')
    try {
      onNewKey(await makeNewRecoveryKey())
    } finally {
      setBusy(null)
    }
  }

  async function demoSeason() {
    // Development only: Vite sets import.meta.env.DEV to false in a
    // production build, which leaves this out, and the file with it.
    if (!import.meta.env.DEV) return
    setBusy('demo')
    try {
      const { fillDemoSeason } = await import('../lib/records/demo-season.ts')
      const added = await fillDemoSeason(api, unlocked.dataKey)
      setToast(added.weeks === 0 ? 'Every finished week already has parlays, so nothing was added.'
        : `Added a demo season: ${count(added.weeks, 'week', 'weeks')} and ${count(added.parlays, 'parlay', 'parlays')}.`)
      load()
      onWeeksChanged()
    } catch {
      setToast(null)
      setRestoreProblem(OFFLINE)
    } finally {
      setBusy(null)
    }
  }

  const status: BackupStatus | null = loaded === null ? null : backupStatus(loaded.settings, loaded.wraps)
  // When the recovery key was made: when its wrap was saved.
  const madeAt = loaded === null ? undefined : newestFirst(loaded.wraps, 'recovery')[0]?.created_at
  const lastBackup = loaded?.settings.lastBackupAt ?? null
  const weeks = loaded === null ? 0 : new Set(loaded.weeks.map(w => `${w.season} ${w.competition} ${w.period}`)).size

  return (
    <>
      <PageHead title="Settings" admin={admin} status={`Signed in as ${unlocked.email}. Closing or refreshing this tab signs you out.`}
        right={<Button onClick={onSignOut}>Sign out</Button>} />

      {status !== null && status.kind !== 'fine' && <Reminder status={status} action="Export backup" onAction={() => setOpen({ kind: 'export' })} />}
      {loadProblem && <Note problem><p>{OFFLINE}</p></Note>}

      <div className="grid">
        <section className="panel span-6">
          <div>
            <h2 className="ptitle">Password</h2>
            <p className="sub">Your password unlocks your bets in each tab. Changing it re-locks your data key, so nothing needs re-encrypting.</p>
          </div>
          <div className="btn-row"><Button onClick={() => setOpen({ kind: 'change-password' })}>Change password</Button></div>
        </section>

        <section className="panel span-6">
          <div>
            <h2 className="ptitle">Recovery key</h2>
            <p className="sub">Gets you back in if you forget your password. Make a new one if you think someone has seen yours, and the old one stops working.</p>
          </div>
          <div className="stats">
            <div><div className="stat-label">Made</div><div className="stat-value">{madeAt === undefined ? 'Not yet' : formatDay(madeAt)}</div></div>
          </div>
          <div className="btn-row"><Button onClick={newKey} busy={busy === 'new-key'} busyLabel="Making a key…">Make a new recovery key</Button></div>
        </section>

        <section className="panel span-12">
          <div>
            <h2 className="ptitle">Backups</h2>
            <p className="sub">An encrypted copy of your whole account. It's safe to keep anywhere, and it opens only with your password or recovery key.</p>
          </div>
          <div className="stats">
            <div>
              <div className="stat-label">Last backup</div>
              <div className="stat-value">{lastBackup === null ? 'Not yet' : formatDay(lastBackup)}</div>
              {lastBackup !== null && <div className="stat-note">{daysAgo(lastBackup)}</div>}
            </div>
            <div>
              <div className="stat-label">In your account</div>
              <div className="stat-value">{count(weeks, 'week', 'weeks')}</div>
              <div className="stat-note">{count(loaded?.versions ?? 0, 'saved version', 'saved versions')}</div>
            </div>
          </div>
          <div className="btn-row">
            <Button onClick={() => setOpen({ kind: 'export' })}><DownloadIcon />Export backup</Button>
            <FileButton onFile={chooseRestoreFile} busy={busy === 'restore'} busyLabel="Reading the file…"><UploadIcon />Restore from a backup</FileButton>
            {import.meta.env.DEV && (
              <>
                <Button onClick={demoSeason} busy={busy === 'demo'} busyLabel="Filling…">Fill with a demo season</Button>
                <span className="dev-tag">Dev only</span>
              </>
            )}
          </div>
          {restoreProblem !== null ? <Hint tone="bad">{restoreProblem}</Hint>
            : <Hint>Restoring adds anything in the file that's missing here. It never replaces or deletes what's already saved.</Hint>}
        </section>

        {/* Opened again whenever the panels above reload, since a restore can add entries. */}
        <AuditLog key={version} api={api} unlocked={unlocked} />
        <Invites api={api} myEmail={unlocked.email} onToast={setToast} />
      </div>

      {open?.kind === 'change-password' && (
        <ChangePasswordDialog api={api} unlocked={unlocked} onClose={() => setOpen(null)}
          onChanged={() => {
            setOpen(null)
            setToast('Password changed. Other tabs and devices sign out within 15 minutes.')
            load()
          }} />
      )}
      {open?.kind === 'export' && (
        <Dialog title="Export a backup" wide onClose={() => setOpen(null)}
          sub="Download it, then choose the file so the app can check it opens. Only a checked backup counts.">
          <BackupSteps api={api} unlocked={unlocked} finishLabel="Done"
            onFinish={() => {
              setOpen(null)
              setToast('Backup checked. It opens and matches your account.')
              load()
            }} />
        </Dialog>
      )}
      {open?.kind === 'restore' && (
        <RestoreDialog api={api} fileName={open.fileName} backup={open.backup} plan={open.plan}
          onClose={() => setOpen(null)} onRestored={restored} onChooseAnother={chooseRestoreFile} />
      )}
      {toast !== null && <Toast message={toast} onDone={() => setToast(null)} />}
    </>
  )
}
