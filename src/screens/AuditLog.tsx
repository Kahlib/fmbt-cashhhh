// Settings' audit log (step 10.5, and the canvas "FMBT Settings: invites and
// audit log"): every change to a locked parlay, newest first, and whether the
// log checks out. The entries are decrypted here in the tab with your data
// key, like every record, and their text goes through React, which escapes it.
import { useEffect, useState } from 'react'
import { Button, Hint, Note } from '../components/Controls.tsx'
import { StatusIcon } from '../components/Icons.tsx'
import type { AccountApi } from '../lib/account/api.ts'
import type { Unlocked } from '../lib/account/wraps.ts'
import { loadAuditLog, type AuditEntry, type AuditProblem } from '../lib/bets/audit.ts'
import { auditCheck, changeWords } from '../lib/bets/view.ts'
import { clockTime, count, formatDay } from '../lib/format.ts'
import { periodName } from '../lib/periods.ts'
import { OFFLINE } from './messages.ts'

// The newest entries shown at first, with a button for the rest.
const SHOWN = 10

const when = (iso: string) => `${formatDay(iso)}, ${clockTime(iso)}`

export function AuditLog({ api, unlocked }: { api: AccountApi; unlocked: Unlocked }) {
  const [log, setLog] = useState<{ entries: AuditEntry[]; problems: AuditProblem[] } | 'failed' | null>(null)
  const [all, setAll] = useState(false)

  useEffect(() => {
    let current = true
    void (async () => {
      try {
        const loaded = await loadAuditLog(api, unlocked.dataKey)
        if (current) setLog(loaded)
      } catch {
        if (current) setLog('failed')
      }
    })()
    return () => {
      current = false
    }
  }, [api, unlocked])

  const loaded = log !== null && log !== 'failed' ? log : null
  const entries = loaded === null ? [] : [...loaded.entries].reverse()
  const check = loaded === null ? null : auditCheck(loaded.entries, loaded.problems)
  // What's wrong with each entry that has a problem of its own.
  const flags = new Map<number, string>()
  for (const problem of loaded?.problems ?? []) {
    if (problem.kind === 'broken') flags.set(problem.seq, `Doesn't link to #${problem.seq - 1}`)
  }

  return (
    <section className="panel span-12" aria-labelledby="audit-title">
      <div>
        <div className="ph-row">
          <h2 className="ptitle" id="audit-title">Audit log</h2>
          {entries.length > 0 && <span className="count">{count(entries.length, 'entry', 'entries')}</span>}
        </div>
        <p className="sub">Every change to a locked parlay, with its reason. Entries can't be changed or deleted, and each one is linked to the one before, so a change or a gap shows up here.</p>
      </div>
      {log === null ? <Hint>Opening the log…</Hint>
        : log === 'failed' ? <Note problem><p>{OFFLINE}</p></Note>
          : check === null ? <Hint>Nothing yet. Changing a locked parlay in Admin mode adds an entry.</Hint>
            : (
              <>
                <div className={check.ok ? 'log-check' : 'log-check bad'} role={check.ok ? undefined : 'alert'}>
                  <StatusIcon kind={check.ok ? 'good' : 'bad'} />
                  <span>{check.text}</span>
                </div>
                <ol className="log">
                  {(all ? entries : entries.slice(0, SHOWN)).map(entry => {
                    const record = entry.record
                    const flag = flags.get(entry.seq)
                    return (
                      <li key={entry.seq} className="entry">
                        <div className="entry-h">
                          <span className="seq">#{entry.seq}</span>
                          {record === null ? <b>Doesn't open</b> : (
                            <>
                              <b>{periodName(record.week.period)}</b>
                              <span className="muted">Version {record.fromVersion} to {record.toVersion}</span>
                            </>
                          )}
                          {flag !== undefined && <span className="tag bad">{flag}</span>}
                          <span className="when">{when(record?.at ?? entry.savedAt)}</span>
                        </div>
                        {record !== null && (
                          <>
                            <p className="why"><span>Reason: </span>{record.reason}</p>
                            <div className="changes">{record.changes.map((change, i) => <span key={i}>{changeWords(change)}</span>)}</div>
                          </>
                        )}
                      </li>
                    )
                  })}
                </ol>
                {!all && entries.length > SHOWN && <div className="btn-row"><Button onClick={() => setAll(true)}>Show all {count(entries.length, 'entry', 'entries')}</Button></div>}
              </>
            )}
      <p className="hint">Changes to locked parlays need Admin mode and a reason, and a corrected score from the feed adds an entry by itself.</p>
    </section>
  )
}
