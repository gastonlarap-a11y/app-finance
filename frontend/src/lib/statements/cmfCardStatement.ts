// Chilean credit-card statement in the CMF's standard format, as Itaú emails
// it and Banco de Chile issues it: "ESTADO DE CUENTA NACIONAL DE TARJETA DE
// CRÉDITO" (CLP) and, in Itaú's PDF, the international one (USD) after it.
// Each document starts at a page with its title and runs until the next title.
// Both are read in full — header, limits, rates, previous period, every
// movement by section, the bank's coming-months schedule — and cross-checked
// against the totals the bank prints. Issuers differ in details this parser
// takes as options (Template Method): who issued it and how its text runs are
// cut.
import Decimal from 'decimal.js'
import type { CardStatementInput, CardStatementLineInput } from '@/services/contract'
import { center, groupRows, nearestAnchor, rowText, type Anchor, type Row, type TextRun } from '@/lib/statements/layout'
import { hasCurrencySymbol, isClAmount, parseClMoney, parseClPercent, parseClShortDate } from '@/lib/statements/amounts'
import {
  belowLabel,
  check,
  dates,
  emptyInput,
  emptyLine,
  INSTALLMENT,
  labelValues,
  MONTHS,
  moneys,
  norm,
  percents,
  periodForMonth,
  splitInterest,
  sum,
  sumOf,
  summarize,
  type Kind,
} from '@/lib/statements/cardFields'
import { StatementFormatError, type ParsedStatement, type StatementParser } from '@/lib/statements/types'

type Section = 'pago' | 'compra' | 'voluntario' | 'cargo' | 'diferida'

const TITLE = /ESTADO DE CUENTA (NACIONAL|INTERNACIONAL) DE TARJETA DE CREDITO/

// isCmfCardStatement recognizes the standard format from the document's text.
export function isCmfCardStatement(text: string): boolean {
  const t = norm(text)
  return TITLE.test(t) && t.includes('CUPO TOTAL')
}

// Header fields every statement carries in its first page.
function cardDigits(rows: readonly Row[]): string {
  for (const row of rows) {
    const i = row.runs.findIndex((r) => /^N[º°] DE TARJETA DE CREDITO$/.test(norm(r.str)))
    const value = i >= 0 ? row.runs[i + 1]?.str : undefined
    const digits = value ? /(\d{4})\s*$/.exec(value)?.[1] : undefined
    if (digits) return digits
  }
  return ''
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

// ---------- text runs ----------

// Tokens a run is cut at when an issuer prints several cells in one run
// ("12.345 $", "060787654321 ZAPATERIA"): currency signs, amounts and
// operation codes. Other words stay together.
function isCell(token: string): boolean {
  return token === '$' || token === 'US$' || token === '%' || isClAmount(token) || /^\d{12,16}$/.test(token)
}

// splitRun cuts a run into its cells, placing each by its share of the run's
// characters (the PDF gives no finer geometry).
function splitRun(run: TextRun): TextRun[] {
  const tokens = [...run.str.matchAll(/\S+/g)]
  if (!tokens.some((m) => isCell(m[0]))) return [run]
  const out: TextRun[] = []
  const per = run.str.length > 0 ? run.width / run.str.length : 0
  let pending: { start: number; end: number } | null = null
  const flush = () => {
    if (!pending) return
    out.push({ ...run, str: run.str.slice(pending.start, pending.end), x: run.x + pending.start * per, width: (pending.end - pending.start) * per })
    pending = null
  }
  for (const m of tokens) {
    const start = m.index
    const end = start + m[0].length
    if (isCell(m[0])) {
      flush()
      out.push({ ...run, str: m[0], x: run.x + start * per, width: m[0].length * per })
    } else if (pending) {
      pending.end = end
    } else {
      pending = { start, end }
    }
  }
  flush()
  return out
}

// joinCells rejoins a row's currency signs and percent marks with their
// numbers ("$" + "12.345" → "$ 12.345" spanning both), the shape the readers
// expect.
function joinCells(runs: readonly TextRun[]): TextRun[] {
  const out: TextRun[] = []
  for (const run of runs) {
    const prev = out.at(-1)
    const s = run.str.trim()
    const prevIsSign = prev !== undefined && (prev.str === '$' || prev.str === 'US$')
    if (prevIsSign && /^-?[\d.,]+$/.test(s)) {
      out[out.length - 1] = { ...run, str: `${prev.str} ${s}`, x: prev.x, width: run.x + run.width - prev.x }
    } else if (prev !== undefined && s === '%' && /^[\d.,]+$/.test(prev.str.trim())) {
      out[out.length - 1] = { ...prev, str: `${prev.str.trim()} %`, width: run.x + run.width - prev.x }
    } else {
      out.push(run)
    }
  }
  return out
}

// cellRuns rebuilds the runs of an issuer that packs cells together.
function cellRuns(runs: readonly TextRun[]): TextRun[] {
  return groupRows(runs).flatMap((row) => joinCells(row.runs.flatMap(splitRun)))
}

// ---------- movements ----------

interface Totals {
  operations: string | null // Itaú (B): payments + purchases
  payments: string | null
  purchases: string[] // one TOTAL TARJETA per card (holder and additional cards)
  purchaseParts: string[] // Banco de Chile: automatic payments (C), one-cuota (D) and cuotas (E) purchases
  purchasesHeader: string | null // international "TOTAL DE COMPRAS"
  voluntary: string | null
  charges: string | null
}

type AmountColumn = 'operation' | 'total' | 'installment' | 'origin' | 'usd'

interface Columns {
  dateX: number // text left of it is the place (national) or the reference (international)
  descX: number
  cityX: number // international only
  countryX: number // international only
  amounts: Anchor<AmountColumn>[]
}

// REFERENCE is a national operation code: "2508 12345678" (Itaú),
// "060787654321" (Banco de Chile).
const REFERENCE = /^\d{4}(?: ?\d+)?$/

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

// withoutPlace drops the place of the operation that national descriptors end
// with, in a word of its own or glued to a truncated name ("FARMACIASSANTIAGO").
function withoutPlace(description: string, place: string): string {
  if (place === '' || description.length <= place.length || !description.endsWith(place)) return description
  return description.slice(0, -place.length).trimEnd()
}

// readLine turns a movement row into a line; null when it has no charged amount.
function readLine(row: Row, cols: Columns, section: Section, kind: Kind): CardStatementLineInput | null {
  const line = emptyLine(section)
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
  line.description = withoutPlace(splitInterest(line, text.join(' ').replace(/\s+/g, ' ')), line.place)
  if (section === 'cargo' && new Decimal(line.installmentAmount).isNegative()) line.section = 'abono'
  return line
}

// readMovements walks the document's rows, switching section at each of the
// bank's section markers and reading the rows that carry an operation date.
function readMovements(rows: readonly Row[], kind: Kind, warnings: string[]): { lines: CardStatementLineInput[]; totals: Totals } {
  const totals: Totals = {
    operations: null, payments: null, purchases: [], purchaseParts: [], purchasesHeader: null, voluntary: null, charges: null,
  }
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
    } else if (/^TOTAL (PAT A LA CUENTA|TRANSACCIONES EN UNA CUOTA|TRANSACCIONES EN CUOTAS)/.test(t)) {
      // Banco de Chile closes each kind of purchase with its own total.
      const total = lastMoney(row)
      if (total !== null) totals.purchaseParts.push(total)
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
    } else if (/^TOTAL PRODUCTOS O SERVICIOS VOLUNTARIAMENTE/.test(t)) {
      totals.voluntary = lastMoney(row)
    } else if (/^3\. ?CARGOS, COMISIONES|^COMISIONES, OTROS CARGOS/.test(t)) {
      totals.charges = lastMoney(row)
      section = 'cargo'
    } else if (/^TOTAL CARGOS, COMISIONES/.test(t)) {
      totals.charges = lastMoney(row)
    } else if (/^4\. ?INFORMACION COMPRAS EN CUOTAS/.test(t)) {
      section = 'diferida' // bought this period, first cuota next period: not billed yet
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

function readDocument(issuer: string, doc: Document, warnings: string[]): CardStatementInput {
  const { rows, kind } = doc
  const who = kind === 'nacional' ? 'Estado nacional' : 'Estado internacional'
  const st = emptyInput(issuer, kind)
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
  if (totals.purchaseParts.length > 0) check(warnings, who, 'el total de compras', purchases, sum(totals.purchaseParts).toString())
  else if (totals.purchases.length > 0) check(warnings, who, 'el total de compras', purchases, sum(totals.purchases).toString())
  check(warnings, who, 'el total de compras', purchases, totals.purchasesHeader)
  check(warnings, who, 'el total de cargos y abonos', charges, totals.charges)

  if (kind === 'nacional') {
    st.totalOperations = totals.operations ?? ''
    st.voluntaryProducts = totals.voluntary ?? ''
    st.chargesNet = totals.charges ?? ''
    check(warnings, who, 'el total de productos voluntarios', sumOf(lines, 'voluntario'), totals.voluntary)
    check(warnings, who, 'el total de operaciones (B)', payments.plus(purchases), totals.operations)
    // Issuers that print no operations total (Banco de Chile) add its parts.
    const printed = st.totalOperations !== ''
    const operations = printed ? new Decimal(st.totalOperations) : payments.plus(purchases)
    const billed = new Decimal(st.previousBilled || 0).plus(operations).plus(st.voluntaryProducts || 0).plus(st.chargesNet || 0)
    check(warnings, who, printed ? 'el total facturado (A+B+C+D)' : 'el total facturado', billed, st.totalBilled || null)
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

export interface CmfIssuer {
  issuer: string // stored on the statement ("itau", "bancochile")
  label: string // shown to the user
  matches(text: string): boolean // beyond isCmfCardStatement: this issuer's marks
  packedCells: boolean // prints several cells in one text run ("12.345 $")
}

// cmfCardStatementParser builds the parser of one issuer's standard statements.
export function cmfCardStatementParser(o: CmfIssuer): StatementParser {
  return {
    label: o.label,
    matches: (text) => isCmfCardStatement(text) && o.matches(text),
    parse(input: readonly TextRun[]): ParsedStatement {
      const runs = o.packedCells ? cellRuns(input) : input
      const warnings: string[] = []
      const statements = splitDocuments(runs).map((doc) => readDocument(o.issuer, doc, warnings))
      if (statements.length === 0) throw new StatementFormatError('El PDF no contiene estados de cuenta de tarjeta reconocibles.')
      return { kind: 'cardStatements', statements, notes: statements.map(summarize), warnings }
    },
  }
}
