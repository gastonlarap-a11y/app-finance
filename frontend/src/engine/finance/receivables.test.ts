// Mirror of backend/finance/receivable_test.go: what others owe of an expense,
// settled as a refund in the month the money arrives.
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

describe('por cobrar', () => {
  it('se cobra como reembolso y se deshace borrando el reembolso', async () => {
    const dinner = (await finance.CreateExpense('2030-03-10', 'Cena', 'Comida', '', null, 'unico', '60000', 1)).data!
    const ana = await finance.CreateReceivable(dinner.id, ' Ana ', '20000')
    expect(ana.error).toBeUndefined()
    expect((await finance.CreateReceivable(dinner.id, 'Beto', '20000')).error).toBeUndefined()
    expect((await finance.CreateReceivable(dinner.id, 'Carla', '20001')).error?.code).toBe('VALIDATION_ERROR')
    expect((await finance.CreateReceivable(dinner.id, '', '1')).error?.code).toBe('VALIDATION_ERROR')
    expect((await finance.CreateReceivable(dinner.id, 'Ana', '0')).error?.code).toBe('VALIDATION_ERROR')

    let list = (await finance.ListReceivables()).data!
    expect(list).toHaveLength(2)
    expect(list[0]).toMatchObject({ person: 'Ana', expenseDescription: 'Cena', expenseDate: '2030-03-10', settledPeriod: '' })

    expect((await finance.SettleReceivable(ana.data!.id, '2030-04')).error).toBeUndefined()
    expect((await finance.SettleReceivable(ana.data!.id, '2030-04')).error?.code).toBe('CONFLICT')
    expect((await finance.MonthlySummary('2030-04')).data!.gastos).toBe('-20000')
    list = (await finance.ListReceivables()).data!
    expect([list[0]!.person, list[1]!.settledPeriod]).toEqual(['Beto', '2030-04'])

    expect((await finance.DeleteRefund(list[1]!.refundId!)).error).toBeUndefined()
    list = (await finance.ListReceivables()).data!
    expect(list.map((r) => r.settledPeriod)).toEqual(['', ''])
    expect((await finance.DeleteReceivable(ana.data!.id)).error).toBeUndefined()
    expect((await finance.ListReceivables()).data).toHaveLength(1)
  })
})
