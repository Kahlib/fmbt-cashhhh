// American odds and payouts, in whole cents (fmbt-security, section 11).
//
// American odds, the way a book shows them:
//   +150 means a $100 stake wins $150, so a winning bet pays 2.5 times the stake
//   -200 means a $200 stake wins $100, so a winning bet pays 1.5 times the stake
//   +100 and -100 both pay 2 times the stake
// That multiple is the "decimal odds". A parlay pays its stake times every
// winning leg's decimal odds.
//
// Money never goes near floating point here. 1.5 times 2.5 times a stake is
// fine in floating point, but a long parlay's tiny errors add up. So each
// leg's decimal odds stay an exact fraction of whole numbers (+150 is
// 250/100), multiplied with BigInt, JavaScript's whole numbers of any size,
// and the payout rounds once, at the very end, to the nearest cent, with
// halves rounding up. Decided 5 November 2026.

// The limits on what can be entered (step 9 plan, smaller choices).
export const MIN_STAKE_CENTS = 1                // $0.01
export const MAX_STAKE_CENTS = 1_000_000        // $10,000
export const MAX_ODDS = 100_000                 // +100000, or -100000
// Far above any book's limit, and small enough that every sum of payouts in
// a season stays an exact JavaScript number.
export const MAX_PAYOUT_CENTS = 10_000_000_000  // $100 million

// True for whole-number odds of +100 to +100000, or -100 to -100000.
export function isAmericanOdds(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && Math.abs(value) >= 100 && Math.abs(value) <= MAX_ODDS
}

// True for a whole number of cents from $0.01 to $10,000.
export function isStakeCents(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= MIN_STAKE_CENTS && value <= MAX_STAKE_CENTS
}

// A leg's decimal odds as an exact fraction, top over bottom:
//   +150 → 250/100, since 1 + 150/100 = 250/100
//   -200 → 300/200, since 1 + 100/200 = 300/200
export function decimalFraction(odds: number): { top: bigint; bottom: bigint } {
  if (!isAmericanOdds(odds)) throw new RangeError('Odds must be a whole number, +100 or more, or -100 or less.')
  const size = BigInt(Math.abs(odds))
  return odds > 0 ? { top: size + 100n, bottom: 100n } : { top: size + 100n, bottom: size }
}

// Decimal odds as an ordinary number, such as 2.5 for +150, for showing
// only. Never use it for money.
export function decimalOdds(odds: number): number {
  const { top, bottom } = decimalFraction(odds)
  return Number(top) / Number(bottom)
}

// The exact payout as a BigInt, before any limit: the stake times each won
// leg's decimal odds, rounded once to the nearest cent, halves up. With no
// won legs, as when every leg is dropped, it's the stake back.
export function exactPayoutCents(stakeCents: number, wonOdds: readonly number[]): bigint {
  if (!isStakeCents(stakeCents)) throw new RangeError('A stake must be a whole number of cents, from $0.01 to $10,000.')
  let top = BigInt(stakeCents)
  let bottom = 1n
  for (const odds of wonOdds) {
    const fraction = decimalFraction(odds)
    top *= fraction.top
    bottom *= fraction.bottom
  }
  // top / bottom rounded to the nearest whole cent, halves up. BigInt
  // division rounds down, so adding half of `bottom` first makes it round to
  // the nearest: floor((2 × top + bottom) / (2 × bottom)).
  return (2n * top + bottom) / (2n * bottom)
}

// The payout in cents, as an ordinary number. The record checks keep every
// parlay's possible payout within MAX_PAYOUT_CENTS, so this never loses a cent.
export function payoutCents(stakeCents: number, wonOdds: readonly number[]): number {
  const cents = exactPayoutCents(stakeCents, wonOdds)
  if (cents > BigInt(MAX_PAYOUT_CENTS)) throw new RangeError('That payout is over the $100 million limit.')
  return Number(cents)
}
