// Setup step 4 (canvas: "Setup 4 of 4: first backup").
import type { AccountApi } from '../lib/account/api.ts'
import type { Unlocked } from '../lib/account/wraps.ts'
import { OutPage, ScreenTitle, StepBar } from '../components/Layout.tsx'
import { BackupSteps } from './BackupSteps.tsx'

export function FirstBackup({ api, unlocked, onDone }: { api: AccountApi; unlocked: Unlocked; onDone: () => void }) {
  return (
    <OutPage corner={`Signed in as ${unlocked.email}`} wide footer="The app reminds you once your last backup is more than 30 days old.">
      <StepBar step={4} label="Take your first backup" />
      <ScreenTitle sub="A backup is your whole account in one encrypted file. It's safe to keep anywhere, and it opens only with your password or recovery key.">
        Take your first backup
      </ScreenTitle>
      <BackupSteps api={api} unlocked={unlocked} finishLabel="Finish setup" onFinish={onDone} />
    </OutPage>
  )
}
