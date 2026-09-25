// Builds the export tables from the data the views already show, so what gets
// exported is exactly what the user sees. Money cells keep the backend's
// decimal strings (never JS numbers); the writer (xlsx on desktop, CSV on web)
// decides how to render them.
import type {
  ExpenseHit,
  ExportTable,
  MonthlySummary,
  YearSummary,
} from '@/services/contract'
import { monthLabel, periodLabel } from '@/lib/format'

const SOURCE_FIJO = 'fijo'

export function monthTable(s: MonthlySummary): ExportTable {
  return {
    sheet: periodLabel(s.period),
    columns: [
      { title: 'Fecha', kind: 'text' },
      { title: 'Descripción', kind: 'text' },
      { title: 'Categoría', kind: 'text' },
      { title: 'Comercio', kind: 'text' },
      { title: 'Tarjeta', kind: 'text' },
      { title: 'Cuota', kind: 'text' },
      { title: 'Estado', kind: 'text' },
      { title: 'Monto', kind: 'money' },
    ],
    rows: s.movimientos.map((m) => [
      m.date ? m.date.slice(0, 10) : '',
      m.description,
      m.category,
      m.merchant,
      m.cardName,
      m.source === SOURCE_FIJO ? 'Fijo' : m.total > 1 ? `${m.number}/${m.total}` : 'Único',
      m.status,
      m.amount,
    ]),
  }
}

export function yearTable(y: YearSummary): ExportTable {
  return {
    sheet: `Año ${y.year}`,
    columns: [
      { title: 'Mes', kind: 'text' },
      { title: 'Ingresos', kind: 'money' },
      { title: 'Gastos', kind: 'money' },
      { title: 'Ahorro', kind: 'money' },
      { title: 'Balance', kind: 'money' },
      { title: 'Saldo acumulado', kind: 'money' },
    ],
    rows: [
      ...y.months.map((m) => [monthLabel(m.period), m.ingresos, m.gastos, m.ahorro, m.balance, m.saldo]),
      ['Total', y.totalIngresos, y.totalGastos, y.totalAhorro, y.totalBalance, ''],
    ],
  }
}

export function searchTable(items: ExpenseHit[]): ExportTable {
  return {
    sheet: 'Búsqueda',
    columns: [
      { title: 'Fecha', kind: 'text' },
      { title: 'Descripción', kind: 'text' },
      { title: 'Comercio', kind: 'text' },
      { title: 'Categoría', kind: 'text' },
      { title: 'Tarjeta', kind: 'text' },
      { title: 'Cuotas', kind: 'int' },
      { title: 'Pagadas', kind: 'int' },
      { title: 'Monto cuota', kind: 'money' },
      { title: 'Total', kind: 'money' },
      { title: 'Desde', kind: 'text' },
      { title: 'Hasta', kind: 'text' },
    ],
    rows: items.map((h) => [
      h.expense.date.slice(0, 10),
      h.expense.description,
      h.expense.merchant,
      h.expense.category,
      h.cardName,
      String(h.expense.installmentsTotal),
      String(h.paidCount),
      h.expense.installmentAmount,
      h.total,
      h.firstPeriod,
      h.lastPeriod,
    ]),
  }
}

// toCsv renders a table as CSV for spreadsheets set to a Spanish locale: ';'
// separator (',' is their decimal mark), CRLF, UTF-8 BOM so accents survive
// Excel, and RFC 4180 quoting. Money stays a plain decimal string.
export function toCsv(t: ExportTable): string {
  const quote = (v: string) => (/[";\r\n\t]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v)
  const cell = (v: string) => quote(neutralizeFormula(v))
  const lines = [t.columns.map((c) => cell(c.title)), ...t.rows.map((r) => r.map(cell))]
  return '﻿' + lines.map((l) => l.join(';')).join('\r\n') + '\r\n'
}

// Characters that make a spreadsheet read a cell as a formula (OWASP CSV
// Injection), including their full-width forms. Bank descriptors are
// third-party text, so a merchant named "=HYPERLINK(…)" must stay text.
const FORMULA_START = /^[=+\-@\t\r\n＝＋－＠]/
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/

// neutralizeFormula prefixes a formula-looking cell with a quote, as OWASP
// recommends; plain numbers (money, including negatives) stay numeric.
export function neutralizeFormula(v: string): string {
  return FORMULA_START.test(v) && !PLAIN_NUMBER.test(v) ? `'${v}` : v
}

// exportBasename builds a filesystem-friendly name: "app-finance-mes-2026-09".
export function exportBasename(kind: string, suffix: string): string {
  return `app-finance-${kind}-${suffix}`.replace(/[^\w.-]+/g, '-')
}
