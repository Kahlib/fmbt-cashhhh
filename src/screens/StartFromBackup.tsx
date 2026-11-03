// Setup step 1, instead: start from a backup (canvas: "Setup 1 of 4,
// instead: start from a backup"). The new account takes over the backup's
// data key, so everything in the file opens again.
import { useState, type FormEvent } from 'react'
import type { AccountApi } from '../lib/account/api.ts'
import { startFromBackup, type Backup } from '../lib/account/backup.ts'
import type { NewRecoveryKey, PreparedRecoveryWrap } from '../lib/account/new-recovery-key.ts'
import type { Unlocked } from '../lib/account/wraps.ts'
import { count, formatDay } from '../lib/format.ts'
import { Button, FileButton, Hint, KeyField, LinkButton, Note, PasswordField, Segmented, TextField, type Message } from '../components/Controls.tsx'
import { FileIcon } from '../components/Icons.tsx'
import { OutPage, ScreenTitle, StepBar } from '../components/Layout.tsx'
import { backupFileProblem, readBackupFile } from '../components/files.ts'
import { confirmHint, keyProblemText, newPasswordHint, newPasswordReady, OFFLINE, passwordProblemText, TOO_MANY_TRIES } from './messages.ts'

type Chosen = { name: string; backup: Backup }
type Opener = 'password' | 'key'

// What the new account got from the file, for a note on the next screen.
export type StartedSummary = { added: number; skipped: number }

export function StartFromBackup({ api, onStarted, onSetUp, onSignIn }: {
  api: AccountApi
  onStarted: (unlocked: Unlocked, newKey: NewRecoveryKey, prepared: PreparedRecoveryWrap, summary: StartedSummary) => void
  onSetUp: () => void
  onSignIn: () => void
}) {
  const [email, setEmail] = useState('')
  const [chosen, setChosen] = useState<Chosen | null>(null)
  const [fileMessage, setFileMessage] = useState<Message | null>(null)
  const [opener, setOpener] = useState<Opener>('password')
  const [password, setPassword] = useState('')
  const [keyText, setKeyText] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [again, setAgain] = useState('')
  const [tried, setTried] = useState(false)
  const [busy, setBusy] = useState(false)
  const [emailMessage, setEmailMessage] = useState<Message | null>(null)
  const [secretMessage, setSecretMessage] = useState<Message | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  async function choose(file: File) {
    setFileMessage(null)
    const read = await readBackupFile(file)
    if (!read.ok) {
      setChosen(null)
      setFileMessage({ tone: 'bad', text: backupFileProblem(read.problem) })
      return
    }
    setChosen({ name: file.name, backup: read.backup })
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    setTried(true)
    setEmailMessage(null)
    setSecretMessage(null)
    setProblem(null)
    if (chosen === null) {
      setFileMessage({ tone: 'bad', text: 'Choose the backup file first.' })
      return
    }
    if (opener === 'key' && !newPasswordReady(newPassword, again, email)) return
    setBusy(true)
    try {
      const secret = opener === 'password' ? { password } : { recoveryKeyText: keyText, newPassword }
      const result = await startFromBackup(api, email, chosen.backup, secret)
      switch (result.kind) {
        case 'started':
          onStarted(result.unlocked, result.newKey, result.prepared, { added: result.added, skipped: result.taken + result.wontOpen })
          return
        case 'wont-open':
          setSecretMessage({
            tone: 'bad',
            text: opener === 'password'
              ? "This doesn't open the backup. Check the email is the one its account had, or use its recovery key instead."
              : "This key doesn't open the backup. It needs the key you had when you took it.",
          })
          break
        case 'key-problem':
          setSecretMessage({ tone: 'bad', text: keyProblemText(result.problem, keyText) })
          break
        case 'password-rules':
          setSecretMessage({
            tone: 'bad',
            text: opener === 'password'
              ? `${passwordProblemText(result.problem, password)} A new account needs a stronger password, so use the backup's recovery key and choose a new one.`
              : passwordProblemText(result.problem, newPassword),
          })
          break
        case 'not-invited':
          setEmailMessage({ tone: 'bad', text: "This email doesn't have an invite. Check it's the address you were invited with." })
          break
        case 'exists':
          setEmailMessage({ tone: 'bad', text: <>There's already an account with this email. <LinkButton onClick={onSignIn}>Sign in</LinkButton>, then use Restore in Settings.</> })
          break
        case 'too-many-tries':
          setProblem(TOO_MANY_TRIES)
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

  const records = chosen === null ? 0
    : chosen.backup.weekVersions.length + chosen.backup.settingsVersions.length + chosen.backup.auditEntries.length

  return (
    <OutPage corner="Invite only" wide footer="The file is opened in this tab. Nothing is sent until it opens.">
      <StepBar step={1} label="Start from a backup" />
      <ScreenTitle sub="Your new account takes over the backup's key, so everything in it opens again. You still need an invite.">Start from a backup</ScreenTitle>

      <form className="stack" onSubmit={submit} noValidate>
        <div className="form">
          <TextField label="Email" type="email" autoComplete="username" value={email} onChange={setEmail} message={emailMessage} />

          <div className="field">
            <span className="label">Backup file</span>
            {chosen === null ? (
              <div className="btn-row"><FileButton onFile={choose}>Choose the backup file</FileButton></div>
            ) : (
              <div className="file">
                <FileIcon />
                <div className="file-text">
                  <span className="file-name">{chosen.name}</span>
                  <span className="file-meta">Exported {formatDay(chosen.backup.exportedAt)}, {count(records, 'saved version', 'saved versions')}</span>
                </div>
                <FileButton onFile={choose}>Choose another</FileButton>
              </div>
            )}
            {fileMessage !== null && <Hint tone={fileMessage.tone}>{fileMessage.text}</Hint>}
          </div>

          <Segmented label="Open it with" value={opener} onChange={value => { setOpener(value); setSecretMessage(null) }}
            options={[{ value: 'password', label: 'Its password' }, { value: 'key', label: 'Its recovery key' }]} />

          {opener === 'password' ? (
            <PasswordField label="The backup's password" autoComplete="current-password" value={password} onChange={setPassword}
              message={secretMessage ?? { tone: 'neutral', text: "It opens the file only with the email that account had. It becomes your new account's password too." }} />
          ) : (
            <>
              <KeyField label="The backup's recovery key" value={keyText} onChange={setKeyText}
                message={secretMessage ?? { tone: 'neutral', text: "The key you had when you took the backup. Spaces, dashes and capitals don't matter." }} />
              <PasswordField label="New password" autoComplete="new-password" value={newPassword} onChange={setNewPassword}
                message={newPasswordHint(newPassword, email, tried)} />
              <PasswordField label="Type it again" autoComplete="new-password" value={again} onChange={setAgain}
                message={confirmHint(newPassword, again, tried)} />
            </>
          )}
        </div>

        <Note><p>Next you'll save a new recovery key and take a fresh backup, the same as a new setup.</p></Note>
        {problem !== null && <Note problem><p>{problem}</p></Note>}

        <Button kind="primary" type="submit" block busy={busy} busyLabel="Opening the backup…">Start from this backup</Button>
      </form>

      <div className="links">
        <LinkButton onClick={onSetUp}>Back to setup</LinkButton>
        <LinkButton onClick={onSignIn}>Back to sign in</LinkButton>
      </div>
    </OutPage>
  )
}
