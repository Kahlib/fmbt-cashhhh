// The pieces every screen is built from: the brand, the two page layouts
// (signed out, and signed in with the sidebar), screen titles and the
// setup step bar.
import { useEffect, useRef, type ReactNode } from 'react'
import { ChartIcon, ClockIcon, DashboardIcon, ListIcon, SlidersIcon } from './Icons.tsx'

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

// The signed-in frame: the sidebar, then the page. Only Settings exists in
// step 7, so the other pages show as not ready yet.
export function AppFrame({ children }: { children: ReactNode }) {
  const later = [
    { name: 'Dashboard', icon: <DashboardIcon /> },
    { name: 'My parlays', icon: <ListIcon /> },
    { name: 'History', icon: <ClockIcon /> },
    { name: 'Analytics', icon: <ChartIcon /> },
  ]
  return (
    <div className="frame">
      <aside className="side">
        <Brand />
        <nav className="nav" aria-label="Main">
          {later.map(page => (
            <span key={page.name} className="nav-item off" aria-disabled="true" title="Not built yet">
              {page.icon}{page.name}
            </span>
          ))}
          <span className="nav-item on" aria-current="page"><SlidersIcon />Settings</span>
        </nav>
        <div className="side-foot">
          <div className="season">Season 2026/27</div>
        </div>
      </aside>
      <div className="main">{children}</div>
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
