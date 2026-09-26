// Mirror of backend/finance/reconciliation_test.go: same history, same numbers.
import { beforeEach, describe, expect, it } from 'vitest'
import { createTestDb } from '@/engine/testing/db'
import { createFinanceService } from '@/engine/finance/service'
import { createSession } from '@/engine/users/service'
import { addMonths, currentPeriod } from '@/engine/finance/period'
import type { FinanceServiceContract, MonthlySummary } from '@/services/contract'

let finance: FinanceServiceContract

beforeEach(async () => {
  const db = await createTestDb()
  finance = createFinanceService(db, createSession(db))
})

function ok<T extends { error?: unknown }>(r: T): T {
  expect(r.error).toBeUndefined()
  return r
}

async function monthly(period: string): Promise<MonthlySummary> {
  return ok(await finance.MonthlySummary(period)).data!
}

// Nov 2025 – Feb 2026:
//   Nov: fixed −10.000, ahorro −20.000                     → −30.000
//   Dec: fixed −10.000                                    → −10.000
//   Jan: sueldo 1.000.000, gasto 300.000, fixed 10.000    → +690.000
//   Feb: sueldo 1.000.000, gasto 200.000, fixed 10.000, ahorro 50.000
async function seedHistory() {
  ok(await finance.CreateFixedExpense('Luz', 'Hogar', null, '2025-11', '10000'))
  const goal = ok(await finance.CreateSavingsGoal('Viaje', '1000000', '')).data!
  ok(await finance.AddSavingsContribution(goal.id, '2025-11', '20000'))
  ok(await finance.AddSavingsContribution(goal.id, '2026-02', '50000'))
  ok(await finance.SetSalary('2026-01', '1000000'))
  ok(await finance.SetSalary('2026-02', '1000000'))
  ok(await finance.CreateExpense('2026-01-10', 'Super', 'Comida', '', null, 'unico', '300000', 1))
  ok(await finance.CreateExpense('2026-02-10', 'Super', 'Comida', '', null, 'unico', '200000', 1))
}

describe('conciliación', () => {
  it('reinicia el saldo arrastrado desde el cierre real', async () => {
    await seedHistory()

    let feb = await monthly('2026-02')
    expect([feb.acumulado, feb.acumuladoDesde, feb.conciliacion]).toEqual(['650000', '', null])

    ok(await finance.SetReconciliation('2025-12', '100000'))
    let jan = await monthly('2026-01')
    expect([jan.acumulado, jan.acumuladoDesde, jan.balance]).toEqual(['100000', '2025-12', '790000'])

    ok(await finance.SetReconciliation('2026-01', '740000'))
    jan = await monthly('2026-01')
    expect(jan.conciliacion).toEqual({ saldoReal: '740000', calculado: '790000', diferencia: '-50000' })
    feb = await monthly('2026-02')
    expect([feb.acumulado, feb.acumuladoDesde, feb.balance]).toEqual(['740000', '2026-01', '1480000'])

    const year = ok(await finance.YearSummary(2026)).data!
    expect(year.months.slice(0, 2).map((m) => [m.saldo, m.conciliado])).toEqual([
      ['740000', true],
      ['1480000', false],
    ])

    const fc = ok(await finance.CommitmentsForecast('2026-01', 2)).data!
    expect(fc.map((m) => m.saldoProyectado)).toEqual(['740000', '1480000'])

    ok(await finance.SetReconciliation('2026-01', '-20000'))
    expect((await monthly('2026-02')).acumulado).toBe('-20000')
    ok(await finance.DeleteReconciliation('2026-01'))
    feb = await monthly('2026-02')
    expect([feb.acumulado, feb.acumuladoDesde]).toEqual(['790000', '2025-12'])
  })

  it('valida mes y monto', async () => {
    for (const [period, amount] of [
      [addMonths(currentPeriod(), 1), '1000'],
      ['2026-13', '1000'],
      ['1999-12', '1000'],
      ['2026-01', 'mucho'],
    ] as const) {
      expect((await finance.SetReconciliation(period, amount)).error?.code).toBe('VALIDATION_ERROR')
    }
    expect((await finance.DeleteReconciliation('2026-01')).error?.code).toBe('NOT_FOUND')
    ok(await finance.SetReconciliation(currentPeriod(), '0'))
  })
})
