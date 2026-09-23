import { describe, expect, it } from 'vitest'
import { Money } from '@/engine/decimal'
import { activeIn, resolveAsOf as resolveFixedAmount, sumAsOf } from '@/engine/finance/fixedexpense'
import { addMonths } from '@/engine/finance/period'
import type { FixedExpenseAmountRow } from '@/engine/finance/models'

const amounts: FixedExpenseAmountRow[] = [
  // Deliberately out of order: resolveAsOf must not assume sorting.
  { fixedExpenseId: 1, effectiveFrom: '2026-05', amount: '12000' },
  { fixedExpenseId: 1, effectiveFrom: '2026-01', amount: '10000' },
  { fixedExpenseId: 1, effectiveFrom: '2026-09', amount: '15000' },
]

describe('resolveFixedAmount', () => {
  it('toma el mayor effective_from <= period', () => {
    expect(resolveFixedAmount(amounts, '2026-04').toString()).toBe('10000')
    expect(resolveFixedAmount(amounts, '2026-05').toString()).toBe('12000')
    expect(resolveFixedAmount(amounts, '2026-08').toString()).toBe('12000')
    expect(resolveFixedAmount(amounts, '2027-01').toString()).toBe('15000')
  })
  it('borde exacto: effective_from == period aplica', () => {
    expect(resolveFixedAmount(amounts, '2026-09').toString()).toBe('15000')
  })
  it('sin entrada aplicable aún devuelve cero', () => {
    expect(resolveFixedAmount(amounts, '2025-12').toString()).toBe('0')
    expect(resolveFixedAmount([], '2026-01').toString()).toBe('0')
  })
})

// The original month-by-month walk, kept as the oracle sumAsOf must match
// (mirror of TestSumAsOfMatchesMonthByMonth in Go).
function sumMonthByMonth(from: string, to: string): Money {
  let total = Money.zero()
  for (let m = from; m <= to; m = addMonths(m, 1)) total = total.add(resolveFixedAmount(amounts, m))
  return total
}

describe('sumAsOf', () => {
  it.each([
    ['rango completo con tres tramos', '2026-01', '2027-03'],
    ['empieza antes del primer monto (meses en cero)', '2025-06', '2026-02'],
    ['un solo mes', '2026-05', '2026-05'],
    ['termina justo antes de un cambio', '2026-02', '2026-08'],
    ['rango vacío (from > to)', '2026-05', '2026-04'],
  ])('%s', (_name, from, to) => {
    expect(sumAsOf(amounts, from, to).toString()).toBe(sumMonthByMonth(from, to).toString())
  })
})

describe('activeIn', () => {
  it('antes del inicio no factura', () => {
    expect(activeIn({ startPeriod: '2026-03', endPeriod: '' }, '2026-02')).toBe(false)
  })
  it('activo para siempre cuando endPeriod es vacío', () => {
    expect(activeIn({ startPeriod: '2026-03', endPeriod: '' }, '2030-01')).toBe(true)
  })
  it('después del fin no factura; el mes final sí', () => {
    const fe = { startPeriod: '2026-03', endPeriod: '2026-06' }
    expect(activeIn(fe, '2026-06')).toBe(true)
    expect(activeIn(fe, '2026-07')).toBe(false)
  })
})
