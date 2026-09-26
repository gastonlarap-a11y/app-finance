// Mirror of backend/finance/budget_alert_test.go.
import { describe, expect, it } from 'vitest'
import { createTestDb } from '@/engine/testing/db'
import { createFinanceService } from '@/engine/finance/service'
import { createSession } from '@/engine/users/service'

describe('alerta de presupuesto', () => {
  for (const [spent, near, over] of [
    ['79999', false, false],
    ['80000', true, false],
    ['100000', true, false],
    ['100001', false, true],
  ] as const) {
    it(`gastado ${spent} de 100.000`, async () => {
      const db = await createTestDb()
      const finance = createFinanceService(db, createSession(db))
      const cat = (await finance.CreateCategory('Comida')).data!
      expect((await finance.SetCategoryBudget(cat.id, '2026-01', '100000')).error).toBeUndefined()
      expect((await finance.CreateExpense('2026-01-10', 'Super', 'Comida', '', null, 'unico', spent, 1)).error).toBeUndefined()
      const b = (await finance.MonthlySummary('2026-01')).data!.presupuestos
      expect(b.map((x) => [x.near, x.over])).toEqual([[near, over]])
    })
  }
})
