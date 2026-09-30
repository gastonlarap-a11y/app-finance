// Mirror of backend/finance/account_test.go: accounts as a lens on the ledger.
import { beforeEach, describe, expect, it } from 'vitest'
import { createTestDb } from '@/engine/testing/db'
import { createFinanceService } from '@/engine/finance/service'
import { createSession } from '@/engine/users/service'
import { blankStatement } from '@/engine/testing/cardStatement'
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
    // The card's 80.000 leaves the checking account when January's statement is paid, in February.
    expect(byName.get('Cuenta corriente')).toMatchObject({ balance: '600000', ingresos: '500000', gastos: '0' })
    expect(byName.get('Efectivo')).toMatchObject({ balance: '45000' })
    expect([jan.unassignedGastos, jan.unassignedIngresos]).toEqual(['1000', '0'])
    expect((await at('2030-02')).accounts[0]).toMatchObject({ balance: '520000', gastos: '80000' })

    await finance.UpdateAccount(cash.id, 'Efectivo', 'efectivo', '20000', '2030-01', true)
    for (const a of (await at('2030-01')).accounts) expect(a.receivesSalary).toBe(a.id === cash.id)
    expect((await finance.DeleteAccount(cash.id)).error).toBeUndefined()
    const after = await at('2030-01')
    expect([after.accounts.length, after.unassignedGastos]).toEqual([1, '6000'])

    // An account a transfer moves money to or from is not deleted.
    const savings = (await finance.CreateAccount('Ahorro', 'ahorro', '0', '2030-01', false)).data!
    const tr = (await finance.CreateTransfer(checking.id, savings.id, 'Ahorro mensual', 'fixed', '10000', '2030-01', true)).data!
    expect((await finance.DeleteAccount(savings.id)).error?.code).toBe('CONFLICT')
    expect((await finance.DeleteTransfer(tr.id)).error).toBeUndefined()
    expect((await finance.DeleteAccount(savings.id)).error).toBeUndefined()

    for (const [n, k, o, p] of [['', 'corriente', '0', '2030-01'], ['X', 'banco', '0', '2030-01'], ['X', 'vista', 'abc', '2030-01'], ['X', 'vista', '0', '2030-1']]) {
      expect((await finance.CreateAccount(n!, k!, o!, p!, false)).error?.code).toBe('VALIDATION_ERROR')
    }
    expect((await finance.SetExpenseAccount(lunch.id, 999)).error?.code).toBe('NOT_FOUND')
  })
})

// Mirror of backend/finance/cardpayment_test.go: a card purchase is its month's
// spending, but leaves the account that pays the card when the statement is paid.
describe('pago de la tarjeta', () => {
  const owedOf = async (period: string, card: number) => (await at(period)).cards.find((c) => c.cardId === card)
  const itauAt = async (period: string) => (await at(period)).accounts.find((a) => a.name === 'Itaú')!

  it('sale de la cuenta el mes en que se paga el estado', async () => {
    const itau = (await finance.CreateAccount('Itaú', 'corriente', '1000000', '2026-08', false)).data!
    const card = (await finance.CreateCard('Itaú Mastercard', '2000000', 24, '1234')).data!
    expect((await finance.SetCardAccount(card.id, itau.id)).error).toBeUndefined()
    await finance.CreateExpense('2026-08-10', 'Zapatillas', '', '', card.id, 'unico', '100000', 1)
    await finance.CreateFixedExpense('Netflix', '', card.id, '2026-08', '10000', 1, 'CLP')
    const cash = (await finance.CreateExpense('2026-08-15', 'Feria', '', '', null, 'unico', '5000', 1)).data!
    expect((await finance.SetExpenseAccount(cash.id, itau.id)).error).toBeUndefined()

    expect((await finance.MonthlySummary('2026-08')).data!.gastos).toBe('115000')
    expect(await itauAt('2026-08')).toMatchObject({ balance: '995000', gastos: '5000' })
    expect(await owedOf('2026-08', card.id)).toEqual({ cardId: card.id, name: 'Itaú Mastercard', owed: '110000', paymentPeriod: '2026-09' })
    expect(await itauAt('2026-09')).toMatchObject({ balance: '885000', gastos: '110000' })
    expect(await owedOf('2026-09', card.id)).toMatchObject({ owed: '10000', paymentPeriod: '2026-10' })

    // Paid on the 28th, after the 24th cutoff: the same month.
    expect((await finance.SetCardPaymentDay(card.id, 28)).error).toBeUndefined()
    expect((await itauAt('2026-08')).balance).toBe('885000')
    expect(await owedOf('2026-08', card.id)).toBeUndefined()

    // An imported statement's «pagar hasta» wins over the payment day.
    const imp = await finance.ImportCardStatement({
      ...blankStatement,
      issuer: 'itau', kind: 'nacional', currency: 'CLP', cardLastDigits: '1234',
      statementDate: '2026-08-24', periodTo: '2026-08-24', dueDate: '2026-10-02',
    })
    expect(imp.error).toBeUndefined()
    expect((await itauAt('2026-09')).balance).toBe('985000')
    expect(await owedOf('2026-09', card.id)).toMatchObject({ owed: '110000', paymentPeriod: '2026-10' })
  })

  it('valida el día de pago', async () => {
    const card = (await finance.CreateCard('Visa', '500000', 20, '')).data!
    for (const bad of [0, 32, 1.5]) expect((await finance.SetCardPaymentDay(card.id, bad)).error?.code).toBe('VALIDATION_ERROR')
    expect((await finance.SetCardPaymentDay(999, 5)).error?.code).toBe('NOT_FOUND')
    expect((await finance.SetCardPaymentDay(card.id, 5)).error).toBeUndefined()
    expect((await finance.ListCards())[0]?.paymentDay).toBe(5)
    expect((await finance.SetCardPaymentDay(card.id, null)).error).toBeUndefined()
    expect((await finance.ListCards())[0]?.paymentDay).toBeNull()
  })
})

// Mirror of TestAccountsClosing (accountreconciliation_test.go): the accounts'
// real closing balances minus what the cards owed, savings goals' accounts apart.
describe('cierre según tus cuentas', () => {
  it('suma los saldos reales y resta lo que deben las tarjetas', async () => {
    const itau = (await finance.CreateAccount('Itaú', 'corriente', '1000000', '2026-08', false)).data!
    const mp = (await finance.CreateAccount('Mercado Pago', 'digital', '0', '2026-08', false)).data!
    const ahorro = (await finance.CreateAccount('Cuenta de ahorro', 'ahorro', '2000000', '2026-08', false)).data!
    await finance.CreateAccount('Cuenta nueva', 'vista', '0', '2026-10', false)
    const goal = (await finance.CreateSavingsGoal('Pie departamento', '9000000', '')).data!
    expect((await finance.SetSavingsGoalAccount(goal.id, ahorro.id)).error).toBeUndefined()
    const card = (await finance.CreateCard('Visa', '2000000', 24, '')).data!
    expect((await finance.SetCardAccount(card.id, itau.id)).error).toBeUndefined()
    await finance.CreateExpense('2026-08-10', 'Zapatillas', '', '', card.id, 'unico', '100000', 1)

    const closing = async () => {
      const r = await finance.AccountsClosing('2026-08')
      expect(r.error).toBeUndefined()
      return r.data!
    }
    expect(await closing()).toMatchObject({ complete: false, missing: ['Itaú', 'Mercado Pago'] })
    expect((await finance.SetAccountReconciliation(itau.id, '2026-08', '990000')).error).toBeUndefined()
    expect((await finance.SetAccountReconciliation(mp.id, '2026-08', '20000')).error).toBeUndefined()
    expect(await closing()).toMatchObject({
      complete: true,
      missing: [],
      accounts: '1010000',
      cardsOwed: '100000',
      total: '910000',
      saved: '2000000',
    })
    expect((await finance.AccountsClosing('2099-12')).error?.code).toBe('VALIDATION_ERROR')
    expect((await finance.AccountsClosing('2026-13')).error?.code).toBe('VALIDATION_ERROR')
  })
})
