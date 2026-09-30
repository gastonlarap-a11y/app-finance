// Mirror of backend/finance/installments_test.go: the bank's rounding settled
// in the last cuota, editing a pending cuota and paying a plan off early.
import { beforeEach, describe, expect, it } from 'vitest'
import { createTestDb } from '@/engine/testing/db'
import { createFinanceService } from '@/engine/finance/service'
import { createSession } from '@/engine/users/service'
import { blankStatement, statementLine } from '@/engine/testing/cardStatement'
import type { SqlDb } from '@/engine/db/types'
import type { FinanceServiceContract } from '@/services/contract'

let db: SqlDb
let finance: FinanceServiceContract

beforeEach(async () => {
  db = await createTestDb()
  finance = createFinanceService(db, createSession(db))
})

const cuotas = (expenseId: number) =>
  db
    .query('SELECT id, amount, period FROM installments WHERE expense_id = ? ORDER BY number', [expenseId])
    .map((r) => ({ id: Number(r.id), amount: String(r.amount), period: String(r.period) }))

describe('cuotas', () => {
  it('la última cuota absorbe el redondeo del banco', async () => {
    const card = (await finance.CreateCard('Itaú', '1000000', 26, '4321')).data!.id
    await finance.ImportCardStatement({
      ...blankStatement,
      issuer: 'itau', kind: 'nacional', currency: 'CLP', cardLastDigits: '4321',
      statementDate: '2026-08-25', periodFrom: '2026-07-28', periodTo: '2026-08-25',
      lines: [statementLine({ section: 'compra', operationDate: '2026-06-20', reference: '2508 22222222',
        description: 'TIENDA DOS', operationAmount: '60001', totalAmount: '60001',
        installmentNumber: 3, installmentsTotal: 6, installmentAmount: '10000' })],
    })
    const dos = (await finance.ListImportItems('pendiente')).data!.find((it) => it.description === 'TIENDA DOS')!
    const ex = await finance.ConfirmImportItem(dos.id, dos.date, 'Tienda dos', '', '', card, 'cuotas', dos.installmentAmount, 6, '')
    expect(ex.error).toBeUndefined()
    expect(cuotas(ex.data!.id).map((c) => c.amount)).toEqual(['10000', '10000', '10000', '10000', '10000', '10001'])
  })

  it('editar las palabras de una compra del estado de cuenta conserva la cuota redondeada del banco', async () => {
    const card = (await finance.CreateCard('Itaú', '1000000', 26, '4321')).data!.id
    await finance.ImportCardStatement({
      ...blankStatement,
      issuer: 'itau', kind: 'nacional', currency: 'CLP', cardLastDigits: '4321',
      statementDate: '2026-08-25', periodFrom: '2026-07-28', periodTo: '2026-08-25',
      lines: [statementLine({ section: 'compra', operationDate: '2026-06-20', reference: '2508 22222222',
        description: 'TIENDA DOS', operationAmount: '60001', totalAmount: '60001',
        installmentNumber: 3, installmentsTotal: 6, installmentAmount: '10000' })],
    })
    const dos = (await finance.ListImportItems('pendiente')).data!.find((it) => it.description === 'TIENDA DOS')!
    const ex = (await finance.ConfirmImportItem(dos.id, dos.date, 'Tienda dos', '', '', card, 'cuotas', dos.installmentAmount, 6, '')).data!
    const periods = cuotas(ex.id).map((c) => c.period)

    const edited = await finance.UpdateExpense(ex.id, dos.date, 'Tienda dos', 'Hogar', '', card, 'cuotas', dos.installmentAmount, 6)
    expect(edited.error).toBeUndefined()
    expect(cuotas(ex.id).map((c) => c.amount)).toEqual(['10000', '10000', '10000', '10000', '10000', '10001'])
    expect(cuotas(ex.id).map((c) => c.period)).toEqual(periods)
  })

  it('editar conserva el prepago y las cuotas desiguales; un monto nuevo llega a las pendientes', async () => {
    const ex = (await finance.CreateExpense('2030-01-10', 'Notebook', '', '', null, 'cuotas', '100000', 4)).data!
    const plan = cuotas(ex.id)
    await finance.SetInstallmentPaid(plan[0]!.id, true)
    expect((await finance.SetInstallmentAmount(plan[3]!.id, '100001')).error).toBeUndefined()
    expect((await finance.PrepayExpense(ex.id, '2030-02')).error).toBeUndefined()
    const prepaid = ['2030-01', '2030-02', '2030-02', '2030-02']
    const edit = async (amount: string, total: number) =>
      expect(
        (await finance.UpdateExpense(ex.id, '2030-01-10', 'Notebook gamer', 'Tecnología', '', null, 'cuotas', amount, total)).error,
      ).toBeUndefined()

    await edit('100000', 4)
    expect(cuotas(ex.id).map((c) => c.period)).toEqual(prepaid)
    expect(cuotas(ex.id).map((c) => c.amount)).toEqual(['100000', '100000', '100000', '100001'])

    await edit('90000', 4)
    expect(cuotas(ex.id).map((c) => c.amount)).toEqual(['100000', '90000', '90000', '90000'])
    expect(cuotas(ex.id).map((c) => c.period)).toEqual(prepaid)

    await edit('90000', 5)
    expect(cuotas(ex.id).map((c) => c.period)).toEqual([...prepaid, '2030-03'])
  })

  it('cada fila de un plan dice cuánto llevas y cuánto falta, por mes', async () => {
    const ex = (await finance.CreateExpense('2030-01-10', 'Notebook', '', '', null, 'cuotas', '100000', 4)).data!
    await finance.CreateExpense('2030-02-05', 'Café', '', '', null, 'unico', '3000', 1)
    const plan = cuotas(ex.id)
    expect((await finance.SetInstallmentAmount(plan[3]!.id, '100001')).error).toBeUndefined()

    const rows = async (period: string) => (await finance.MonthlySummary(period)).data!.movimientos
    const feb = await rows('2030-02')
    expect(feb.find((m) => m.expenseId === ex.id)).toMatchObject({ soFar: '200000', remaining: '200001', remainingCount: 2 })
    expect(feb.find((m) => m.expenseId !== ex.id)).toMatchObject({ soFar: null, remaining: null, remainingCount: 0 })

    await finance.SetInstallmentPaid(plan[0]!.id, true)
    await finance.SetInstallmentPaid(plan[1]!.id, true)
    expect((await finance.PrepayExpense(ex.id, '2030-03')).error).toBeUndefined()
    const mar = (await rows('2030-03')).filter((m) => m.expenseId === ex.id)
    expect(mar).toHaveLength(2)
    for (const m of mar) expect(m).toMatchObject({ soFar: '400001', remaining: '0', remainingCount: 0 })
  })

  it('se edita el monto de una cuota pendiente, nunca de una pagada', async () => {
    const ex = (await finance.CreateExpense('2030-01-10', 'Notebook', '', '', null, 'cuotas', '100000', 3)).data!
    const [first, second, third] = cuotas(ex.id)
    expect((await finance.SetInstallmentAmount(third!.id, '99998')).error).toBeUndefined()
    expect(cuotas(ex.id).map((c) => c.amount)).toEqual(['100000', '100000', '99998'])
    await finance.SetInstallmentPaid(first!.id, true)
    expect((await finance.SetInstallmentAmount(first!.id, '1')).error?.code).toBe('VALIDATION_ERROR')
    expect((await finance.SetInstallmentAmount(second!.id, '0')).error?.code).toBe('VALIDATION_ERROR')
    expect((await finance.SetInstallmentAmount(999, '1')).error?.code).toBe('NOT_FOUND')
  })

  it('prepagar mueve solo las cuotas pendientes al mes del pago', async () => {
    const ex = (await finance.CreateExpense('2030-01-10', 'Notebook', '', '', null, 'cuotas', '100000', 4)).data!
    await finance.SetInstallmentPaid(cuotas(ex.id)[0]!.id, true)
    expect((await finance.PrepayExpense(ex.id, '2030-02')).error).toBeUndefined()
    expect(cuotas(ex.id).map((c) => c.period)).toEqual(['2030-01', '2030-02', '2030-02', '2030-02'])
    expect((await finance.MonthlySummary('2030-02')).data!.gastos).toBe('300000')
    expect((await finance.PrepayExpense(999, '2030-02')).error?.code).toBe('NOT_FOUND')
    expect((await finance.PrepayExpense(ex.id, '2030-2')).error?.code).toBe('VALIDATION_ERROR')
  })
})
