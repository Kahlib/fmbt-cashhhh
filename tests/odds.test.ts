// Tests for src/lib/bets/odds.ts: American odds and payouts in whole cents.
// Every payout here was worked out by hand.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  decimalFraction, decimalOdds, exactPayoutCents, isAmericanOdds, isStakeCents, MAX_PAYOUT_CENTS, payoutCents,
} from '../src/lib/bets/odds.ts'

test('odds are whole numbers of +100 or more, or -100 or less, up to 100000', () => {
  for (const odds of [100, -100, 150, -110, 100_000, -100_000]) assert.equal(isAmericanOdds(odds), true, String(odds))
  for (const odds of [99, -99, 0, 50, -50, 100_001, -100_001, 150.5, '150', Number.NaN, Number.POSITIVE_INFINITY, null]) {
    assert.equal(isAmericanOdds(odds), false, String(odds))
  }
})

test('stakes are whole cents, from $0.01 to $10,000', () => {
  for (const cents of [1, 2500, 1_000_000]) assert.equal(isStakeCents(cents), true, String(cents))
  for (const cents of [0, -1, 1_000_001, 25.5, '2500', Number.NaN, null]) assert.equal(isStakeCents(cents), false, String(cents))
})

test('decimal odds are exact fractions', () => {
  assert.deepEqual(decimalFraction(150), { top: 250n, bottom: 100n })
  assert.deepEqual(decimalFraction(-200), { top: 300n, bottom: 200n })
  assert.deepEqual(decimalFraction(100), { top: 200n, bottom: 100n })
  assert.deepEqual(decimalFraction(-100), { top: 200n, bottom: 100n })
  assert.equal(decimalOdds(150), 2.5)
  assert.equal(decimalOdds(-200), 1.5)
  assert.throws(() => decimalFraction(99), RangeError)
  assert.throws(() => decimalFraction(-150.5), RangeError)
})

test('payouts, worked out by hand', () => {
  assert.equal(payoutCents(2500, [150]), 6250, '$25 on +150 pays $62.50')
  assert.equal(payoutCents(2500, [150, -200]), 9375, '$25 on +150 and -200 pays $93.75')
  assert.equal(payoutCents(5000, [-110]), 9545, '$50 on -110 pays $95.4545..., so $95.45')
  assert.equal(payoutCents(2500, [-110, -110]), 9112, '$25 on two -110s pays $91.1157..., so $91.12')
  assert.equal(payoutCents(2500, [100, -100]), 10000, '$25 on +100 and -100 pays $100')
  assert.equal(payoutCents(2500, []), 2500, 'with no won legs, the stake comes back')
})

test('halves round up, once, at the end', () => {
  assert.equal(payoutCents(1, [150]), 3, '1 cent on +150 is 2.5 cents, so 3')
  assert.equal(payoutCents(3, [-200]), 5, '3 cents on -200 is 4.5 cents, so 5')
  assert.equal(payoutCents(1, [-300]), 1, '1 cent on -300 is 1.33 cents, so 1')
  // $25 on -110, -120 and +105 is exactly $179.375. Multiplying ordinary
  // numbers, the odds first and then the stake, gets 17937.499999999996
  // cents, which would round to $179.37.
  assert.equal(payoutCents(2500, [-110, -120, 105]), 17938)
  assert.equal(decimalOdds(-110) * decimalOdds(-120) * decimalOdds(105) * 2500, 17937.499999999996)
  assert.equal(Math.round(decimalOdds(-110) * decimalOdds(-120) * decimalOdds(105) * 2500), 17937, 'floating point really does get it wrong')
})

test('a long parlay stays exact', () => {
  // 15 legs at +100 double the stake 15 times: $10 becomes $327,680.
  assert.equal(payoutCents(1000, Array.from({ length: 15 }, () => 100)), 32_768_000)
  // 20 legs at -110: 1000 × (21/11)^20, worked out with whole numbers.
  const top = 1000n * 21n ** 20n
  const bottom = 11n ** 20n
  assert.equal(payoutCents(1000, Array.from({ length: 20 }, () => -110)), Number((2n * top + bottom) / (2n * bottom)))
})

test('even one floating-point division would get a payout wrong', () => {
  // $57 on -110, -110, -120, -105, -105 and +175 is 5700 × (21/11)² × (11/6) × (41/21)² × (11/4).
  // The 21s and 11s cancel, leaving 5700 × 1681 / 24, which is exactly
  // 399,237.5 cents, so it pays $3,992.38.
  const odds = [-110, -110, -120, -105, -105, 175]
  assert.equal(payoutCents(5700, odds), 399_238)
  // The whole fraction is too big for an ordinary number to hold exactly, so
  // dividing it once in floating point lands just under the half.
  const top = odds.reduce((product, each) => product * decimalFraction(each).top, 5700n)
  const bottom = odds.reduce((product, each) => product * decimalFraction(each).bottom, 1n)
  assert.equal(top * 2n, bottom * 798_475n, 'exactly 399,237.5')
  assert.equal(Math.round(Number(top) / Number(bottom)), 399_237, 'floating point rounds it down')
})

test('payouts over $100 million are refused, and bad input throws', () => {
  const huge = Array.from({ length: 3 }, () => 100_000)
  assert.equal(exactPayoutCents(1_000_000, huge) > BigInt(MAX_PAYOUT_CENTS), true)
  assert.throws(() => payoutCents(1_000_000, huge), RangeError)
  assert.equal(payoutCents(1_000_000, [99_900, 900]), MAX_PAYOUT_CENTS, '$10,000 at 1000 times 10 pays exactly the limit')
  assert.throws(() => payoutCents(1_000_000, [99_900, 901]), RangeError, '$100.1 million is over it')
  assert.throws(() => payoutCents(0, [150]), RangeError)
  assert.throws(() => payoutCents(2500.5, [150]), RangeError)
  assert.throws(() => payoutCents(2500, [99]), RangeError)
})
