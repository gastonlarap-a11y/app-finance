// Mirror of backend/finance/merge_test.go: a purchase entered by hand and then
// seen in a card statement is one expense, with the bank's date, amount and
// month, the user's words and the bank's code.
import { beforeEach, describe, expect, it } from 'vitest'
import { createTestDb } from '@/engine/testing/db'
import { createFinanceService } from '@/engine/finance/service'
import { createSession } from '@/engine/users/service'
import { blankStatement, statementLine } from '@/engine/testing/cardStatement'
import type { SqlDb } from '@/engine/db/types'
import type { CardStatementInput, FinanceServiceContract } from '@/services/contract'

let db: SqlDb
let finance: FinanceServiceContract

beforeEach(async () => {
  db = await createTestDb()
  finance = createFinanceService(db, createSession(db))
})

// taxiStatement bills one purchase: TAXI VIAJE 2.340 on 2026-08-12.
const taxiStatement = (): CardStatementInput => ({
  ...blankStatement,
  issuer: 'itau', kind: 'nacional', currency: 'CLP', cardLastDigits: '4321',
  statementDate: '2026-08-25', periodFrom: '2026-07-28', periodTo: '2026-08-25',
  lines: [statementLine({ section: 'compra', operationDate: '2026-08-12', reference: '1308 33333333', description: 'TAXI VIAJE',
    operationAmount: '2340', totalAmount: '2340', installmentNumber: 1, installmentsTotal: 1, installmentAmount: '2340' })],
})

async function card(billingDay = 24, digits = '4321'): Promise<number> {
  const r = await finance.CreateCard('Itaú', '1000000', billingDay, digits)
  expect(r.error).toBeUndefined()
  return r.data!.id
}

async function expense(date: string, description: string, cardId: number): Promise<number> {
  const r = await finance.CreateExpense(date, description, 'Transporte', 'Uber', cardId, 'unico', '2340', 1)
  expect(r.error).toBeUndefined()
  return r.data!.id
}

async function importTaxi() {
  const r = await finance.ImportCardStatement(taxiStatement())
  expect(r.error).toBeUndefined()
  return r.data!
}

const row = (id: number) =>
  db.query('SELECT date, description, category, merchant, bank_description FROM expenses WHERE id = ?', [id])[0]!
const periods = (id: number) =>
  db.query('SELECT period FROM installments WHERE expense_id = ? ORDER BY number', [id]).map((r) => String(r.period))

describe('unir un gasto ingresado a mano con su movimiento del banco', () => {
  it('toma la fecha del banco, conserva lo del usuario y agrega el código', async () => {
    const id = await expense('2026-08-05', 'Taxi al aeropuerto', await card())
    expect((await finance.SetExpenseTags(id, ['viaje'])).error).toBeUndefined()
    expect(await importTaxi()).toMatchObject({ merged: 1, added: 0 })
    const ex = row(id)
    expect([String(ex.date).slice(0, 10), ex.description, ex.category, ex.merchant, ex.bank_description]).toEqual([
      '2026-08-12', 'Taxi al aeropuerto', 'Transporte', 'Uber', 'TAXI VIAJE',
    ])
    const mv = (await finance.MonthlySummary('2026-08')).data!.movimientos.find((m) => m.expenseId === id)
    expect(mv).toMatchObject({ tags: ['viaje'], references: ['1308 33333333'], bankDescription: 'TAXI VIAJE' })
    expect((await finance.ListImportItems('pendiente')).data).toEqual([])
  })

  it('lo mueve al mes que cobró el banco', async () => {
    const id = await expense('2026-08-12', 'Taxi', await card(5))
    expect(periods(id)).toEqual(['2026-09'])
    await importTaxi()
    expect(periods(id)).toEqual(['2026-08'])
  })

  it('con dos candidatos o a más de 10 días deja la decisión en la bandeja', async () => {
    const cardId = await card()
    const first = await expense('2026-08-10', 'Taxi uno', cardId)
    const second = await expense('2026-08-14', 'Taxi dos', cardId)
    expect(await importTaxi()).toMatchObject({ merged: 0, added: 1 })
    const item = (await finance.ListImportItems('pendiente')).data![0]!
    expect(item.duplicateExpenseId).not.toBeNull()
    expect(item.duplicateDate).not.toBe('')
    expect((await finance.LinkImportItem(item.id, second)).error).toBeUndefined()
    expect(row(second).bank_description).toBe('TAXI VIAJE')
    expect(row(first).bank_description).toBe('')
  })

  it('lejos en fecha no es la misma compra', async () => {
    await expense('2026-08-01', 'Taxi', await card())
    expect(await importTaxi()).toMatchObject({ merged: 0, added: 1 })
  })

  it('sin la tarjeta del estado no une a ciegas', async () => {
    await expense('2026-08-12', 'Taxi', await card(24, '9999'))
    expect(await importTaxi()).toMatchObject({ merged: 0, added: 1 })
  })

  it('nunca mueve una cuota pagada', async () => {
    const id = await expense('2026-08-12', 'Taxi', await card(5))
    const inst = db.query('SELECT id FROM installments WHERE expense_id = ?', [id])[0]!
    expect((await finance.SetInstallmentPaid(Number(inst.id), true)).error).toBeUndefined()
    expect(await importTaxi()).toMatchObject({ merged: 1 })
    expect(periods(id)).toEqual(['2026-09'])
    expect(row(id).bank_description).toBe('TAXI VIAJE')
  })
})
