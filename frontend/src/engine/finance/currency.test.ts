// Mirror of backend/finance/currency_test.go: a purchase in another currency
// keeps its pesos for every total plus the original and the rate.
import { beforeEach, describe, expect, it } from 'vitest'
import { createTestDb } from '@/engine/testing/db'
import { createFinanceService } from '@/engine/finance/service'
import { createSession } from '@/engine/users/service'
import type { SqlDb } from '@/engine/db/types'
import type { FinanceServiceContract } from '@/services/contract'

let db: SqlDb
let finance: FinanceServiceContract

beforeEach(async () => {
  db = await createTestDb()
  finance = createFinanceService(db, createSession(db))
})

const expenseRow = (id: number) =>
  db.query('SELECT currency, original_amount, fx_rate, installment_amount FROM expenses WHERE id = ?', [id])[0]

describe('moneda de los gastos', () => {
  it('confirmar un ítem en dólares guarda el original y la tasa', async () => {
    await finance.StageImport({
      source: 'pdf_account', issuer: 'Itau',
      items: [{ date: '2030-03-10', description: 'APP STORE', amount: '20.50', currency: 'USD', cardLastDigits: '',
        account: '', reference: '', installmentsTotal: 0, hint: '' }],
    })
    const item = (await finance.ListImportItems('pendiente')).data![0]!
    const ex = await finance.ConfirmImportItem(item.id, item.date, 'Suscripción', '', '', null, 'unico', '19475', 1, '')
    expect(ex.error).toBeUndefined()
    expect(expenseRow(ex.data!.id)).toEqual({ currency: 'USD', original_amount: '20.5', fx_rate: '950', installment_amount: '19475' })
    const mv = (await finance.MonthlySummary('2030-03')).data!.movimientos[0]!
    expect(mv).toMatchObject({ currency: 'USD', originalAmount: '20.5', amount: '19475' })
  })

  it('se anota y se limpia a mano', async () => {
    const ex = (await finance.CreateExpense('2030-03-10', 'Hotel', '', '', null, 'unico', '95000', 1)).data!
    expect(expenseRow(ex.id)?.currency).toBe('CLP')
    expect((await finance.SetExpenseCurrency(ex.id, 'eur', '100', '950')).error).toBeUndefined()
    expect(expenseRow(ex.id)).toMatchObject({ currency: 'EUR', original_amount: '100', fx_rate: '950' })
    expect((await finance.SetExpenseCurrency(ex.id, 'CLP', '', '')).error).toBeUndefined()
    expect(expenseRow(ex.id)).toMatchObject({ currency: 'CLP', original_amount: '', fx_rate: '' })
    for (const [c, o, r] of [['dólar', '1', '1'], ['USD', '0', '950'], ['USD', '10', '']]) {
      expect((await finance.SetExpenseCurrency(ex.id, c!, o!, r!)).error?.code).toBe('VALIDATION_ERROR')
    }
    expect((await finance.SetExpenseCurrency(999, 'USD', '1', '1')).error?.code).toBe('NOT_FOUND')
    expect(await finance.LatestFxRate()).toEqual({ data: '' })
  })
})
