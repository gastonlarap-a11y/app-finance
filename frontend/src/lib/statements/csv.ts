// Generic CSV import for any bank: every Chilean bank exports its cartola to
// Excel/CSV, so instead of guessing each layout the user maps the columns once
// (the approach of YNAB, Actual and Monarch file imports). Pure functions —
// the dialog (components/CsvImport.tsx) turns the result into a StageImport
// batch, so CSV movements go through the inbox like every other source.
import type { ImportBatch, ImportCandidate } from '@/services/contract'

// decodeText reads the file as UTF-8, falling back to Windows-1252 (what Excel
// and most Chilean bank exports use) when it is not valid UTF-8.
export function decodeText(bytes: Uint8Array): string {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    text = new TextDecoder('windows-1252').decode(bytes)
  }
  return text.charCodeAt(0) === BYTE_ORDER_MARK ? text.slice(1) : text
}

const BYTE_ORDER_MARK = 0xfeff

const DELIMITERS = [';', ',', '\t'] as const

// splitRows parses RFC 4180 CSV (quoted fields, "" escapes, newlines inside
// quotes) with the given delimiter.
function splitRows(text: string, delimiter: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"'
        i++
      } else if (ch === '"') {
        quoted = false
      } else {
        field += ch
      }
    } else if (ch === '"' && field === '') {
      quoted = true
    } else if (ch === delimiter) {
      row.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else {
      field += ch
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows.map((r) => r.map((c) => c.trim())).filter((r) => r.some((c) => c !== ''))
}

// parseCsv detects the delimiter (the one giving the most rows with the same,
// widest column count) and returns the non-empty rows.
export function parseCsv(text: string): string[][] {
  let best: string[][] = []
  let bestScore = -1
  for (const d of DELIMITERS) {
    const rows = splitRows(text, d)
    const widths = new Map<number, number>()
    for (const r of rows) if (r.length > 1) widths.set(r.length, (widths.get(r.length) ?? 0) + 1)
    let score = 0
    for (const [w, n] of widths) score = Math.max(score, w * n)
    if (score > bestScore) {
      best = rows
      bestScore = score
    }
  }
  return best
}

// How the file writes numbers and dates: a Chilean export (1.234,56 and
// dd/mm/yyyy) or one in the US locale (1,234.56 and mm/dd/yyyy), which a
// spreadsheet set to English produces. ISO dates (yyyy-mm-dd) read the same.
export type NumberFormat = 'cl' | 'us'
export type DateOrder = 'dmy' | 'mdy'

export interface CsvFormats {
  numbers: NumberFormat
  dates: DateOrder
}

export const CHILEAN_FORMATS: CsvFormats = { numbers: 'cl', dates: 'dmy' }

// splitSign takes the currency marks off an amount cell and reads its sign:
// "-12", "12-" and "(12)" are negative.
function splitSign(raw: string): { negative: boolean; digits: string } | null {
  let s = raw.replace(/[\s$]/g, '').replace(/CLP/i, '')
  let negative = false
  if (/^\(.*\)$/.test(s)) {
    negative = true
    s = s.slice(1, -1)
  }
  if (s.startsWith('-')) {
    negative = !negative
    s = s.slice(1)
  } else if (s.endsWith('-')) {
    negative = !negative
    s = s.slice(0, -1)
  }
  return s === '' ? null : { negative, digits: s }
}

// digitsCL reads "1.234.567", "1.234,50", "1234,5" or "1234.5": a dot is a
// thousands separator unless it is the only separator and followed by one or
// two digits.
function digitsCL(s: string): string | null {
  if (s.includes(',')) {
    if (!/^\d{1,3}(\.\d{3})*(,\d+)?$|^\d+(,\d+)?$/.test(s)) return null
    return s.replace(/\./g, '').replace(',', '.')
  }
  if (/^\d+\.\d{1,2}$/.test(s)) return s
  if (/^\d{1,3}(\.\d{3})+$|^\d+$/.test(s)) return s.replace(/\./g, '')
  return null
}

// digitsUS reads "1,234,567", "1,234.50" or "1234.5": commas group thousands.
function digitsUS(s: string): string | null {
  if (!/^\d{1,3}(,\d{3})*(\.\d+)?$|^\d+(\.\d+)?$/.test(s)) return null
  return s.replace(/,/g, '')
}

// parseAmount reads an amount written in `format` ("$ 1.234.567", "(3.000)",
// "1.234,50" in Chile; "1,234,567", "1,234.50" in the US) as a plain decimal
// string ("-1234.5"); null when it is not a number.
export function parseAmount(raw: string, format: NumberFormat): string | null {
  const signed = splitSign(raw)
  if (!signed) return null
  const digits = format === 'cl' ? digitsCL(signed.digits) : digitsUS(signed.digits)
  if (digits === null) return null
  const normalized = digits.replace(/^0+(?=\d)/, '')
  if (/^0+(\.0+)?$/.test(normalized)) return '0'
  return signed.negative ? '-' + normalized : normalized
}

// A date written day and month first, with a two- or four-digit year.
const LOCAL_DATE = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})(?:\s.*)?$/

// parseDate reads dd/mm/yyyy (or mm/dd/yyyy when `order` says so), with -, .
// or / and a two-digit year, or yyyy-mm-dd (with an optional time, as Excel
// exports it) into YYYY-MM-DD; null when it is not a real date.
export function parseDate(raw: string, order: DateOrder): string | null {
  const s = raw.trim()
  let y: number, m: number, d: number
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/.exec(s)
  const local = LOCAL_DATE.exec(s)
  if (iso) {
    ;[y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])]
  } else if (local) {
    const [first, second] = [Number(local[1]), Number(local[2])]
    ;[d, m] = order === 'dmy' ? [first, second] : [second, first]
    y = Number(local[3])
    if (y < 100) y += 2000
  } else {
    return null
  }
  const date = new Date(Date.UTC(y, m - 1, d))
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

// How amounts are laid out in the file.
export type AmountLayout =
  | { kind: 'signed'; column: number } // one column: negative = charge, positive = credit
  | { kind: 'charges'; column: number } // one column of charges (a card export): negative = credit
  | { kind: 'split'; charge: number; credit: number } // "Cargos" and "Abonos" columns

export interface CsvMapping {
  headerRow: number // index in rows of the header; data starts after it
  date: number
  description: number
  amount: AmountLayout
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')

// guessMapping proposes a mapping from the first row that names a date column:
// fecha / descripción (detalle, glosa…) / monto, or cargos + abonos.
export function guessMapping(rows: readonly string[][]): CsvMapping | null {
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const cells = (rows[i] ?? []).map(norm)
    const find = (...words: string[]) => cells.findIndex((c) => words.some((w) => c.includes(w)))
    const date = find('fecha')
    if (date < 0) continue
    const description = find('descripcion', 'detalle', 'glosa', 'concepto', 'movimiento', 'comercio')
    const charge = find('cargo', 'debito', 'giro')
    const credit = find('abono', 'credito', 'deposito')
    const amount = find('monto', 'importe', 'valor')
    if (description < 0) continue
    if (charge >= 0 && credit >= 0) return { headerRow: i, date, description, amount: { kind: 'split', charge, credit } }
    if (amount >= 0) return { headerRow: i, date, description, amount: { kind: 'signed', column: amount } }
  }
  return null
}

// A reading is a vote for one format, or for neither ('ambiguous': it reads
// as both, differently).
type Vote<T> = T | 'ambiguous' | null

function dateVote(raw: string): Vote<DateOrder> {
  const m = LOCAL_DATE.exec(raw.trim())
  if (!m) return null // ISO, or not a date
  const [first, second] = [Number(m[1]), Number(m[2])]
  if (first > 12 && second <= 12) return 'dmy'
  if (second > 12 && first <= 12) return 'mdy'
  return first === second || (first > 12 && second > 12) ? null : 'ambiguous'
}

// numberVote: money has at most two decimals, so a reading with three or more
// is not money ("1,234" is 1234 in the US, not 1,234 pesos; "1.234" is 1234 in
// Chile, not 1.234 dollars).
function numberVote(raw: string): Vote<NumberFormat> {
  const signed = splitSign(raw)
  if (!signed) return null
  const money = (n: string | null) => (n !== null && !/\.\d{3,}$/.test(n) ? n : null)
  const cl = money(digitsCL(signed.digits))
  const us = money(digitsUS(signed.digits))
  if (cl === us) return null // the same either way, or not a number
  if (cl === null) return 'us'
  if (us === null) return 'cl'
  return 'ambiguous'
}

interface Decision<T> {
  value: T
  voted: boolean // some value told it
  sure: boolean // no value pointed elsewhere, and none read both ways unresolved
}

// decide takes the most voted format, or the fallback without votes.
function decide<T extends string>(votes: readonly Vote<T>[], fallback: T): Decision<T> {
  const counts = new Map<T, number>()
  let ambiguous = false
  for (const v of votes) {
    if (v === 'ambiguous') ambiguous = true
    else if (v !== null) counts.set(v, (counts.get(v) ?? 0) + 1)
  }
  const ranked = [...counts].sort((a, b) => b[1] - a[1])
  if (ranked.length === 0) return { value: fallback, voted: false, sure: !ambiguous }
  return { value: ranked[0]![0], voted: true, sure: ranked.length === 1 }
}

// One file comes from one locale: its dates and numbers go together.
const LOCALE_DATES: Record<NumberFormat, DateOrder> = { cl: 'dmy', us: 'mdy' }
const LOCALE_NUMBERS: Record<DateOrder, NumberFormat> = { dmy: 'cl', mdy: 'us' }

// detectFormats reads how the mapped columns write dates and amounts: a day
// past 12 tells the date order, a separator only one locale reads as money
// tells the number format, and when only one of them is told the other follows
// its locale (Chile when nothing tells). `sure` is false when the data points
// both ways or reads both ways: the dialog then asks to check the preview.
export function detectFormats(rows: readonly string[][], mapping: CsvMapping): CsvFormats & { sure: boolean } {
  const data = rows.slice(mapping.headerRow + 1)
  const amountColumns =
    mapping.amount.kind === 'split' ? [mapping.amount.charge, mapping.amount.credit] : [mapping.amount.column]
  let dates = decide(
    data.map((r) => dateVote(r[mapping.date] ?? '')),
    'dmy',
  )
  let numbers = decide(
    data.flatMap((r) => amountColumns.map((c) => numberVote(r[c] ?? ''))),
    'cl',
  )
  if (!dates.voted && numbers.voted) dates = { value: LOCALE_DATES[numbers.value], voted: false, sure: numbers.sure }
  else if (!numbers.voted && dates.voted) numbers = { value: LOCALE_NUMBERS[dates.value], voted: false, sure: dates.sure }
  return { dates: dates.value, numbers: numbers.value, sure: dates.sure && numbers.sure }
}

export interface CsvReadResult {
  batch: ImportBatch
  skipped: number // rows after the header that are not a movement (totals, blanks, saldos)
}

// buildBatch turns the mapped rows, read in `formats`, into an inbox batch for
// `issuer` (the bank name the user typed). Rows without a valid date,
// description or non-zero amount are skipped and counted.
export function buildBatch(rows: readonly string[][], mapping: CsvMapping, formats: CsvFormats, issuer: string): CsvReadResult {
  const items: ImportCandidate[] = []
  let skipped = 0
  for (const row of rows.slice(mapping.headerRow + 1)) {
    const date = parseDate(row[mapping.date] ?? '', formats.dates)
    const description = (row[mapping.description] ?? '').replace(/\s+/g, ' ').trim()
    const signed = signedAmount(row, mapping.amount, formats.numbers)
    if (date === null || description === '' || signed === null || signed === '0') {
      skipped++
      continue
    }
    const credit = !signed.startsWith('-')
    items.push({
      date,
      description,
      amount: credit ? signed : signed.slice(1),
      currency: 'CLP',
      cardLastDigits: '',
      account: '',
      reference: '',
      installmentsTotal: 1,
      hint: '',
      kind: credit ? 'abono' : 'gasto',
    })
  }
  return { batch: { source: 'csv', issuer: issuer.trim(), items }, skipped }
}

// signedAmount is the row's movement with charges negative and credits
// positive, or null when the amount cells are not numbers.
function signedAmount(row: readonly string[], layout: AmountLayout, format: NumberFormat): string | null {
  const cell = (i: number) => (row[i] ?? '').trim()
  switch (layout.kind) {
    case 'signed':
      return parseAmount(cell(layout.column), format)
    case 'charges': {
      const v = parseAmount(cell(layout.column), format)
      if (v === null || v === '0') return v
      return v.startsWith('-') ? v.slice(1) : '-' + v
    }
    case 'split': {
      const charge = cell(layout.charge) === '' ? '0' : parseAmount(cell(layout.charge), format)
      const credit = cell(layout.credit) === '' ? '0' : parseAmount(cell(layout.credit), format)
      if (charge === null || credit === null) return null
      if (charge !== '0' && credit !== '0') return null // both filled: ambiguous, skip
      if (charge !== '0') return charge.startsWith('-') ? charge.slice(1) : '-' + charge
      return credit
    }
  }
}
