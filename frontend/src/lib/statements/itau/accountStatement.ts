// Itaú Chile "Estado de Cuenta Personal" (cartola de cuenta corriente). One PDF
// carries one page per product: the USD account, the CLP account and the line
// of credit. Only charges of peso accounts become import candidates; deposits,
// foreign-currency accounts and the credit line are reported as skipped.
import Decimal from 'decimal.js'
import type { ImportCandidate } from '@/services/contract'
import { groupRows, nearestAnchor, rowText, type Anchor, type Row, type TextRun } from '@/lib/statements/layout'
import { isClDate, parseClAmount, parseClDate } from '@/lib/statements/amounts'
import { StatementFormatError, type ParsedStatement, type StatementParser } from '@/lib/statements/types'

const TITLE_ACCOUNT = 'ESTADO DE CUENTA PERSONAL'
const TITLE_CREDIT_LINE = 'ESTADO DE LINEA DE CREDITO'
const PESO = 'PESO'

type Column = 'operacion' | 'sucursal' | 'codigo' | 'cargo' | 'abono' | 'saldo'

// Header labels, matched against runs within HEADER_BAND points of the row
// holding "Fecha … Descripción" (several labels wrap onto two lines).
const HEADER_LABELS: ReadonlyArray<readonly [Column, RegExp]> = [
  ['operacion', /^Operaci[oó]n$/],
  ['sucursal', /^Sucursal$/],
  ['codigo', /^C[oó]digo$/],
  ['cargo', /^Cargos$/],
  ['abono', /^o Abonos$/],
  ['saldo', /^(Saldo Diario|Monto Utilizado)$/],
]
const HEADER_BAND = 15
const REQUIRED: readonly Column[] = ['sucursal', 'codigo', 'cargo', 'abono', 'saldo']

const NUMERIC = /^[\d.,]+$/

// Descriptors that pay a credit card: its purchases are already counted on the
// card, so the inbox warns before the payment is counted as spending (and a
// card statement reconciles it). Transfers to people are ordinary spending.
const CARD_PAYMENT = [/^PAGO DEUDA/, /^PAGO (TARJETA|TC)\b/, /^TRANSFERENCIA A CMR\b/]

export function hintFor(description: string): string {
  return CARD_PAYMENT.some((re) => re.test(description)) ? 'card_payment' : ''
}

interface Movement {
  date: string // YYYY-MM-DD
  operation: string
  description: string
  cargo: string | null
  abono: string | null
  saldo: string | null
}

interface AccountPage {
  account: string
  currency: string
  period: string
  movements: Movement[]
}

function headerAnchors(rows: readonly Row[], headerY: number): Anchor<Column>[] {
  const anchors: Anchor<Column>[] = []
  for (const row of rows) {
    if (Math.abs(row.y - headerY) > HEADER_BAND) continue
    for (const run of row.runs) {
      const label = HEADER_LABELS.find(([, re]) => re.test(run.str.trim()))
      if (label && !anchors.some((a) => a.key === label[0])) anchors.push({ key: label[0], x: run.x + run.width / 2 })
    }
  }
  return anchors
}

function parseMovement(row: Row, anchors: readonly Anchor<Column>[]): Movement | null {
  const [first, ...rest] = row.runs
  const date = first ? parseClDate(first.str) : null
  if (!date) return null
  const mv: Movement = { date, operation: '', description: '', cargo: null, abono: null, saldo: null }
  const text: string[] = []
  for (const run of rest) {
    const s = run.str.trim()
    if (!NUMERIC.test(s)) {
      text.push(s)
      continue
    }
    switch (nearestAnchor(run, anchors)) {
      case 'operacion':
        mv.operation = s
        break
      case 'cargo':
        mv.cargo = parseClAmount(s)
        break
      case 'abono':
        mv.abono = parseClAmount(s)
        break
      case 'saldo':
        mv.saldo = parseClAmount(s)
        break
      default: // sucursal / código: not needed for staging
    }
  }
  mv.description = text.join(' ').replace(/\s+/g, ' ')
  return mv
}

function readPage(rows: readonly Row[], page: number, notes: string[]): AccountPage | null {
  const text = rows.map(rowText).join('\n')
  const account = /N[uú]mero de Cuenta\s*:?\s*(\d+)\s*Moneda\s*:?\s*([A-ZÁÉÍÓÚ]+)/.exec(text)
  const period = /Per[ií]odo\s*:?\s*(\d{2}\/\d{2}\/\d{4}\s*-\s*\d{2}\/\d{2}\/\d{4})/.exec(text)?.[1] ?? ''
  if (text.includes(TITLE_CREDIT_LINE)) {
    notes.push(`Línea de crédito ${account?.[1] ?? ''}: se omite (sus giros financian la cuenta, no son gastos).`)
    return null
  }
  if (!text.includes(TITLE_ACCOUNT) || !account) {
    notes.push(`Página ${page}: no es una cartola de cuenta corriente, se omite.`)
    return null
  }
  const [, number = '', currency = ''] = account
  if (currency !== PESO) {
    notes.push(`Cuenta ${number} en ${currency}: se omite (sólo se importan cuentas en pesos).`)
    return null
  }

  const header = rows.find((r) => /^Fecha\b/.test(rowText(r)) && rowText(r).includes('Descripci'))
  if (!header) throw new StatementFormatError(`Página ${page}: no se encontró la tabla de movimientos (¿cambió el formato?).`)
  const anchors = headerAnchors(rows, header.y)
  const missing = REQUIRED.filter((k) => !anchors.some((a) => a.key === k))
  if (missing.length > 0) {
    throw new StatementFormatError(`Página ${page}: faltan columnas en la tabla de movimientos (${missing.join(', ')}).`)
  }

  const movements: Movement[] = []
  for (const row of rows) {
    if (row.y >= header.y - 1) continue // above or on the header
    if (/^RESUMEN\b/.test(rowText(row))) break
    const first = row.runs[0]
    if (!first || !isClDate(first.str)) continue
    const mv = parseMovement(row, anchors)
    if (mv) movements.push(mv)
  }
  return { account: number, currency, period, movements }
}

// checkBalances replays the movements between two reported daily balances:
// each reported balance must equal the previous one plus deposits minus
// charges. A mismatch means a row was misread (or skipped), so it is surfaced.
function checkBalances(page: AccountPage, warnings: string[]): void {
  let running: Decimal | null = null
  for (const mv of page.movements) {
    if (running !== null) running = running.plus(mv.abono ?? 0).minus(mv.cargo ?? 0)
    if (mv.saldo === null) continue
    const reported = new Decimal(mv.saldo)
    if (running !== null && !running.eq(reported)) {
      warnings.push(
        `Cuenta ${page.account}: el saldo del ${mv.date} no cuadra (calculado ${running.toString()}, informado ${mv.saldo}). Revisa los movimientos importados.`,
      )
    }
    running = reported
  }
}

function toCandidate(page: AccountPage, mv: Movement, cargo: string): ImportCandidate {
  return {
    date: mv.date,
    description: mv.description,
    amount: cargo,
    currency: 'CLP',
    cardLastDigits: '',
    account: page.account,
    reference: mv.operation,
    installmentsTotal: 1,
    hint: hintFor(mv.description),
  }
}

export const itauAccountStatement: StatementParser = {
  label: 'Cartola Itaú (cuenta corriente)',

  // The bank's name is only in the logo (an image), so the format is recognized
  // by its title and the labels of its movements table.
  matches(text) {
    return text.includes(TITLE_ACCOUNT) && /N[uú]mero de Cuenta/.test(text) && text.includes('Saldo Diario')
  },

  parse(runs: readonly TextRun[]): ParsedStatement {
    const notes: string[] = []
    const warnings: string[] = []
    const items: ImportCandidate[] = []
    const pages = [...new Set(runs.map((r) => r.page))].toSorted((a, b) => a - b)
    for (const page of pages) {
      const rows = groupRows(runs.filter((r) => r.page === page))
      const acc = readPage(rows, page, notes)
      if (!acc) continue
      checkBalances(acc, warnings)
      let charges = 0
      let deposits = 0
      for (const mv of acc.movements) {
        if (mv.cargo !== null) {
          items.push(toCandidate(acc, mv, mv.cargo))
          charges++
        } else if (mv.abono !== null) {
          deposits++
        } else {
          warnings.push(`Cuenta ${acc.account}: la fila del ${mv.date} «${mv.description}» no tiene monto legible.`)
        }
      }
      notes.push(
        `Cuenta ${acc.account} (pesos) ${acc.period}: ${charges} cargo${charges === 1 ? '' : 's'} leído${charges === 1 ? '' : 's'}` +
          (deposits > 0 ? `, ${deposits} abono${deposits === 1 ? '' : 's'} no se importa${deposits === 1 ? '' : 'n'}.` : '.'),
      )
    }
    return { kind: 'batch', batch: { source: 'pdf_account', issuer: 'itau', items }, notes, warnings }
  },
}
