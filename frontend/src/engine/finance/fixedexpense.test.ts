import { describe, expect, it } from 'vitest'
import { activeIn, resolveFixedAmount } from '@/engine/finance/fixedexpense'
import type { FixedExpenseAmountRow } from '@/engine/finance/models'

const amounts: FixedExpenseAmountRow[] = [
  // Deliberately out of order: resolveFixedAmount must not assume sorting.
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
