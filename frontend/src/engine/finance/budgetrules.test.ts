// Mirror of backend/finance/budget_rules_test.go: the reserved «Sin categoría»,
// a $0 cap versus no cap, and the carry-over of unspent budget.
import { beforeEach, describe, expect, it } from 'vitest'
import { createTestDb } from '@/engine/testing/db'
import { createFinanceService } from '@/engine/finance/service'
import { createSession } from '@/engine/users/service'
import type { BudgetStatus, FinanceServiceContract } from '@/services/contract'

let finance: FinanceServiceContract

beforeEach(async () => {
  const db = await createTestDb()
  finance = createFinanceService(db, createSession(db))
})

async function budgetOf(period: string): Promise<BudgetStatus> {
  const p = (await finance.MonthlySummary(period)).data!.presupuestos
  expect(p).toHaveLength(1)
  return p[0]!
}

async function category(name: string): Promise<number> {
  const r = await finance.CreateCategory(name)
  expect(r.error).toBeUndefined()
  return r.data!.id
}

describe('reglas de presupuesto', () => {
  it('«Sin categoría» está reservado', async () => {
    for (const name of ['Sin categoría', '  sin CATEGORÍA ']) {
      expect((await finance.CreateCategory(name)).error?.code).toBe('VALIDATION_ERROR')
    }
    const id = await category('Comida')
    expect((await finance.UpdateCategory(id, 'Sin categoría')).error?.code).toBe('VALIDATION_ERROR')
  })

  it('un tope de $0 es un tope, no su ausencia', async () => {
    const id = await category('Delivery')
    expect((await finance.SetCategoryBudget(id, '2030-01', '0')).error).toBeUndefined()
    expect(await budgetOf('2030-01')).toMatchObject({ over: false, budget: '0' })
    await finance.CreateExpense('2030-02-03', 'Pizza', 'Delivery', '', null, 'unico', '9990', 1)
    expect(await budgetOf('2030-02')).toMatchObject({ over: true, remaining: '-9990' })
    expect((await finance.RemoveCategoryBudget(id, '2030-03')).error).toBeUndefined()
    expect((await finance.ListCategoryBudgets('2030-03')).data).toEqual([])
    expect((await finance.ListCategoryBudgets('2030-02')).data).toHaveLength(1)
  })

  it('el traspaso lleva lo no gastado al mes siguiente', async () => {
    const id = await category('Comida')
    await finance.SetCategoryBudget(id, '2030-01', '100000')
    await finance.CreateExpense('2030-01-10', 'Super', 'Comida', '', null, 'unico', '70000', 1)
    await finance.CreateExpense('2030-02-10', 'Super', 'Comida', '', null, 'unico', '150000', 1)

    expect(await budgetOf('2030-02')).toMatchObject({ carried: '0', over: true })
    expect((await finance.SetCategoryRollover(id, true)).error).toBeUndefined()
    expect(await budgetOf('2030-02')).toMatchObject({ carried: '30000', remaining: '-20000', over: true })
    expect(await budgetOf('2030-03')).toMatchObject({ carried: '0', remaining: '100000' })
    expect(await budgetOf('2030-05')).toMatchObject({ carried: '200000' })
    await finance.RemoveCategoryBudget(id, '2030-06')
    await finance.SetCategoryBudget(id, '2030-07', '100000')
    expect(await budgetOf('2030-07')).toMatchObject({ carried: '0' })
    expect((await finance.SetCategoryRollover(999, true)).error?.code).toBe('NOT_FOUND')
  })
})
