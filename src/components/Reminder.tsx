// The fresh-backup reminder, which Settings and the Dashboard both show
// (step 10 plan, smaller choices): a changed password or recovery key since
// the last checked backup, or a backup more than 30 days old.
import type { BackupStatus } from '../lib/account/backup.ts'
import { Button } from './Controls.tsx'
import { ClockIcon, KeyIcon } from './Icons.tsx'

// The banner at the top: a changed password or key first, then an old backup.
export function Reminder({ status, action, onAction }: { status: Exclude<BackupStatus, { kind: 'fine' }>; action: string; onAction: () => void }) {
  let text
  if (status.kind === 'keys-changed') {
    text = status.password && status.recovery
      ? <><b>Your password and recovery key have changed since your last backup.</b> Take a fresh backup, then delete older ones: they still open with the old ones.</>
      : status.password
        ? <><b>Your password has changed since your last backup.</b> Take a fresh backup, then delete older ones: they still open with your old password.</>
        : <><b>Your recovery key has changed since your last backup.</b> Take a fresh backup, then delete older ones: they still open with your old recovery key.</>
  } else {
    text = status.days === null
      ? <><b>No backup has been checked yet.</b> Export one, so you can restore everything if something goes wrong.</>
      : <><b>Your last backup was {status.days} days ago.</b> Export a new one, so you can restore everything if something goes wrong.</>
  }
  return (
    <div className="reminder" role="status">
      <div className="reminder-text">
        {status.kind === 'keys-changed' ? <KeyIcon /> : <ClockIcon />}
        <span>{text}</span>
      </div>
      <Button kind="primary" onClick={onAction}>{action}</Button>
    </div>
  )
}
