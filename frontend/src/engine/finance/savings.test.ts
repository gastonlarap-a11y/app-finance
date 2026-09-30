// Mirror of backend/finance/savings_withdraw_test.go and savings_account_test.go: same numbers.
import { beforeEach, describe, expect, it } from 'vitest'
import { createTestDb } from '@/engine/testing/db'
import { createFinanceService } from '@/engine/finance/service'
import { createSession } from '@/engine/users/service'
import { currentPeriod } from '@/engine/finance/period'
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

describe('retiros de ahorro en el tiempo', () => {
  it('no retiran antes de los aportes ni dejan un mes posterior bajo cero', async () => {
    const id = ok(await finance.CreateSavingsGoal('Viaje', '500000', '')).data!.id
    ok(await finance.AddSavingsContribution(id, '2026-03', '200000'))
    expect((await finance.WithdrawSavings(id, '2026-01', '1000')).error?.code).toBe('VALIDATION_ERROR')
    ok(await finance.WithdrawSavings(id, '2026-04', '150000'))
    expect((await finance.WithdrawSavings(id, '2026-03', '100000')).error?.code).toBe('VALIDATION_ERROR')
    ok(await finance.WithdrawSavings(id, '2026-03', '50000'))
  })
})

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

// Mirror of backend/finance/savings_account_test.go: a goal that follows a
// savings account holds its balance, and the transfers into it are the Ahorro.
describe('meta que sigue una cuenta de ahorro', () => {
  it('lo transferido a la cuenta es el Ahorro del mes, en todas las vistas', async () => {
    const itau = ok(await finance.CreateAccount('Itaú', 'corriente', '1000000', '2026-09', false)).data!
    const ahorro = ok(await finance.CreateAccount('Cuenta de ahorro', 'ahorro', '2000000', '2026-09', false)).data!
    ok(await finance.CreateTransfer(itau.id, ahorro.id, 'Ahorro mensual', 'fixed', '150000', '2026-09', true))
    for (const p of ['2026-09', '2026-10']) ok(await finance.SetSalary(p, '1500000'))
    const goal = ok(await finance.CreateSavingsGoal('Fondo de emergencia', '5000000', '')).data!
    expect(ok(await finance.MonthlySummary('2026-09')).data!.ahorro).toBe('0')

    ok(await finance.SetSavingsGoalAccount(goal.id, ahorro.id))
    const sep = ok(await finance.MonthlySummary('2026-09')).data!
    expect([sep.ahorro, sep.balance]).toEqual(['150000', '1350000'])
    expect(ok(await finance.MonthlySummary('2026-10')).data!.acumulado).toBe('1350000')
    expect(ok(await finance.YearSummary(2026)).data!.totalAhorro).toBe('600000')
    expect(ok(await finance.CommitmentsForecast('2026-11', 2)).data![1]!.ahorro).toBe('150000')
    const itauOct = ok(await finance.ListAccounts('2026-10')).data!.accounts.find((a) => a.name === 'Itaú')!
    expect(itauOct.balance).toBe('700000')

    ok(await finance.CreateTransfer(ahorro.id, itau.id, 'Imprevisto', 'fixed', '100000', '2026-10', false))
    expect(ok(await finance.MonthlySummary('2026-10')).data!.ahorro).toBe('50000')

    expect((await finance.AddSavingsContribution(goal.id, '2026-10', '1000')).error?.code).toBe('VALIDATION_ERROR')
    expect((await finance.WithdrawSavings(goal.id, '2026-10', '1000')).error?.code).toBe('VALIDATION_ERROR')

    ok(await finance.DeleteSavingsGoal(goal.id))
    expect(ok(await finance.MonthlySummary('2026-09')).data!.ahorro).toBe('0')
    const other = ok(await finance.CreateSavingsGoal('Viaje', '1000000', '')).data!
    ok(await finance.SetSavingsGoalAccount(other.id, ahorro.id))
    expect((await finance.RestoreSavingsGoal(goal.id)).error?.code).toBe('CONFLICT')

    ok(await finance.SetSavingsGoalAccount(other.id, null))
    expect(ok(await finance.MonthlySummary('2026-09')).data!.ahorro).toBe('0')
    ok(await finance.RestoreSavingsGoal(goal.id))
    expect(ok(await finance.MonthlySummary('2026-09')).data!.ahorro).toBe('150000')
  })

  it('lo ahorrado es el saldo de la cuenta este mes', async () => {
    const now = currentPeriod()
    const itau = ok(await finance.CreateAccount('Itaú', 'corriente', '1000000', now, false)).data!
    const ahorro = ok(await finance.CreateAccount('Cuenta de ahorro', 'ahorro', '2000000', now, false)).data!
    ok(await finance.CreateTransfer(itau.id, ahorro.id, 'Ahorro mensual', 'fixed', '150000', now, true))
    const goal = ok(await finance.CreateSavingsGoal('Fondo de emergencia', '5000000', '')).data!
    ok(await finance.SetSavingsGoalAccount(goal.id, ahorro.id))
    expect(await finance.ListSavingsGoals()).toMatchObject([{ saved: '2150000', remaining: '2850000', accountId: ahorro.id }])
  })

  it('valida la cuenta y la meta', async () => {
    const acc = ok(await finance.CreateAccount('Ahorro', 'ahorro', '0', '2026-09', false)).data!
    const byHand = ok(await finance.CreateSavingsGoal('Auto', '3000000', '')).data!
    ok(await finance.AddSavingsContribution(byHand.id, '2026-09', '50000'))
    const linked = ok(await finance.CreateSavingsGoal('Casa', '9000000', '')).data!
    ok(await finance.SetSavingsGoalAccount(linked.id, acc.id))
    const fresh = ok(await finance.CreateSavingsGoal('Viaje', '1000000', '')).data!

    expect((await finance.SetSavingsGoalAccount(byHand.id, acc.id)).error?.code).toBe('CONFLICT')
    expect((await finance.SetSavingsGoalAccount(fresh.id, acc.id)).error?.code).toBe('CONFLICT')
    expect((await finance.SetSavingsGoalAccount(linked.id, 999)).error?.code).toBe('NOT_FOUND')
    expect((await finance.SetSavingsGoalAccount(999, acc.id)).error?.code).toBe('NOT_FOUND')
  })
})
