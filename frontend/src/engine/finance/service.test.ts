// Mirror-integration suite: exercises the ported domain logic end-to-end over
// an in-memory sqlite-wasm DB with the real migrations, checking the same
// behaviors the Go tests cover (soft delete, cuotas, resúmenes, aislamiento).
import { beforeEach, describe, expect, it } from 'vitest'
import { createTestDb } from '@/engine/testing/db'
import { createFinanceService } from '@/engine/finance/service'
import { createSession, createUsersService } from '@/engine/users/service'
import type { FinanceServiceContract, UsersServiceContract } from '@/services/contract'
import type { SqlDb } from '@/engine/db/types'

let db: SqlDb
let finance: FinanceServiceContract
let users: UsersServiceContract

beforeEach(async () => {
  db = await createTestDb()
  const session = createSession(db)
  finance = createFinanceService(db, session)
  users = createUsersService(db, session)
})

describe('cards', () => {
  it('CRUD + soft delete + restore', async () => {
    const created = await finance.CreateCard('Visa', '500000', 24)
    expect(created.error).toBeUndefined()
    expect(created.data?.creditLimit).toBe('500000')

    const updated = await finance.UpdateCard(created.data!.id, 'Visa Gold', '800000', 15)
    expect(updated.data?.name).toBe('Visa Gold')
    expect(updated.data?.billingDay).toBe(15)

    expect(await finance.ListCards()).toHaveLength(1)
    await finance.DeleteCard(created.data!.id)
    expect(await finance.ListCards()).toHaveLength(0)

    const trash = await finance.ListTrash()
    expect(trash.data?.some((t) => t.type === 'card' && t.id === created.data!.id)).toBe(true)

    const restored = await finance.RestoreCard(created.data!.id)
    expect(restored.error).toBeUndefined()
    expect(await finance.ListCards()).toHaveLength(1)
  })

  it('día de corte fuera de rango cae al 24 y nombre vacío falla', async () => {
    const bad = await finance.CreateCard('  ', '0', 10)
    expect(bad.error?.code).toBe('VALIDATION_ERROR')
    const def = await finance.CreateCard('CMR', '100000', 99)
    expect(def.data?.billingDay).toBe(24)
  })
})

describe('categories', () => {
  it('renombrar cascadea a los gastos y respeta unicidad', async () => {
    const cat = await finance.CreateCategory('Comida')
    expect(cat.error).toBeUndefined()
    const dup = await finance.CreateCategory('Comida')
    expect(dup.error?.message).toBe('la categoría ya existe')

    await finance.CreateExpense('2026-07-10', 'Almuerzo', 'Comida', '', null, 'unico', '12000', 1)
    const renamed = await finance.UpdateCategory(cat.data!.id, 'Alimentación')
    expect(renamed.data?.name).toBe('Alimentación')
    const expenses = await finance.ListExpenses('2026-07')
    expect(expenses[0]?.category).toBe('Alimentación')
  })

  it('restaurar choca con una activa del mismo nombre', async () => {
    const cat = await finance.CreateCategory('Viajes')
    await finance.DeleteCategory(cat.data!.id)
    await finance.CreateCategory('Viajes') // reutiliza el nombre
    const res = await finance.RestoreCategory(cat.data!.id)
    expect(res.error?.code).toBe('CONFLICT')
  })
})

describe('expenses + installments', () => {
  it('cuotas ruedan según el corte de la tarjeta', async () => {
    const card = await finance.CreateCard('Visa', '1000000', 24)
    const ex = await finance.CreateExpense(
      '2026-06-26', 'MacBook', 'Tecnología', '', card.data!.id, 'cuotas', '100000', 3,
    )
    expect(ex.error).toBeUndefined()
    const periods = db
      .query('SELECT period FROM installments WHERE expense_id = ? ORDER BY number', [ex.data!.id])
      .map((r) => r.period)
    expect(periods).toEqual(['2026-07', '2026-08', '2026-09'])
  })

  it('editar preserva las cuotas ya pagadas', async () => {
    const ex = await finance.CreateExpense('2026-07-01', 'Cama', '', '', null, 'cuotas', '50000', 4)
    const first = db.query('SELECT id FROM installments WHERE expense_id = ? AND number = 1', [ex.data!.id])[0]
    await finance.SetInstallmentPaid(Number(first!.id), true)

    const upd = await finance.UpdateExpense(
      ex.data!.id, '2026-07-01', 'Cama king', '', '', null, 'cuotas', '60000', 5,
    )
    expect(upd.error).toBeUndefined()
    const insts = db.query(
      'SELECT number, status, amount FROM installments WHERE expense_id = ? ORDER BY number',
      [ex.data!.id],
    )
    expect(insts).toHaveLength(5)
    expect(insts[0]?.status).toBe('pagado')
    expect(insts[1]?.status).toBe('pendiente')
    expect(insts[0]?.amount).toBe('60000')
  })

  it('validaciones espejo de Go', async () => {
    expect((await finance.CreateExpense('mala-fecha', 'x', '', '', null, 'unico', '1', 1)).error?.message).toContain(
      'fecha inválida',
    )
    expect((await finance.CreateExpense('2026-07-01', 'x', '', '', null, 'raro', '1', 1)).error?.message).toContain(
      'tipo inválido',
    )
    expect((await finance.CreateExpense('2026-07-01', 'x', '', '', null, 'unico', '0', 1)).error?.message).toBe(
      'el monto debe ser mayor a 0',
    )
    expect((await finance.CreateExpense('2026-07-01', 'x', '', '', 99, 'unico', '1', 1)).error?.message).toBe(
      'la tarjeta indicada no existe',
    )
  })
})

describe('fixed expenses', () => {
  it('effective_from: editar desde un mes no toca el pasado', async () => {
    const fe = await finance.CreateFixedExpense('Netflix', 'Streaming', null, '2026-01', '10000')
    expect(fe.error).toBeUndefined()
    await finance.SetFixedExpenseAmount(fe.data!.id, '2026-05', '12000')

    const abril = await finance.MonthlySummary('2026-04')
    const mayo = await finance.MonthlySummary('2026-05')
    expect(abril.data?.movimientos.find((m) => m.source === 'fijo')?.amount).toBe('10000')
    expect(mayo.data?.movimientos.find((m) => m.source === 'fijo')?.amount).toBe('12000')
  })

  it('EndFixedExpense corta desde el mes indicado', async () => {
    const fe = await finance.CreateFixedExpense('Gym', '', null, '2026-01', '30000')
    await finance.EndFixedExpense(fe.data!.id, '2026-04')
    expect((await finance.MonthlySummary('2026-03')).data?.movimientos).toHaveLength(1)
    expect((await finance.MonthlySummary('2026-04')).data?.movimientos).toHaveLength(0)
  })

  it('pago por mes es sparse', async () => {
    const fe = await finance.CreateFixedExpense('Luz', '', null, '2026-01', '20000')
    await finance.SetFixedExpensePaid(fe.data!.id, '2026-02', true)
    expect((await finance.MonthlySummary('2026-02')).data?.movimientos[0]?.status).toBe('pagado')
    expect((await finance.MonthlySummary('2026-03')).data?.movimientos[0]?.status).toBe('pendiente')
    await finance.SetFixedExpensePaid(fe.data!.id, '2026-02', false)
    expect((await finance.MonthlySummary('2026-02')).data?.movimientos[0]?.status).toBe('pendiente')
  })
})

describe('MonthlySummary', () => {
  it('calcula ingresos, acumulado, gastos y cupos como el backend Go', async () => {
    await finance.SetSalary('2026-07', '1000000')
    await finance.CreateIncome('2026-07', 'Bono', '50000')
    const card = await finance.CreateCard('Visa', '500000', 24)
    // 3 cuotas de 30000 desde 2026-07 (compra día 10 < corte 24).
    await finance.CreateExpense('2026-07-10', 'Sofá', 'Hogar', '', card.data!.id, 'cuotas', '30000', 3)
    // Fijo de 10000 desde junio → junio pesa en el acumulado de julio.
    await finance.CreateFixedExpense('Netflix', 'Streaming', null, '2026-06', '10000')

    const s = (await finance.MonthlySummary('2026-07')).data!
    expect(s.salary).toBe('1000000')
    expect(s.extras).toBe('50000')
    expect(s.ingresos).toBe('1050000')
    expect(s.acumulado).toBe('-10000') // junio: sólo el fijo
    expect(s.disponible).toBe('1040000')
    expect(s.gastos).toBe('40000') // cuota 30000 + fijo 10000
    expect(s.pendiente).toBe('40000')
    expect(s.pagado).toBe('0')
    expect(s.balance).toBe('1000000')
    expect(s.alcanza).toBe(true)
    expect(s.movimientos).toHaveLength(2)

    const porCat = Object.fromEntries(s.porCategoria.map((c) => [c.category, c.total]))
    expect(porCat).toEqual({ Hogar: '30000', Streaming: '10000' })

    const visa = s.porTarjeta.find((t) => t.card.id === card.data!.id)!
    expect(visa.gastoMes).toBe('30000')
    expect(visa.cupoUsado).toBe('90000') // 3 cuotas pendientes de todos los períodos
    expect(visa.cupoDisponible).toBe('410000')
  })

  it('pagar una cuota mueve pendiente→pagado y libera cupo', async () => {
    const card = await finance.CreateCard('Visa', '500000', 24)
    const ex = await finance.CreateExpense('2026-07-10', 'TV', '', '', card.data!.id, 'cuotas', '30000', 3)
    const first = db.query('SELECT id FROM installments WHERE expense_id = ? AND number = 1', [ex.data!.id])[0]
    await finance.SetInstallmentPaid(Number(first!.id), true)

    const s = (await finance.MonthlySummary('2026-07')).data!
    expect(s.pagado).toBe('30000')
    expect(s.pendiente).toBe('0')
    expect(s.porTarjeta[0]?.cupoUsado).toBe('60000')
  })

  it('un gasto soft-deleted sale de los totales y vuelve al restaurar', async () => {
    const ex = await finance.CreateExpense('2026-07-01', 'Impulso', '', '', null, 'unico', '99000', 1)
    expect((await finance.MonthlySummary('2026-07')).data?.gastos).toBe('99000')
    await finance.DeleteExpense(ex.data!.id)
    expect((await finance.MonthlySummary('2026-07')).data?.gastos).toBe('0')
    await finance.RestoreExpense(ex.data!.id)
    expect((await finance.MonthlySummary('2026-07')).data?.gastos).toBe('99000')
  })
})

describe('YearSummary', () => {
  it('acumula saldo mes a mes con arrastre', async () => {
    await finance.SetSalary('2026-01', '100000')
    await finance.SetSalary('2026-02', '100000')
    await finance.CreateExpense('2026-01-05', 'Único', '', '', null, 'unico', '150000', 1)

    const y = (await finance.YearSummary(2026)).data!
    expect(y.months).toHaveLength(12)
    expect(y.months[0]?.saldo).toBe('-50000') // enero: 100000 - 150000
    expect(y.months[1]?.saldo).toBe('50000') // febrero arrastra
    expect(y.months[0]?.alcanza).toBe(false)
    expect(y.months[1]?.alcanza).toBe(true)
    expect(y.totalIngresos).toBe('200000')
    expect(y.totalGastos).toBe('150000')
    expect(y.totalBalance).toBe('50000')
  })

  it('rechaza años absurdos', async () => {
    expect((await finance.YearSummary(1990)).error?.message).toBe('año inválido')
  })
})

describe('aislamiento multi-usuario', () => {
  it('cada perfil ve sólo sus datos y el switch es inmediato', async () => {
    await finance.CreateCard('Visa G', '100000', 24)
    await finance.SetSalary('2026-07', '500000')

    const friend = await users.CreateUser('Amigo') // create-and-enter
    expect(friend.error).toBeUndefined()
    expect(await finance.ListCards()).toHaveLength(0)
    expect((await finance.MonthlySummary('2026-07')).data?.salary).toBe('0')

    await finance.CreateCard('Master A', '200000', 24)
    expect((await finance.ListCards()).map((c) => c.name)).toEqual(['Master A'])

    await users.SwitchUser(1)
    expect((await finance.ListCards()).map((c) => c.name)).toEqual(['Visa G'])
  })

  it('no se puede eliminar el último usuario y borrar el activo cambia al siguiente', async () => {
    expect((await users.DeleteUser(1)).error?.code).toBe('CONFLICT')
    const friend = await users.CreateUser('Amigo')
    const res = await users.DeleteUser(friend.data!.id) // activo → cae al usuario 1
    expect(res.data?.id).toBe(1)
    expect((await users.ActiveUser()).data?.id).toBe(1)
    expect((await users.ListDeletedUsers()).map((u) => u.name)).toEqual(['Amigo'])
    expect((await users.RestoreUser(friend.data!.id)).error).toBeUndefined()
  })
})
