// Mirror of backend/finance/dues_test.go: what falls due and is still unpaid.
import { beforeEach, describe, expect, it } from 'vitest'
import { createTestDb } from '@/engine/testing/db'
import { blankStatement } from '@/engine/testing/cardStatement'
import { createFinanceService } from '@/engine/finance/service'
import { createSession } from '@/engine/users/service'
import { dayOfMonth, MAX_DUE_DAYS, shiftDays } from '@/engine/finance/dues'
import type { SqlDb } from '@/engine/db/types'
import type { Due, FinanceServiceContract } from '@/services/contract'

let db: SqlDb
let finance: FinanceServiceContract

beforeEach(async () => {
  db = await createTestDb()
  finance = createFinanceService(db, createSession(db))
})

async function dues(today: string, days: number): Promise<Due[]> {
  const r = await finance.UpcomingDues(today, days)
  expect(r.error).toBeUndefined()
  return r.data!
}

describe('UpcomingDues', () => {
  it('lista lo que vence y sigue sin pagar', async () => {
    const card = (await finance.CreateCard('Visa', '1000000', 26, '4321')).data!
    const imported = await finance.ImportCardStatement({
      ...blankStatement,
      issuer: 'itau', kind: 'nacional', currency: 'CLP', cardLastDigits: '4321',
      statementDate: '2026-08-25', periodFrom: '2026-07-28', periodTo: '2026-08-25', dueDate: '2026-09-08',
      totalBilled: '0',
    })
    expect(imported.error).toBeUndefined()
    const period = String(db.query('SELECT period FROM card_statements', [])[0]!.period)

    const buy = (await finance.CreateExpense(`${period}-01`, 'Super', '', '', card.id, 'unico', '50000', 1)).data!
    const streaming = (await finance.CreateFixedExpense('Streaming', '', card.id, period, '10000', 1, 'CLP')).data!
    expect((await finance.SetFixedExpenseDueDay(streaming.id, 5)).error).toBeUndefined()
    const rent = (await finance.CreateFixedExpense('Arriendo', '', null, '2026-07', '400000', 1, 'CLP')).data!
    expect((await finance.SetFixedExpenseDueDay(rent.id, 5)).error).toBeUndefined()
    await finance.CreateFixedExpense('Gimnasio', '', null, '2026-07', '30000', 1, 'CLP')

    const got = await dues('2026-09-03', 7)
    expect(got).toEqual([
      { kind: 'fijo', refId: rent.id, label: 'Arriendo', period: '2026-09', dueDate: '2026-09-05', amount: '400000', overdue: false },
      { kind: 'tarjeta', refId: card.id, label: 'Visa', period, dueDate: '2026-09-08', amount: '60000', overdue: false },
    ])
    expect((await dues('2026-09-07', 3)).map((d) => d.overdue)).toEqual([true, false])

    const cuota = (await finance.MonthlySummary(period)).data!.movimientos.find((m) => m.expenseId === buy.id)!
    expect((await finance.SetInstallmentPaid(cuota.installmentId, true)).error).toBeUndefined()
    expect((await dues('2026-09-03', 7))[1]?.amount).toBe('10000')
    await finance.SetFixedExpensePaid(streaming.id, period, true)
    await finance.SetFixedExpensePaid(rent.id, '2026-09', true)
    expect(await dues('2026-09-03', 7)).toEqual([])

    expect((await finance.SetFixedExpenseDueDay(rent.id, null)).error).toBeUndefined()
    expect(await dues('2026-10-01', 10)).toEqual([])
    await finance.SetFixedExpenseDueDay(rent.id, 20)
    expect((await dues('2026-10-15', 10)).map((d) => d.dueDate)).toEqual(['2026-10-20'])
    await finance.DeleteFixedExpense(rent.id)
    expect(await dues('2026-10-15', 10)).toEqual([])
  })

  it('valida la fecha, los días y el día de vencimiento', async () => {
    for (const [today, days] of [
      ['2026-9-3', 7],
      ['1999-01-01', 7],
      ['2026-09-03', -1],
      ['2026-09-03', MAX_DUE_DAYS + 1],
    ] as const) {
      expect((await finance.UpcomingDues(today, days)).error?.code).toBe('VALIDATION_ERROR')
    }
    const fe = (await finance.CreateFixedExpense('Arriendo', '', null, '2026-07', '400000', 1, 'CLP')).data!
    for (const day of [0, 32]) {
      expect((await finance.SetFixedExpenseDueDay(fe.id, day)).error?.code).toBe('VALIDATION_ERROR')
    }
  })

  it('dayOfMonth usa el último día de meses cortos', () => {
    expect(dayOfMonth('2026-09', 5)).toBe('2026-09-05')
    expect(dayOfMonth('2026-04', 31)).toBe('2026-04-30')
    expect(dayOfMonth('2027-02', 30)).toBe('2027-02-28')
    expect(dayOfMonth('2028-02', 31)).toBe('2028-02-29')
    expect(shiftDays('2026-03-01', -1)).toBe('2026-02-28')
  })
})
