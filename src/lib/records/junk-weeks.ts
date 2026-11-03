// Development only: saves an encrypted junk week, so backups and restores
// can be tried before step 9 builds real saving. A production build never
// includes this file, because the Settings button that loads it only exists
// when Vite runs in development.
import type { AccountApi, SaveResult } from '../account/api.ts'
import { encryptRecord, RECORD_VERSION } from '../crypto/records.ts'

export async function addJunkWeek(api: AccountApi, dataKey: CryptoKey, now = new Date()): Promise<SaveResult> {
  const weeks = (await api.records('week_versions')).filter(w => w.season === 2026 && w.competition === 'PL')
  // The first Premier League matchweek with nothing saved, so each click
  // adds another week. Once all 38 have one, it adds versions to MW1.
  const used = new Set(weeks.map(w => w.period))
  const period = Array.from({ length: 38 }, (_, i) => `MW${i + 1}`).find(p => !used.has(p)) ?? 'MW1'
  const versions = weeks.filter(w => w.period === period).map(w => w.version_no)
  const plain = {
    id: crypto.randomUUID(), season: 2026, competition: 'PL', period,
    version_no: Math.max(0, ...versions) + 1, v: RECORD_VERSION,
  }
  const sealed = await encryptRecord('week_versions', plain, { junk: true, addedAt: now.toISOString() }, dataKey)
  return api.addRecord('week_versions', { ...plain, ...sealed })
}
