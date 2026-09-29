// CMR Falabella (Banco Falabella) credit-card statement: the CMF's standard
// contents in the issuer's layout — mixed-case "Label:" / value header cells,
// dd/mm/yyyy dates, bare amounts without "$", the card in the footer ("(1) T :
// Titular : 000000******1234"), operations grouped by store (FALABELLA,
// SODIMAC, TOTTUS…, "Sin Movimientos" when empty) and the card payment among
// the charges. No per-section totals are printed: the bill is checked against
// its grand total.
//
// Built from a statement without purchases: the columns of a purchase row
// (and «Primer Cargo») are read from the table's header, not yet from a real
// row, so every import carries a note asking to check the amounts. The coming
// months of «Vencimiento próximos 4 meses» are not read until a statement with
// cuotas shows how they are labeled; only «Actual» (the debt not billed yet) is.
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
  norm,
  percents,
  sumOf,
  summarize,
} from '@/lib/statements/cardFields'
import { StatementFormatError, type ParsedStatement, type StatementParser } from '@/lib/statements/types'

type Section = 'operaciones' | 'voluntario' | 'cargo'
type Column = 'operation' | 'total' | 'cuotas' | 'first' | 'installment'

interface Columns {
  dateX: number
  holderX: number // «Titular o Adicional»: T or A, never part of the descriptor
  cells: Anchor<Column>[]
}

export const CMR_UNVERIFIED_NOTE = 'El lector de CMR aún no se valida con compras reales: revisa los montos de este estado.'

// A payment to the card (never a merchant whose name holds the word).
const PAYMENT = /^PAGO\b/

function columnsFrom(rows: readonly Row[], header: Row): Columns {
  const band = rows.filter((r) => r.page === header.page && Math.abs(r.y - header.y) <= 8).flatMap((r) => r.runs)
  const find = (label: string) => band.find((r) => norm(r.str) === label)
  const [operation, total] = band.filter((r) => norm(r.str) === 'MONTO').toSorted((a, b) => a.x - b.x)
  const date = find('FECHA')
  const holder = find('TITULAR O')
  const cuotas = find('NUMERO')
  const first = find('PRIMER')
  const installment = find('VALOR CUOTA')
  if (!operation || !total || !date || !holder || !cuotas || !first || !installment) {
    throw new StatementFormatError(`Página ${header.page}: no se reconocen las columnas de movimientos (¿cambió el formato?).`)
  }
  return {
    dateX: date.x,
    holderX: holder.x,
    cells: [
      { key: 'operation', x: center(operation) },
      { key: 'total', x: center(total) },
      { key: 'cuotas', x: center(cuotas) },
      { key: 'first', x: center(first) },
      { key: 'installment', x: center(installment) },
    ],
  }
}

// readLine turns a movement row into a line; null when it is not one. A row
// that only prints the operation amount (the card payment) charges that.
function readLine(row: Row, cols: Columns, section: Section): CardStatementLineInput | null {
  const line = emptyLine(section === 'operaciones' ? 'compra' : section)
  const text: string[] = []
  for (const run of row.runs) {
    const s = run.str.trim()
    const date = line.operationDate === '' ? parseClDate(s) : null
    if (date) {
      line.operationDate = date
      continue
    }
    if (run.x < cols.dateX - 2) {
      line.place = s
      continue
    }
    if (run.x < cols.holderX - 5) {
      text.push(s)
      continue
    }
    const cell = nearestAnchor(run, cols.cells)
    const cuota = INSTALLMENT.exec(s)
    const money = parseClMoney(s)
    if (cell === 'cuotas' && cuota) {
      line.installmentNumber = Number(cuota[1])
      line.installmentsTotal = Number(cuota[2])
    } else if (money !== null && cell === 'operation') line.operationAmount = money
    else if (money !== null && cell === 'total') line.totalAmount = money
    else if (money !== null && cell === 'installment') line.installmentAmount = money
    // «Titular o Adicional» and «Primer Cargo» are not kept.
  }
  if (line.installmentAmount === '') line.installmentAmount = line.totalAmount || line.operationAmount
  if (line.operationDate === '' || line.installmentAmount === '') return null
  line.description = text.join(' ').replace(/\s+/g, ' ')
  const negative = new Decimal(line.installmentAmount).isNegative()
  if (negative && PAYMENT.test(norm(line.description))) line.section = 'pago'
  else if (section === 'cargo' && negative) line.section = 'abono'
  return line
}

// isMovementRow: a movement carries a date in the date column, unlike the
// header every page repeats (the statement's own date, further right).
function isMovementRow(row: Row, cols: Columns): boolean {
  return row.runs.some((r) => Math.abs(r.x - cols.dateX) <= 15 && parseClDate(r.str) !== null)
}

function readMovements(rows: readonly Row[], warnings: string[]): CardStatementLineInput[] {
  const lines: CardStatementLineInput[] = []
  let cols: Columns | null = null
  let section: Section | null = null
  for (const row of rows) {
    const t = norm(rowText(row))
    if (row.runs.some((r) => norm(r.str) === 'DESCRIPCION OPERACION')) cols = columnsFrom(rows, row)
    else if (/^2\.1 TOTAL OPERACIONES/.test(t)) section = 'operaciones'
    else if (/^2\.2 PRODUCTOS O SERVICIOS VOLUNTARIAMENTE/.test(t)) section = 'voluntario'
    else if (/^2\.3 CARGOS, COMISIONES/.test(t)) section = 'cargo'
    else if (/^III\./.test(t)) section = null
    else if (section && cols && isMovementRow(row, cols)) {
      const line = readLine(row, cols, section)
      if (line) lines.push(line)
      else warnings.push(`Página ${row.page}: la fila «${rowText(row)}» no tiene monto legible.`)
    }
  }
  return lines
}

// holderDigits reads the holder's card from the footer's list of cards.
function holderDigits(rows: readonly Row[]): string {
  for (const run of rows.flatMap((r) => r.runs)) {
    const m = /TITULAR\s*:\s*[\d*]*(\d{4})\b/.exec(norm(run.str))
    if (m?.[1] !== undefined) return m[1]
  }
  return ''
}

function readStatement(rows: readonly Row[], warnings: string[]): CardStatementInput {
  const who = 'Estado nacional'
  const st = emptyInput('cmr', 'nacional')
  const first = (label: string | RegExp, pick: (v: string[]) => string[] = moneys) => pick(labelValues(rows, label))[0] ?? ''

  st.cardLastDigits = holderDigits(rows)
  st.statementDate = first('FECHA FACTURACION ESTADO DE CUENTA:', dates)
  if (st.cardLastDigits === '' || st.statementDate === '') {
    throw new StatementFormatError(`${who}: no se encontraron la tarjeta o la fecha del estado de cuenta (¿cambió el formato?).`)
  }
  // «Cupo Total» adds a pre-approved loan (Súper Avance); the card's own
  // purchase line is «Cupo Compras».
  ;[st.creditLimit = '', st.creditUsed = '', st.creditAvailable = ''] = moneyCells(labelValues(rows, 'CUPO COMPRAS'))
  ;[st.cashLimit = '', st.cashUsed = '', st.cashAvailable = ''] = moneyCells(labelValues(rows, /^CUPO AVANCE EN EFECTIVO/))
  ;[st.periodFrom = '', st.periodTo = ''] = dates(labelValues(rows, 'PERIODO FACTURADO'))
  st.dueDate = first('PAGAR HASTA', dates)
  // Columns: Refundido (the revolving balance), Cuotas, Avances.
  ;[st.rateRevolving = '', st.rateInstallments = '', st.rateCashAdvance = ''] = percents(labelValues(rows, 'TASA INTERES VIGENTE'))
  ;[st.caeRevolving = '', st.caeInstallments = '', st.caeCashAdvance = ''] = percents(labelValues(rows, 'CAE'))
  st.caePrepayment = belowLabel(rows, 'CAE PREPAGO:', parseClPercent)
  ;[st.previousPeriodFrom = '', st.previousPeriodTo = ''] = dates(labelValues(rows, 'PERIODO DE FACTURACION ANTERIOR'))
  st.previousBalanceStart = first('SALDO ADEUDADO INICIO PERIODO ANTERIOR')
  st.previousBilled = first('MONTO FACTURADO O A PAGAR PERIODO ANTERIOR')
  st.previousPaid = first('MONTO PAGADO PERIODO ANTERIOR')
  st.previousBalanceEnd = first('SALDO ADEUDADO FINAL PERIODO ANTERIOR')
  st.totalBilled = first('MONTO TOTAL FACTURADO A PAGAR')
  st.minimumPayment = first('MONTO MINIMO A PAGAR')
  st.prepaymentCost = first(/^COSTO MONETARIO PREPAGO/)
  ;[st.nextPeriodFrom = '', st.nextPeriodTo = ''] = dates(labelValues(rows, 'PROXIMO PERIODO A FACTURAR'))
  st.lateInterestRate = first('TASA MAXIMA INTERES VIGENTE MORA', percents)
  st.unbilledBalance = belowLabel(rows, 'ACTUAL', parseClMoney)

  st.lines = readMovements(rows, warnings)
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

export const cmrCardStatement: StatementParser = {
  label: 'Estado de cuenta tarjeta CMR Falabella',

  matches(text) {
    const t = norm(text)
    return t.includes('ESTADO DE CUENTA') && t.includes('CLIENTE CMR')
  },

  parse(runs: readonly TextRun[]): ParsedStatement {
    const warnings: string[] = []
    const st = readStatement(groupRows(runs), warnings)
    return { kind: 'cardStatements', statements: [st], notes: [summarize(st), CMR_UNVERIFIED_NOTE], warnings }
  },
}
