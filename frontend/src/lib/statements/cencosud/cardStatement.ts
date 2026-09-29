// Tarjeta Cencosud Scotiabank credit-card statement, as its PDF is downloaded:
// the CMF's standard contents in the issuer's own layout — the header in runs
// of their own ("TARJETA ************1234", "FECHA 21/03/2026"), dd/mm/yyyy
// dates, bare amounts without "$", rates with a decimal point ("2.46%"), one
// sub-header per card of the account and no per-section totals, so the bill is
// checked against its grand total and the credit used. International purchases
// come already in pesos, in the same statement.
//
// Notes the user wrote over the PDF (an annotation flattened into the page,
// "ropa G") come out as text runs inside the description column, after the
// bank's descriptor: only a row's first text after its date is the descriptor.
import Decimal from 'decimal.js'
import type { CardStatementInput, CardStatementLineInput } from '@/services/contract'
import { center, groupRows, nearestAnchor, rowText, type Anchor, type Row, type TextRun } from '@/lib/statements/layout'
import { parseClDate, parseClMoney, parseClPercent } from '@/lib/statements/amounts'
import {
  belowLabel,
  check,
  dates,
  emptyInput,
  emptyLine,
  INSTALLMENT,
  labelValues,
  moneyCells,
  moneys,
  monthNumber,
  norm,
  percents,
  periodForMonth,
  sumOf,
  summarize,
} from '@/lib/statements/cardFields'
import { shiftPeriod } from '@/lib/format'
import { StatementFormatError, type ParsedStatement, type StatementParser } from '@/lib/statements/types'

type Section = 'operaciones' | 'voluntario' | 'cargo' | 'diferida'
type AmountColumn = 'operation' | 'total' | 'installment'

interface Columns {
  dateX: number
  cuotaX: number
  amounts: Anchor<AmountColumn>[]
}

// A payment to the card among the operations (never a merchant whose name
// holds the word, like MERCADOPAGO).
const PAYMENT = /^(MONTO CANCELADO|PAGO\b)/

// headerRun reads a header field printed with its value in one run.
function headerRun(rows: readonly Row[], pattern: RegExp): string {
  for (const run of rows.flatMap((r) => r.runs)) {
    const m = pattern.exec(norm(run.str))
    if (m?.[1] !== undefined) return m[1]
  }
  return ''
}

// columnsFrom reads the movements table's columns from the band of header rows
// around DESCRIPCIÓN OPERACIÓN O COBRO: two MONTO (operation, total to pay),
// N° CUOTA and VALOR CUOTA.
function columnsFrom(rows: readonly Row[], header: Row): Columns {
  const band = rows.filter((r) => r.page === header.page && Math.abs(r.y - header.y) <= 16).flatMap((r) => r.runs)
  const find = (label: string) => band.find((r) => norm(r.str) === label)
  const [operation, total] = band.filter((r) => norm(r.str) === 'MONTO').toSorted((a, b) => a.x - b.x)
  const installment = find('VALOR')
  const date = find('FECHA DE')
  const cuota = find('N°') ?? find('Nº')
  if (!operation || !total || !installment || !date || !cuota) {
    throw new StatementFormatError(`Página ${header.page}: no se reconocen las columnas de movimientos (¿cambió el formato?).`)
  }
  return {
    dateX: date.x,
    cuotaX: center(cuota),
    amounts: [
      { key: 'operation', x: center(operation) },
      { key: 'total', x: center(total) },
      { key: 'installment', x: center(installment) },
    ],
  }
}

// readLine turns a movement row into a line; null when it is not one.
function readLine(row: Row, cols: Columns, section: Section): CardStatementLineInput | null {
  const line = emptyLine(section === 'operaciones' ? 'compra' : section)
  for (const run of row.runs) {
    const s = run.str.trim()
    const date = line.operationDate === '' ? parseClDate(s) : null
    const cuota = INSTALLMENT.exec(s)
    const money = parseClMoney(s)
    if (date) line.operationDate = date
    else if (run.x < cols.dateX - 2) line.place = s
    else if (cuota && Math.abs(center(run) - cols.cuotaX) < 20) {
      line.installmentNumber = Number(cuota[1])
      line.installmentsTotal = Number(cuota[2])
    } else if (money !== null && line.operationDate !== '') {
      switch (nearestAnchor(run, cols.amounts)) {
        case 'operation': line.operationAmount = money; break
        case 'total': line.totalAmount = money; break
        case 'installment': line.installmentAmount = money; break
        default:
      }
    } else if (line.operationDate !== '' && line.description === '') line.description = s.replace(/\s+/g, ' ')
    // Any other text is a note written over the PDF: never part of the descriptor.
  }
  if (line.operationDate === '' || line.installmentAmount === '') return null
  const negative = new Decimal(line.installmentAmount).isNegative()
  if (section === 'operaciones' && negative && PAYMENT.test(norm(line.description))) line.section = 'pago'
  if (section === 'cargo' && negative) line.section = 'abono'
  return line
}

// isMovementRow: a movement carries a date in the date column, unlike any
// other date on the page.
function isMovementRow(row: Row, cols: Columns): boolean {
  return row.runs.some((r) => Math.abs(r.x - cols.dateX) <= 15 && parseClDate(r.str) !== null)
}

function readMovements(rows: readonly Row[], warnings: string[]): CardStatementLineInput[] {
  const lines: CardStatementLineInput[] = []
  let cols: Columns | null = null
  let section: Section | null = null
  for (const row of rows) {
    const t = norm(rowText(row))
    if (row.runs.some((r) => norm(r.str) === 'DESCRIPCION OPERACION O COBRO')) cols = columnsFrom(rows, row)
    else if (/^\d\. ?TOTAL OPERACIONES/.test(t)) section = 'operaciones' // nacionales, then internacionales
    else if (/^3\. ?PRODUCTOS O SERVICIOS VOLUNTARIAMENTE/.test(t)) section = 'voluntario'
    else if (/^4\. ?CARGOS, COMISIONES/.test(t)) section = 'cargo'
    else if (/^5\. ?INFORMACION COMPRAS EN CUOTAS/.test(t)) section = 'diferida'
    else if (/^III\./.test(t)) section = null
    else if (section && cols && isMovementRow(row, cols)) {
      const line = readLine(row, cols, section)
      if (line) lines.push(line)
      else warnings.push(`Página ${row.page}: la fila «${rowText(row)}» no tiene monto legible.`)
    }
  }
  return lines
}

// schedule reads "VENCIMIENTOS PRÓXIMOS 4 MESES": ACTUAL (the debt not billed
// yet) and four months with, on the row below, their amounts. Cencosud names
// each month by when it is paid: MAY holds the cuotas of April's statement.
function schedule(rows: readonly Row[], period: string): { unbilled: string; months: { period: string; amount: string }[] } {
  const out = { unbilled: '', months: [] as { period: string; amount: string }[] }
  const head = rows.find((r) => r.runs.some((run) => norm(run.str) === 'ACTUAL') && r.runs.some((run) => monthNumber(run.str) > 0))
  if (!head) return out
  const anchors: Anchor<string>[] = head.runs
    .filter((r) => norm(r.str) === 'ACTUAL' || monthNumber(r.str) > 0)
    .map((r) => ({ key: norm(r.str), x: center(r) }))
  const values = rows.find((r) => r.page === head.page && r.y < head.y && head.y - r.y <= 20)
  for (const run of values?.runs ?? []) {
    const amount = parseClMoney(run.str)
    const key = amount === null ? null : nearestAnchor(run, anchors)
    if (amount === null || key === null) continue
    if (key === 'ACTUAL') out.unbilled = amount
    else out.months.push({ period: shiftPeriod(periodForMonth(period, monthNumber(key)), -1), amount })
  }
  return out
}

// rateAfter reads the rate printed after `label` with words of its own
// ("INTERÉS MORATORIO" · "29.52% ANUAL"), which labelValues takes for a label.
function rateAfter(rows: readonly Row[], label: string): string {
  for (const row of rows) {
    const i = row.runs.findIndex((r) => norm(r.str) === label)
    const m = i >= 0 ? /^(\d+(?:[.,]\d+)?\s*%)/.exec(row.runs[i + 1]?.str.trim() ?? '') : null
    const rate = m?.[1] !== undefined ? parseClPercent(m[1]) : null
    if (rate !== null) return rate
  }
  return ''
}

function readStatement(rows: readonly Row[], warnings: string[]): CardStatementInput {
  const who = 'Estado nacional'
  const st = emptyInput('cencosud', 'nacional')
  const first = (label: string, pick: (v: string[]) => string[] = moneys) => pick(labelValues(rows, label))[0] ?? ''

  st.cardLastDigits = headerRun(rows, /^TARJETA [*\d]*(\d{4})$/)
  st.statementDate = parseClDate(headerRun(rows, /^FECHA (\d{2}\/\d{2}\/\d{4})$/)) ?? ''
  if (st.cardLastDigits === '' || st.statementDate === '') {
    throw new StatementFormatError(`${who}: no se encontraron la tarjeta o la fecha del estado de cuenta (¿cambió el formato?).`)
  }
  ;[st.creditLimit = '', st.creditUsed = '', st.creditAvailable = ''] = moneyCells(labelValues(rows, 'CUPO TOTAL'))
  ;[st.cashLimit = '', st.cashUsed = '', st.cashAvailable = ''] = moneyCells(labelValues(rows, 'CUPO TOTAL AVANCE EN EFECTIVO'))
  ;[st.periodFrom = '', st.periodTo = ''] = dates(labelValues(rows, 'PERIODO FACTURADO'))
  st.dueDate = first('PAGAR HASTA', dates)
  ;[st.rateRevolving = '', st.rateInstallments = '', st.rateCashAdvance = ''] = percents(labelValues(rows, 'TASA INTERES VIGENTE'))
  ;[st.caeRevolving = '', st.caeInstallments = '', st.caeCashAdvance = ''] = percents(labelValues(rows, 'CAE'))
  st.caePrepayment = belowLabel(rows, 'CAE PREPAGO', parseClPercent)
  ;[st.previousPeriodFrom = '', st.previousPeriodTo = ''] = dates(labelValues(rows, 'PERIODO FACTURADO ANTERIOR'))
  st.previousBalanceStart = first('SALDO ADEUDADO INICIO PERIODO ANTERIOR')
  st.previousBilled = first('MONTO FACTURADO A PAGAR DEL PERIODO ANTERIOR')
  st.previousPaid = first('MONTO PAGADO PERIODO ANTERIOR')
  st.previousBalanceEnd = first('SALDO ADEUDADO FINAL PERIODO ANTERIOR')
  st.totalBilled = first('MONTO TOTAL FACTURADO A PAGAR')
  st.minimumPayment = first('MONTO MINIMO A PAGAR')
  st.prepaymentCost = first('COSTO MONETARIO PREPAGO')
  ;[st.nextPeriodFrom = '', st.nextPeriodTo = ''] = dates(labelValues(rows, 'PROXIMO PERIODO A FACTURAR'))
  st.lateInterestRate = rateAfter(rows, 'INTERES MORATORIO')

  const coming = schedule(rows, (st.periodTo || st.statementDate).slice(0, 7))
  st.unbilledBalance = coming.unbilled
  st.schedule = coming.months

  st.lines = readMovements(rows, warnings)
  // No per-section totals are printed: the sections add up to the bill.
  const operations = sumOf(st.lines, 'pago', 'compra')
  const voluntary = sumOf(st.lines, 'voluntario')
  const charges = sumOf(st.lines, 'cargo', 'abono')
  st.totalOperations = operations.toString()
  st.voluntaryProducts = voluntary.toString()
  st.chargesNet = charges.toString()
  const billed = new Decimal(st.previousBilled || 0).plus(operations).plus(voluntary).plus(charges)
  check(warnings, who, 'el total facturado', billed, st.totalBilled || null)
  if (st.creditUsed !== '' && st.unbilledBalance !== '') {
    check(warnings, who, 'el cupo utilizado', new Decimal(st.totalBilled || 0).plus(st.unbilledBalance), st.creditUsed)
  }
  return st
}

export const cencosudCardStatement: StatementParser = {
  label: 'Estado de cuenta tarjeta Cencosud Scotiabank',

  matches(text) {
    const t = norm(text)
    return t.includes('ESTADO DE CUENTA') && t.includes('TARJETA CENCOSUD')
  },

  parse(runs: readonly TextRun[]): ParsedStatement {
    const warnings: string[] = []
    const st = readStatement(groupRows(runs), warnings)
    return { kind: 'cardStatements', statements: [st], notes: [summarize(st)], warnings }
  },
}
