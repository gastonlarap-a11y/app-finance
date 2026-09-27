// Mirror of backend/finance/purge_test.go and backend/users/purge_test.go:
// deleting for good what is in the trash, one record, all of it, or a profile.
import { beforeEach, describe, expect, it } from 'vitest'
import { createTestDb } from '@/engine/testing/db'
import { createFinanceService } from '@/engine/finance/service'
import { createSession, createUsersService } from '@/engine/users/service'
import type { SqlDb } from '@/engine/db/types'
import type { FinanceServiceContract, UsersServiceContract } from '@/services/contract'

let db: SqlDb
let finance: FinanceServiceContract
let users: UsersServiceContract

beforeEach(async () => {
  db = await createTestDb()
  const session = createSession(db)
  finance = createFinanceService(db, session)
  users = createUsersService(db, session)
})

const count = (sql: string, ...params: number[]) => Number(db.query(sql, params)[0]?.n)

describe('borrado definitivo', () => {
  it('un elemento de la papelera, con sus cuotas', async () => {
    const ex = await finance.CreateExpense('2030-01-10', 'Notebook', '', '', null, 'cuotas', '100000', 3)
    const id = ex.data!.id
    expect((await finance.PurgeTrashItem('expense', id)).error?.code).toBe('NOT_FOUND')
    await finance.DeleteExpense(id)
    expect((await finance.PurgeTrashItem('expense', id)).error).toBeUndefined()
    expect(count('SELECT COUNT(*) AS n FROM expenses')).toBe(0)
    expect(count('SELECT COUNT(*) AS n FROM installments')).toBe(0)
    expect((await finance.PurgeTrashItem('nope', 1)).error?.code).toBe('VALIDATION_ERROR')
  })

  it('vaciar la papelera conserva lo vivo', async () => {
    const gone = await finance.CreateCategory('Viejo')
    await finance.CreateCategory('Comida')
    const card = await finance.CreateCard('Vieja', '100000', 24, '')
    await finance.DeleteCategory(gone.data!.id)
    await finance.DeleteCard(card.data!.id)
    expect((await finance.EmptyTrash()).error).toBeUndefined()
    expect((await finance.ListTrash()).data).toEqual([])
    expect(count('SELECT COUNT(*) AS n FROM categories')).toBe(1)
  })

  it('un perfil en la papelera, con todos sus datos', async () => {
    await finance.CreateExpense('2030-01-10', 'de Gastón', 'Comida', '', null, 'cuotas', '1000', 3)
    const camila = (await users.CreateUser('Camila')).data!.id
    await users.SwitchUser(camila)
    await finance.CreateExpense('2030-01-10', 'de Camila', 'Comida', '', null, 'cuotas', '1000', 3)
    await finance.CreateCategory('Ropa')

    expect((await users.PurgeUser(camila)).error?.code).toBe('NOT_FOUND')
    await users.DeleteUser(camila)
    expect((await users.PurgeUser(camila)).error).toBeUndefined()
    for (const table of ['expenses', 'installments', 'categories']) {
      expect(count(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`, camila)).toBe(0)
    }
    expect(count('SELECT COUNT(*) AS n FROM expenses WHERE user_id = 1')).toBe(1)
    expect(await users.ListDeletedUsers()).toEqual([])
  })
})
