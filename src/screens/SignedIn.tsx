// The signed-in app: the frame, its pages and Admin mode, with your weeks
// and the season's fixtures loaded once and kept fresh while the tab is open
// (step 10 plan, The flows: Signing in).
//
// There's no router. Back and Forward still move between pages: each page
// change adds a history entry holding only the page's name, and the address
// stays the same, so they never leave the site and sign you out.
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { AccountApi } from '../lib/account/api.ts'
import type { NewRecoveryKey } from '../lib/account/new-recovery-key.ts'
import type { Unlocked } from '../lib/account/wraps.ts'
import type { Competition, Week } from '../lib/bets/week-record.ts'
import { leaving } from '../lib/leaving.ts'
import { editable, inLiveWindow, LiveData, MINUTE, RELOAD_EVERY } from '../lib/live.ts'
import { seasonLabel, seasonOf } from '../lib/periods.ts'
import { AdminContext, useAdminMode } from '../components/admin.ts'
import { AppFrame, type Page } from '../components/Layout.tsx'
import { Toast } from '../components/Overlays.tsx'
import { EMPTY_SLIP, slipFor, type Slip } from '../lib/bets/slip.ts'
import { BuildParlay } from './BuildParlay.tsx'
import { MyParlays } from './MyParlays.tsx'
import { Settings } from './Settings.tsx'

const PAGES = new Set<unknown>(['parlays', 'build', 'settings'])

// The season the app shows: the one this tab opened in.
const SEASON = seasonOf(new Date())

export function SignedIn({ api, unlocked, firstPage, firstToast, onSignOut, onNewKey }: {
  api: AccountApi
  unlocked: Unlocked
  firstPage: Page
  firstToast?: string
  onSignOut: () => void
  onNewKey: (newKey: NewRecoveryKey) => void
}) {
  const season = SEASON
  const live = useMemo(() => new LiveData(api, unlocked.dataKey, season), [api, unlocked, season])
  const snapshot = useSyncExternalStore(live.subscribe, live.snapshot)
  const [page, setPage] = useState<Page>(firstPage)
  const [toast, setToast] = useState<string | null>(null)
  const [slip, setSlip] = useState<Slip>(EMPTY_SLIP)
  const [competition, setCompetition] = useState<Competition>('PL')
  const [period, setPeriod] = useState<string | null>(null)
  const admin = useAdminMode(why => setToast(why === 'idle'
    ? 'Admin mode turned itself off after 5 idle minutes.'
    : 'Admin mode is off. Locked parlays are read-only again.'))

  // Load everything now, then keep it fresh: every minute while a match is
  // in its live window, the whole season every hour, and again when you come
  // back to the tab after a minute or more away.
  useEffect(() => {
    void live.loadAll()
    const tick = setInterval(() => {
      const state = live.snapshot()
      const now = Date.now()
      if (state.loadedAt !== null && now - state.loadedAt >= RELOAD_EVERY) void live.loadAll()
      else if ([...state.fixtures.values()].some(fixture => inLiveWindow(fixture, now))) void live.refresh()
      else live.tick()
    }, MINUTE)
    const back = () => {
      const state = live.snapshot()
      if (document.visibilityState === 'visible' && state.loadedAt !== null && Date.now() - state.loadedAt >= MINUTE) void live.loadAll()
    }
    document.addEventListener('visibilitychange', back)
    return () => {
      clearInterval(tick)
      document.removeEventListener('visibilitychange', back)
    }
  }, [live])

  // Back and Forward. The history entry holds the page's name and nothing
  // else, so no bet ever lands in the browser's history.
  useEffect(() => {
    history.replaceState({ fmbt: firstPage }, '', '/')
    const moved = (event: PopStateEvent) => {
      const to: unknown = (event.state as { fmbt?: unknown } | null)?.fmbt
      if (PAGES.has(to)) setPage(to as Page)
    }
    addEventListener('popstate', moved)
    return () => removeEventListener('popstate', moved)
  }, [firstPage])

  // Leaving or refreshing the tab with a parlay half-built: the browser asks
  // first. Signing out doesn't, since that's on purpose.
  useEffect(() => {
    if (slip.legs.length === 0) return
    const ask = (event: BeforeUnloadEvent) => {
      if (!leaving.onPurpose) event.preventDefault()
    }
    addEventListener('beforeunload', ask)
    return () => removeEventListener('beforeunload', ask)
  }, [slip.legs.length])

  function go(to: Page) {
    if (to === page) return
    history.pushState({ fmbt: to }, '', '/')
    setPage(to)
  }

  function build() {
    // A parlay being changed isn't kept when you start a new one.
    if (slip.editing !== null) setSlip({ ...EMPTY_SLIP, competition })
    else if (slip.legs.length === 0) setSlip({ ...slip, competition })
    go('build')
  }

  function edit(week: Week, parlayId: string) {
    const next = slipFor(editable(live.week(week)), week, parlayId)
    if (next === null) return
    setSlip(next)
    go('build')
  }

  let content
  if (page === 'settings') {
    content = <Settings api={api} unlocked={unlocked} toast={firstPage === 'settings' ? firstToast : undefined} onSignOut={onSignOut} onNewKey={onNewKey}
      onWeeksChanged={() => void live.loadAll()} />
  } else if (page === 'build') {
    content = (
      <BuildParlay live={live} snapshot={snapshot} slip={slip} onSlip={setSlip} onCancel={() => go('parlays')}
        onDone={(message, savedPeriod) => {
          setToast(message)
          setPeriod(savedPeriod)
          go('parlays')
        }} />
    )
  } else {
    content = (
      <MyParlays live={live} snapshot={snapshot} competition={competition} period={period}
        onCompetition={each => {
          setCompetition(each)
          setPeriod(null)
        }}
        onPeriod={setPeriod} onBuild={build} onEdit={edit} onToast={setToast} />
    )
  }

  return (
    <AdminContext.Provider value={admin}>
      <AppFrame page={page} onNavigate={go} admin={admin} seasonName={seasonLabel(season)}>
        {content}
      </AppFrame>
      {/* A toast's timer only ever clears its own message, never a newer one. */}
      {toast !== null && <Toast message={toast} onDone={() => setToast(current => (current === toast ? null : current))} />}
    </AdminContext.Provider>
  )
}
