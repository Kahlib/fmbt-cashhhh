// The Dashboard's charts, hand-built in SVG as mockup v7 draws them
// (fmbt-design-system, "Charts"). Each one answers one question, measures
// its real width, says its result in an aria-label, and shows a tooltip on
// every mark, from the mouse or the keyboard. Tooltips are drawn inside the
// SVG, since the content security policy refuses style attributes.
import { useState, type ReactNode } from 'react'
import { axisDollars, money, pointsText, signedMoney, wholePercent } from '../../lib/format.ts'
import { periodName } from '../../lib/periods.ts'
import type { RateRow, WeekPoint } from '../../lib/stats/season.ts'
import { barPath, moneyAxis, useWidth, wrapWords } from './size.ts'

type Tone = 'good' | 'bad' | 'warn' | 'you' | 'odds' | 'plain'
export type Tip = { title: string; rows: { label: string; value: string; tone?: Tone }[]; note?: string }

const toneOf = (cents: number): Tone => (cents > 0 ? 'good' : cents < 0 ? 'bad' : 'plain')

// The glows the design rules allow: the bankroll line, and the "you" marks.
export function ChartFilters() {
  return (
    <svg className="defs" width="0" height="0" aria-hidden="true" focusable="false">
      <defs>
        <filter id="glow-you" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="0" stdDeviation="3" floodColor="#3FC1EA" floodOpacity=".7" /></filter>
        <filter id="glow-good" x="-20%" y="-50%" width="140%" height="200%"><feDropShadow dx="0" dy="0" stdDeviation="3" floodColor="#2FBF71" floodOpacity=".75" /></filter>
        <filter id="glow-bad" x="-20%" y="-50%" width="140%" height="200%"><feDropShadow dx="0" dy="0" stdDeviation="3" floodColor="#F0435A" floodOpacity=".75" /></filter>
        <filter id="tip-shadow" x="-20%" y="-20%" width="140%" height="160%"><feDropShadow dx="0" dy="10" stdDeviation="12" floodColor="#000" floodOpacity=".6" /></filter>
      </defs>
    </svg>
  )
}

// A tooltip at (x, y), kept inside a chart of `width` by `height`.
function SvgTip({ tip, x, y, width, height }: { tip: Tip; x: number; y: number; width: number; height: number }) {
  const w = 200
  const note = tip.note === undefined ? [] : wrapWords(tip.note, 33)
  const h = 34 + tip.rows.length * 19 + note.length * 16 + (note.length > 0 ? 6 : 0)
  const left = Math.max(4, x + 14 + w > width - 4 ? x - 14 - w : x + 14)
  const top = Math.max(4, Math.min(y + 16, height - h - 4))
  return (
    <g className="tip" transform={`translate(${left} ${top})`} pointerEvents="none">
      <rect width={w} height={h} rx={4} className="tip-box" filter="url(#tip-shadow)" />
      <text x={11} y={22} className="tip-title">{tip.title}</text>
      {tip.rows.map((row, i) => (
        <g key={row.label}>
          <text x={11} y={42 + i * 19} className="tip-label">{row.label}</text>
          <text x={w - 11} y={42 + i * 19} textAnchor="end" className={`tip-value ${row.tone ?? 'plain'}`}>{row.value}</text>
        </g>
      ))}
      {note.map((line, i) => <text key={line} x={11} y={40 + tip.rows.length * 19 + i * 16} className="tip-note">{line}</text>)}
    </g>
  )
}

// The marks a tooltip belongs to: hover or focus shows it.
function useActive(): [number | null, (i: number) => { onMouseEnter: () => void; onMouseLeave: () => void; onFocus: () => void; onBlur: () => void; tabIndex: number }] {
  const [active, setActive] = useState<number | null>(null)
  const handlers = (i: number) => ({
    onMouseEnter: () => setActive(i),
    onMouseLeave: () => setActive(current => (current === i ? null : current)),
    onFocus: () => setActive(i),
    onBlur: () => setActive(current => (current === i ? null : current)),
    tabIndex: 0,
  })
  return [active, handlers]
}

// ---------------------------------------------------------------------------
// The bankroll: the season's running total, with each week's profit under it
// ---------------------------------------------------------------------------

export function Bankroll({ weeks, netCents, peak }: { weeks: readonly WeekPoint[]; netCents: number; peak: WeekPoint | null }) {
  const [ref, width] = useWidth<HTMLDivElement>(720)
  const [active, on] = useActive()
  const H1 = 190
  const GAP = 22
  const H2 = 72
  const height = H1 + GAP + H2 + 20
  const L = 54
  const R = 12
  const n = weeks.length
  const step = (width - L - R) / Math.max(1, n)
  const xs = weeks.map((_, i) => L + step * (i + 0.5))
  const totals = weeks.map(each => each.totalCents / 100)
  const axis = moneyAxis(totals)
  const y = (v: number) => 8 + ((axis.hi - v) / (axis.hi - axis.lo)) * (H1 - 16)
  const y0 = y(0)
  const ticks: number[] = []
  for (let t = axis.lo; t <= axis.hi + 0.001; t += axis.step) ticks.push(t)
  const points = [[L, y0], ...xs.map((x, i) => [x, y(totals[i])])]
  const line = `M${points.map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`).join(' L')}`
  const area = `${line} L${(xs[n - 1] ?? L).toFixed(1)},${y0.toFixed(1)} Z`
  const mid = H1 + GAP + H2 / 2
  const biggest = Math.max(1, ...weeks.map(each => Math.abs(each.profitCents)))
  const bw = Math.min(24, step * 0.5)
  const peakAt = peak === null ? -1 : weeks.indexOf(peak)
  return (
    <div className="chart" ref={ref}>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Running profit and loss by week, ending at ${signedMoney(netCents)}`}>
        <defs>
          <clipPath id="bank-up"><rect x={0} y={0} width={width} height={y0} /></clipPath>
          <clipPath id="bank-down"><rect x={0} y={y0} width={width} height={H1 - y0 + 4} /></clipPath>
          <linearGradient id="bank-fill-up" gradientUnits="userSpaceOnUse" x1={0} y1={y(axis.hi)} x2={0} y2={y0}>
            <stop offset={0} stopColor="#2FBF71" stopOpacity=".42" /><stop offset={1} stopColor="#2FBF71" stopOpacity=".03" />
          </linearGradient>
          <linearGradient id="bank-fill-down" gradientUnits="userSpaceOnUse" x1={0} y1={y0} x2={0} y2={y(axis.lo)}>
            <stop offset={0} stopColor="#F0435A" stopOpacity=".03" /><stop offset={1} stopColor="#F0435A" stopOpacity=".42" />
          </linearGradient>
        </defs>
        {ticks.map(t => (
          <g key={t}>
            <line x1={L} x2={width - R} y1={y(t)} y2={y(t)} className={t === 0 ? 'zero' : 'gridline'} />
            <text x={L - 10} y={y(t) + 4} textAnchor="end" className={t === 0 ? 'axis strong' : 'axis'}>{axisDollars(t)}</text>
          </g>
        ))}
        <g className="fade-in">
          <path d={area} fill="url(#bank-fill-up)" clipPath="url(#bank-up)" />
          <path d={area} fill="url(#bank-fill-down)" clipPath="url(#bank-down)" />
        </g>
        <path d={line} className="bank-line up draw-in" pathLength={1} strokeDasharray="1" clipPath="url(#bank-up)" filter="url(#glow-good)" />
        <path d={line} className="bank-line down draw-in" pathLength={1} strokeDasharray="1" clipPath="url(#bank-down)" filter="url(#glow-bad)" />
        {weeks.map((each, i) => (
          <circle key={`dot ${i}`} cx={xs[i]} cy={y(totals[i])} r={active === i ? 6 : 4} className={each.totalCents >= 0 ? 'dot up' : 'dot down'} />
        ))}
        {peak !== null && peakAt >= 0 && (
          <text x={xs[peakAt]} y={y(totals[peakAt]) - 12} className="peak"
            textAnchor={xs[peakAt] > width - 120 ? 'end' : xs[peakAt] < L + 60 ? 'start' : 'middle'}>
            High point {signedMoney(peak.totalCents)}
          </text>
        )}
        <line x1={L} x2={width - R} y1={mid} y2={mid} className="base" />
        <text x={L - 10} y={mid - 4} textAnchor="end" className="axis">Each</text>
        <text x={L - 10} y={mid + 9} textAnchor="end" className="axis">week</text>
        {weeks.map((each, i) => {
          const h = Math.max(2, (Math.abs(each.profitCents) / biggest) * (H2 / 2 - 3))
          const up = each.profitCents >= 0
          return (
            <g key={`week ${i}`}>
              <path d={barPath(xs[i] - bw / 2, up ? mid - h : mid, bw, h, up)} className={up ? 'bar good' : 'bar bad'} />
              <text x={xs[i]} y={H1 + GAP + H2 + 15} textAnchor="middle" className="axis">{each.week.period}</text>
            </g>
          )
        })}
        {active !== null && <line x1={xs[active]} x2={xs[active]} y1={4} y2={H1 + GAP + H2} className="crosshair" />}
        {weeks.map((each, i) => (
          <rect key={`hit ${i}`} x={L + step * i} y={0} width={step} height={H1 + GAP + H2 + 18} className="hit" {...on(i)}
            aria-label={`${periodName(each.week.period)}: ${signedMoney(each.profitCents)} this week, ${signedMoney(each.totalCents)} so far`} />
        ))}
        {active !== null && weeks[active] !== undefined && (
          <SvgTip x={xs[active]} y={y(totals[active])} width={width} height={height} tip={{
            title: periodName(weeks[active].week.period),
            rows: [
              { label: 'This week', value: signedMoney(weeks[active].profitCents), tone: toneOf(weeks[active].profitCents) },
              { label: 'Season so far', value: signedMoney(weeks[active].totalCents), tone: toneOf(weeks[active].totalCents) },
            ],
            note: `${weeks[active].cashed} of ${weeks[active].counted} parlays cashed${weeks[active].perfect ? ', a perfect week' : ''}.`,
          }} />
        )}
      </svg>
    </div>
  )
}

// ---------------------------------------------------------------------------
// You against the odds: two rings, and the money the odds expected
// ---------------------------------------------------------------------------

export function Ring({ name, row, what }: { name: string; row: RateRow; what: string }) {
  const size = 144
  const c = size / 2
  const outer = 2 * Math.PI * 60
  const inner = 2 * Math.PI * 44
  const difference = row.you - row.odds
  return (
    <div className="ring">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img"
        aria-label={`${name}: ${row.won} of ${row.n} ${what}, ${wholePercent(row.you)}. The odds said ${wholePercent(row.odds)}.`}>
        <circle cx={c} cy={c} r={60} className="ring-track" strokeWidth={12} />
        <circle cx={c} cy={c} r={44} className="ring-track" strokeWidth={4} />
        <circle cx={c} cy={c} r={60} className="ring-you" strokeWidth={12} strokeDasharray={`${outer * row.you} ${outer}`} transform={`rotate(-90 ${c} ${c})`} filter="url(#glow-you)" />
        <circle cx={c} cy={c} r={44} className="ring-odds" strokeWidth={4} strokeDasharray={`${inner * row.odds} ${inner}`} transform={`rotate(-90 ${c} ${c})`} />
        <text x={c} y={c + 4} textAnchor="middle" className="ring-number">{wholePercent(row.you)}</text>
        <text x={c} y={c + 21} textAnchor="middle" className="ring-you-label">you</text>
      </svg>
      <b>{name}</b>
      <span>{row.won} of {row.n} {what}</span>
      <span><span className="odds-t">Odds said {wholePercent(row.odds)}</span>, <span className={difference > 0.005 ? 'good-t' : difference < -0.005 ? 'bad-t' : undefined}>{pointsText(difference)}</span></span>
    </div>
  )
}

// Bars from a shared $0 line, as percentages of the track, which SVG takes as attributes.
export function MoneyBars({ expectedCents, netCents }: { expectedCents: number; netCents: number }) {
  const lo = Math.min(0, expectedCents, netCents)
  const hi = Math.max(0, expectedCents, netCents)
  const at = (v: number) => ((v - lo) / (hi - lo || 1)) * 100
  const zero = at(0)
  const bar = (v: number, kind: string) => (
    <svg className="mt" width="100%" height={10} aria-hidden="true">
      <rect x="0" y="0" width="100%" height={10} rx={2} className="mt-track" />
      <rect x={`${Math.min(zero, at(v))}%`} y="0" width={`${Math.abs(at(v) - zero)}%`} height={10} rx={2} className={kind} />
      <rect x={`${zero}%`} y="0" width={1} height={10} className="mt-zero" />
    </svg>
  )
  const difference = netCents - expectedCents
  return (
    <div className="money">
      <div className="mh">Where the odds expected you to be, at the prices you took</div>
      <div className="mb"><span>Odds expected</span>{bar(expectedCents, 'mt-odds')}<b className="odds-t">{signedMoney(expectedCents)}</b></div>
      <div className="mb"><span>You</span>{bar(netCents, netCents >= 0 ? 'mt-good' : 'mt-bad')}<b className={netCents > 0 ? 'good-t' : netCents < 0 ? 'bad-t' : undefined}>{signedMoney(netCents)}</b></div>
      <div className="verdict">That's <span className={difference >= 0 ? 'good-t' : 'bad-t'}>{money(difference)} {difference >= 0 ? 'better' : 'worse'}</span> than the odds expected.</div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// How your legs finished: won, lost to a draw, lost
// ---------------------------------------------------------------------------

export function Donut({ won, drawn, lost }: { won: number; drawn: number; lost: number }) {
  const [active, on] = useActive()
  const total = won + drawn + lost
  const parts = [
    { key: 'won', label: 'Won', value: won, symbol: '✓' },
    { key: 'drawn', label: 'Lost to a draw', value: drawn, symbol: '=' },
    { key: 'lost', label: 'Lost', value: lost, symbol: '✕' },
  ]
  const c = 110
  const r = 88
  const gap = 2.6 / r
  let angle = -Math.PI / 2
  const slices: ReactNode[] = []
  parts.forEach((part, i) => {
    if (part.value === 0) return
    const span = (part.value / total) * Math.PI * 2
    const handlers = on(i)
    if (part.value === total) {
      slices.push(<circle key={part.key} cx={c} cy={c} r={r} className={`slice ${part.key}`} {...handlers} aria-label={`${part.label}: ${part.value}`} />)
    } else {
      const a0 = angle + gap / 2
      const a1 = angle + span - gap / 2
      const d = `M${c + r * Math.cos(a0)},${c + r * Math.sin(a0)} A${r},${r} 0 ${span > Math.PI ? 1 : 0} 1 ${c + r * Math.cos(a1)},${c + r * Math.sin(a1)}`
      slices.push(<path key={part.key} d={d} className={`slice ${part.key}`} {...handlers} aria-label={`${part.label}: ${part.value}`} />)
    }
    angle += span
  })
  const shown = active === null ? null : parts[active]
  return (
    <div className="donut">
      <svg width={220} height={220} viewBox="0 0 220 220" role="img" aria-label={`${won} won, ${drawn} lost to a draw, ${lost} lost`}>
        {slices}
        <text x={c} y={c + 6} textAnchor="middle" className="donut-number">{total}</text>
        <text x={c} y={c + 26} textAnchor="middle" className="donut-label">legs settled</text>
        {shown !== null && (
          <SvgTip x={110} y={30} width={220} height={220} tip={{ title: shown.label, rows: [{ label: 'Legs', value: String(shown.value) }, { label: 'Share', value: wholePercent(shown.value / total) }] }} />
        )}
      </svg>
      <div className="dl">
        {parts.map(part => (
          <div key={part.key} className={`dl-${part.key}`}>
            <span><i className={`ic ${part.key}`} aria-hidden="true">{part.symbol}</i>{part.label}</span>
            <b>{part.value}<em>{wholePercent(part.value / total)}</em></b>
          </div>
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Where you beat the odds: your hit rate on each type of pick
// ---------------------------------------------------------------------------

export function Radar({ rows }: { rows: { name: string; row: RateRow }[] }) {
  const [ref, width] = useWidth<HTMLDivElement>(320)
  const [active, on] = useActive()
  const w = Math.max(260, width)
  const R = Math.min(98, (w / 2 - 68) / 1.065)
  const cx = w / 2
  const cy = Math.round(R * 1.12 + 34)
  const height = Math.round(cy + R * 0.906 + 44)
  const n = rows.length
  const angle = (i: number) => -Math.PI / 2 + (i * 2 * Math.PI) / n
  const at = (i: number, v: number): [number, number] => [cx + Math.cos(angle(i)) * R * v, cy + Math.sin(angle(i)) * R * v]
  const polygon = (values: number[]) => values.map((v, i) => at(i, v).join(',')).join(' ')
  return (
    <div className="chart" ref={ref}>
      <svg width={w} height={height} viewBox={`0 0 ${w} ${height}`} role="img" aria-label="Hit rate by type of pick, against what the odds said">
        {[0.25, 0.5, 0.75, 1].map(f => <polygon key={f} points={polygon(rows.map(() => f))} className={f === 1 ? 'web outer' : 'web'} />)}
        {rows.map((_, i) => <line key={i} x1={cx} y1={cy} x2={at(i, 1)[0]} y2={at(i, 1)[1]} className="gridline" />)}
        <polygon points={polygon(rows.map(each => each.row.odds))} className="radar-odds" />
        <polygon points={polygon(rows.map(each => each.row.you))} className="radar-you" filter="url(#glow-you)" />
        <text x={cx + 5} y={cy - R * 0.5 - 4} className="ring-tag">50%</text>
        <text x={cx + 5} y={cy - R - 4} className="ring-tag">100%</text>
        {rows.map((each, i) => {
          const [px, py] = at(i, each.row.you)
          const [lx, ly] = at(i, 1.12)
          const cos = Math.cos(angle(i))
          const sin = Math.sin(angle(i))
          const anchor = Math.abs(cos) < 0.2 ? 'middle' : cos > 0 ? 'start' : 'end'
          const words = each.name.split(' ')
          const lines = Math.abs(cos) > 0.8 && words.length > 1 ? [words[0], words.slice(1).join(' ')] : [each.name]
          const block = 15 * (lines.length + 1)
          const y0 = i === 0 ? ly - block + 6 : sin > 0.5 ? ly + 8 : ly - block / 2 + 10
          const [hx, hy] = at(i, Math.max(each.row.you, 0.08))
          return (
            <g key={each.name}>
              <circle cx={px} cy={py} r={3.5} className="radar-point" />
              {lines.map((text, k) => <text key={text} x={lx} y={y0 + k * 15} textAnchor={anchor} className="radar-name">{text}</text>)}
              <text x={lx} y={y0 + lines.length * 15} textAnchor={anchor} className="radar-rates">
                {each.row.n > 0
                  ? <><tspan className="you">{wholePercent(each.row.you)}</tspan><tspan className="vs"> vs </tspan><tspan className="odds">{wholePercent(each.row.odds)}</tspan></>
                  : <tspan className="vs">No picks yet</tspan>}
              </text>
              <circle cx={hx} cy={hy} r={16} className="hit" {...on(i)}
                aria-label={`${each.name}: ${each.row.won} of ${each.row.n}. The odds said ${wholePercent(each.row.odds)}.`} />
            </g>
          )
        })}
        {active !== null && rows[active] !== undefined && (
          <SvgTip x={at(active, Math.max(rows[active].row.you, 0.08))[0]} y={at(active, Math.max(rows[active].row.you, 0.08))[1]} width={w} height={height} tip={{
            title: rows[active].name,
            rows: [
              { label: 'You', value: rows[active].row.n > 0 ? `${rows[active].row.won} of ${rows[active].row.n}, ${wholePercent(rows[active].row.you)}` : 'No picks', tone: 'you' },
              { label: 'Odds said', value: rows[active].row.n > 0 ? wholePercent(rows[active].row.odds) : '—', tone: 'odds' },
            ],
          }} />
        )}
      </svg>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Which parlay size pays: hit rate against break-even, and profit
// ---------------------------------------------------------------------------

export type LadderRow = { label: string; placed: number; hit: number; breakEven: number; profitCents: number }

export function Ladder({ rows }: { rows: readonly LadderRow[] }) {
  const largest = Math.max(...rows.map(each => Math.max(each.hit, each.breakEven)))
  const max = Math.min(1, Math.max(0.4, Math.ceil(largest / 0.2 - 1e-9) * 0.2))
  const ticks = (max > 0.61 ? [0, 0.5, 1] : [0, 0.2, 0.4, 0.6]).filter(t => t <= max + 0.001)
  const share = (v: number) => `${(v / max) * 100}%`
  return (
    <div className="ladder">
      <div className="rung head"><span /><span>Hit rate</span><span className="rv">Profit</span></div>
      {rows.map(each => (
        <div key={each.label} className="rung">
          <div className="rl"><b>{each.label}</b><span>{each.placed} placed</span></div>
          <svg className="rt" width="100%" height={20} role="img"
            aria-label={`${each.label}: cashed ${wholePercent(each.hit)}, needs ${wholePercent(each.breakEven)} to break even`}>
            <rect x="0" y={4} width="100%" height={12} rx={2} className="rt-track" />
            <rect x="0" y={4} width={each.hit === 0 ? 0 : share(Math.max(each.hit, max * 0.015))} height={12} rx={2} className="rt-fill" />
            <rect x={share(each.breakEven)} y={0} width={3} height={20} rx={1} className="rt-tick" transform="translate(-1.5 0)" />
          </svg>
          <div className={`rv ${each.profitCents > 0 ? 'good-t' : each.profitCents < 0 ? 'bad-t' : ''}`}>{signedMoney(each.profitCents)}</div>
        </div>
      ))}
      <div className="rung axis-row">
        <span />
        <svg width="100%" height={14} aria-hidden="true">
          {ticks.map(t => <text key={t} x={share(t)} y={11} textAnchor={t === 0 ? 'start' : t >= max - 0.001 ? 'end' : 'middle'} className="axis">{wholePercent(t)}</text>)}
        </svg>
        <span />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Legs by week, stacked: won, then lost to a draw, then lost
// ---------------------------------------------------------------------------

export function Stack({ weeks }: { weeks: readonly WeekPoint[] }) {
  const [ref, width] = useWidth<HTMLDivElement>(560)
  const [active, on] = useActive()
  const height = 236
  const L = 30
  const R = 6
  const T = 22
  const B = 24
  const n = weeks.length
  const step = (width - L - R) / Math.max(1, n)
  const top = Math.max(5, Math.ceil(Math.max(...weeks.map(each => each.won + each.drawn + each.lost)) / 5) * 5)
  const y = (v: number) => T + (1 - v / top) * (height - T - B)
  const bw = Math.min(30, step * 0.56)
  const ticks: number[] = []
  for (let t = 0; t <= top; t += 5) ticks.push(t)
  return (
    <div className="chart" ref={ref}>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Legs won, lost to a draw and lost each week">
        {ticks.map(t => (
          <g key={t}>
            <line x1={L} x2={width - R} y1={y(t)} y2={y(t)} className={t === 0 ? 'base' : 'gridline'} />
            <text x={L - 8} y={y(t) + 4} textAnchor="end" className="axis">{t}</text>
          </g>
        ))}
        {weeks.map((each, i) => {
          const x = L + step * (i + 0.5) - bw / 2
          const segments = ([['won', each.won], ['drawn', each.drawn], ['lost', each.lost]] as const).filter(([, v]) => v > 0)
          let base = 0
          const legs = each.won + each.drawn + each.lost
          return (
            <g key={`${each.week.competition} ${each.week.period}`}>
              {segments.map(([kind, v], j) => {
                const yTop = y(base + v)
                const h = y(base) - yTop - (j > 0 ? 2 : 0)
                base += v
                return j === segments.length - 1
                  ? <path key={kind} d={barPath(x, yTop, bw, h, true)} className={`part ${kind}`} />
                  : <rect key={kind} x={x} y={yTop} width={bw} height={h} className={`part ${kind}`} />
              })}
              {each.perfect && <text x={x + bw / 2} y={y(legs) - 8} textAnchor="middle" className="perfect">Perfect</text>}
              <text x={x + bw / 2} y={height - 6} textAnchor="middle" className="axis">{each.week.period}</text>
              <rect x={L + step * i} y={0} width={step} height={height} className="hit" {...on(i)}
                aria-label={`${periodName(each.week.period)}: ${each.won} won, ${each.drawn} lost to a draw, ${each.lost} lost`} />
            </g>
          )
        })}
        {active !== null && weeks[active] !== undefined && (
          <SvgTip x={L + step * (active + 0.5)} y={y(weeks[active].won + weeks[active].drawn + weeks[active].lost)} width={width} height={height} tip={{
            title: periodName(weeks[active].week.period),
            rows: [
              { label: 'Won', value: String(weeks[active].won), tone: 'good' },
              { label: 'Lost to a draw', value: String(weeks[active].drawn), tone: 'warn' },
              { label: 'Lost', value: String(weeks[active].lost), tone: 'bad' },
            ],
            note: `${weeks[active].cashed} of ${weeks[active].counted} parlays cashed.`,
          }} />
        )}
      </svg>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Does your confidence mean anything: hit rate by rating, against the odds
// ---------------------------------------------------------------------------

export function ConfidenceColumns({ rows }: { rows: readonly (RateRow & { rating: number })[] }) {
  const [ref, width] = useWidth<HTMLDivElement>(420)
  const [active, on] = useActive()
  const w = Math.max(260, width)
  const height = 214
  const L = 42
  const R = 4
  const T = 24
  const B = 40
  const step = (w - L - R) / 5
  const bw = Math.min(40, step * 0.5)
  const y = (v: number) => T + (1 - v) * (height - T - B)
  return (
    <div className="chart" ref={ref}>
      <svg width={w} height={height} viewBox={`0 0 ${w} ${height}`} role="img" aria-label="Hit rate by confidence rating, against what the odds said">
        {[0, 0.5, 1].map(t => (
          <g key={t}>
            <line x1={L} x2={w - R} y1={y(t)} y2={y(t)} className={t === 0 ? 'base' : t === 0.5 ? 'gridline dashed' : 'gridline'} />
            <text x={L - 8} y={y(t) + 4} textAnchor="end" className="axis">{wholePercent(t)}</text>
          </g>
        ))}
        {rows.map((each, i) => {
          const cx = L + step * (i + 0.5)
          const x = cx - bw / 2
          return (
            <g key={each.rating}>
              {each.n > 0 && (
                <>
                  <path d={barPath(x, y(each.you), bw, Math.max(2, y(0) - y(each.you)), true)} className="col-you" />
                  <line x1={x - 5} x2={x + bw + 5} y1={y(each.odds)} y2={y(each.odds)} className="col-odds" />
                  <text x={cx} y={Math.min(y(each.you), y(each.odds)) - 8} textAnchor="middle" className="col-value">{wholePercent(each.you)}</text>
                </>
              )}
              <text x={cx} y={height - 22} textAnchor="middle" className="col-name">Rated {each.rating}</text>
              <text x={cx} y={height - 7} textAnchor="middle" className="axis">{each.n === 1 ? '1 leg' : `${each.n} legs`}</text>
              <rect x={L + step * i} y={0} width={step} height={height} className="hit" {...on(i)}
                aria-label={`Rated ${each.rating}: ${each.won} of ${each.n}. The odds said ${wholePercent(each.odds)}.`} />
            </g>
          )
        })}
        {active !== null && rows[active] !== undefined && (
          <SvgTip x={L + step * (active + 0.5)} y={y(Math.max(rows[active].you, rows[active].odds))} width={w} height={height} tip={{
            title: `Rated ${rows[active].rating} out of 5`,
            rows: [
              { label: 'You', value: rows[active].n > 0 ? `${rows[active].won} of ${rows[active].n}, ${wholePercent(rows[active].you)}` : 'No legs', tone: 'you' },
              { label: 'Odds said', value: rows[active].n > 0 ? wholePercent(rows[active].odds) : '—', tone: 'odds' },
            ],
          }} />
        )}
      </svg>
    </div>
  )
}

// A club's record: won, then lost to a draw, then lost, as 9px squares.
export function Strip({ won, drawn, lost }: { won: number; drawn: number; lost: number }) {
  const kinds = [...Array<string>(won).fill('won'), ...Array<string>(drawn).fill('drawn'), ...Array<string>(lost).fill('lost')]
  return (
    <svg width={kinds.length * 11} height={9} role="img" aria-label={`${won} won, ${drawn} lost to a draw, ${lost} lost`}>
      {kinds.map((kind, i) => <rect key={i} x={i * 11} y={0} width={9} height={9} rx={2} className={`part ${kind}`} />)}
    </svg>
  )
}

// A 150px progress bar, for an achievement still to unlock.
export function Progress({ share }: { share: number }) {
  return (
    <svg className="prog" width={150} height={3} aria-hidden="true">
      <rect x={0} y={0} width={150} height={3} rx={1.5} className="prog-track" />
      <rect x={0} y={0} width={Math.max(0, Math.min(1, share)) * 150} height={3} rx={1.5} className="prog-fill" />
    </svg>
  )
}
