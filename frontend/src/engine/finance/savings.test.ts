// Mirror of backend/finance/savings_withdraw_test.go: same numbers.
import { beforeEach, describe, expect, it } from 'vitest'
import { createTestDb } from '@/engine/testing/db'
import { createFinanceService } from '@/engine/finance/service'
import { createSession } from '@/engine/users/service'
import type { FinanceServiceContract } from '@/services/contract'

let finance: FinanceServiceContract

beforeEach(async () => {
  const db = await createTestDb()
  finance = createFinanceService(db, createSession(db))
})

function ok<T extends { error?: unknown }>(r: T): T {
  expect(r.error).toBeUndefined()
  return r
}

describe('retiros de ahorro', () => {
  it('devuelven la plata al mes y al arrastre', async () => {
    const id = ok(await finance.CreateSavingsGoal('Viaje', '500000', '2026-06')).data!.id
    const jan = ok(await finance.AddSavingsContribution(id, '2026-01', '200000')).data!
    ok(await finance.AddSavingsContribution(id, '2026-02', '100000'))

    const w = ok(await finance.WithdrawSavings(id, '2026-03', '150000')).data!
    expect(w.amount).toBe('-150000')
    const mar = ok(await finance.MonthlySummary('2026-03')).data!
    expect([mar.ahorro, mar.balance]).toEqual(['-150000', '-150000'])
    expect(ok(await finance.MonthlySummary('2026-04')).data!.acumulado).toBe('-150000')
    expect(ok(await finance.YearSummary(2026)).data!.totalAhorro).toBe('150000')

    expect((await finance.WithdrawSavings(id, '2026-03', '150001')).error?.code).toBe('VALIDATION_ERROR')
    expect((await finance.WithdrawSavings(id, '2026-03', '0')).error?.code).toBe('VALIDATION_ERROR')
    expect((await finance.ListSavingsGoals())[0]!.saved).toBe('150000')

    expect((await finance.DeleteSavingsContribution(jan.id)).error?.code).toBe('CONFLICT')
    ok(await finance.DeleteSavingsContribution(w.id))
    ok(await finance.DeleteSavingsContribution(jan.id))

    ok(await finance.DeleteSavingsGoal(id))
    expect((await finance.WithdrawSavings(id, '2026-03', '1')).error?.code).toBe('NOT_FOUND')
  })
})

describe('metas vencidas', () => {
  it('marca las que pasaron su mes objetivo sin completarse', async () => {
    const late = ok(await finance.CreateSavingsGoal('Auto', '1000000', '2024-06')).data!.id
    ok(await finance.AddSavingsContribution(late, '2024-01', '100000'))
    const reached = ok(await finance.CreateSavingsGoal('Bici', '100000', '2024-02')).data!.id
    ok(await finance.AddSavingsContribution(reached, '2024-01', '100000'))
    ok(await finance.CreateSavingsGoal('Casa', '1000000', '2098-12'))
    const overdue = Object.fromEntries((await finance.ListSavingsGoals()).map((g) => [g.name, g.overdue]))
    expect(overdue).toEqual({ Auto: true, Bici: false, Casa: false })
  })
})
