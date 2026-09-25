// Itaú Chile credit-card statement. One PDF carries the national statement
// (CLP, "ESTADO DE CUENTA NACIONAL DE TARJETA DE CRÉDITO") and, after it, the
// international one (USD); each document starts at a page with its title and
// runs until the next title. Both are read in full — header, limits, rates,
// previous period, every movement by section, the bank's coming-months
// schedule — and cross-checked against the totals the bank prints.
import Decimal from 'decimal.js'
import type { CardStatementInput, CardStatementLineInput } from '@/services/contract'
import { center, groupRows, nearestAnchor, rowText, type Anchor, type Row, type TextRun } from '@/lib/statements/layout'
import {
  hasCurrencySymbol,
  parseClDate,
  parseClMoney,
  parseClPercent,
  parseClShortDate,
} from '@/lib/statements/amounts'
import { StatementFormatError, type ParsedStatement, type StatementParser } from '@/lib/statements/types'

type Kind = 'nacional' | 'internacional'
type Section = 'pago' | 'compra' | 'voluntario' | 'cargo'

const TITLE = /ESTADO DE CUENTA (NACIONAL|INTERNACIONAL) DE TARJETA DE CREDITO/

// norm drops accents and case so labels match however the PDF encodes them.
function norm(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toUpperCase().replace(/\s+/g, ' ').trim()
}

// A run with three letters in a row is a label, which ends the values that
// follow the previous label on the same row ("US$" and "(A)" are not labels).
const LABELISH = /\p{L}{3}/u

// labelValues returns the texts that follow `label` on its row, up to the next
// label; the first row where the label has values wins (the payment slip
// repeats several labels with their values on another row).
function labelValues(rows: readonly Row[], label: string): string[] {
  for (const row of rows) {
    const i = row.runs.findIndex((r) => norm(r.str) === label)
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

function parseAnyDate(s: string): string | null {
  return parseClDate(s) ?? parseClShortDate(s)
}

function moneys(values: readonly string[]): string[] {
  return values.flatMap((v) => parseClMoney(v) ?? [])
}

function dates(values: readonly string[]): string[] {
  return values.flatMap((v) => parseAnyDate(v) ?? [])
}

function percents(values: readonly string[]): string[] {
  return values.flatMap((v) => parseClPercent(v) ?? [])
}

// Header fields every statement carries in its first page.
function cardDigits(rows: readonly Row[]): string {
  for (const row of rows) {
    const i = row.runs.findIndex((r) => norm(r.str) === 'Nº DE TARJETA DE CREDITO')
    const value = i >= 0 ? row.runs[i + 1]?.str : undefined
    const digits = value ? /(\d{4})\s*$/.exec(value)?.[1] : undefined
    if (digits) return digits
  }
  return ''
}

// belowLabel reads a value printed under its label rather than beside it
// (CAE PREPAGO): the closest matching run up to 30 points below, centered.
function belowLabel(rows: readonly Row[], label: string, parse: (s: string) => string | null): string {
  const runs = rows.flatMap((r) => r.runs)
  const at = runs.find((r) => norm(r.str) === label)
  if (!at) return ''
  const hit = runs
    .filter((r) => r.page === at.page && r.y < at.y && at.y - r.y <= 30 && Math.abs(center(r) - center(at)) <= 60)
    .filter((r) => parse(r.str) !== null)
    .toSorted((a, b) => b.y - a.y)[0]
  return hit ? (parse(hit.str) ?? '') : ''
}

const MONTHS = ['ENERO', 'FEBRERO', 'MARZO', 'ABRIL', 'MAYO', 'JUNIO', 'JULIO', 'AGOSTO', 'SEPTIEMBRE', 'OCTUBRE', 'NOVIEMBRE', 'DICIEMBRE']

// periodForMonth is the first period after `after` (YYYY-MM) in month m (1-12).
function periodForMonth(after: string, m: number): string {
  const year = Number(after.slice(0, 4))
  const month = Number(after.slice(5, 7))
  return `${m > month ? year : year + 1}-${String(m).padStart(2, '0')}`
}

// schedule reads "VENCIMIENTO PRÓXIMOS 4 MESES": a row of labels (ACTUAL, then
// month names) and, just below, their amounts. ACTUAL is the debt not billed
// yet; each month is what the bank will bill then.
function schedule(rows: readonly Row[], period: string): { unbilled: string; months: { period: string; amount: string }[] } {
  const out = { unbilled: '', months: [] as { period: string; amount: string }[] }
  const header = rows.find((r) => r.runs.some((run) => norm(run.str) === 'ACTUAL'))
  if (!header) return out
  const anchors: Anchor<string>[] = header.runs
    .filter((r) => norm(r.str) === 'ACTUAL' || MONTHS.includes(norm(r.str)))
    .map((r) => ({ key: norm(r.str), x: center(r) }))
  const values = rows.find((r) => r.page === header.page && r.y < header.y && header.y - r.y <= 20)
  for (const run of values?.runs ?? []) {
    const amount = hasCurrencySymbol(run.str) ? parseClMoney(run.str) : null
    const key = amount === null ? null : nearestAnchor(run, anchors)
    if (amount === null || key === null) continue
    if (key === 'ACTUAL') out.unbilled = amount
    else out.months.push({ period: periodForMonth(period, MONTHS.indexOf(key) + 1), amount })
  }
  return out
}

// ---------- movements ----------

interface Totals {
  operations: string | null // (B): payments + purchases
  payments: string | null
  purchases: string[] // one TOTAL TARJETA per card (holder and additional cards)
  purchasesHeader: string | null // international "TOTAL DE COMPRAS"
  voluntary: string | null // (C)
  charges: string | null // (D) / international commissions and credits
}

type AmountColumn = 'operation' | 'total' | 'installment' | 'origin' | 'usd'

interface Columns {
  dateX: number // text left of it is the place (national) or the reference (international)
  descX: number
  cityX: number // international only
  countryX: number // international only
  amounts: Anchor<AmountColumn>[]
}

const INSTALLMENT = /^(\d{1,2})\/(\d{1,2})$/
const REFERENCE = /^\d{4}(?: \d+)?$/
const INTEREST = /\s*TASA INT\.\s*(\d+(?:,\d+)?)\s*%/

// columnsFrom reads the column positions from the movements table header
// (the row naming DESCRIPCIÓN OPERACIÓN O COBRO and the rows just below it).
function columnsFrom(rows: readonly Row[], header: Row): Columns {
  const band = rows.filter((r) => r.page === header.page && r.y <= header.y && header.y - r.y <= 25).flatMap((r) => r.runs)
  const x = (label: string) => band.find((r) => norm(r.str) === label)?.x
  const cx = (label: string) => {
    const run = band.find((r) => norm(r.str) === label)
    return run ? center(run) : undefined
  }
  const desc = x('DESCRIPCION OPERACION O COBRO')
  const date = x('FECHA')
  const amounts: Anchor<AmountColumn>[] = []
  const [operation, total] = band.filter((r) => norm(r.str) === 'MONTO').toSorted((a, b) => a.x - b.x)
  if (operation) amounts.push({ key: 'operation', x: center(operation) })
  if (total) amounts.push({ key: 'total', x: center(total) })
  const installment = cx('VALOR CUOTA')
  if (installment !== undefined) amounts.push({ key: 'installment', x: installment })
  const origin = cx('ORIGEN')
  if (origin !== undefined) amounts.push({ key: 'origin', x: origin })
  const usd = cx('MONTO US$')
  if (usd !== undefined) amounts.push({ key: 'usd', x: usd })
  if (desc === undefined || date === undefined || amounts.length < 2) {
    throw new StatementFormatError(`Página ${header.page}: no se reconocen las columnas de movimientos (¿cambió el formato?).`)
  }
  return {
    dateX: date,
    descX: desc,
    cityX: x('CIUDAD') ?? Number.POSITIVE_INFINITY,
    countryX: band.find((r) => norm(r.str).startsWith('PAIS'))?.x ?? Number.POSITIVE_INFINITY,
    amounts,
  }
}

function isHeader(row: Row): boolean {
  return row.runs.some((r) => norm(r.str) === 'DESCRIPCION OPERACION O COBRO')
}

function lastMoney(row: Row): string | null {
  return moneys(row.runs.map((r) => r.str)).at(-1) ?? null
}

// readLine turns a movement row into a line; null when it has no charged amount.
function readLine(row: Row, cols: Columns, section: Section, kind: Kind): CardStatementLineInput | null {
  const line: CardStatementLineInput = {
    section, place: '', city: '', country: '', operationDate: '', reference: '', description: '', interestRate: '',
    operationAmount: '', totalAmount: '', installmentNumber: 1, installmentsTotal: 1, installmentAmount: '', originAmount: '',
  }
  const text: string[] = []
  const ref: string[] = []
  for (const run of row.runs) {
    const s = run.str.trim()
    const date = line.operationDate === '' ? parseClShortDate(s) : null
    const cuota = INSTALLMENT.exec(s)
    // National amounts carry "$"; international ones are bare numbers right of the country.
    const money = (kind === 'nacional' ? hasCurrencySymbol(s) : run.x >= cols.countryX) ? parseClMoney(s) : null
    if (date) line.operationDate = date
    else if (money !== null) {
      switch (nearestAnchor(run, cols.amounts)) {
        case 'operation': line.operationAmount = money; break
        case 'total': line.totalAmount = money; break
        case 'installment': case 'usd': line.installmentAmount = money; break
        case 'origin': line.originAmount = money; break
        default:
      }
    } else if (cuota && run.x > cols.descX) {
      line.installmentNumber = Number(cuota[1])
      line.installmentsTotal = Number(cuota[2])
    } else if (run.x < cols.dateX - 2) {
      if (kind === 'nacional') line.place = s
      else ref.push(s)
    } else if (kind === 'nacional' && run.x < cols.descX - 2 && REFERENCE.test(s)) line.reference = s
    else if (run.x >= cols.countryX) line.country = s
    else if (run.x >= cols.cityX) line.city = [line.city, s].filter(Boolean).join(' ')
    else text.push(s)
  }
  if (line.operationDate === '' || line.installmentAmount === '') return null
  if (kind === 'internacional') line.reference = ref.join(' ')
  let description = text.join(' ').replace(/\s+/g, ' ')
  const rate = INTEREST.exec(description)
  if (rate?.[1] !== undefined) {
    line.interestRate = rate[1].replace(',', '.')
    description = description.replace(INTEREST, ' ').replace(/\s+/g, ' ').trim()
  }
  // National descriptors end with the place of the operation, already kept apart.
  if (line.place !== '' && description.endsWith(' ' + line.place)) {
    description = description.slice(0, -line.place.length - 1)
  }
  line.description = description
  if (section === 'cargo' && new Decimal(line.installmentAmount).isNegative()) line.section = 'abono'
  return line
}

// readMovements walks the document's rows, switching section at each of the
// bank's section markers and reading the rows that carry an operation date.
function readMovements(rows: readonly Row[], kind: Kind, warnings: string[]): { lines: CardStatementLineInput[]; totals: Totals } {
  const totals: Totals = { operations: null, payments: null, purchases: [], purchasesHeader: null, voluntary: null, charges: null }
  const lines: CardStatementLineInput[] = []
  let cols: Columns | null = null
  let section: Section | null = null
  for (const row of rows) {
    if (isHeader(row)) {
      cols = columnsFrom(rows, row)
      continue
    }
    const t = norm(rowText(row))
    if (/^1\. ?TOTAL OPERACIONES/.test(t)) {
      totals.operations = lastMoney(row)
      section = 'pago'
    } else if (/^TOTAL PAGOS A LA CUENTA/.test(t)) {
      // National: the payments total closes the payments, purchases follow.
      totals.payments = lastMoney(row)
      section = 'compra'
    } else if (/^TOTAL DE PAGOS/.test(t)) {
      // International: each section opens with its total.
      totals.payments = lastMoney(row)
      section = 'pago'
    } else if (/^TOTAL DE COMPRAS/.test(t)) {
      totals.purchasesHeader = lastMoney(row)
      section = 'compra'
    } else if (/^TOTAL TARJETA/.test(t)) {
      const total = lastMoney(row)
      if (total !== null) totals.purchases.push(total)
    } else if (/^2\. ?PRODUCTOS O SERVICIOS VOLUNTARIAMENTE/.test(t)) {
      totals.voluntary = lastMoney(row)
      section = 'voluntario'
    } else if (/^3\. ?CARGOS, COMISIONES|^COMISIONES, OTROS CARGOS/.test(t)) {
      totals.charges = lastMoney(row)
      section = 'cargo'
    } else if (/^III\./.test(t)) {
      section = null // payment information: no more movements
    } else if (section && cols && row.runs.some((r) => parseClShortDate(r.str) !== null)) {
      // Only movements carry dd/mm/yy dates; the payment slips and period
      // fields between table pages use dd/mm/yyyy, so they never land here.
      const line = readLine(row, cols, section, kind)
      if (line) lines.push(line)
      else warnings.push(`Página ${row.page}: la fila «${rowText(row)}» no tiene monto legible.`)
    }
  }
  return { lines, totals }
}

// ---------- checks ----------

function sum(values: readonly string[]): Decimal {
  return values.reduce((acc, v) => acc.plus(v), new Decimal(0))
}

function sumOf(lines: readonly CardStatementLineInput[], ...sections: string[]): Decimal {
  return sum(lines.filter((l) => sections.includes(l.section)).map((l) => l.installmentAmount))
}

function check(warnings: string[], who: string, what: string, computed: Decimal, reported: string | null): void {
  if (reported === null || computed.eq(reported)) return
  warnings.push(`${who}: ${what} no cuadra (calculado ${computed.toString()}, informado ${new Decimal(reported).toString()}). Revisa el estado de cuenta.`)
}

// ---------- documents ----------

interface Document {
  kind: Kind
  rows: Row[]
}

// splitDocuments groups pages by the statement they belong to: a titled page
// starts a document, untitled pages continue the current one.
function splitDocuments(runs: readonly TextRun[]): Document[] {
  const docs: Document[] = []
  const pages = [...new Set(runs.map((r) => r.page))].toSorted((a, b) => a - b)
  for (const page of pages) {
    const rows = groupRows(runs.filter((r) => r.page === page))
    const title = rows.map((r) => TITLE.exec(norm(rowText(r)))).find(Boolean)
    if (title?.[1]) docs.push({ kind: title[1] === 'NACIONAL' ? 'nacional' : 'internacional', rows })
    else docs.at(-1)?.rows.push(...rows)
  }
  return docs
}

function emptyInput(kind: Kind): CardStatementInput {
  return {
    issuer: 'itau', kind, currency: kind === 'nacional' ? 'CLP' : 'USD', cardLastDigits: '', statementDate: '',
    periodFrom: '', periodTo: '', dueDate: '', previousPeriodFrom: '', previousPeriodTo: '', nextPeriodFrom: '',
    nextPeriodTo: '', creditLimit: '', creditUsed: '', creditAvailable: '', cashLimit: '', cashUsed: '',
    cashAvailable: '', previousBalanceStart: '', previousBilled: '', previousPaid: '', previousBalanceEnd: '',
    transferFromNational: '', totalOperations: '', voluntaryProducts: '', chargesNet: '', totalBilled: '',
    minimumPayment: '', prepaymentCost: '', automaticCharge: '', unbilledBalance: '', rateRevolving: '',
    rateInstallments: '', rateCashAdvance: '', caeRevolving: '', caeInstallments: '', caeCashAdvance: '',
    caePrepayment: '', lateInterestRate: '', fileHash: '', lines: [], schedule: [],
  }
}

function readDocument(doc: Document, warnings: string[]): CardStatementInput {
  const { rows, kind } = doc
  const who = kind === 'nacional' ? 'Estado nacional' : 'Estado internacional'
  const st = emptyInput(kind)
  const first = (label: string, pick: (v: string[]) => string[] = moneys) => pick(labelValues(rows, label))[0] ?? ''

  st.cardLastDigits = cardDigits(rows)
  st.statementDate = first('FECHA ESTADO DE CUENTA', dates)
  if (st.cardLastDigits === '' || st.statementDate === '') {
    throw new StatementFormatError(`${who}: no se encontraron la tarjeta o la fecha del estado de cuenta (¿cambió el formato?).`)
  }
  ;[st.creditLimit = '', st.creditUsed = '', st.creditAvailable = ''] = moneys(labelValues(rows, 'CUPO TOTAL'))
  ;[st.cashLimit = '', st.cashUsed = '', st.cashAvailable = ''] = moneys(labelValues(rows, 'CUPO TOTAL AVANCE EN EFECTIVO'))
  st.dueDate = first('PAGAR HASTA', dates)

  if (kind === 'nacional') {
    ;[st.periodFrom = '', st.periodTo = ''] = dates(labelValues(rows, 'PERIODO FACTURADO'))
    ;[st.previousPeriodFrom = '', st.previousPeriodTo = ''] = dates(labelValues(rows, 'PERIODO DE FACTURACION ANTERIOR'))
    ;[st.nextPeriodFrom = '', st.nextPeriodTo = ''] = dates(labelValues(rows, 'PROXIMO PERIODO DE FACTURACION'))
    ;[st.rateRevolving = '', st.rateInstallments = '', st.rateCashAdvance = ''] = percents(labelValues(rows, 'TASA INTERES VIGENTE'))
    ;[st.caeRevolving = '', st.caeInstallments = '', st.caeCashAdvance = ''] = percents(labelValues(rows, 'CAE'))
    st.caePrepayment = belowLabel(rows, 'CAE PREPAGO', parseClPercent)
    st.lateInterestRate = first('INTERES MORATORIO', percents)
    st.previousBalanceStart = first('SALDO ADEUDADO INICIO PERIODO ANTERIOR')
    st.previousBilled = first('MONTO FACTURADO A PAGAR (PERIODO ANTERIOR)')
    st.previousPaid = first('MONTO PAGADO PERIODO ANTERIOR')
    st.previousBalanceEnd = first('SALDO ADEUDADO FINAL PERIODO ANTERIOR')
    st.totalBilled = first('MONTO TOTAL FACTURADO A PAGAR')
    st.minimumPayment = first('MONTO MINIMO A PAGAR')
    st.prepaymentCost = first('COSTO MONETARIO PREPAGO')
    st.automaticCharge = first('CARGO AUTOMATICO')
  } else {
    st.periodFrom = first('PERIODO FACTURADO DESDE', dates)
    st.periodTo = first('PERIODO FACTURADO HASTA', dates)
    st.previousBilled = first('SALDO ANTERIOR FACTURADO')
    st.previousPaid = first('ABONO REALIZADO')
    st.transferFromNational = first('TRASPASO DEUDA NACIONAL')
    st.totalBilled = first('DEUDA TOTAL')
  }

  const period = (st.periodTo || st.statementDate).slice(0, 7)
  const coming = schedule(rows, period)
  st.unbilledBalance = coming.unbilled
  st.schedule = coming.months

  const { lines, totals } = readMovements(rows, kind, warnings)
  st.lines = lines
  const payments = sumOf(lines, 'pago')
  const purchases = sumOf(lines, 'compra')
  const charges = sumOf(lines, 'cargo', 'abono')
  check(warnings, who, 'el total de pagos', payments, totals.payments)
  if (totals.purchases.length > 0) check(warnings, who, 'el total de compras', purchases, sum(totals.purchases).toString())
  check(warnings, who, 'el total de compras', purchases, totals.purchasesHeader)
  check(warnings, who, 'el total de cargos y abonos', charges, totals.charges)

  if (kind === 'nacional') {
    st.totalOperations = totals.operations ?? ''
    st.voluntaryProducts = totals.voluntary ?? ''
    st.chargesNet = totals.charges ?? ''
    check(warnings, who, 'el total de productos voluntarios', sumOf(lines, 'voluntario'), totals.voluntary)
    check(warnings, who, 'el total de operaciones (B)', payments.plus(purchases), totals.operations)
    const billed = new Decimal(st.previousBilled || 0).plus(st.totalOperations || 0).plus(st.voluntaryProducts || 0).plus(st.chargesNet || 0)
    check(warnings, who, 'el total facturado (A+B+C+D)', billed, st.totalBilled || null)
    if (st.creditUsed !== '' && st.unbilledBalance !== '') {
      check(warnings, who, 'el cupo utilizado', new Decimal(st.totalBilled || 0).plus(st.unbilledBalance), st.creditUsed)
    }
  } else {
    st.chargesNet = totals.charges ?? ''
    const debt = new Decimal(st.previousBilled || 0).plus(st.previousPaid || 0).plus(st.transferFromNational || 0).plus(purchases).plus(charges)
    check(warnings, who, 'la deuda total', debt, st.totalBilled || null)
  }
  return st
}

function summarize(st: CardStatementInput): string {
  const count = (section: string) => st.lines.filter((l) => l.section === section).length
  const [y, m, d] = st.statementDate.split('-')
  const parts = [
    [count('pago'), 'pago', 'pagos'],
    [count('compra') + count('voluntario'), 'compra', 'compras'],
    [count('cargo'), 'cargo', 'cargos'],
    [count('abono'), 'abono', 'abonos'],
  ] as const
  const summary = parts.filter(([n]) => n > 0).map(([n, one, many]) => `${n} ${n === 1 ? one : many}`)
  return `Estado ${st.kind} ••${st.cardLastDigits} al ${d}/${m}/${y} (${st.currency}): ${summary.join(', ') || 'sin movimientos'}.`
}

export const itauCardStatement: StatementParser = {
  label: 'Estado de cuenta tarjeta de crédito Itaú',

  matches(text) {
    return TITLE.test(norm(text)) && norm(text).includes('CUPO TOTAL')
  },

  parse(runs: readonly TextRun[]): ParsedStatement {
    const warnings: string[] = []
    const statements = splitDocuments(runs).map((doc) => readDocument(doc, warnings))
    if (statements.length === 0) throw new StatementFormatError('El PDF no contiene estados de cuenta de tarjeta reconocibles.')
    return { kind: 'cardStatements', statements, notes: statements.map(summarize), warnings }
  },
}
