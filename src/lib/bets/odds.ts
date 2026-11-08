// American odds, bet365's prices, and returns in whole cents
// (fmbt-security, section 11).
//
// American odds, the way bet365 shows them:
//   +150 means a $100 stake wins $150, so a winning bet returns 2.5 times the stake
//   -200 means a $200 stake wins $100, so a winning bet returns 1.5 times the stake
// That multiple is the "decimal odds". A parlay returns its stake times every
// winning leg's decimal odds. The code calls the return the payout.
//
// bet365 keeps each price as a fraction, and shows it as American odds
// rounded its own way. So the odds on the screen aren't always the price it
// pays: -209 is really 12/25, which is 1.48, not 1 + 100/209 = 1.4785.
// KMan's bet slips showed this on 8 November 2026 (step 10 plan, decision 8).
// So the app works out bet365's real price for the odds you type, then does
// what bet365 does with it:
//   1. multiplies the legs' prices exactly
//   2. adds any boost, which is a percent of the profit
//   3. rounds the return down to the cent, once, at the end
//
// Money never goes near floating point here. Every price stays an exact
// fraction of whole numbers, multiplied with BigInt, JavaScript's whole
// numbers of any size.

// The limits on what can be entered (step 9 plan, smaller choices).
export const MIN_STAKE_CENTS = 1                // $0.01
export const MAX_STAKE_CENTS = 1_000_000        // $10,000
export const MAX_ODDS = 100_000                 // +100000, or -100000
// Boosts are in basis points, hundredths of a percent: 250 is 2.5%, the
// most is 10,000, which is 100%, and 0 is no boost (step 10 plan, decision 9).
export const MAX_BOOST_BPS = 10_000
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

// True for a boost of 0 to 10,000 basis points: no boost up to 100%.
export function isBoostBps(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_BOOST_BPS
}

// A fraction of whole numbers, top over bottom.
export type Fraction = { top: bigint; bottom: bigint }

// ---------------------------------------------------------------------------
// bet365's price for the odds you type
// ---------------------------------------------------------------------------

// The British odds ladder: the fractions bookmakers like bet365 price in,
// as the profit on a stake of 1. So 10/11 means a stake of 11 wins 10.
const LADDER: readonly (readonly [number, number])[] = [
  [1, 1000], [1, 750], [1, 500], [1, 400], [1, 300], [1, 250], [1, 200], [1, 150], [1, 125], [1, 100], [1, 80], [1, 66], [1, 50],
  [1, 40], [1, 33], [1, 25], [1, 20], [1, 16], [1, 14], [1, 12], [1, 11], [1, 10], [1, 9], [1, 8], [2, 15], [1, 7], [2, 13],
  [1, 6], [2, 11], [1, 5], [2, 9], [1, 4], [2, 7], [3, 10], [1, 3], [4, 11], [2, 5], [4, 9], [1, 2], [8, 15], [4, 7], [8, 13],
  [4, 6], [8, 11], [4, 5], [5, 6], [10, 11], [20, 21], [1, 1], [21, 20], [11, 10], [6, 5], [5, 4], [11, 8], [7, 5], [6, 4],
  [8, 5], [13, 8], [7, 4], [15, 8], [2, 1], [85, 40], [9, 4], [5, 2], [11, 4], [3, 1], [10, 3], [7, 2], [4, 1], [9, 2], [5, 1],
  [11, 2], [6, 1], [13, 2], [7, 1], [15, 2], [8, 1], [17, 2], [9, 1], [10, 1], [11, 1], [12, 1], [14, 1], [16, 1], [18, 1],
  [20, 1], [22, 1], [25, 1], [28, 1], [33, 1], [40, 1], [50, 1], [66, 1], [80, 1], [100, 1], [125, 1], [150, 1], [200, 1],
  [250, 1], [300, 1], [400, 1], [500, 1], [750, 1], [1000, 1],
]

// How bet365 shows a profit as American odds. It rounds against you:
// 12/25 is -208.33, shown as -209, and 13/8 is +162.5, shown as +162.
export function shownAs(profit: Fraction): number {
  if (profit.top <= 0n || profit.bottom <= 0n) throw new RangeError('A price has to pay something.')
  // Evens or longer: + 100 × profit, rounded down. BigInt division rounds down.
  if (profit.top >= profit.bottom) return Number((100n * profit.top) / profit.bottom)
  // Shorter than evens: - 100 ÷ profit, rounded up, so away from zero.
  return -Number((100n * profit.bottom + profit.top - 1n) / profit.top)
}

const gcd = (a: bigint, b: bigint): bigint => (b === 0n ? a : gcd(b, a % b))

function lowest(fraction: Fraction): Fraction {
  const divisor = gcd(fraction.top, fraction.bottom)
  return { top: fraction.top / divisor, bottom: fraction.bottom / divisor }
}

// bet365's price for odds you type, as the profit on a stake of 1:
//   1. the fraction from the ladder that bet365 shows as those odds, such as
//      10/11 for -110 or 13/8 for +162
//   2. otherwise the price with 2 decimal places that it shows as those
//      odds, such as 0.48 for -209 or 2.60 for +260
//   3. otherwise the odds exactly as typed, such as 100/135 for -135
// Every one of KMan's slips fits this, and the tests hold them to it.
export function bet365Profit(odds: number): Fraction {
  if (!isAmericanOdds(odds)) throw new RangeError('Odds must be a whole number, +100 or more, or -100 or less.')
  for (const [top, bottom] of LADDER) {
    const profit = { top: BigInt(top), bottom: BigInt(bottom) }
    if (shownAs(profit) === odds) return lowest(profit)
  }
  // Positive odds already have 2 decimal places: +260 is a profit of 2.60.
  if (odds > 0) return lowest({ top: BigInt(odds), bottom: 100n })
  // For -209, the smallest price in hundredths at or above 100/209 is 0.48.
  const size = BigInt(-odds)
  const hundredths = { top: (10_000n + size - 1n) / size, bottom: 100n }
  if (shownAs(hundredths) === odds) return lowest(hundredths)
  return lowest({ top: 100n, bottom: size })
}

// A leg's decimal odds as an exact fraction: 1 plus bet365's profit.
//   -110 → 21/11, since bet365's price is 10/11
//   -209 → 37/25, which is 1.48
export function decimalFraction(odds: number): Fraction {
  const profit = bet365Profit(odds)
  return { top: profit.top + profit.bottom, bottom: profit.bottom }
}

// Decimal odds as an ordinary number, such as 1.48 for -209, for showing
// only. Never use it for money.
export function decimalOdds(odds: number): number {
  const { top, bottom } = decimalFraction(odds)
  return Number(top) / Number(bottom)
}

// ---------------------------------------------------------------------------
// Returns
// ---------------------------------------------------------------------------

// Every leg's decimal odds multiplied, as one exact fraction. No legs makes 1.
function multiplied(odds: readonly number[]): Fraction {
  let top = 1n
  let bottom = 1n
  for (const each of odds) {
    const fraction = decimalFraction(each)
    top *= fraction.top
    bottom *= fraction.bottom
  }
  return { top, bottom }
}

function checkBet(stakeCents: number, boostBps: number): void {
  if (!isStakeCents(stakeCents)) throw new RangeError('A stake must be a whole number of cents, from $0.01 to $10,000.')
  if (!isBoostBps(boostBps)) throw new RangeError('A boost must be from 0% to 100%, in hundredths of a percent.')
}

// The exact payout as a BigInt, before any limit: the stake times each won
// leg's decimal odds, plus the boost, which is a percent of the profit,
// rounded down to the cent once, at the end, as bet365 rounds. With no won
// legs, as when every leg is dropped, it's the stake back.
export function exactPayoutCents(stakeCents: number, wonOdds: readonly number[], boostBps = 0): bigint {
  checkBet(stakeCents, boostBps)
  const { top, bottom } = multiplied(wonOdds)
  // The stake times top/bottom, plus boostBps/10,000 of the profit, which is
  // the stake times (top - bottom)/bottom. Put over one bottom:
  //   stake × (10,000 × top + boostBps × (top - bottom)) ÷ (10,000 × bottom)
  // BigInt division rounds down, which is how bet365 rounds a return.
  return (BigInt(stakeCents) * (10_000n * top + BigInt(boostBps) * (top - bottom))) / (10_000n * bottom)
}

// The payout in cents, as an ordinary number. The record checks keep every
// parlay's possible payout within MAX_PAYOUT_CENTS, so this never loses a cent.
export function payoutCents(stakeCents: number, wonOdds: readonly number[], boostBps = 0): number {
  const cents = exactPayoutCents(stakeCents, wonOdds, boostBps)
  if (cents > BigInt(MAX_PAYOUT_CENTS)) throw new RangeError('That payout is over the $100 million limit.')
  return Number(cents)
}

// How much of a payout the boost is, rounded down to the cent, the way
// bet365's slip shows it. It's for showing: payoutCents already includes it.
export function boostCents(stakeCents: number, wonOdds: readonly number[], boostBps: number): number {
  checkBet(stakeCents, boostBps)
  const { top, bottom } = multiplied(wonOdds)
  return Number((BigInt(stakeCents) * BigInt(boostBps) * (top - bottom)) / (10_000n * bottom))
}

// A parlay's odds the way bet365 shows them: its legs' prices multiplied,
// then shown its way. 1.48 × 1.70 × 2.00 = 5.032, a profit of 4.032, shows as +403.
export function combinedOdds(odds: readonly number[]): number {
  if (odds.length === 0) throw new RangeError('A parlay needs at least one leg.')
  const { top, bottom } = multiplied(odds)
  return shownAs({ top: top - bottom, bottom })
}
