// Mirror of backend/finance/features_test.go and the cross-user checks in
// backend/users/isolation_test.go: same scenarios, same expected numbers, so the
// web engine and the Go backend can never drift apart silently.
import { beforeEach, describe, expect, it } from 'vitest'
import { createTestDb } from '@/engine/testing/db'
import { createFinanceService } from '@/engine/finance/service'
import { createSession, createUsersService } from '@/engine/users/service'
import type { ExpenseFilter, FinanceServiceContract, OpResult, UsersServiceContract } from '@/services/contract'

let finance: FinanceServiceContract
let users: UsersServiceContract

beforeEach(async () => {
  const db = await createTestDb()
  const session = createSession(db)
  finance = createFinanceService(db, session)
  users = createUsersService(db, session)
})

const filter = (f: Partial<ExpenseFilter> = {}): ExpenseFilter => ({
  text: '',
  category: '',
  cardId: null,
  fromPeriod: '',
  toPeriod: '',
  limit: 0,
  offset: 0,
  ...f,
})

function ok<T extends { error?: unknown }>(r: T): T {
  expect(r.error).toBeUndefined()
  return r
}

describe('borrar filas inexistentes', () => {
  it('devuelve NOT_FOUND en vez de éxito silencioso', async () => {
    const cat = ok(await finance.CreateCategory('Comida'))
    ok(await finance.DeleteCategory(cat.data!.id))
    const calls: Array<() => Promise<OpResult>> = [
      () => finance.DeleteCategory(cat.data!.id),
      () => finance.DeleteCard(999),
      () => finance.DeleteExpense(999),
      () => finance.DeleteIncome(999),
      () => finance.DeleteMerchant(999),
      () => finance.DeleteFixedExpense(999),
      () => finance.SetInstallmentPaid(999, true),
    ]
    for (const call of calls) expect((await call()).error?.code).toBe('NOT_FOUND')
  })
})

describe('renombrar categoría', () => {
  it('cascadea también a los gastos fijos', async () => {
    const cat = ok(await finance.CreateCategory('Servicios'))
    ok(await finance.CreateFixedExpense('Luz', 'Servicios', null, '2030-01', '30000'))
    ok(await finance.UpdateCategory(cat.data!.id, 'Hogar'))
    expect((await finance.ListFixedExpenses())[0]?.category).toBe('Hogar')
  })
})

describe('YearSummary.categoriaMeses', () => {
  it('desglosa por categoría y mes, consistente con porCategoria', async () => {
    ok(await finance.CreateExpense('2030-03-10', 'Tele', 'Hogar', '', null, 'cuotas', '1000', 3))
    ok(await finance.CreateExpense('2030-01-05', 'Pan', '', '', null, 'unico', '200', 1))
    ok(await finance.CreateFixedExpense('Internet', 'Hogar', null, '2030-02', '500'))

    const y = ok(await finance.YearSummary(2030)).data!
    expect(y.categoriaMeses).toHaveLength(2)
    const hogar = y.categoriaMeses[0]!
    expect(hogar.category).toBe('Hogar')
    expect(hogar.months).toEqual(['0', '500', '1500', '1500', '1500', '500', '500', '500', '500', '500', '500', '500'])
    expect(hogar.total).toBe('8500')
    expect(y.categoriaMeses[1]).toMatchObject({ category: 'Sin categoría', total: '200' })
    expect(y.porCategoria[0]).toEqual({ category: 'Hogar', total: '8500' })
  })
})

describe('presupuestos por categoría', () => {
  it('rigen desde su mes, se exceden, se quitan con 0 y viajan con la categoría', async () => {
    const cat = ok(await finance.CreateCategory('Comida'))
    const id = cat.data!.id
    ok(await finance.SetCategoryBudget(id, '2030-01', '100000'))
    ok(await finance.SetCategoryBudget(id, '2030-03', '80000'))
    ok(await finance.SetCategoryBudget(id, '2030-05', '0'))
    ok(await finance.CreateExpense('2030-03-02', 'Super', 'Comida', '', null, 'unico', '90000', 1))

    const at = async (period: string) => ok(await finance.MonthlySummary(period)).data!.presupuestos
    expect(await at('2029-12')).toEqual([])
    expect(await at('2030-02')).toMatchObject([{ budget: '100000', over: false }])
    expect(await at('2030-03')).toMatchObject([{ budget: '80000', spent: '90000', remaining: '-10000', over: true }])
    expect(await at('2030-06')).toEqual([])

    ok(await finance.UpdateCategory(id, 'Alimentación'))
    expect(ok(await finance.ListCategoryBudgets('2030-03')).data).toEqual([
      { categoryId: id, category: 'Alimentación', amount: '80000', effectiveFrom: '2030-03' },
    ])
    ok(await finance.DeleteCategory(id))
    expect(ok(await finance.ListCategoryBudgets('2030-03')).data).toEqual([])
    expect((await finance.SetCategoryBudget(id, '2030-03', '1')).error?.code).toBe('NOT_FOUND')
    ok(await finance.RestoreCategory(id))
    expect(ok(await finance.ListCategoryBudgets('2030-03')).data).toHaveLength(1)
  })
})

describe('proyección de compromisos', () => {
  it('suma cuotas y fijos futuros contra el sueldo (estimado si falta)', async () => {
    ok(await finance.SetSalary('2029-12', '1000000'))
    ok(await finance.SetSalary('2030-02', '1200000'))
    ok(await finance.CreateIncome('2030-03', 'Bono', '50000'))
    ok(await finance.CreateExpense('2030-01-10', 'Notebook', 'Tecno', '', null, 'cuotas', '100000', 2))
    ok(await finance.CreateFixedExpense('Plan', 'Servicios', null, '2030-02', '20000'))

    const f = ok(await finance.CommitmentsForecast('2030-01', 3)).data!
    expect(f).toEqual([
      {
        period: '2030-01', cuotas: '100000', fijos: '0', comprometido: '100000', ingresos: '1000000',
        ingresoEstimado: true, libre: '900000', saldoProyectado: '1900000',
      },
      {
        period: '2030-02', cuotas: '100000', fijos: '20000', comprometido: '120000', ingresos: '1200000',
        ingresoEstimado: false, libre: '1080000', saldoProyectado: '2980000',
      },
      {
        period: '2030-03', cuotas: '0', fijos: '20000', comprometido: '20000', ingresos: '1250000',
        ingresoEstimado: true, libre: '1230000', saldoProyectado: '4210000',
      },
    ])
    expect((await finance.CommitmentsForecast('2030-01', 0)).error?.code).toBe('VALIDATION_ERROR')
    expect((await finance.CommitmentsForecast('2030-01', 37)).error?.code).toBe('VALIDATION_ERROR')
  })
})

describe('búsqueda de gastos', () => {
  it('filtra por texto, categoría, tarjeta y rango, pagina y escapa comodines', async () => {
    const card = ok(await finance.CreateCard('Visa', '1000000', 24))
    ok(await finance.CreateExpense('2030-01-05', 'Supermercado Lider', 'Comida', 'Lider', null, 'unico', '30000', 1))
    ok(await finance.CreateExpense('2030-02-05', 'Zapatillas', 'Ropa', 'Falabella', card.data!.id, 'cuotas', '20000', 3))
    ok(await finance.CreateExpense('2030-03-05', 'Descuento 100%_off', '', '', null, 'unico', '1000', 1))
    const deleted = ok(await finance.CreateExpense('2030-01-06', 'Lider borrado', 'Comida', '', null, 'unico', '5000', 1))
    ok(await finance.DeleteExpense(deleted.data!.id))

    const cases: Array<[string, Partial<ExpenseFilter>, number, string]> = [
      ['sin filtros', {}, 3, 'Descuento 100%_off'],
      ['texto en comercio', { text: 'falabella' }, 1, 'Zapatillas'],
      ['excluye borrados', { text: 'lider' }, 1, 'Supermercado Lider'],
      ['% y _ literales', { text: '100%_' }, 1, 'Descuento 100%_off'],
      ['% solo', { text: '%' }, 1, 'Descuento 100%_off'],
      ['categoría', { category: 'Comida' }, 1, 'Supermercado Lider'],
      ['sin categoría', { category: 'Sin categoría' }, 1, 'Descuento 100%_off'],
      ['tarjeta', { cardId: card.data!.id }, 1, 'Zapatillas'],
      ['rango con cuotas posteriores', { fromPeriod: '2030-04', toPeriod: '2030-04' }, 1, 'Zapatillas'],
      ['paginado', { limit: 1, offset: 1 }, 3, 'Zapatillas'],
    ]
    for (const [name, f, count, first] of cases) {
      const res = ok(await finance.SearchExpenses(filter(f))).data!
      expect(res.count, name).toBe(count)
      expect(res.items[0]?.expense.description, name).toBe(first)
    }

    const hit = ok(await finance.SearchExpenses(filter({ text: 'zapatillas' }))).data!.items[0]!
    expect(hit).toMatchObject({ cardName: 'Visa', firstPeriod: '2030-02', lastPeriod: '2030-04', total: '60000' })
    expect((await finance.SearchExpenses(filter({ fromPeriod: '2030-05', toPeriod: '2030-01' }))).error?.code).toBe(
      'VALIDATION_ERROR',
    )
  })
})

describe('aislamiento en escrituras por id y lecturas agregadas', () => {
  it('otro perfil no puede tocar ni ver filas ajenas', async () => {
    const period = '2030-01'
    const fe = ok(await finance.CreateFixedExpense('Netflix', 'Servicios', null, period, '8000'))
    const cat = ok(await finance.CreateCategory('Servicios'))
    ok(await finance.SetCategoryBudget(cat.data!.id, period, '50000'))
    ok(await finance.CreateExpense(`${period}-10`, 'Cine', 'Servicios', '', null, 'cuotas', '10000', 3))

    ok(await users.CreateUser('Camila'))
    const writes: Array<() => Promise<OpResult>> = [
      () => finance.SetFixedExpenseAmount(fe.data!.id, period, '1'),
      () => finance.SetFixedExpensePaid(fe.data!.id, period, true),
      () => finance.SetCategoryBudget(cat.data!.id, period, '1'),
      () => finance.DeleteFixedExpense(fe.data!.id),
    ]
    for (const w of writes) expect((await w()).error?.code).toBe('NOT_FOUND')

    expect(ok(await finance.SearchExpenses(filter())).data?.count).toBe(0)
    expect(ok(await finance.ListCategoryBudgets(period)).data).toEqual([])
    for (const m of ok(await finance.CommitmentsForecast(period, 3)).data!) expect(m.comprometido).toBe('0')
    expect(ok(await finance.YearSummary(2030)).data?.categoriaMeses).toEqual([])

    ok(await users.SwitchUser(1))
    const mv = ok(await finance.MonthlySummary(period)).data!.movimientos.find((m) => m.fixedId === fe.data!.id)
    expect(mv).toMatchObject({ amount: '8000', status: 'pendiente' })
  })
})
