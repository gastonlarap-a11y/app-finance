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

// parseAmountCL reads an es-CL amount ("$ 1.234.567", "-12.345", "(3.000)",
// "1.234,50", "1234.5") as a plain decimal string ("-1234.5"); null when it is
// not a number. A dot is a thousands separator unless it is the only
// separator and followed by one or two digits.
export function parseAmountCL(raw: string): string | null {
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
  if (s === '') return null
  let normalized: string
  if (s.includes(',')) {
    if (!/^\d{1,3}(\.\d{3})*(,\d+)?$|^\d+(,\d+)?$/.test(s)) return null
    normalized = s.replace(/\./g, '').replace(',', '.')
  } else if (/^\d+\.\d{1,2}$/.test(s)) {
    normalized = s
  } else if (/^\d{1,3}(\.\d{3})+$|^\d+$/.test(s)) {
    normalized = s.replace(/\./g, '')
  } else {
    return null
  }
  normalized = normalized.replace(/^0+(?=\d)/, '')
  if (/^0+(\.0+)?$/.test(normalized)) return '0'
  return negative ? '-' + normalized : normalized
}

// parseDateCL reads dd/mm/yyyy, dd-mm-yyyy, dd.mm.yyyy, dd/mm/yy or
// yyyy-mm-dd (with an optional time, as Excel exports it) into YYYY-MM-DD;
// null when it is not a real date.
export function parseDateCL(raw: string): string | null {
  const s = raw.trim()
  let y: number, m: number, d: number
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/.exec(s)
  const cl = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})(?:\s.*)?$/.exec(s)
  if (iso) {
    ;[y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])]
  } else if (cl) {
    ;[d, m, y] = [Number(cl[1]), Number(cl[2]), Number(cl[3])]
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

export interface CsvReadResult {
  batch: ImportBatch
  skipped: number // rows after the header that are not a movement (totals, blanks, saldos)
}

// buildBatch turns the mapped rows into an inbox batch for `issuer` (the bank
// name the user typed). Rows without a valid date, description or non-zero
// amount are skipped and counted.
export function buildBatch(rows: readonly string[][], mapping: CsvMapping, issuer: string): CsvReadResult {
  const items: ImportCandidate[] = []
  let skipped = 0
  for (const row of rows.slice(mapping.headerRow + 1)) {
    const date = parseDateCL(row[mapping.date] ?? '')
    const description = (row[mapping.description] ?? '').replace(/\s+/g, ' ').trim()
    const signed = signedAmount(row, mapping.amount)
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
function signedAmount(row: readonly string[], layout: AmountLayout): string | null {
  const cell = (i: number) => (row[i] ?? '').trim()
  switch (layout.kind) {
    case 'signed':
      return parseAmountCL(cell(layout.column))
    case 'charges': {
      const v = parseAmountCL(cell(layout.column))
      if (v === null || v === '0') return v
      return v.startsWith('-') ? v.slice(1) : '-' + v
    }
    case 'split': {
      const charge = cell(layout.charge) === '' ? '0' : parseAmountCL(cell(layout.charge))
      const credit = cell(layout.credit) === '' ? '0' : parseAmountCL(cell(layout.credit))
      if (charge === null || credit === null) return null
      if (charge !== '0' && credit !== '0') return null // both filled: ambiguous, skip
      if (charge !== '0') return charge.startsWith('-') ? charge.slice(1) : '-' + charge
      return credit
    }
  }
}
