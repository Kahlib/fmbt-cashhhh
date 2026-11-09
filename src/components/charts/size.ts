// Shared pieces for the hand-built SVG charts (fmbt-design-system, "Charts").
// Every size goes in as an SVG attribute, never a style attribute, which
// the content security policy refuses.
import { useEffect, useRef, useState, type RefObject } from 'react'

// The width of the element `ref` points at, kept up to date as it resizes,
// so a chart draws at its real pixel width and its text stays 11 to 13px.
export function useWidth<T extends Element>(fallback: number): [RefObject<T | null>, number] {
  const ref = useRef<T>(null)
  const [width, setWidth] = useState(fallback)
  useEffect(() => {
    const element = ref.current
    if (element === null) return
    const observer = new ResizeObserver(entries => {
      const seen = entries[0]?.contentRect.width
      if (seen !== undefined && seen > 0) setWidth(Math.round(seen))
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return [ref, width]
}

// A bar rounded only on the end away from its baseline.
export function barPath(x: number, yTop: number, w: number, h: number, up: boolean, radius = 2): string {
  const r = Math.max(0, Math.min(radius, h, w / 2))
  return up
    ? `M${x},${yTop + h}V${yTop + r}Q${x},${yTop} ${x + r},${yTop}H${x + w - r}Q${x + w},${yTop} ${x + w},${yTop + r}V${yTop + h}Z`
    : `M${x},${yTop}V${yTop + h - r}Q${x},${yTop + h} ${x + r},${yTop + h}H${x + w - r}Q${x + w},${yTop + h} ${x + w},${yTop + h - r}V${yTop}Z`
}

// The running total's axis, in dollars: steps of 25, 50, 100, 200, 250, 500
// or 1,000, five at most, with room above the high point for its label.
export function moneyAxis(totals: readonly number[]): { lo: number; hi: number; step: number } {
  const top = Math.max(0, ...totals)
  const bottom = Math.min(0, ...totals)
  const span = top - bottom || 100
  const step = [25, 50, 100, 200, 250, 500, 1000].find(each => span / each <= 5) ?? Math.ceil(span / 5 / 1000) * 1000
  let lo = Math.floor(bottom / step) * step
  let hi = Math.ceil(top / step) * step
  if (hi - top < step * 0.35) hi += step
  if (bottom - lo < step * 0.2 && lo < 0) lo -= step
  return { lo, hi, step }
}

// A tooltip's note, in lines of about `size` characters.
export function wrapWords(text: string, size: number): string[] {
  const lines: string[] = []
  let line = ''
  for (const word of text.split(' ')) {
    if (line !== '' && line.length + 1 + word.length > size) {
      lines.push(line)
      line = word
    } else {
      line = line === '' ? word : `${line} ${word}`
    }
  }
  if (line !== '') lines.push(line)
  return lines
}
