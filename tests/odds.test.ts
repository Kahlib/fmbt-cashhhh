// Tests for src/lib/bets/odds.ts: bet365's prices, and returns in whole
// cents. Every return here was worked out by hand, and four of them are
// KMan's own bet365 slips from 8 November 2026.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  bet365Profit, boostCents, combinedOdds, decimalFraction, decimalOdds, exactPayoutCents, isAmericanOdds, isBoostBps,
  isStakeCents, MAX_PAYOUT_CENTS, payoutCents, shownAs,
} from '../src/lib/bets/odds.ts'

// bet365's price for some odds, written like "12/25".
const priceOf = (odds: number) => {
  const { top, bottom } = bet365Profit(odds)
  return `${top}/${bottom}`
}

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

test('boosts are whole basis points, from 0 to 100%', () => {
  for (const bps of [0, 1, 250, 500, 10_000]) assert.equal(isBoostBps(bps), true, String(bps))
  for (const bps of [-1, 10_001, 2.5, '250', Number.NaN, null, true]) assert.equal(isBoostBps(bps), false, String(bps))
})

test('bet365 shows a price as American odds, rounded against you', () => {
  assert.equal(shownAs({ top: 12n, bottom: 25n }), -209, '12/25 is -208.33')
  assert.equal(shownAs({ top: 7n, bottom: 10n }), -143, '7/10 is -142.86')
  assert.equal(shownAs({ top: 10n, bottom: 11n }), -110)
  assert.equal(shownAs({ top: 13n, bottom: 8n }), 162, '13/8 is +162.5')
  assert.equal(shownAs({ top: 1n, bottom: 1n }), 100, 'evens')
  assert.equal(shownAs({ top: 2016n, bottom: 500n }), 403, 'a profit of 4.032 is +403.2')
  for (const nothing of [{ top: 0n, bottom: 1n }, { top: -1n, bottom: 1n }, { top: 1n, bottom: -1n }, { top: 1n, bottom: 0n }]) {
    assert.throws(() => shownAs(nothing), /has to pay something/, `${nothing.top}/${nothing.bottom}`)
  }
})

test("bet365's price for the odds you type", () => {
  // A fraction from the ladder, when one shows as those odds.
  const ladder: [number, string][] = [
    [-110, '10/11'], [-120, '5/6'], [-125, '4/5'], [-150, '2/3'], [-105, '20/21'], [-200, '1/2'], [-138, '8/11'], [-163, '8/13'],
    [-188, '8/15'], [-334, '3/10'], [-3300, '1/33'], [100, '1/1'], [162, '13/8'], [137, '11/8'], [212, '17/8'], [333, '10/3'],
  ]
  // Otherwise a price with 2 decimal places.
  const twoPlaces: [number, string][] = [
    [-209, '12/25'], [-143, '7/10'], [-121, '83/100'], [-137, '73/100'], [-118, '17/20'], [260, '13/5'], [170, '17/10'], [101, '101/100'],
  ]
  // Otherwise the odds exactly as typed.
  const exact: [number, string][] = [[-135, '20/27'], [-140, '5/7'], [-100_000, '1/1000']]
  for (const [odds, price] of [...ladder, ...twoPlaces, ...exact]) assert.equal(priceOf(odds), price, String(odds))
  // -100 never shows on bet365, which shows evens as +100. Typed, it's evens anyway.
  assert.equal(priceOf(-100), '1/1')
  assert.deepEqual(decimalFraction(-209), { top: 37n, bottom: 25n })
  assert.equal(decimalOdds(-209), 1.48)
  assert.equal(decimalOdds(150), 2.5)
  assert.throws(() => bet365Profit(99), RangeError)
  assert.throws(() => bet365Profit(-150.5), RangeError)
})

test('every price shows as the odds it came from', () => {
  for (const odds of [
    ...Array.from({ length: 4901 }, (_, i) => -100 - i - 1), ...Array.from({ length: 4901 }, (_, i) => 100 + i),
    -100_000, -99_999, -10_000, -5001, 5001, 10_000, 99_999, 100_000,
  ]) {
    assert.equal(shownAs(bet365Profit(odds)), odds, String(odds))
  }
})

test("KMan's bet365 slips, to the cent", () => {
  // $25 on -209, -143 and +100 with a 5% boost: 1.48 × 1.70 × 2.00 = 5.032,
  // shown as +403. $125.80, plus 5% of the $100.80 profit, $5.04.
  const first = [-209, -143, 100]
  assert.equal(combinedOdds(first), 403)
  assert.equal(payoutCents(2500, first), 12_580)
  assert.equal(payoutCents(2500, first, 500), 13_084)
  assert.equal(boostCents(2500, first, 500), 504)

  // $25 on +260, -125 and +170 with a 5% boost: 3.60 × 1.80 × 2.70 = 17.496,
  // shown as +1649. $437.40, plus 5% of $412.40, $20.62.
  const second = [260, -125, 170]
  assert.equal(combinedOdds(second), 1649)
  assert.equal(payoutCents(2500, second, 500), 45_802)
  assert.equal(boostCents(2500, second, 500), 2062)

  // $25 on -110 and -125 with a 2.5% boost: 21/11 × 9/5 = 189/55, shown as
  // +243. $85.909..., plus 2.5% of the $60.909... profit, $1.522...,
  // is $87.4318..., which rounds down to $87.43.
  const third = [-110, -125]
  assert.equal(combinedOdds(third), 243)
  assert.equal(payoutCents(2500, third, 250), 8743)
  assert.equal(boostCents(2500, third, 250), 152)

  // $25 on -110 alone: 25 × 21/11 is $47.727..., shown as $47.72.
  assert.equal(payoutCents(2500, [-110]), 4772)
  assert.equal(combinedOdds([-110]), -110, 'a single shows its own odds')
})

test('a parlay shorter than evens shows as minus odds, rounded against you', () => {
  // Two legs at -1000, 1/10 each: 1.1 × 1.1 = 1.21, a profit of 0.21, which
  // is -476.19, shown as -477.
  assert.equal(combinedOdds([-1000, -1000]), -477)
  assert.equal(combinedOdds([-200, -200]), 125, '1.5 × 1.5 = 2.25, shown as +125')
})

test('returns round down to the cent, once, at the end', () => {
  // Rounding the return and the boost apart would make the third slip $85.90
  // + $1.52 = $87.42. Rounding once makes it $87.43, as bet365 did.
  assert.equal(payoutCents(2500, [-110, -125]) + boostCents(2500, [-110, -125], 250), 8742)
  assert.equal(payoutCents(2500, [-110, -125], 250), 8743)
  assert.equal(payoutCents(1, [150]), 2, '1 cent on +150 is 2.5 cents, so 2')
  assert.equal(payoutCents(3, [-200]), 4, '3 cents on -200 is 4.5 cents, so 4')
  assert.equal(payoutCents(2500, [150]), 6250, '$25 on +150 returns exactly $62.50')
  assert.equal(payoutCents(2500, [150, -200]), 9375, '$25 on +150 and -200 returns exactly $93.75')
  assert.equal(payoutCents(5000, [-110]), 9545, '$50 on -110 is $95.4545..., so $95.45')
  assert.equal(payoutCents(2500, [100, -100]), 10_000, '$25 on +100 and -100 returns $100')
})

test('even one floating-point step can get a return wrong', () => {
  // $50 on three -143 legs, at bet365's 1.70 each, returns exactly
  // 5000 × 1.7 × 1.7 × 1.7 = 24,565 cents, which is $245.65.
  assert.equal(payoutCents(5000, [-143, -143, -143]), 24_565)
  // Multiplying ordinary numbers, the odds first, lands just under, which
  // rounds down to $245.64.
  assert.equal(1.7 * 1.7 * 1.7 * 5000, 24_564.999999999996)
  assert.equal(Math.floor(1.7 * 1.7 * 1.7 * 5000), 24_564, 'floating point really does get it wrong')

  // Even done carefully, as one division of whole numbers, it can still
  // miss. $3,906.25 on eight -125 legs returns exactly 390,625 × (9/5)^8 =
  // 43,046,721 cents, $430,467.21. But the numbers on the way are too big
  // for an ordinary number to hold exactly, and it comes out a cent short.
  assert.equal(payoutCents(390_625, Array.from({ length: 8 }, () => -125)), 43_046_721)
  assert.equal(Math.floor((390_625 * (10_000 * 9 ** 8)) / (10_000 * 5 ** 8)), 43_046_720)
})

test('a long parlay stays exact', () => {
  // 15 legs at +100 double the stake 15 times: $10 becomes $327,680.
  assert.equal(payoutCents(1000, Array.from({ length: 15 }, () => 100)), 32_768_000)
  // 20 legs at -110: 1000 × (21/11)^20, worked out with whole numbers.
  assert.equal(payoutCents(1000, Array.from({ length: 20 }, () => -110)), Number((1000n * 21n ** 20n) / 11n ** 20n))
})

test('dropped legs and boosts', () => {
  // With no won legs, as when every leg is dropped, the stake comes back,
  // and a boost on no profit adds nothing.
  assert.equal(payoutCents(2500, []), 2500)
  assert.equal(payoutCents(2500, [], 500), 2500)
  assert.equal(boostCents(2500, [], 500), 0)
  assert.equal(boostCents(2500, [150], 0), 0)
  // A 100% boost doubles the profit: $25 on +150 wins $37.50, and the boost
  // adds another $37.50.
  assert.equal(payoutCents(2500, [150], 10_000), 10_000, '$25 + $37.50 + $37.50')
  assert.throws(() => combinedOdds([]), /at least one leg/)
})

test('payouts over $100 million are refused, and bad input throws', () => {
  const huge = Array.from({ length: 3 }, () => 100_000)
  assert.equal(exactPayoutCents(1_000_000, huge) > BigInt(MAX_PAYOUT_CENTS), true)
  assert.throws(() => payoutCents(1_000_000, huge), RangeError)
  assert.equal(payoutCents(1_000_000, [99_900, 900]), MAX_PAYOUT_CENTS, '$10,000 at 1000 times 10 returns exactly the limit')
  assert.throws(() => payoutCents(1_000_000, [99_900, 901]), RangeError, '$100.1 million is over it')
  assert.throws(() => payoutCents(1_000_000, [99_900, 900], 1), RangeError, 'and a boost tips it over')
  assert.throws(() => payoutCents(0, [150]), RangeError)
  assert.throws(() => payoutCents(2500.5, [150]), RangeError)
  assert.throws(() => payoutCents(2500, [99]), RangeError)
  assert.throws(() => payoutCents(2500, [150], -1), RangeError)
  assert.throws(() => payoutCents(2500, [150], 10_001), RangeError)
  assert.throws(() => boostCents(2500, [150], 2.5), RangeError)
})
