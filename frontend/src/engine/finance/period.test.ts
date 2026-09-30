// Ports the exact cases from backend/finance/period_test.go.
import { describe, expect, it } from 'vitest'
import { addMonths, monthsBetween, periodOf, validPeriod } from '@/engine/finance/period'

const d = (year: number, month: number, day: number) => ({ year, month, day })

describe('monthsBetween', () => {
  it.each([
    ['mismo mes', '2026-05', '2026-05', 0],
    ['dentro del año', '2026-01', '2026-12', 11],
    ['cruce de año', '2026-11', '2027-02', 3],
    ['hacia atrás es negativo', '2027-02', '2026-11', -3],
    ['período inválido cuenta 0', '2026-13', '2026-01', 0],
  ])('%s', (_name, a, b, want) => {
    expect(monthsBetween(a, b)).toBe(want)
  })
})

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
  it.each([
    ['corte 31: el 30 queda en el mes', d(2026, 1, 30), 31, '2026-01'],
    ['corte 31: el 31 rueda', d(2026, 1, 31), 31, '2026-02'],
    ['corte 30 en febrero cae el último día', d(2026, 2, 28), 30, '2026-03'],
    ['corte 30 en febrero: el 27 queda en el mes', d(2026, 2, 27), 30, '2026-02'],
    ['corte 29 en febrero bisiesto cae el 29', d(2028, 2, 28), 29, '2028-02'],
    ['corte 31 en abril cae el 30', d(2026, 4, 30), 31, '2026-05'],
  ])('%s', (_name, date, day, want) => {
    expect(periodOf(date, day)).toBe(want)
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
