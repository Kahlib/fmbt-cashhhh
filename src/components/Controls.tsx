// Buttons, fields, notes and the other controls the screens share. Every
// field has a real <label>, and its hint or error is tied to it with
// aria-describedby, so a screen reader reads them together.
import { useId, useRef, useState, type ReactNode } from 'react'
import { Spinner, StatusIcon } from './Icons.tsx'

type ButtonProps = {
  kind?: 'primary' | 'secondary'
  type?: 'button' | 'submit'
  block?: boolean
  busy?: boolean      // shows a spinner and `busyLabel`, and can't be pressed
  busyLabel?: string
  disabled?: boolean
  onClick?: () => void
  children: ReactNode
}

export function Button({ kind = 'secondary', type = 'button', block = false, busy = false, busyLabel, disabled = false, onClick, children }: ButtonProps) {
  const classes = ['btn', kind === 'primary' ? 'btn-primary' : 'btn-secondary', block ? 'btn-block' : ''].filter(Boolean).join(' ')
  return (
    <button type={type} className={classes} disabled={disabled || busy} aria-busy={busy || undefined} onClick={onClick}>
      {busy ? <><Spinner />{busyLabel ?? children}</> : children}
    </button>
  )
}

// A button that looks like a link, for moving between screens. It's a
// button because it does something in the app rather than open an address.
export function LinkButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return <button type="button" className="link" onClick={onClick}>{children}</button>
}

export type Tone = 'neutral' | 'ok' | 'bad'
export type Message = { tone: Tone; text: ReactNode }

// The line under a field: a plain hint, a tick, or an error. Errors are
// announced as soon as they appear.
export function Hint({ tone = 'neutral', id, children }: { tone?: Tone; id?: string; children: ReactNode }) {
  if (tone === 'neutral') return <p className="hint" id={id}>{children}</p>
  return (
    <p className={`hint ${tone}`} id={id} role={tone === 'bad' ? 'alert' : undefined}>
      <StatusIcon kind={tone === 'ok' ? 'good' : 'bad'} />
      <span>{children}</span>
    </p>
  )
}

type FieldProps = {
  label: string
  value: string
  onChange: (value: string) => void
  message?: Message | null      // what shows under the field
  type?: 'text' | 'email'
  autoComplete?: string
  autoFocus?: boolean
  code?: boolean                // a recovery key group: capitals, centred
  maxLength?: number
}

export function TextField({ label, value, onChange, message, type = 'text', autoComplete, autoFocus, code = false, maxLength }: FieldProps) {
  const id = useId()
  const bad = message?.tone === 'bad'
  return (
    <div className="field">
      <label className="label" htmlFor={id}>{label}</label>
      <input
        id={id} type={type} value={value} onChange={event => onChange(event.target.value)}
        className={['input', code ? 'code' : '', bad ? 'bad' : ''].filter(Boolean).join(' ')}
        autoComplete={autoComplete} autoFocus={autoFocus} maxLength={maxLength}
        spellCheck={code || type === 'email' ? false : undefined}
        autoCapitalize={code ? 'characters' : type === 'email' ? 'none' : undefined}
        aria-invalid={bad || undefined} aria-describedby={message ? `${id}-message` : undefined}
      />
      {message && <Hint tone={message.tone} id={`${id}-message`}>{message.text}</Hint>}
    </div>
  )
}

// A password field with Show and Hide. `autoComplete` tells password
// managers which password this is: "current-password" or "new-password".
export function PasswordField({ label, value, onChange, message, autoComplete, autoFocus, extra }: Omit<FieldProps, 'type' | 'code' | 'maxLength'> & { extra?: ReactNode }) {
  const id = useId()
  const [shown, setShown] = useState(false)
  const bad = message?.tone === 'bad'
  return (
    <div className="field">
      <label className="label" htmlFor={id}>{label}</label>
      <div className="input-wrap">
        <input
          id={id} type={shown ? 'text' : 'password'} value={value} onChange={event => onChange(event.target.value)}
          className={bad ? 'input bad' : 'input'} autoComplete={autoComplete} autoFocus={autoFocus}
          spellCheck={false} autoCapitalize="none"
          aria-invalid={bad || undefined} aria-describedby={message ? `${id}-message` : undefined}
        />
        <button type="button" className="reveal" aria-label={shown ? 'Hide password' : 'Show password'} onClick={() => setShown(!shown)}>
          {shown ? 'Hide' : 'Show'}
        </button>
      </div>
      {message && <Hint tone={message.tone} id={`${id}-message`}>{message.text}</Hint>}
      {extra}
    </div>
  )
}

// The recovery key, typed or pasted in.
export function KeyField({ label, value, onChange, message }: Omit<FieldProps, 'type' | 'code' | 'maxLength' | 'autoComplete'>) {
  const id = useId()
  const bad = message?.tone === 'bad'
  return (
    <div className="field">
      <label className="label" htmlFor={id}>{label}</label>
      <textarea
        id={id} rows={2} value={value} onChange={event => onChange(event.target.value)}
        className={bad ? 'input bad' : 'input'} autoComplete="off" spellCheck={false} autoCapitalize="characters"
        aria-invalid={bad || undefined} aria-describedby={message ? `${id}-message` : undefined}
      />
      {message && <Hint tone={message.tone} id={`${id}-message`}>{message.text}</Hint>}
    </div>
  )
}

export function Note({ children, problem = false }: { children: ReactNode; problem?: boolean }) {
  if (!problem) return <div className="note">{children}</div>
  return (
    <div className="note icon" role="alert">
      <StatusIcon kind="bad" />
      <div>{children}</div>
    </div>
  )
}

// Two or three choices side by side, like "Its password | Its recovery key".
export function Segmented<T extends string>({ label, options, value, onChange }: {
  label: string
  options: { value: T; label: string }[]
  value: T
  onChange: (value: T) => void
}) {
  const labelId = useId()
  return (
    <div className="field">
      <span className="label" id={labelId}>{label}</span>
      <div className="segmented" role="group" aria-labelledby={labelId}>
        {options.map(option => (
          <button key={option.value} type="button" className={option.value === value ? 'on' : undefined}
            aria-pressed={option.value === value} onClick={() => onChange(option.value)}>
            {option.label}
          </button>
        ))}
      </div>
    </div>
  )
}

// A button that opens the computer's file chooser. The file is read in this
// tab only: nothing is uploaded.
// Backups are JSON, and the backfill's import is CSV.
export function FileButton({ kind = 'secondary', block = false, busy = false, busyLabel, onFile, accept = '.json,application/json', children }: Omit<ButtonProps, 'onClick' | 'type' | 'disabled'> & { onFile: (file: File) => void; accept?: string }) {
  const input = useRef<HTMLInputElement>(null)
  return (
    <>
      <input
        ref={input} type="file" accept={accept} hidden
        onChange={event => {
          const file = event.target.files?.[0]
          event.target.value = '' // so choosing the same file again still counts
          if (file) onFile(file)
        }}
      />
      <Button kind={kind} block={block} busy={busy} busyLabel={busyLabel} onClick={() => input.current?.click()}>{children}</Button>
    </>
  )
}

// A table heading that sorts by its column: select it to sort, and again to
// reverse. aria-sort tells a screen reader which way the table is sorted.
export function SortHeading<K extends string>({ label, column, sort, onSort, right = false, className }: {
  label: string
  column: K
  sort: { key: K; down: boolean }
  onSort: (column: K) => void
  right?: boolean
  className?: string
}) {
  const on = sort.key === column
  const classes = [right ? 'r' : '', on ? 'sorted' : '', className ?? ''].filter(Boolean).join(' ')
  return (
    <th className={classes === '' ? undefined : classes} aria-sort={on ? (sort.down ? 'descending' : 'ascending') : undefined}>
      <button type="button" onClick={() => onSort(column)}>
        {label}
        {on && <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true"><path d={sort.down ? 'M3 4.5 6 7.5 9 4.5' : 'M3 7.5 6 4.5 9 7.5'} /></svg>}
      </button>
    </th>
  )
}
