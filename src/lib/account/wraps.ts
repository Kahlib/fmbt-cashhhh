// Small helpers for key wraps that every account flow shares.
import type { AccountApi } from './api.ts'
import { type KeyWrapKind, type KeyWrapRow, unwrapDataKey, wrapDataKey } from '../crypto/keys.ts'

// What an unlocked tab holds: the tidied email, for working out keys again
// later, and the data key, which can't be read out (fmbt-security, section 3).
export type Unlocked = { email: string; dataKey: CryptoKey }

// The wraps of one kind, newest first. Sign-in and recovery try them in this
// order, so a key change that stopped halfway never locks anyone out.
// Generic, so rows from the server keep their created_at.
export function newestFirst<T extends KeyWrapRow>(wraps: T[], kind: KeyWrapKind): T[] {
  return wraps.filter(wrap => wrap.kind === kind).sort((a, b) => b.version_no - a.version_no)
}

// The version number for a new wrap of this kind: one past the highest.
export function nextVersion(wraps: KeyWrapRow[], kind: KeyWrapKind): number {
  return Math.max(0, ...wraps.filter(wrap => wrap.kind === kind).map(wrap => wrap.version_no)) + 1
}

// Tries each wrap, newest first, and returns the first that opens.
export async function openFirst(
  wraps: KeyWrapRow[], wrapKey: CryptoKey, options: { extractable: boolean },
): Promise<{ row: KeyWrapRow; key: CryptoKey } | null> {
  for (const row of wraps) {
    try {
      return { row, key: await unwrapDataKey(row, wrapKey, options) }
    } catch {
      // Wrong key for this wrap, or it was changed. Try the next one.
    }
  }
  return null
}

// The safe way to add a key wrap: wrap the data key, save the wrap, read it
// back from the server, and prove it opens. Returns the data key as the tab
// should hold it (non-extractable), or null if any step failed.
export async function saveAndProveWrap(
  api: AccountApi,
  dataKey: CryptoKey,
  wrapKey: CryptoKey,
  plain: { kind: KeyWrapKind; version_no: number },
): Promise<CryptoKey | null> {
  const row = await wrapDataKey(dataKey, wrapKey, { id: crypto.randomUUID(), ...plain })
  if ((await api.addKeyWrap(row)) !== 'saved') return null
  return proveWrap(api, row.id, wrapKey)
}

// Reads a saved wrap back from the server and proves it opens.
export async function proveWrap(api: AccountApi, id: string, wrapKey: CryptoKey): Promise<CryptoKey | null> {
  const saved = (await api.keyWraps()).find(wrap => wrap.id === id)
  if (saved === undefined) return null
  return (await openFirst([saved], wrapKey, { extractable: false }))?.key ?? null
}
