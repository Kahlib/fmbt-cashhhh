// Tests for how step 10's pages write things and read what you type:
// src/lib/periods.ts, the money, odds and time additions to src/lib/format.ts,
// src/lib/names.ts, src/lib/bets/inputs.ts, and Admin mode's countdown.
//
// Times are checked in Toronto, where KMan is, so the clock times are the
// ones he'd see. Toronto is UTC-5 in November and UTC-4 in summer.
process.env.TZ = 'America/Toronto'

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { countdown, IDLE_LIMIT, secondsLeft } from '../src/components/admin.ts'
import { parseBoost, parseOdds, parseStake } from '../src/lib/bets/inputs.ts'
import { clockTime, dayAndTime, dayRange, longDay, MINUS, money, oddsText, percentText, signedMoney, timeAgo } from '../src/lib/format.ts'
import type { Team } from '../src/lib/fixtures.ts'
import { nameOf, pickWords, teamNames } from '../src/lib/names.ts'
import { COMPETITION_NAMES, periodIndex, periodName, PERIODS, seasonLabel, seasonOf } from '../src/lib/periods.ts'

test('Weeks and stages come in the order they are played, and read in full', () => {
  assert.equal(PERIODS.length, 38 + 8 + 5)
  assert.deepEqual([PERIODS[0], PERIODS[37], PERIODS[38], PERIODS[45], PERIODS[46], PERIODS[50]], ['MW1', 'MW38', 'MD1', 'MD8', 'KPO', 'F'])
  // Sorting by index, not by text, so matchweek 2 comes before matchweek 10.
  assert.ok(periodIndex('MW2') < periodIndex('MW10'))
  assert.ok(periodIndex('MD8') < periodIndex('KPO') && periodIndex('SF') < periodIndex('F'))
  assert.equal(periodIndex('MW39'), -1)
  assert.equal(periodIndex('constructor'), -1)

  assert.equal(periodName('MW12'), 'Matchweek 12')
  assert.equal(periodName('MW1'), 'Matchweek 1')
  assert.equal(periodName('MD3'), 'Matchday 3')
  assert.equal(periodName('KPO'), 'Knockout play-offs')
  assert.equal(periodName('R16'), 'Round of 16')
  assert.equal(periodName('QF'), 'Quarter-finals')
  assert.equal(periodName('SF'), 'Semi-finals')
  assert.equal(periodName('F'), 'Final')
  // Anything else shows as it is, and a name like "constructor" finds nothing.
  assert.equal(periodName('MW123'), 'MW123')
  assert.equal(periodName('constructor'), 'constructor')
  assert.deepEqual(COMPETITION_NAMES, { PL: 'Premier League', UCL: 'Champions League' })
})

test('A season runs from July to June, and is named by both years', () => {
  assert.equal(seasonOf(new Date('2026-07-01T00:00:00.000Z')), 2026)
  assert.equal(seasonOf(new Date('2026-06-30T23:59:59.999Z')), 2025)
  assert.equal(seasonOf(new Date('2027-01-15T12:00:00.000Z')), 2026)
  assert.equal(seasonOf(new Date('2027-05-30T12:00:00.000Z')), 2026)
  assert.equal(seasonLabel(2026), '2026/27')
  assert.equal(seasonLabel(2099), '2099/00')
})

test('Money is dollars and cents, with the real minus sign on losses', () => {
  assert.equal(money(0), '$0.00')
  assert.equal(money(5), '$0.05')
  assert.equal(money(13_084), '$130.84')
  assert.equal(money(123_456_789), '$1,234,567.89')
  assert.equal(money(-2500), '$25.00')
  assert.equal(signedMoney(3535), '+$35.35')
  assert.equal(signedMoney(-2500), `${MINUS}$25.00`)
  assert.equal(signedMoney(0), '$0.00')
  assert.equal(MINUS, '−')
})

test('Odds read the way bet365 shows them, and boosts as percents', () => {
  assert.equal(oddsText(150), '+150')
  assert.equal(oddsText(100), '+100')
  assert.equal(oddsText(-110), '−110')
  assert.equal(oddsText(-100_000), '−100000')
  assert.equal(percentText(0), '0%')
  assert.equal(percentText(500), '5%')
  assert.equal(percentText(250), '2.5%')
  assert.equal(percentText(10), '0.1%')
  assert.equal(percentText(105), '1.05%')
  assert.equal(percentText(1), '0.01%')
  assert.equal(percentText(10_000), '100%')
})

test('Match times read in this computer\'s time zone', () => {
  assert.equal(clockTime('2026-11-21T12:30:00.000Z'), '7:30 am')
  assert.equal(clockTime('2026-11-21T17:00:00.000Z'), '12:00 pm')
  assert.equal(clockTime('2026-11-21T20:05:00.000Z'), '3:05 pm')
  assert.equal(clockTime('2026-11-22T05:05:00.000Z'), '12:05 am')
  assert.equal(clockTime('2026-08-15T11:30:00.000Z'), '7:30 am') // summer time, UTC-4
  assert.equal(dayAndTime('2026-11-21T12:30:00.000Z'), 'Sat 7:30 am')
  assert.equal(longDay('2026-11-21T12:30:00.000Z'), 'Saturday 21 Nov')
  // 01:00 UTC on the 24th is still Monday the 23rd in Toronto.
  assert.equal(dayRange('2026-11-21T12:30:00.000Z', '2026-11-24T01:00:00.000Z'), 'Sat 21 to Mon 23 Nov')
  assert.equal(dayRange('2026-12-01T20:00:00.000Z', '2026-12-01T22:00:00.000Z'), 'Tue 1 Dec')
  assert.equal(dayRange('2026-11-28T15:00:00.000Z', '2026-12-01T20:00:00.000Z'), 'Sat 28 Nov to Tue 1 Dec')
  assert.equal(dayRange('2026-12-30T20:00:00.000Z', '2027-01-02T15:00:00.000Z'), 'Wed 30 Dec to Sat 2 Jan')
  // The same month a year apart still names both months.
  assert.equal(dayRange('2026-12-30T20:00:00.000Z', '2027-12-02T20:00:00.000Z'), 'Wed 30 Dec to Thu 2 Dec')
})

test('How long ago something happened, from just now to the day', () => {
  const now = Date.parse('2026-11-22T15:20:00.000Z')
  const ago = (ms: number) => timeAgo(new Date(now - ms).toISOString(), now)
  assert.equal(ago(0), 'just now')
  assert.equal(ago(59_999), 'just now')
  assert.equal(ago(-60_000), 'just now') // a clock a little ahead never reads as the future
  assert.equal(ago(60_000), '1 min ago')
  assert.equal(ago(25 * 60_000), '25 min ago')
  assert.equal(ago(60 * 60_000 - 1), '59 min ago')
  assert.equal(ago(60 * 60_000), '1 hour ago')
  assert.equal(ago(2 * 60 * 60_000), '2 hours ago')
  assert.equal(ago(24 * 60 * 60_000 - 1), '23 hours ago')
  assert.equal(ago(24 * 60 * 60_000), 'on 21 Nov 2026')
})

test('Team names come from the feed by code, and a code it lacks shows as itself', () => {
  const teams = new Map<number, Team>([
    [9001, { id: 9001, name: 'Manchester City FC', shortName: 'Man City', code: 'MCI' }],
    [9002, { id: 9002, name: 'Liverpool FC', shortName: 'Liverpool', code: 'LIV' }],
    [9003, { id: 9003, name: 'Made-up Second MCI', shortName: 'Not this one', code: 'MCI' }],
  ])
  const names = teamNames(teams)
  assert.equal(nameOf(names, 'MCI'), 'Man City') // the first team with a code keeps it
  assert.equal(nameOf(names, 'ARS'), 'ARS')
  assert.equal(nameOf(names, 'constructor'), 'constructor')
  assert.equal(pickWords('H', 'MCI', 'LIV', names), 'Man City to win')
  assert.equal(pickWords('A', 'MCI', 'LIV', names), 'Liverpool to win')
  assert.equal(pickWords('D', 'MCI', 'LIV', names), 'Draw')
})

test('Odds typed into the slip: with or without a sign, and the real minus too', () => {
  assert.equal(parseOdds('+150'), 150)
  assert.equal(parseOdds('150'), 150)
  assert.equal(parseOdds(' +403 '), 403)
  assert.equal(parseOdds('-110'), -110)
  assert.equal(parseOdds('−110'), -110)
  assert.equal(parseOdds('-100'), -100)
  assert.equal(parseOdds('+100000'), 100_000)
  assert.equal(parseOdds('-100000'), -100_000)
  for (const bad of ['', '+', '99', '+99', '-99', '100001', '-100001', '1.5', '+-110', '--110', '−−110', '1e3', 'abc', '١٥٠', '+ 150']) {
    assert.equal(parseOdds(bad), null, bad)
  }
})

test('A stake typed into the slip: dollars and cents, from $0.01 to $10,000', () => {
  assert.equal(parseStake('25'), 2500)
  assert.equal(parseStake('25.5'), 2550)
  assert.equal(parseStake('25.50'), 2550)
  assert.equal(parseStake('$25'), 2500)
  assert.equal(parseStake(' 25 '), 2500)
  assert.equal(parseStake('0.01'), 1)
  assert.equal(parseStake('1,000'), 100_000)
  assert.equal(parseStake('10,000'), 1_000_000)
  assert.equal(parseStake('10000.00'), 1_000_000)
  for (const bad of ['', '0', '0.00', '10000.01', '1,000,000', '1,00', '25.555', '-5', '$ 25', '1e3', '25.', '.5', '٢٥', '25$']) {
    assert.equal(parseStake(bad), null, bad)
  }
})

test('A boost typed into the slip: a percent in hundredths, and nothing means none', () => {
  assert.equal(parseBoost(''), 0)
  assert.equal(parseBoost('  '), 0)
  assert.equal(parseBoost('%'), 0)
  assert.equal(parseBoost('0'), 0)
  assert.equal(parseBoost('5'), 500)
  assert.equal(parseBoost('2.5'), 250)
  assert.equal(parseBoost('2.5%'), 250)
  assert.equal(parseBoost(' 2.5 % '), 250)
  assert.equal(parseBoost('0.01'), 1)
  assert.equal(parseBoost('100'), 10_000)
  for (const bad of ['100.01', '101', '1000', '-5', '2.555', '2.5%%', 'five', '1e2', '٥']) {
    assert.equal(parseBoost(bad), null, bad)
  }
})

test("Admin mode's countdown: whole seconds, rounded up, never below zero", () => {
  assert.equal(IDLE_LIMIT, 5 * 60_000)
  assert.equal(secondsLeft(10_000, 10_000), 0)
  assert.equal(secondsLeft(10_000, 20_000), 0)
  assert.equal(secondsLeft(10_000, 9_001), 1)
  assert.equal(secondsLeft(IDLE_LIMIT, 0), 300)
  assert.equal(countdown(300), '5:00')
  assert.equal(countdown(299), '4:59')
  assert.equal(countdown(61), '1:01')
  assert.equal(countdown(9), '0:09')
  assert.equal(countdown(0), '0:00')
})
