// Reading the backfill's CSV (step 11.1, claude/fmbt-step11-plan.md): the
// rules of RFC 4180, as Excel's "CSV UTF-8" writes them. The file is
// untrusted, so it's read strictly and within limits, and nothing in it is
// ever run or turned into HTML: its text is only shown through React.

export const MAX_FILE_BYTES = 1_000_000
export const MAX_ROWS = 5000
export const MAX_CELL = 200

export type CsvRow = { line: number; cells: string[] } // `line` is where the row starts in the file, from 1
export type CsvTable = { header: string[]; rows: CsvRow[] }

// The header and every row after it, or what's wrong with the file. Blank
// lines, which Excel can leave at the end, are left out.
export function readCsv(text: string): CsvTable | { problem: string } {
  // A file saved in another encoding comes through with U+FFFD in place of
  // the characters it couldn't read.
  if (text.includes('\uFFFD')) return { problem: "The file isn't UTF-8. In Excel, save it as CSV UTF-8." }
  const body = text.startsWith('\uFEFF') ? text.slice(1) : text
  const rows: CsvRow[] = []
  let cells: string[] = []
  let cell = ''
  let quoted = false
  let line = 1
  let start = 1
  for (let i = 0; i < body.length; i++) {
    const c = body[i]
    if (quoted) {
      if (c === '"' && body[i + 1] === '"') {
        cell += '"'
        i++
      } else if (c === '"') {
        quoted = false
      } else {
        if (c === '\n') line++
        cell += c
      }
    } else if (c === '"') {
      if (cell !== '') return { problem: `Line ${line} has a quote in the middle of a cell.` }
      quoted = true
    } else if (c === ',') {
      cells.push(cell)
      cell = ''
    } else if (c === '\r' || c === '\n') {
      if (c === '\r' && body[i + 1] === '\n') i++
      cells.push(cell)
      rows.push({ line: start, cells })
      cells = []
      cell = ''
      line++
      start = line
      if (rows.length > MAX_ROWS + 1) return { problem: `The file has more than ${MAX_ROWS.toLocaleString('en-GB')} rows.` }
    } else {
      cell += c
    }
    if (cell.length > MAX_CELL) return { problem: `Line ${line} has a cell longer than ${MAX_CELL} characters.` }
  }
  if (quoted) return { problem: `A quote that opens on line ${start} is never closed.` }
  if (cell !== '' || cells.length > 0) {
    cells.push(cell)
    rows.push({ line: start, cells })
  }
  const filled = rows.filter(row => row.cells.some(each => each.trim() !== ''))
  if (filled.length > MAX_ROWS + 1) return { problem: `The file has more than ${MAX_ROWS.toLocaleString('en-GB')} rows.` }
  const [first, ...rest] = filled
  if (first === undefined) return { problem: 'The file is empty.' }
  return { header: first.cells.map(each => each.trim()), rows: rest }
}
