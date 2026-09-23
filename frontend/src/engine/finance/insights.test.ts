// Mirror of backend/finance/insights_test.go (savings, trend, recurring) and the
// savings cross-user checks in backend/users/isolation_test.go.
import { beforeEach, describe, expect, it } from 'vitest'
import { createTestDb } from '@/engine/testing/db'
import { createFinanceService } from '@/engine/finance/service'
import { createSession, createUsersService } from '@/engine/users/service'
import { currentPeriod, monthsBetween } from '@/engine/finance/period'
import { Money } from '@/engine/decimal'
import type { FinanceServiceContract, UsersServiceContract } from '@/services/contract'

let finance: FinanceServiceContract
let users: UsersServiceContract

beforeEach(async () => {
  const db = await createTestDb()
  const session = createSession(db)
  finance = createFinanceService(db, session)
  users = createUsersService(db, session)
})

function ok<T extends { error?: unknown }>(r: T): T {
  expect(r.error).toBeUndefined()
  return r
}

describe('metas de ahorro', () => {
  it('los aportes salen del mes y del arrastre, aparte de los gastos', async () => {
    ok(await finance.SetSalary('2030-01', '1000000'))
    ok(await finance.SetSalary('2030-02', '1000000'))
    ok(await finance.CreateExpense('2030-01-05', 'Super', 'Comida', '', null, 'unico', '200000', 1))
    const goal = ok(await finance.CreateSavingsGoal('Vacaciones', '1200000', '2030-12')).data!
    ok(await finance.AddSavingsContribution(goal.id, '2030-01', '100000'))

    const jan = ok(await finance.MonthlySummary('2030-01')).data!
    expect(jan).toMatchObject({ ahorro: '100000', balance: '700000', alcanza: true, gastos: '200000' })
    expect(ok(await finance.MonthlySummary('2030-02')).data?.acumulado).toBe('700000')

    const [view] = await finance.ListSavingsGoals()
    const monthsLeft = monthsBetween(currentPeriod(), '2030-12') + 1
    expect(view).toMatchObject({ saved: '100000', remaining: '1100000', monthsLeft })
    expect(view?.monthlyNeeded).toBe(Money.fromString('1100000').divCeil(monthsLeft).toString())

    const year = ok(await finance.YearSummary(2030)).data!
    expect(year.totalAhorro).toBe('100000')
    expect(year.months[0]?.balance).toBe('700000')
    const [fc] = ok(await finance.CommitmentsForecast('2030-01', 1)).data!
    expect(fc).toMatchObject({ ahorro: '100000', libre: '700000' })

    ok(await finance.DeleteSavingsGoal(goal.id))
    expect((await finance.AddSavingsContribution(goal.id, '2030-02', '1')).error?.code).toBe('NOT_FOUND')
    expect(ok(await finance.MonthlySummary('2030-02')).data?.acumulado).toBe('800000')
    expect(ok(await finance.ListTrash()).data?.some((t) => t.type === 'savingsgoal' && t.id === goal.id)).toBe(true)
    ok(await finance.RestoreSavingsGoal(goal.id))
    expect(ok(await finance.MonthlySummary('2030-02')).data?.acumulado).toBe('700000')
  })

  it('valida metas y aportes', async () => {
    for (const [name, target, period] of [
      [' ', '1000', ''],
      ['Auto', '0', ''],
      ['Auto', '-5', ''],
      ['Auto', '1000', '2030-13'],
    ] as const) {
      expect((await finance.CreateSavingsGoal(name, target, period)).error?.code).toBe('VALIDATION_ERROR')
    }
    const g = ok(await finance.CreateSavingsGoal('Auto', '1000', '')).data!
    expect((await finance.AddSavingsContribution(g.id, '2030-01', '0')).error).toBeTruthy()
    const c = ok(await finance.AddSavingsContribution(g.id, '2030-01', '300')).data!
    ok(await finance.DeleteSavingsContribution(c.id))
    expect((await finance.DeleteSavingsContribution(c.id)).error?.code).toBe('NOT_FOUND')
  })
})

describe('tendencia de gasto', () => {
  it('compara con el mes anterior y el promedio, total y por categoría', async () => {
    for (const [date, cat, amount] of [
      ['2030-01-05', 'Comida', '100'],
      ['2030-02-05', 'Comida', '200'],
      ['2030-03-05', 'Comida', '300'],
      ['2030-03-06', 'Ropa', '50'],
    ] as const) {
      ok(await finance.CreateExpense(date, 'x', cat, '', null, 'unico', amount, 1))
    }
    ok(await finance.CreateFixedExpense('Luz', 'Servicios', null, '2030-02', '10'))

    const tr = ok(await finance.SpendingTrend('2030-03', 3)).data!
    expect(tr.months.map((m) => `${m.period}=${m.gastos}`)).toEqual(['2030-01=100', '2030-02=210', '2030-03=360'])
    expect(tr).toMatchObject({ current: '360', previous: '210', average: '155' })
    expect(tr.categories.map((c) => `${c.category}:${c.current}/${c.previous}/${c.average}`)).toEqual([
      'Comida:300/200/150',
      'Ropa:50/0/0',
      'Servicios:10/10/5',
    ])
    expect((await finance.SpendingTrend('2030-03', 1)).error).toBeTruthy()
    expect((await finance.SpendingTrend('2030-03', 25)).error).toBeTruthy()
  })
})

describe('detección de recurrentes', () => {
  it('sugiere únicos repetidos con monto parecido que aún no son fijos', async () => {
    const add = async (date: string, desc: string, merchant: string, kind: string, amount: string, n: number) =>
      ok(await finance.CreateExpense(date, desc, 'Servicios', merchant, null, kind, amount, n))
    for (const m of ['01', '02', '03', '04']) await add(`2030-${m}-10`, 'Spotify', 'Spotify', 'unico', '5990', 1)
    await add('2030-01-11', 'Viaje', 'Uber', 'unico', '3000', 1)
    await add('2030-02-11', 'Viaje', 'Uber', 'unico', '9000', 1)
    await add('2030-03-11', 'Viaje', 'Uber', 'unico', '15000', 1)
    for (const m of ['01', '02', '03']) await add(`2030-${m}-12`, 'Netflix', '', 'unico', '8990', 1)
    ok(await finance.CreateFixedExpense('netflix', 'Servicios', null, '2030-04', '8990'))
    await add('2030-01-13', 'Gimnasio', 'Gym', 'cuotas', '20000', 4)

    const res = ok(await finance.DetectRecurring('2030-04')).data!
    expect(res).toEqual([
      {
        description: 'Spotify',
        merchant: 'Spotify',
        category: 'Servicios',
        cardId: null,
        amount: '5990',
        periods: ['2030-01', '2030-02', '2030-03', '2030-04'],
        nextPeriod: '2030-05',
      },
    ])
  })
})

describe('aislamiento de ahorro y tendencias', () => {
  it('otro perfil no ve ni toca metas ajenas', async () => {
    const goal = ok(await finance.CreateSavingsGoal('Viaje', '500000', '')).data!
    const contrib = ok(await finance.AddSavingsContribution(goal.id, '2030-01', '50000')).data!
    ok(await finance.CreateExpense('2030-01-10', 'Cine', 'Ocio', '', null, 'unico', '10000', 1))

    ok(await users.CreateUser('Camila'))
    expect(await finance.ListSavingsGoals()).toEqual([])
    const tr = ok(await finance.SpendingTrend('2030-01', 3)).data!
    expect(tr.current).toBe('0')
    expect(tr.categories).toEqual([])
    expect((await finance.AddSavingsContribution(goal.id, '2030-01', '1')).error?.code).toBe('NOT_FOUND')
    expect((await finance.DeleteSavingsContribution(contrib.id)).error?.code).toBe('NOT_FOUND')
    expect((await finance.DeleteSavingsGoal(goal.id)).error?.code).toBe('NOT_FOUND')
  })
})
