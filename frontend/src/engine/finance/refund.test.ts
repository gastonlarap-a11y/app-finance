// Mirror of backend/finance/refund_test.go: same scenarios, same numbers.
import { beforeEach, describe, expect, it } from 'vitest'
import { createTestDb } from '@/engine/testing/db'
import { createFinanceService } from '@/engine/finance/service'
import { createSession } from '@/engine/users/service'
import type { FinanceServiceContract, ImportItemView, MonthlySummary } from '@/services/contract'

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

describe('reembolsos', () => {
  it('rebajan su mes y su categoría', async () => {
    const card = ok(await finance.CreateCard('Visa', '1000000', 25, '')).data!
    const cat = ok(await finance.CreateCategory('Ropa')).data!
    ok(await finance.SetCategoryBudget(cat.id, '2026-01', '50000'))
    const ex = ok(await finance.CreateExpense('2026-01-05', 'Zapatillas', 'Ropa', 'Falabella', card.id, 'unico', '60000', 1)).data!

    ok(await finance.CreateRefund(ex.id, '2026-01', '10000', ''))
    const jan = await monthly('2026-01')
    expect([jan.gastos, jan.pagado]).toEqual(['50000', '-10000'])
    expect(jan.presupuestos.map((b) => [b.spent, b.over])).toEqual([['50000', false]])
    expect(jan.porTarjeta[0]!.gastoMes).toBe('50000')
    const movs = jan.movimientos.filter((m) => m.source === 'reembolso')
    expect(movs.map((m) => [m.description, m.category, m.amount, m.refundId !== null])).toEqual([
      ['Reembolso: Zapatillas', 'Ropa', '-10000', true],
    ])

    ok(await finance.CreateRefund(ex.id, '2026-02', '20000', 'Devolución parcial'))
    expect((await monthly('2026-02')).gastos).toBe('-20000')
    expect((await monthly('2026-03')).acumulado).toBe('-30000')
    expect(ok(await finance.YearSummary(2026)).data!.totalGastos).toBe('30000')
    expect(ok(await finance.CommitmentsForecast('2026-02', 1)).data![0]!.libre).toBe('20000')

    expect((await finance.CreateRefund(ex.id, '2026-02', '30001', '')).error?.code).toBe('VALIDATION_ERROR')
    ok(await finance.CreateRefund(ex.id, '2026-02', '30000', ''))

    ok(await finance.DeleteExpense(ex.id))
    expect((await monthly('2026-02')).gastos).toBe('0')
    expect((await monthly('2026-03')).acumulado).toBe('0')
  })

  it('validan y se borran', async () => {
    const ex = ok(await finance.CreateExpense('2026-01-05', 'Tele', '', '', null, 'cuotas', '100000', 3)).data!
    for (const [expenseID, period, amount, code] of [
      [ex.id, '2026-01', '0', 'VALIDATION_ERROR'],
      [ex.id, '2026-13', '1', 'VALIDATION_ERROR'],
      [999, '2026-01', '1', 'NOT_FOUND'],
      [ex.id, '2026-02', '300001', 'VALIDATION_ERROR'],
    ] as const) {
      expect((await finance.CreateRefund(expenseID, period, amount, '')).error?.code).toBe(code)
    }
    const rf = ok(await finance.CreateRefund(ex.id, '2026-02', '300000', '')).data!
    ok(await finance.DeleteRefund(rf.id))
    expect((await finance.DeleteRefund(rf.id)).error?.code).toBe('NOT_FOUND')
  })

  it('el tope es la suma real de las cuotas, no cuota × N', async () => {
    const ex = ok(await finance.CreateExpense('2026-01-05', 'Tele', '', '', null, 'cuotas', '10000', 6)).data!
    const last = (await monthly('2026-06')).movimientos.find((m) => m.expenseId === ex.id)!
    ok(await finance.SetInstallmentAmount(last.installmentId, '10001'))

    expect((await finance.CreateRefund(ex.id, '2026-02', '60002', '')).error?.code).toBe('VALIDATION_ERROR')
    expect((await finance.CreateReceivable(ex.id, 'Ana', '60002')).error?.code).toBe('VALIDATION_ERROR')
    ok(await finance.CreateReceivable(ex.id, 'Ana', '60001'))
    ok(await finance.CreateRefund(ex.id, '2026-02', '60001', ''))
  })

  it('un abono del banco se confirma como reembolso', async () => {
    const ex = ok(await finance.CreateExpense('2026-03-02', 'Zapatillas', 'Ropa', 'Falabella', null, 'unico', '45990', 1)).data!
    const blank = { currency: '', cardLastDigits: '', account: '', reference: '', installmentsTotal: 0, hint: '' }
    ok(
      await finance.StageImport({
        source: 'pdf_account',
        issuer: 'itau',
        items: [
          { ...blank, date: '2026-03-20', description: 'FALABELLA DEVOLUCION', amount: '45990', kind: 'abono' },
          { ...blank, date: '2026-03-21', description: 'CASHBACK PUNTOS', amount: '3000', kind: 'abono' },
        ],
      }),
    )
    const items = ok(await finance.ListImportItems('pendiente')).data!
    const byDesc = (d: string): ImportItemView => items.find((it) => it.description === d)!
    expect(byDesc('FALABELLA DEVOLUCION').suggestedRefundExpenseId).toBe(ex.id)
    expect(byDesc('CASHBACK PUNTOS').suggestedRefundExpenseId).toBeNull()

    const itemID = byDesc('FALABELLA DEVOLUCION').id
    const rf = ok(await finance.ConfirmImportItemAsRefund(itemID, ex.id, '2026-03', '45990')).data!
    expect((await monthly('2026-03')).gastos).toBe('0')
    expect((await finance.ConfirmImportItemAsRefund(itemID, ex.id, '2026-03', '1')).error?.code).toBe('CONFLICT')

    ok(await finance.DeleteRefund(rf.id))
    ok(await finance.RestoreImportItem(itemID))
    expect(ok(await finance.ListImportItems('pendiente')).data).toHaveLength(2)

    ok(await finance.StageImport({ source: 'pdf_account', issuer: 'itau', items: [{ ...blank, date: '2026-03-25', description: 'LIDER', amount: '5000' }] }))
    const charge = ok(await finance.ListImportItems('pendiente')).data!.find((it) => it.description === 'LIDER')!
    expect((await finance.ConfirmImportItemAsRefund(charge.id, ex.id, '2026-03', '5000')).error?.code).toBe('VALIDATION_ERROR')
  })
})
