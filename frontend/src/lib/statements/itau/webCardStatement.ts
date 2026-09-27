// Itaú Chile credit-card statement downloaded from the bank's website
// ("Estado de cuenta nacional"): the data of the emailed PDF in another
// layout — mixed-case labels, header values inside their label's run
// ("Nº de tarjeta de crédito: xxxx-xxxx-xxxx-1234"), dd/mm/yyyy dates, a
// 16-digit code (the operation date, then the operation number) and no
// per-section totals, so the whole bill is checked against its grand total.
// The place column is printed out of step with its rows and is not read.
import Decimal from 'decimal.js'
import type { CardStatementInput, CardStatementLineInput } from '@/services/contract'
import { center, groupRows, nearestAnchor, rowText, type Anchor, type Row, type TextRun } from '@/lib/statements/layout'
import { hasCurrencySymbol, parseClDate, parseClMoney, parseClPercent } from '@/lib/statements/amounts'
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
  sumOf,
  summarize,
} from '@/lib/statements/cardFields'
import { StatementFormatError, type ParsedStatement, type StatementParser } from '@/lib/statements/types'

type Section = 'operaciones' | 'voluntario' | 'cargo' | 'diferida'
type AmountColumn = 'operation' | 'total' | 'installment'

const TITLE = /^ESTADO DE CUENTA (NACIONAL|INTERNACIONAL)$/
const CODE = /^\d{16}$/

// header reads "Label: value" runs, the web layout's header fields.
function header(rows: readonly Row[], label: RegExp): string {
  for (const run of rows.flatMap((r) => r.runs)) {
    const m = label.exec(norm(run.str))
    if (m?.[1] !== undefined) return m[1]
  }
  return ''
}

interface Columns {
  dateX: number
  descX: number
  amounts: Anchor<AmountColumn>[]
}

function columnsFrom(header: Row): Columns {
  const at = (label: string) => header.runs.find((r) => norm(r.str) === label)
  const date = at('FECHA OPERACION')
  const desc = at('DESCRIPCION OPERACION O COBRO')
  const operation = at('MONTO OPERACION')
  const total = at('MONTO TOTAL A PAGAR')
  const installment = at('CARGO DEL MES')
  if (!date || !desc || !operation || !total || !installment) {
    throw new StatementFormatError(`Página ${header.page}: no se reconocen las columnas de movimientos (¿cambió el formato?).`)
  }
  return {
    dateX: date.x,
    descX: desc.x,
    amounts: [
      { key: 'operation', x: center(operation) },
      { key: 'total', x: center(total) },
      { key: 'installment', x: center(installment) },
    ],
  }
}

// PAYMENT tells a payment to the card from a reversal among the operations.
const PAYMENT = /MONTO CANCELADO|PAGO/

// readLine turns a movement row into a line; null when it is not one.
function readLine(row: Row, cols: Columns, section: Section): CardStatementLineInput | null {
  const line = emptyLine(section === 'operaciones' ? 'compra' : section)
  const text: string[] = []
  for (const run of row.runs) {
    const s = run.str.trim()
    const date = line.operationDate === '' ? parseClDate(s) : null
    const cuota = INSTALLMENT.exec(s)
    const money = hasCurrencySymbol(s) ? parseClMoney(s) : null
    // Dates start a little left of their header: the row's first date is the operation's.
    if (date) line.operationDate = date
    else if (CODE.test(s)) line.reference = s
    else if (money !== null) {
      switch (nearestAnchor(run, cols.amounts)) {
        case 'operation': line.operationAmount = money; break
        case 'total': line.totalAmount = money; break
        case 'installment': line.installmentAmount = money; break
        default:
      }
    } else if (cuota && run.x > cols.descX) {
      line.installmentNumber = Number(cuota[1])
      line.installmentsTotal = Number(cuota[2])
    } else if (run.x >= cols.descX - 2) text.push(s)
  }
  if (line.operationDate === '' || line.reference === '' || line.installmentAmount === '') return null
  line.description = splitInterest(line, text.join(' ').replace(/\s+/g, ' '))
  const negative = new Decimal(line.installmentAmount).isNegative()
  if (section === 'operaciones' && negative && PAYMENT.test(norm(line.description))) line.section = 'pago'
  if (section === 'cargo' && negative) line.section = 'abono'
  return line
}

function readMovements(rows: readonly Row[], warnings: string[]): CardStatementLineInput[] {
  const lines: CardStatementLineInput[] = []
  let cols: Columns | null = null
  let section: Section | null = null
  for (const row of rows) {
    const t = norm(rowText(row))
    if (row.runs.some((r) => norm(r.str) === 'DESCRIPCION OPERACION O COBRO')) cols = columnsFrom(row)
    else if (/^1\. ?TOTAL OPERACIONES/.test(t)) section = 'operaciones'
    else if (/^2\. ?PRODUCTOS O SERVICIOS VOLUNTARIAMENTE/.test(t)) section = 'voluntario'
    else if (/^3\. ?CARGOS, COMISIONES/.test(t)) section = 'cargo'
    else if (/^4\. ?INFORMACION COMPRAS EN CUOTAS/.test(t)) section = 'diferida'
    else if (/^III\b/.test(t)) section = null
    else if (section && cols && row.runs.some((r) => CODE.test(r.str.trim()))) {
      const line = readLine(row, cols, section)
      if (line) lines.push(line)
      else warnings.push(`Página ${row.page}: la fila «${rowText(row)}» no tiene monto legible.`)
    }
  }
  return lines
}

// schedule reads "Vencimiento próximos 4 meses": the unbilled debt ("Saldo
// capital cuotas Actual") and the coming months, their amounts in the same
// order on the row below.
function schedule(rows: readonly Row[], period: string): { unbilled: string; months: { period: string; amount: string }[] } {
  const out = { unbilled: '', months: [] as { period: string; amount: string }[] }
  // Not "2. Período actual": the schedule's row also names the months.
  const head = rows.find(
    (r) => r.runs.some((run) => norm(run.str).endsWith('ACTUAL')) && r.runs.some((run) => MONTHS.includes(norm(run.str))),
  )
  if (!head) return out
  const months = head.runs.filter((r) => MONTHS.includes(norm(r.str))).map((r) => MONTHS.indexOf(norm(r.str)) + 1)
  const values = rows.find((r) => r.page === head.page && r.y < head.y && head.y - r.y <= 20)
  const amounts = (values?.runs ?? []).flatMap((r) => (hasCurrencySymbol(r.str) ? (parseClMoney(r.str) ?? []) : []))
  if (amounts.length !== months.length + 1) return out
  out.unbilled = amounts[0] ?? ''
  months.forEach((m, i) => out.months.push({ period: periodForMonth(period, m), amount: amounts[i + 1] ?? '' }))
  return out
}

function readStatement(rows: readonly Row[], warnings: string[]): CardStatementInput {
  const who = 'Estado nacional'
  const st = emptyInput('itau', 'nacional')
  const first = (label: string, pick: (v: string[]) => string[] = moneys) => pick(labelValues(rows, label))[0] ?? ''

  st.cardLastDigits = header(rows, /^N[º°] DE TARJETA DE CREDITO:.*(\d{4})$/)
  st.statementDate = parseClDate(header(rows, /^FECHA DE ESTADO DE CUENTA:\s*(\d{2}\/\d{2}\/\d{4})$/)) ?? ''
  if (st.cardLastDigits === '' || st.statementDate === '') {
    throw new StatementFormatError(`${who}: no se encontraron la tarjeta o la fecha del estado de cuenta (¿cambió el formato?).`)
  }
  ;[st.creditLimit = '', st.creditUsed = '', st.creditAvailable = ''] = moneys(labelValues(rows, 'CUPO TOTAL'))
  ;[st.cashLimit = '', st.cashUsed = '', st.cashAvailable = ''] = moneys(labelValues(rows, 'CUPO AVANCE EN EFECTIVO'))
  ;[st.periodFrom = '', st.periodTo = ''] = dates(labelValues(rows, 'PERIODO FACTURADO'))
  st.dueDate = first('PAGAR HASTA', dates)
  ;[st.rateRevolving = '', st.rateInstallments = '', st.rateCashAdvance = ''] = percents(labelValues(rows, 'TASA DE INTERES VIGENTE'))
  ;[st.caeRevolving = '', st.caeInstallments = '', st.caeCashAdvance = ''] = percents(labelValues(rows, 'CAE'))
  st.caePrepayment = belowLabel(rows, 'CAE PREPAGO', parseClPercent)
  ;[st.previousPeriodFrom = '', st.previousPeriodTo = ''] = dates(labelValues(rows, 'PERIODO FACTURACION ANTERIOR'))
  st.previousBalanceStart = first('SALDO ADEUDADO INICIO PERIODO ANTERIOR')
  st.previousBilled = first('MONTO FACTURADO A PAGAR (PERIODO ANTERIOR)')
  st.previousPaid = first('MONTO PAGADO PERIODO ANTERIOR')
  st.previousBalanceEnd = first('SALDO ADEUDADO FINAL PERIODO ANTERIOR')
  st.totalBilled = first('MONTO TOTAL FACTURADO A PAGAR')
  st.minimumPayment = first('MONTO MINIMO A PAGAR')
  st.prepaymentCost = first('COSTO MONETARIO PREPAGO')
  st.automaticCharge = first('CARGO AUTOMATICO')
  ;[st.nextPeriodFrom = '', st.nextPeriodTo = ''] = dates(labelValues(rows, 'PROXIMO PERIODO FACTURACION'))
  st.lateInterestRate = first('INTERES MORATORIO', percents)

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

export const itauWebCardStatement: StatementParser = {
  label: 'Estado de cuenta tarjeta de crédito Itaú (descargado de la web)',

  matches(text) {
    const t = norm(text)
    // Not the CMF standard's "… DE TARJETA DE CRÉDITO" title (the emailed PDF).
    return /ESTADO DE CUENTA (NACIONAL|INTERNACIONAL)(?! DE TARJETA)/.test(t) && t.includes('BANCO ITAU') && t.includes('CODIGO REFERENCIA')
  },

  parse(runs: readonly TextRun[]): ParsedStatement {
    const rows = groupRows(runs)
    const title = rows.map((r) => TITLE.exec(norm(r.runs[0]?.str ?? ''))).find(Boolean)
    if (title?.[1] === 'INTERNACIONAL') {
      throw new StatementFormatError(
        'El estado internacional descargado de la web aún no se admite: importa el PDF que llega por correo, que trae ambos.',
      )
    }
    const warnings: string[] = []
    const st = readStatement(rows, warnings)
    return { kind: 'cardStatements', statements: [st], notes: [summarize(st)], warnings }
  },
}
