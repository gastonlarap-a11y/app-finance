// Mirror of backend/finance/account_test.go: accounts as a lens on the ledger.
import { beforeEach, describe, expect, it } from 'vitest'
import { createTestDb } from '@/engine/testing/db'
import { createFinanceService } from '@/engine/finance/service'
import { createSession } from '@/engine/users/service'
import type { AccountsSummary, FinanceServiceContract } from '@/services/contract'

let finance: FinanceServiceContract

beforeEach(async () => {
  const db = await createTestDb()
  finance = createFinanceService(db, createSession(db))
})

async function at(period: string): Promise<AccountsSummary> {
  const r = await finance.ListAccounts(period)
  expect(r.error).toBeUndefined()
  return r.data!
}

describe('cuentas', () => {
  it('cada cuenta sigue sus movimientos', async () => {
    const checking = (await finance.CreateAccount('Cuenta corriente', 'corriente', '100000', '2030-01', true)).data!
    const cash = (await finance.CreateAccount('Efectivo', 'efectivo', '20000', '2030-01', false)).data!
    const card = (await finance.CreateCard('Visa', '1000000', 24, '')).data!
    expect((await finance.SetCardAccount(card.id, checking.id)).error).toBeUndefined()

    await finance.SetSalary('2030-01', '500000')
    await finance.CreateExpense('2030-01-05', 'Super', '', '', card.id, 'unico', '80000', 1)
    const lunch = (await finance.CreateExpense('2030-01-06', 'Almuerzo', '', '', null, 'unico', '5000', 1)).data!
    expect((await finance.SetExpenseAccount(lunch.id, cash.id)).error).toBeUndefined()
    const bonus = (await finance.CreateIncome('2030-01', 'Venta', '30000')).data!
    expect((await finance.SetIncomeAccount(bonus.id, cash.id)).error).toBeUndefined()
    await finance.CreateExpense('2030-01-07', 'Sin cuenta', '', '', null, 'unico', '1000', 1)

    const jan = await at('2030-01')
    const byName = new Map(jan.accounts.map((a) => [a.name, a]))
    expect(byName.get('Cuenta corriente')).toMatchObject({ balance: '520000', ingresos: '500000', gastos: '80000' })
    expect(byName.get('Efectivo')).toMatchObject({ balance: '45000' })
    expect([jan.unassignedGastos, jan.unassignedIngresos]).toEqual(['1000', '0'])
    expect((await at('2030-02')).accounts[0]).toMatchObject({ balance: '520000', gastos: '0' })

    await finance.UpdateAccount(cash.id, 'Efectivo', 'efectivo', '20000', '2030-01', true)
    for (const a of (await at('2030-01')).accounts) expect(a.receivesSalary).toBe(a.id === cash.id)
    expect((await finance.DeleteAccount(cash.id)).error).toBeUndefined()
    const after = await at('2030-01')
    expect([after.accounts.length, after.unassignedGastos]).toEqual([1, '6000'])

    for (const [n, k, o, p] of [['', 'corriente', '0', '2030-01'], ['X', 'banco', '0', '2030-01'], ['X', 'vista', 'abc', '2030-01'], ['X', 'vista', '0', '2030-1']]) {
      expect((await finance.CreateAccount(n!, k!, o!, p!, false)).error?.code).toBe('VALIDATION_ERROR')
    }
    expect((await finance.SetExpenseAccount(lunch.id, 999)).error?.code).toBe('NOT_FOUND')
  })
})
