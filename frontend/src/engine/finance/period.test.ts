// Ports the exact cases from backend/finance/period_test.go.
import { describe, expect, it } from 'vitest'
import { addMonths, periodOf, validPeriod } from '@/engine/finance/period'

const d = (year: number, month: number, day: number) => ({ year, month, day })

describe('periodOf', () => {
  it('compra después del corte rueda al mes siguiente', () => {
    expect(periodOf(d(2026, 6, 26), 24)).toBe('2026-07')
  })
  it('compra antes del corte queda en el mes', () => {
    expect(periodOf(d(2026, 6, 23), 24)).toBe('2026-06')
  })
  it('compra el día del corte rueda al mes siguiente', () => {
    expect(periodOf(d(2026, 6, 24), 24)).toBe('2026-07')
  })
  it('sin tarjeta (billingDay 0) no rueda', () => {
    expect(periodOf(d(2026, 6, 26), 0)).toBe('2026-06')
  })
  it('diciembre rueda a enero del año siguiente', () => {
    expect(periodOf(d(2026, 12, 31), 24)).toBe('2027-01')
  })
})

describe('addMonths', () => {
  it('MacBook: 24 cuotas desde 2026-07 termina en 2028-06', () => {
    const first = periodOf(d(2026, 6, 26), 24)
    expect(first).toBe('2026-07')
    expect(addMonths(first, 23)).toBe('2028-06')
  })
  it('cruce de año', () => {
    expect(addMonths('2026-12', 1)).toBe('2027-01')
  })
  it('meses negativos cruzando año', () => {
    expect(addMonths('2026-01', -1)).toBe('2025-12')
  })
  it('período inválido se devuelve tal cual (paridad con Go)', () => {
    expect(addMonths('garbage', 3)).toBe('garbage')
  })
})

describe('validPeriod', () => {
  it.each(['2026-07', '2026-01', '2026-12'])('acepta %s', (p) => {
    expect(validPeriod(p)).toBe(true)
  })
  it.each(['2026-13', '2026-00', '2026-7', '202607', '2026-07-01', ''])('rechaza %s', (p) => {
    expect(validPeriod(p)).toBe(false)
  })
})
