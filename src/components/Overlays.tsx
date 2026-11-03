// Dialogs and toasts.
import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { StatusIcon } from './Icons.tsx'

const FOCUSABLE = 'input:not([type="hidden"]):not([hidden]), textarea, button:not([disabled]), [href]'

// A dialog over the page. Escape closes it, Tab stays inside it, and when
// it closes, focus goes back to whatever opened it.
export function Dialog({ title, sub, wide = false, onClose, children }: {
  title: string
  sub?: ReactNode
  wide?: boolean
  onClose: () => void
  children: ReactNode
}) {
  const box = useRef<HTMLElement>(null)
  const titleId = useId()

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    box.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus()
    return () => opener?.focus()
  }, [])

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.stopPropagation()
      onClose()
      return
    }
    if (event.key !== 'Tab' || box.current === null) return
    const items = Array.from(box.current.querySelectorAll<HTMLElement>(FOCUSABLE))
    const first = items[0]
    const last = items[items.length - 1]
    if (first === undefined || last === undefined) return
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  return (
    <div className="overlay" onKeyDown={onKeyDown}>
      <section ref={box} className={wide ? 'dialog wide' : 'dialog'} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div>
          <h2 className="dialog-title" id={titleId}>{title}</h2>
          {sub !== undefined && <p className="sub">{sub}</p>}
        </div>
        {children}
      </section>
    </div>
  )
}

// A short message at the bottom of the page, gone after 4 seconds. It
// names what just happened.
export function Toast({ message, onDone }: { message: string; onDone: () => void }) {
  // Keep the newest onDone without restarting the timer on every render.
  const done = useRef(onDone)
  useEffect(() => {
    done.current = onDone
  })
  useEffect(() => {
    const timer = setTimeout(() => done.current(), 4000)
    return () => clearTimeout(timer)
  }, [message])
  return (
    <div className="toast" role="status">
      <StatusIcon kind="good" />
      <span>{message}</span>
    </div>
  )
}
