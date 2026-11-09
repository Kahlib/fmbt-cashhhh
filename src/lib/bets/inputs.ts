// Reading what you type into the bet slip: odds, a stake and a boost. Each
// one comes back as the whole number the record keeps, or null when the text
// isn't one, so the slip can say what to fix (fmbt-security, section 11:
// check entries on the way in). addParlay checks them all again before
// anything is saved.
import { isAmericanOdds, isBoostBps, isStakeCents } from './odds.ts'

// American odds as bet365 shows them: +150, 150, -110 or −110 (the real
// minus sign, which a copy from this page would bring along). A number with
// no sign is taken as plus, the way odds are written.
export function parseOdds(text: string): number | null {
  const typed = text.trim().replace(/^−/, '-')
  if (!/^[+-]?\d{1,6}$/.test(typed)) return null
  const odds = Number(typed)
  return isAmericanOdds(odds) ? odds : null
}

// Dollars and cents, like 25, 25.5, 25.50, $25 or 1,000: a whole number of
// cents from $0.01 to $10,000, or null.
export function parseStake(text: string): number | null {
  const typed = text.trim().replace(/^\$/, '')
  if (!/^(\d{1,3}(,\d{3})+|\d+)(\.\d{1,2})?$/.test(typed)) return null
  const [dollars, cents = ''] = typed.replaceAll(',', '').split('.')
  const total = Number(dollars) * 100 + Number(cents.padEnd(2, '0'))
  return isStakeCents(total) ? total : null
}

// A boost in percent, like 5, 2.5 or 2.5%, as basis points (hundredths of a
// percent). Nothing typed means no boost. Null for anything that isn't 0% to
// 100% in hundredths.
export function parseBoost(text: string): number | null {
  const typed = text.trim().replace(/%$/, '').trim()
  if (typed === '') return 0
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(typed)) return null
  const [whole, part = ''] = typed.split('.')
  const bps = Number(whole) * 100 + Number(part.padEnd(2, '0'))
  return isBoostBps(bps) ? bps : null
}
