// Field readers shared by the credit-card statement parsers. Chilean card
// statements follow the CMF's standard contents (holder, limits, rates,
// previous period, movements by section, coming months), so every issuer's
// layout is read with the same label lookups and cross-checked the same way.
import Decimal from 'decimal.js'
import type { CardStatementInput, CardStatementLineInput } from '@/services/contract'
import { center, type Row } from '@/lib/statements/layout'
import { parseClDate, parseClMoney, parseClPercent, parseClShortDate } from '@/lib/statements/amounts'

export type Kind = 'nacional' | 'internacional'

// norm drops accents and case so labels match however the PDF encodes them.
export function norm(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toUpperCase().replace(/\s+/g, ' ').trim()
}

// A run with three letters in a row is a label, which ends the values that
// follow the previous label on the same row ("US$" and "(A)" are not labels).
const LABELISH = /\p{L}{3}/u

// labelValues returns the texts that follow `label` on its row, up to the next
// label; the first row where the label has values wins (the payment slip
// repeats several labels with their values on another row). A label run may
// end with the opening parenthesis of a formula ("MONTO TOTAL FACTURADO A
// PAGAR (" followed by "A + B + … )"). A RegExp label matches labels that
// carry a value of their own ("COSTO MONETARIO PREPAGO AL 19/06/2026 ****").
export function labelValues(rows: readonly Row[], label: string | RegExp): string[] {
  const isLabel = (s: string) => (typeof label === 'string' ? s === label : label.test(s))
  for (const row of rows) {
    const i = row.runs.findIndex((r) => isLabel(norm(r.str).replace(/\s*\($/, '')))
    if (i < 0) continue
    const values: string[] = []
    for (const run of row.runs.slice(i + 1)) {
      const s = run.str.trim()
      if (LABELISH.test(s) && parseClMoney(s) === null) break
      values.push(s)
    }
    if (values.some((v) => parseClMoney(v) !== null || parseClPercent(v) !== null || parseAnyDate(v) !== null)) {
      return values
    }
  }
  return []
}

export function parseAnyDate(s: string): string | null {
  return parseClDate(s) ?? parseClShortDate(s)
}

export function moneys(values: readonly string[]): string[] {
  return values.flatMap((v) => parseClMoney(v) ?? [])
}

// moneyCells keeps the position of a row's amounts: a "-" printed for a value
// that does not apply (a cash-advance limit) stays as an empty cell instead of
// shifting the amounts after it.
export function moneyCells(values: readonly string[]): string[] {
  return values.flatMap((v) => (v.trim() === '-' ? [''] : (parseClMoney(v) ?? [])))
}

export function dates(values: readonly string[]): string[] {
  return values.flatMap((v) => parseAnyDate(v) ?? [])
}

export function percents(values: readonly string[]): string[] {
  return values.flatMap((v) => parseClPercent(v) ?? [])
}

// belowLabel reads a value printed under its label rather than beside it
// (CAE PREPAGO): the closest matching run up to 30 points below, centered.
export function belowLabel(rows: readonly Row[], label: string, parse: (s: string) => string | null): string {
  const runs = rows.flatMap((r) => r.runs)
  const at = runs.find((r) => norm(r.str) === label)
  if (!at) return ''
  const hit = runs
    .filter((r) => r.page === at.page && r.y < at.y && at.y - r.y <= 30 && Math.abs(center(r) - center(at)) <= 60)
    .filter((r) => parse(r.str) !== null)
    .toSorted((a, b) => b.y - a.y)[0]
  return hit ? (parse(hit.str) ?? '') : ''
}

export const MONTHS = [
  'ENERO', 'FEBRERO', 'MARZO', 'ABRIL', 'MAYO', 'JUNIO', 'JULIO', 'AGOSTO', 'SEPTIEMBRE', 'OCTUBRE', 'NOVIEMBRE', 'DICIEMBRE',
]

// monthNumber reads a month label, whole or abbreviated ("MAYO", "MAY",
// "SEPT"): 1-12, or 0 when it is not a month.
export function monthNumber(label: string): number {
  const t = norm(label)
  if (t.length < 3) return 0
  return MONTHS.findIndex((m) => m === t || (t.length <= 4 && m.startsWith(t))) + 1
}

// periodForMonth is the first period after `after` (YYYY-MM) in month m (1-12).
export function periodForMonth(after: string, m: number): string {
  const year = Number(after.slice(0, 4))
  const month = Number(after.slice(5, 7))
  return `${m > month ? year : year + 1}-${String(m).padStart(2, '0')}`
}

export function emptyInput(issuer: string, kind: Kind): CardStatementInput {
  return {
    issuer, kind, currency: kind === 'nacional' ? 'CLP' : 'USD', cardLastDigits: '', statementDate: '',
    periodFrom: '', periodTo: '', dueDate: '', previousPeriodFrom: '', previousPeriodTo: '', nextPeriodFrom: '',
    nextPeriodTo: '', creditLimit: '', creditUsed: '', creditAvailable: '', cashLimit: '', cashUsed: '',
    cashAvailable: '', previousBalanceStart: '', previousBilled: '', previousPaid: '', previousBalanceEnd: '',
    transferFromNational: '', totalOperations: '', voluntaryProducts: '', chargesNet: '', totalBilled: '',
    minimumPayment: '', prepaymentCost: '', automaticCharge: '', unbilledBalance: '', rateRevolving: '',
    rateInstallments: '', rateCashAdvance: '', caeRevolving: '', caeInstallments: '', caeCashAdvance: '',
    caePrepayment: '', lateInterestRate: '', fileHash: '', lines: [], schedule: [],
  }
}

export function emptyLine(section: string): CardStatementLineInput {
  return {
    section, place: '', city: '', country: '', operationDate: '', reference: '', description: '', interestRate: '',
    operationAmount: '', totalAmount: '', installmentNumber: 1, installmentsTotal: 1, installmentAmount: '', originAmount: '',
  }
}

// INSTALLMENT is a cuota "n/N" ("00/3": none billed yet).
export const INSTALLMENT = /^(\d{1,2})\/(\d{1,2})$/

// INTEREST is the rate note issuers append to a cuotas purchase's descriptor
// ("TASA INT. 0,00%", "Tasa Int 0,00%").
const INTEREST = /\s*TASA INT\.?\s*(\d+(?:,\d+)?)\s*%/i

// splitInterest moves a descriptor's rate note to the line's interest rate.
export function splitInterest(line: CardStatementLineInput, description: string): string {
  const rate = INTEREST.exec(description)
  if (rate?.[1] === undefined) return description
  line.interestRate = rate[1].replace(',', '.')
  return description.replace(INTEREST, ' ').replace(/\s+/g, ' ').trim()
}

// ---------- checks ----------

export function sum(values: readonly string[]): Decimal {
  return values.reduce((acc, v) => acc.plus(v), new Decimal(0))
}

export function sumOf(lines: readonly CardStatementLineInput[], ...sections: string[]): Decimal {
  return sum(lines.filter((l) => sections.includes(l.section)).map((l) => l.installmentAmount))
}

export function check(warnings: string[], who: string, what: string, computed: Decimal, reported: string | null): void {
  if (reported === null || computed.eq(reported)) return
  warnings.push(`${who}: ${what} no cuadra (calculado ${computed.toString()}, informado ${new Decimal(reported).toString()}). Revisa el estado de cuenta.`)
}

// summarize is the import note for one statement.
export function summarize(st: CardStatementInput): string {
  const count = (section: string) => st.lines.filter((l) => l.section === section).length
  const [y, m, d] = st.statementDate.split('-')
  const parts = [
    [count('pago'), 'pago', 'pagos'],
    [count('compra') + count('voluntario'), 'compra', 'compras'],
    [count('diferida'), 'compra en cuotas por comenzar', 'compras en cuotas por comenzar'],
    [count('cargo'), 'cargo', 'cargos'],
    [count('abono'), 'abono', 'abonos'],
  ] as const
  const summary = parts.filter(([n]) => n > 0).map(([n, one, many]) => `${n} ${n === 1 ? one : many}`)
  return `Estado ${st.kind} ••${st.cardLastDigits} al ${d}/${m}/${y} (${st.currency}): ${summary.join(', ') || 'sin movimientos'}.`
}
