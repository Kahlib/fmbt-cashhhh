// The pieces every screen is built from: the brand, the two page layouts
// (signed out, and signed in with the sidebar), screen titles and the
// setup step bar.
import { useEffect, useRef, type ReactNode } from 'react'
import { BackIcon, ChartIcon, ClockIcon, DashboardIcon, ListIcon, SlidersIcon } from './Icons.tsx'
import type { Admin } from './admin.ts'
import { AdminBanner } from './AdminMode.tsx'

export function Brand() {
  return (
    <div className="brand">
      <div className="brand-mark" aria-hidden="true">F</div>
      <div>
        <div className="brand-name">FMBT Cashhhh</div>
        <div className="brand-sub">Parlay tracker</div>
      </div>
    </div>
  )
}

// A centred card on the page background: sign-in, setup and recovery.
// `corner` is the line at the top right, like "Invite only".
export function OutPage({ corner, wide = false, footer, children }: {
  corner: string
  wide?: boolean
  footer?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="out">
      <header className="out-top">
        <Brand />
        <p className="hint">{corner}</p>
      </header>
      <main className={wide ? 'card wide' : 'card'}>{children}</main>
      {footer !== undefined && <p className="small">{footer}</p>}
    </div>
  )
}

// The signed-in pages.
export type Page = 'dashboard' | 'parlays' | 'build' | 'history' | 'analytics' | 'settings'

// The signed-in frame: the sidebar, then the page. With Admin mode on, the
// banner sits at the top of the page and a light frame goes round it.
export function AppFrame({ page, onNavigate, admin, seasonName, children }: {
  page: Page
  onNavigate: (page: Page) => void
  admin: Admin
  seasonName: string
  children: ReactNode
}) {
  const item = (to: Page, name: string, icon: ReactNode) => {
    const on = page === to || (to === 'parlays' && page === 'build')
    return (
      <button type="button" className={on ? 'nav-item on' : 'nav-item'} aria-current={on ? 'page' : undefined} onClick={() => onNavigate(to)}>
        {icon}{name}
      </button>
    )
  }
  return (
    <div className={admin.on ? 'frame adm' : 'frame'}>
      <aside className="side">
        <Brand />
        <nav className="nav" aria-label="Main">
          {item('dashboard', 'Dashboard', <DashboardIcon />)}
          {item('parlays', 'My parlays', <ListIcon />)}
          {item('history', 'History', <ClockIcon />)}
          {item('analytics', 'Analytics', <ChartIcon />)}
          {item('settings', 'Settings', <SlidersIcon />)}
        </nav>
        <div className="side-foot">
          <div className="season">Season {seasonName}</div>
          <button type="button" className="admin-row" role="switch" aria-checked={admin.on}
            onClick={admin.on ? admin.turnOff : admin.turnOn}>
            Admin mode<span className="switch" aria-hidden="true" />
          </button>
          <p className="attribution">Football data provided by the Football-Data.org API</p>
        </div>
      </aside>
      <div className="main">
        {admin.on && <AdminBanner admin={admin} />}
        {children}
      </div>
    </div>
  )
}

// A signed-in page's heading, with the Admin tag beside it while Admin mode
// is on, the sentence under it, and what sits at its right.
// `back` puts a button above the title that goes back where you came from,
// where people look for one (step 11 plan, 11.5).
export function PageHead({ title, status, admin, right, back }: {
  title: string
  status?: ReactNode
  admin: Admin
  right?: ReactNode
  back?: { label: string; onClick: () => void }
}) {
  return (
    <div className="topbar">
      <div>
        {back !== undefined && <button type="button" className="back-btn" onClick={back.onClick}><BackIcon />{back.label}</button>}
        <div className="title-row">
          <ScreenTitle>{title}</ScreenTitle>
          {admin.on && <span className="adm-tag">Admin</span>}
        </div>
        {status !== undefined && <p className="status">{status}</p>}
      </div>
      {right !== undefined && <div className="topbar-r">{right}</div>}
    </div>
  )
}

// A screen's heading and the sentence under it. The heading takes focus
// when the screen opens, so a screen reader announces the new screen.
// Sign-in turns that off and puts the cursor in the email field instead.
export function ScreenTitle({ children, sub, focus = true }: { children: ReactNode; sub?: ReactNode; focus?: boolean }) {
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    if (focus) heading.current?.focus()
  }, [focus])
  return (
    <div>
      <h1 className="title" tabIndex={-1} ref={heading}>{children}</h1>
      {sub !== undefined && <p className="sub">{sub}</p>}
    </div>
  )
}

// "Step 2 of 4" over four bars, for first-time setup.
export function StepBar({ step, label }: { step: 1 | 2 | 3 | 4; label: string }) {
  return (
    <div className="steps" aria-label={`Step ${step} of 4: ${label}`}>
      <div className="steps-label" aria-hidden="true"><span>Step {step} of 4</span><span>{label}</span></div>
      <div className="steps-row" aria-hidden="true">
        {[1, 2, 3, 4].map(n => <div key={n} className={n <= step ? 'seg on' : 'seg'} />)}
      </div>
    </div>
  )
}
