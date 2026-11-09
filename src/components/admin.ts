// Admin mode's state (fmbt-design-system, "Admin mode"; fmbt-security,
// section 11). With it on, the pages let you change or remove a locked
// parlay, or delete a week, and ask why. It stops mistakes, not attackers:
// nothing in the database trusts it, and the saving code refuses a change to
// a locked parlay without a reason whatever this says. It's off on every page
// load, and it turns itself off after 5 minutes without a click or a key press.
import { createContext, useContext, useEffect, useRef, useState } from 'react'

export const IDLE_LIMIT = 5 * 60_000

export type Admin = { on: boolean; secondsLeft: number; turnOn: () => void; turnOff: () => void }

export const AdminContext = createContext<Admin>({ on: false, secondsLeft: 0, turnOn: () => undefined, turnOff: () => undefined })

export function useAdmin(): Admin {
  return useContext(AdminContext)
}

// Whole seconds left until `deadline`, rounded up, and never below 0.
export function secondsLeft(deadline: number, now: number): number {
  return Math.max(0, Math.ceil((deadline - now) / 1000))
}

// "4:59".
export function countdown(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

// Admin mode for the signed-in pages. `onOff` hears when it turns off, and
// whether you turned it off or it timed out.
export function useAdminMode(onOff: (why: 'turned off' | 'idle') => void): Admin {
  const [on, setOn] = useState(false)
  const [deadline, setDeadline] = useState(0)
  const [now, setNow] = useState(0)
  const deadlineNow = useRef(0)
  const heard = useRef(onOff)
  useEffect(() => {
    heard.current = onOff
  })

  // While it's on, every click or key press anywhere pushes the deadline
  // back, and a clock ticks once a second for the countdown. The tick that
  // finds the deadline gone turns it off.
  useEffect(() => {
    if (!on) return
    const nudge = () => {
      deadlineNow.current = Date.now() + IDLE_LIMIT
      setDeadline(deadlineNow.current)
    }
    const tick = setInterval(() => {
      const time = Date.now()
      setNow(time)
      if (time >= deadlineNow.current) {
        setOn(false)
        heard.current('idle')
      }
    }, 1000)
    document.addEventListener('click', nudge, true)
    document.addEventListener('keydown', nudge, true)
    return () => {
      clearInterval(tick)
      document.removeEventListener('click', nudge, true)
      document.removeEventListener('keydown', nudge, true)
    }
  }, [on])

  return {
    on,
    secondsLeft: on ? secondsLeft(deadline, now) : 0,
    turnOn() {
      const start = Date.now()
      deadlineNow.current = start + IDLE_LIMIT
      setNow(start)
      setDeadline(deadlineNow.current)
      setOn(true)
    },
    turnOff() {
      setOn(false)
      heard.current('turned off')
    },
  }
}
