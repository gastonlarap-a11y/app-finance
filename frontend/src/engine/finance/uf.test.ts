// Mirror of backend/finance/uf_test.go: schedules and UF, same numbers.
import { beforeEach, describe, expect, it } from 'vitest'
import { createTestDb } from '@/engine/testing/db'
import { createFinanceService } from '@/engine/finance/service'
import { createSession } from '@/engine/users/service'
import { nextBilling } from '@/engine/finance/fixedexpense'
import type { FinanceServiceContract, Movimiento } from '@/services/contract'

let finance: FinanceServiceContract

beforeEach(async () => {
  const db = await createTestDb()
  finance = createFinanceService(db, createSession(db))
})

function ok<T extends { error?: unknown }>(r: T): T {
  expect(r.error).toBeUndefined()
  return r
}

async function fixedIn(period: string, id: number): Promise<Movimiento | undefined> {
  return ok(await finance.MonthlySummary(period)).data!.movimientos.find((m) => m.fixedId === id)
}

describe('gasto fijo trimestral', () => {
  it('cobra sólo en los meses de su calendario', async () => {
    const id = ok(await finance.CreateFixedExpense('Seguro auto', 'Auto', null, '2026-01', '90000', 3, 'CLP')).data!.id
    for (const [period, bills] of [
      ['2026-01', true],
      ['2026-02', false],
      ['2026-03', false],
      ['2026-04', true],
      ['2026-07', true],
    ] as const) {
      const mv = await fixedIn(period, id)
      expect(mv !== undefined).toBe(bills)
      if (mv) expect(mv.amount).toBe('90000')
    }
    const year = ok(await finance.YearSummary(2026)).data!
    expect([year.totalGastos, year.months[1]!.gastos]).toEqual(['360000', '0'])
    expect(ok(await finance.MonthlySummary('2027-01')).data!.acumulado).toBe('-360000')
    const fc = ok(await finance.CommitmentsForecast('2026-03', 2)).data!
    expect(fc.map((m) => m.fijos)).toEqual(['0', '90000'])
    expect((await finance.SetFixedExpensePaid(id, '2026-02', true)).error?.code).toBe('VALIDATION_ERROR')
    ok(await finance.SetFixedExpensePaid(id, '2026-04', true))
  })

  it('nextBilling', () => {
    const yearly = { startPeriod: '2026-03', endPeriod: '', intervalMonths: 12 }
    const quarterly = { startPeriod: '2026-01', endPeriod: '2026-06', intervalMonths: 3 }
    expect(nextBilling(yearly, '2025-01')).toBe('2026-03')
    expect(nextBilling(yearly, '2027-03')).toBe('2027-03')
    expect(nextBilling(yearly, '2026-04')).toBe('2027-03')
    expect(nextBilling(quarterly, '2026-02')).toBe('2026-04')
    expect(nextBilling(quarterly, '2026-05')).toBe('')
  })
})

describe('gasto fijo en UF', () => {
  it('convierte con el valor de la UF del mes', async () => {
    const id = ok(await finance.CreateFixedExpense('Arriendo', 'Hogar', null, '2026-01', '12.5', 1, 'UF')).data!.id
    let mv = await fixedIn('2026-01', id)
    expect([mv?.amount, mv?.estimado]).toEqual(['0', true])

    ok(
      await finance.SetUFValues([
        { period: '2026-01', value: '39000.04' },
        { period: '2026-02', value: '39100.50' },
      ]),
    )
    for (const [period, amount, estimado] of [
      ['2026-01', '487501', false],
      ['2026-02', '488756', false],
      ['2026-03', '488756', true],
    ] as const) {
      mv = await fixedIn(period, id)
      expect([mv?.amount, mv?.ufAmount, mv?.estimado]).toEqual([amount, '12.5', estimado])
    }
    expect(ok(await finance.MonthlySummary('2026-04')).data!.acumulado).toBe('-1465013')

    ok(await finance.SetUFValues([{ period: '2026-01', value: '40000' }]))
    expect((await fixedIn('2026-01', id))?.amount).toBe('500000')

    const list = await finance.ListFixedExpenses()
    expect(list.map((f) => [f.currency, f.currentAmount])).toEqual([['UF', '12.5']])
  })

  it('UFMonthsNeeded', async () => {
    ok(await finance.CreateFixedExpense('Luz', '', null, '2026-01', '1000', 1, 'CLP'))
    const id = ok(await finance.CreateFixedExpense('Dividendo', '', null, '2026-01', '20', 2, 'UF')).data!.id
    ok(await finance.EndFixedExpense(id, '2026-07'))
    ok(await finance.SetUFValues([{ period: '2026-03', value: '39000' }]))
    expect(await finance.UFMonthsNeeded()).toEqual(['2026-01', '2026-05'])
  })

  it('valida frecuencia, moneda y valores UF', async () => {
    for (const [interval, currency] of [
      [5, 'CLP'],
      [0, 'CLP'],
      [1, 'USD'],
    ] as const) {
      expect((await finance.CreateFixedExpense('x', '', null, '2026-01', '1', interval, currency)).error?.code).toBe('VALIDATION_ERROR')
    }
    for (const v of [
      { period: '2026-13', value: '1' },
      { period: '2026-01', value: '0' },
      { period: '2026-01', value: '-5' },
      { period: '2026-01', value: 'mucho' },
    ]) {
      expect((await finance.SetUFValues([v])).error?.code).toBe('VALIDATION_ERROR')
    }
  })
})
