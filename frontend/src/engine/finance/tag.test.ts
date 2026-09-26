// Mirror of backend/finance/tag_test.go: same scenarios, same numbers.
import { beforeEach, describe, expect, it } from 'vitest'
import { createTestDb } from '@/engine/testing/db'
import { createFinanceService } from '@/engine/finance/service'
import { createSession, createUsersService } from '@/engine/users/service'
import type { ExpenseFilter, FinanceServiceContract, UsersServiceContract } from '@/services/contract'

let finance: FinanceServiceContract
let users: UsersServiceContract

beforeEach(async () => {
  const db = await createTestDb()
  const session = createSession(db)
  finance = createFinanceService(db, session)
  users = createUsersService(db, session)
})

function ok<T extends { error?: unknown }>(r: T): T {
  expect(r.error).toBeUndefined()
  return r
}

const filter = (f: Partial<ExpenseFilter> = {}): ExpenseFilter => ({
  text: '',
  category: '',
  tag: '',
  cardId: null,
  fromPeriod: '',
  toPeriod: '',
  limit: 0,
  offset: 0,
  ...f,
})

async function movTags(period: string, expenseID: number): Promise<string[]> {
  const mv = ok(await finance.MonthlySummary(period)).data!.movimientos.find((m) => m.source === 'cuota' && m.expenseId === expenseID)
  return mv!.tags
}

describe('etiquetas', () => {
  it('cruzan categorías, se buscan y suman', async () => {
    const hotel = ok(await finance.CreateExpense('2026-02-10', 'Hotel', 'Alojamiento', '', null, 'unico', '300000', 1)).data!
    const flight = ok(await finance.CreateExpense('2026-01-15', 'Pasaje', 'Transporte', '', null, 'cuotas', '100000', 3)).data!
    ok(await finance.CreateExpense('2026-02-11', 'Super', 'Comida', '', null, 'unico', '50000', 1))

    ok(await finance.SetExpenseTags(hotel.id, [' Viaje ', 'trabajo', 'VIAJE', '']))
    ok(await finance.SetExpenseTags(flight.id, ['viaje']))
    expect(await movTags('2026-02', hotel.id)).toEqual(['trabajo', 'Viaje'])
    let tags = await finance.ListTags()
    expect(tags.map((t) => [t.name, t.count])).toEqual([
      ['trabajo', 1],
      ['Viaje', 2],
    ])

    const res = ok(await finance.SearchExpenses(filter({ tag: 'viaje', limit: 1 }))).data!
    expect([res.count, res.items.length, res.sum]).toEqual([2, 1, '600000'])
    expect(res.items[0]!.tags).toEqual(['trabajo', 'Viaje'])
    expect(ok(await finance.SearchExpenses(filter())).data!.sum).toBe('650000')

    ok(await finance.RenameTag(tags[1]!.id, 'Vacaciones'))
    expect(ok(await finance.SearchExpenses(filter({ tag: 'vacaciones' }))).data!.count).toBe(2)
    expect((await finance.RenameTag(tags[1]!.id, 'TRABAJO')).error?.code).toBe('CONFLICT')
    ok(await finance.DeleteTag(tags[0]!.id))
    expect(await movTags('2026-02', hotel.id)).toEqual(['Vacaciones'])
    ok(await finance.SetExpenseTags(hotel.id, []))
    expect(await movTags('2026-02', hotel.id)).toEqual([])

    ok(await finance.DeleteExpense(flight.id))
    expect((await finance.SetExpenseTags(flight.id, ['x'])).error?.code).toBe('NOT_FOUND')
    tags = await finance.ListTags()
    expect(tags.map((t) => [t.name, t.count])).toEqual([['Vacaciones', 0]])
  })

  it('valida cantidad y largo', async () => {
    const ex = ok(await finance.CreateExpense('2026-02-10', 'Hotel', '', '', null, 'unico', '1000', 1)).data!
    const eleven = Array.from({ length: 11 }, (_, i) => 'a'.repeat(i + 1))
    expect((await finance.SetExpenseTags(ex.id, eleven)).error?.code).toBe('VALIDATION_ERROR')
    expect((await finance.SetExpenseTags(ex.id, ['x'.repeat(31)])).error?.code).toBe('VALIDATION_ERROR')
    expect((await finance.RenameTag(999, 'x')).error?.code).toBe('NOT_FOUND')
    expect((await finance.DeleteTag(999)).error?.code).toBe('NOT_FOUND')
  })

  it('otro perfil no ve ni toca etiquetas ajenas', async () => {
    const ex = ok(await finance.CreateExpense('2026-02-10', 'Remedios', '', '', null, 'unico', '1000', 1)).data!
    ok(await finance.SetExpenseTags(ex.id, ['Salud']))
    const tag = (await finance.ListTags())[0]!
    ok(await users.CreateUser('Camila'))
    expect(await finance.ListTags()).toEqual([])
    expect(ok(await finance.SearchExpenses(filter({ tag: 'Salud' }))).data!.count).toBe(0)
    expect((await finance.SetExpenseTags(ex.id, ['x'])).error?.code).toBe('NOT_FOUND')
    expect((await finance.RenameTag(tag.id, 'x')).error?.code).toBe('NOT_FOUND')
    expect((await finance.DeleteTag(tag.id)).error?.code).toBe('NOT_FOUND')
  })
})
