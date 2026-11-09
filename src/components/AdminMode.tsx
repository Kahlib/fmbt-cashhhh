// Admin mode's banner, pinned to the top of the page while it's on
// (fmbt-design-system, "Admin mode"). Its state is in admin.ts.
import { countdown, type Admin } from './admin.ts'
import { OpenLockIcon } from './Icons.tsx'

export function AdminBanner({ admin }: { admin: Admin }) {
  return (
    <div className="admbar" role="status">
      <OpenLockIcon />
      <span><b>Admin mode is on.</b> Locked parlays can be edited, and every change goes in the audit log.</span>
      <span className="adm-left">Turns itself off in <b>{countdown(admin.secondsLeft)}</b> if you're idle</span>
      <button type="button" className="adm-off" onClick={admin.turnOff}>Turn off</button>
    </div>
  )
}
