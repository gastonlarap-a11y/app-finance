// Mirror of backend/finance/transfer_test.go, accountreconciliation_test.go and
// catalog_test.go: same scenarios, same numbers.
import { beforeEach, describe, expect, it } from 'vitest'
import { createTestDb } from '@/engine/testing/db'
import { createFinanceService } from '@/engine/finance/service'
import { createSession } from '@/engine/users/service'
import { CATALOG } from '@/engine/finance/catalog'
import { LOOK_COLORS, LOOK_ICONS } from '@/engine/finance/looks'
import { addMonths, currentPeriod } from '@/engine/finance/period'
import type { FinanceServiceContract, ImportCandidate } from '@/services/contract'

let finance: FinanceServiceContract

beforeEach(async () => {
  const db = await createTestDb()
  finance = createFinanceService(db, createSession(db))
})

function ok<T extends { error?: unknown }>(r: T): T {
  expect(r.error).toBeUndefined()
  return r
}

async function account(period: string, name: string) {
  const a = ok(await finance.ListAccounts(period)).data!.accounts.find((x) => x.name === name)
  expect(a, name).toBeDefined()
  return a!
}

describe('transfers', () => {
  it('move balances between own accounts, never the totals', async () => {
    const chile = ok(await finance.CreateAccount('Banco de Chile', 'corriente', '0', '2026-07', true)).data!
    const itau = ok(await finance.CreateAccount('Itaú', 'corriente', '0', '2026-07', false)).data!
    const mp = ok(await finance.CreateAccount('Mercado Pago', 'digital', '0', '2026-07', false)).data!
    for (const p of ['2026-07', '2026-08', '2026-09']) ok(await finance.SetSalary(p, '2000000'))

    const salaryMove = ok(await finance.CreateTransfer(chile.id, itau.id, 'Sueldo a Itaú', 'fixed', '1500000', '2026-08', true)).data!
    const once = ok(await finance.CreateTransfer(itau.id, mp.id, 'Carga', 'fixed', '50000', '2026-09', false)).data!
    expect([once.endPeriod, salaryMove.endPeriod]).toEqual(['2026-09', ''])

    const cases: Array<[string, string, string, string, string]> = [
      ['2026-07', 'Banco de Chile', '2000000', '0', '0'],
      ['2026-08', 'Banco de Chile', '2500000', '0', '1500000'],
      ['2026-08', 'Itaú', '1500000', '1500000', '0'],
      ['2026-09', 'Banco de Chile', '3000000', '0', '1500000'],
      ['2026-09', 'Itaú', '2950000', '1500000', '50000'],
      ['2026-09', 'Mercado Pago', '50000', '50000', '0'],
    ]
    for (const [period, name, balance, tin, tout] of cases) {
      const a = await account(period, name)
      expect([a.balance, a.transferIn, a.transferOut, a.gastos], `${period} ${name}`).toEqual([balance, tin, tout, '0'])
    }
    expect(ok(await finance.MonthlySummary('2026-09')).data!.balance).toBe('6000000')

    ok(await finance.EndTransfer(salaryMove.id, '2026-08'))
    expect((await account('2026-09', 'Itaú')).balance).toBe('1450000')
    expect((await finance.EndTransfer(salaryMove.id, '2026-07')).error?.code).toBe('NOT_FOUND')

    ok(await finance.UpdateTransfer(once.id, itau.id, mp.id, 'Carga MP', 'fixed', '80000'))
    expect((await account('2026-09', 'Mercado Pago')).balance).toBe('80000')

    ok(await finance.DeleteTransfer(once.id))
    expect(await finance.ListTransfers()).toHaveLength(1)
    expect((await finance.DeleteAccount(itau.id)).error?.code).toBe('CONFLICT')
    expect(await finance.ListTransfers()).toHaveLength(1)
  })

  it('validate like Go', async () => {
    const a = ok(await finance.CreateAccount('A', 'corriente', '0', '2026-09', false)).data!
    const b = ok(await finance.CreateAccount('B', 'vista', '0', '2026-09', false)).data!
    const salary = ok(await finance.CreateAccount('Sueldo', 'corriente', '0', '2026-09', true)).data!
    const cases: Array<[string, number, number, string, string, string, string | undefined]> = [
      ['same account', a.id, a.id, 'fixed', '1000', '2026-09', 'VALIDATION_ERROR'],
      ['zero amount', a.id, b.id, 'fixed', '0', '2026-09', 'VALIDATION_ERROR'],
      ['negative amount', a.id, b.id, 'fixed', '-5', '2026-09', 'VALIDATION_ERROR'],
      ['not a number', a.id, b.id, 'fixed', 'mucho', '2026-09', 'VALIDATION_ERROR'],
      ['bad period', a.id, b.id, 'fixed', '1000', '2026-13', 'VALIDATION_ERROR'],
      ['unknown account', a.id, 9999, 'fixed', '1000', '2026-09', 'NOT_FOUND'],
      ['unknown mode', a.id, b.id, 'percent', '1000', '2026-09', 'VALIDATION_ERROR'],
      ['salary rest not from the salary account', a.id, b.id, 'salary_rest', '1000', '2026-09', 'VALIDATION_ERROR'],
      ['salary rest keeping a negative amount', salary.id, b.id, 'salary_rest', '-1', '2026-09', 'VALIDATION_ERROR'],
      ['salary rest keeping nothing', salary.id, b.id, 'salary_rest', '0', '2026-09', undefined],
      ['valid', a.id, b.id, 'fixed', '1000', '2026-09', undefined],
    ]
    for (const [name, from, to, mode, amount, period, code] of cases) {
      expect((await finance.CreateTransfer(from, to, '', mode, amount, period, false)).error?.code, name).toBe(code)
    }
    ok(await finance.CreateAccount('Mercado Pago', 'digital', '0', '2026-09', false))
    expect((await finance.CreateAccount('X', 'prepago', '0', '2026-09', false)).error?.code).toBe('VALIDATION_ERROR')
  })

  it('salary_rest passes on the salary minus what stays, whatever the salary', async () => {
    const chile = ok(await finance.CreateAccount('Banco de Chile', 'corriente', '0', '2026-09', true)).data!
    const itau = ok(await finance.CreateAccount('Itaú', 'corriente', '0', '2026-09', false)).data!
    ok(await finance.SetSalary('2026-09', '2300000'))
    ok(await finance.SetSalary('2026-10', '2550000'))
    ok(await finance.SetSalary('2026-12', '300000'))
    const rest = ok(await finance.CreateTransfer(chile.id, itau.id, 'Sueldo a Itaú', 'salary_rest', '470000', '2026-09', true)).data!
    expect(rest.mode).toBe('salary_rest')

    const cases: Array<[string, string, string]> = [
      ['2026-09', '1830000', '470000'],
      ['2026-10', '2080000', '940000'],
      ['2026-11', '0', '940000'], // no salary yet: nothing moves
      ['2026-12', '0', '1240000'], // a salary below what stays: nothing moves, never less
    ]
    for (const [period, moved, chileBalance] of cases) {
      expect((await account(period, 'Itaú')).transferIn, period).toBe(moved)
      const c = await account(period, 'Banco de Chile')
      expect([c.transferOut, c.balance], period).toEqual([moved, chileBalance])
    }

    ok(await finance.UpdateTransfer(rest.id, chile.id, itau.id, 'Sueldo a Itaú', 'fixed', '2000000'))
    expect((await account('2026-11', 'Itaú')).transferIn).toBe('2000000')
  })

  it('a live salary_rest transfer pins the account the salary lands in', async () => {
    const chile = ok(await finance.CreateAccount('Banco de Chile', 'corriente', '0', '2020-01', true)).data!
    const itau = ok(await finance.CreateAccount('Itaú', 'corriente', '0', '2020-01', false)).data!
    const rest = ok(await finance.CreateTransfer(chile.id, itau.id, 'Sueldo a Itaú', 'salary_rest', '470000', '2020-01', true)).data!

    expect((await finance.UpdateAccount(itau.id, 'Itaú', 'corriente', '0', '2020-01', true)).error?.code).toBe('CONFLICT')
    expect((await finance.UpdateAccount(chile.id, 'Banco de Chile', 'corriente', '0', '2020-01', false)).error?.code).toBe('CONFLICT')
    expect((await finance.CreateAccount('Cuenta RUT', 'vista', '0', '2020-01', true)).error?.code).toBe('CONFLICT')
    ok(await finance.UpdateAccount(chile.id, 'Chile', 'corriente', '0', '2020-01', true))
    expect((await account('2020-01', 'Chile')).receivesSalary).toBe(true)

    // Once the transfer has ended, the salary may land elsewhere.
    ok(await finance.EndTransfer(rest.id, '2020-06'))
    ok(await finance.UpdateAccount(itau.id, 'Itaú', 'corriente', '0', '2020-01', true))
    expect((await account('2020-01', 'Chile')).receivesSalary).toBe(false)
  })

  it("a fixed expense's own account wins over its card's", async () => {
    const chile = ok(await finance.CreateAccount('Banco de Chile', 'corriente', '0', '2026-09', false)).data!
    const itau = ok(await finance.CreateAccount('Itaú', 'corriente', '0', '2026-09', false)).data!
    const card = ok(await finance.CreateCard('Visa', '1000000', 24, '')).data!
    ok(await finance.SetCardAccount(card.id, itau.id))
    const mortgage = ok(await finance.CreateFixedExpense('Dividendo', 'Vivienda', null, '2026-09', '600000', 1, 'CLP')).data!
    const netflix = ok(await finance.CreateFixedExpense('Netflix', 'Suscripciones', card.id, '2026-09', '9000', 1, 'CLP')).data!

    // A fixed charge on the card leaves the account when the card is paid:
    // September's Netflix in October, next to October's mortgage.
    ok(await finance.SetFixedExpenseAccount(mortgage.id, chile.id))
    expect((await account('2026-10', 'Banco de Chile')).gastos).toBe('600000')
    expect((await account('2026-10', 'Itaú')).gastos).toBe('9000')
    ok(await finance.SetFixedExpenseAccount(netflix.id, chile.id))
    expect((await account('2026-10', 'Banco de Chile')).gastos).toBe('609000')
    ok(await finance.UpdateFixedExpense(mortgage.id, 'Dividendo casa', 'Vivienda', null))
    expect((await account('2026-10', 'Banco de Chile')).gastos).toBe('609000')
    expect((await finance.SetFixedExpenseAccount(mortgage.id, 9999)).error?.code).toBe('NOT_FOUND')
  })

  // Mirror of TestChangeTransferFromAMonth.
  it('changing from a month on splits the transfer and moves the later links', async () => {
    const itau = ok(await finance.CreateAccount('Itaú', 'corriente', '0', '2026-07', false)).data!
    const mp = ok(await finance.CreateAccount('Mercado Pago', 'digital', '0', '2026-07', false)).data!
    const load = ok(await finance.CreateTransfer(itau.id, mp.id, 'Carga', 'fixed', '50000', '2026-07', true)).data!
    const blank = { currency: '', cardLastDigits: '', account: '', reference: '', installmentsTotal: 0, hint: '' }
    ok(
      await finance.StageImport({
        source: 'pdf_account',
        issuer: 'Itau',
        items: [{ ...blank, date: '2026-09-15', description: 'CARGA MERCADOPAGO', amount: '50000' }],
      }),
    )
    const sep = ok(await finance.ListImportItems('pendiente')).data![0]!
    ok(await finance.LinkImportItemToTransfer(sep.id, load.id, '2026-09'))

    const next = ok(await finance.ChangeTransferFrom(load.id, itau.id, mp.id, 'Carga mayor', 'fixed', '80000', '2026-09')).data!
    expect([next.startPeriod, next.endPeriod, next.id !== load.id]).toEqual(['2026-09', '', true])
    for (const [period, balance] of [
      ['2026-07', '50000'],
      ['2026-08', '100000'],
      ['2026-09', '180000'],
      ['2026-10', '260000'],
    ]) {
      expect((await account(period!, 'Mercado Pago')).balance, period).toBe(balance)
    }
    const transfers = await finance.ListTransfers()
    expect(transfers.map((t) => t.endPeriod)).toEqual(['', '2026-08'])
    expect(ok(await finance.ListImportItems('confirmado')).data!.map((it) => it.transferId)).toEqual([next.id])

    const same = ok(await finance.ChangeTransferFrom(next.id, itau.id, mp.id, 'Carga', 'fixed', '70000', '2026-09')).data!
    expect(same.id).toBe(next.id)

    for (const [id, period, code] of [
      [load.id, '2026-10', 'VALIDATION_ERROR'], // a month it does not cover
      [next.id, '2026-08', 'VALIDATION_ERROR'], // before it starts
      [next.id, '2026-9', 'VALIDATION_ERROR'],
      [999, '2026-10', 'NOT_FOUND'],
    ] as const) {
      expect((await finance.ChangeTransferFrom(id, itau.id, mp.id, '', 'fixed', '1000', period)).error?.code).toBe(code)
    }
  })
})

describe('account reconciliations', () => {
  it('restart the balance from the real close, as a view', async () => {
    const itau = ok(await finance.CreateAccount('Itaú', 'corriente', '100000', '2026-07', true)).data!
    ok(await finance.CreateAccount('Otra', 'vista', '5000', '2026-07', false))
    for (const p of ['2026-07', '2026-08', '2026-09']) ok(await finance.SetSalary(p, '1000000'))
    const monthSummary = ok(await finance.MonthlySummary('2026-09')).data!.balance

    expect((await account('2026-09', 'Itaú')).balance).toBe('3100000')
    ok(await finance.SetAccountReconciliation(itau.id, '2026-08', '1950000'))
    const aug = await account('2026-08', 'Itaú')
    expect(aug.balance).toBe('2100000')
    expect(aug.conciliacion).toEqual({ saldoReal: '1950000', calculado: '2100000', diferencia: '-150000' })
    const sep = await account('2026-09', 'Itaú')
    expect([sep.balance, sep.conciliacion]).toEqual(['2950000', null])
    expect((await account('2026-09', 'Otra')).balance).toBe('5000')
    expect(ok(await finance.MonthlySummary('2026-09')).data!.balance).toBe(monthSummary)

    ok(await finance.SetAccountReconciliation(itau.id, '2026-08', '2000000'))
    expect((await account('2026-09', 'Itaú')).balance).toBe('3000000')
    ok(await finance.DeleteAccountReconciliation(itau.id, '2026-08'))
    expect((await account('2026-09', 'Itaú')).balance).toBe('3100000')
    expect((await finance.DeleteAccountReconciliation(itau.id, '2026-08')).error?.code).toBe('NOT_FOUND')

    ok(await finance.SetAccountReconciliation(itau.id, '2026-07', '0'))
    ok(await finance.UpdateAccount(itau.id, 'Itaú', 'corriente', '500000', '2026-09', true))
    expect((await account('2026-09', 'Itaú')).balance).toBe('1500000')
  })

  it('validate like Go', async () => {
    const acc = ok(await finance.CreateAccount('Itaú', 'corriente', '0', '2026-07', false)).data!
    const future = addMonths(currentPeriod(), 1)
    const cases: Array<[string, number, string, string, string | undefined]> = [
      ['bad period', acc.id, '2026-13', '1000', 'VALIDATION_ERROR'],
      ['future month', acc.id, future, '1000', 'VALIDATION_ERROR'],
      ['before the opening', acc.id, '2026-06', '1000', 'VALIDATION_ERROR'],
      ['not a number', acc.id, '2026-08', 'mucho', 'VALIDATION_ERROR'],
      ['unknown account', 9999, '2026-08', '1000', 'NOT_FOUND'],
      ['overdraft', acc.id, '2026-08', '-25000', undefined],
    ]
    for (const [name, id, period, balance, code] of cases) {
      expect((await finance.SetAccountReconciliation(id, period, balance)).error?.code, name).toBe(code)
    }
  })
})

describe('catalog.json', () => {
  it('has unique names and patterns, known categories, valid looks and normalized patterns', () => {
    expect(CATALOG.categories.length).toBeGreaterThanOrEqual(30)
    expect(CATALOG.merchants.length).toBeGreaterThanOrEqual(150)
    const cats = new Set<string>()
    for (const c of CATALOG.categories) {
      expect(cats.has(c.name.toLowerCase()), c.name).toBe(false)
      cats.add(c.name.toLowerCase())
      expect(LOOK_ICONS, c.name).toContain(c.icon)
      expect(LOOK_COLORS, c.name).toContain(c.color)
    }
    const patterns = new Set<string>()
    for (const m of CATALOG.merchants) {
      if (m.category !== '') expect(cats.has(m.category.toLowerCase()), m.name).toBe(true)
      for (const p of m.patterns) {
        expect(patterns.has(p), p).toBe(false)
        patterns.add(p)
      }
    }
  })
})

describe('ApplyCatalog', () => {
  it('adds only what is missing and never overrides a choice', async () => {
    ok(await finance.CreateCategory('TECNOLOGÍA'))
    ok(await finance.CreateCategory('Comida'))
    ok(await finance.CreateMerchant('cruz verde'))
    const uber = ok(await finance.CreateMerchant('Uber')).data!
    ok(await finance.SetMerchantCategory(uber.id, 'Comida'))
    const netflix = ok(await finance.CreateMerchant('Netflix')).data!
    ok(await finance.DeleteMerchant(netflix.id))

    const first = ok(await finance.ApplyCatalog()).data!
    const allPatterns = CATALOG.merchants.reduce((n, m) => n + m.patterns.length, 0)
    const netflixPatterns = CATALOG.merchants.find((m) => m.name === 'Netflix')!.patterns.length
    expect(first).toEqual({
      categories: CATALOG.categories.length - 1,
      merchants: CATALOG.merchants.length - 3,
      rules: allPatterns - netflixPatterns,
    })

    const byName = new Map((await finance.ListMerchants()).map((m) => [m.name, m]))
    expect(byName.get('cruz verde')?.category).toBe('Farmacia')
    expect(byName.get('Uber')?.category).toBe('Comida')
    expect(byName.has('Netflix')).toBe(false)
    expect(byName.get('Apple Store')?.category).toBe('TECNOLOGÍA')
    const rules = await finance.ListMerchantRules()
    expect(rules.find((r) => r.pattern === 'uber *trip')).toMatchObject({ merchant: 'Uber', category: 'Comida' })
    expect(rules.find((r) => r.pattern === 'cruz verde')).toMatchObject({ merchant: 'cruz verde', category: 'Farmacia' })
    expect(rules.some((r) => r.pattern === 'netflix')).toBe(false)
    const cats = await finance.ListCategories()
    expect(cats.find((c) => c.name === 'Supermercado')).toMatchObject({ icon: 'shopping-cart', color: 'green' })
    expect(cats.find((c) => c.name === 'TECNOLOGÍA')?.icon).toBe('')

    expect(ok(await finance.ApplyCatalog()).data).toEqual({ categories: 0, merchants: 0, rules: 0 })
  })
})

describe('merchant category and renames', () => {
  it('validates, follows renames, and completes an import suggestion', async () => {
    const tech = ok(await finance.CreateCategory('Tecnologia')).data!
    const apple = ok(await finance.CreateMerchant('Apple')).data!
    ok(await finance.SetMerchantCategory(apple.id, 'TECNOLOGIA'))
    expect((await finance.ListMerchants())[0]!.category).toBe('Tecnologia')
    ok(await finance.SetMerchantCategory(apple.id, ''))
    expect((await finance.SetMerchantCategory(apple.id, 'Juguetes')).error?.code).toBe('VALIDATION_ERROR')
    expect((await finance.SetMerchantCategory(9999, '')).error?.code).toBe('NOT_FOUND')

    ok(await finance.SetMerchantCategory(apple.id, 'Tecnologia'))
    ok(await finance.ApplyCatalog()) // brings "Tecnología" and the "apple store" rule → Apple Store / Tecnología
    const catalogTech = (await finance.ListCategories()).find((c) => c.name === 'Tecnología')!
    ok(await finance.UpdateCategory(catalogTech.id, 'Tecno'))
    ok(await finance.UpdateCategory(tech.id, 'Gadgets'))
    expect((await finance.ListMerchants()).find((m) => m.name === 'Apple')?.category).toBe('Gadgets')
    expect((await finance.ListMerchants()).find((m) => m.name === 'Apple Store')?.category).toBe('Tecno')
    expect((await finance.ListMerchantRules()).find((r) => r.pattern === 'apple store')?.category).toBe('Tecno')

    const storeMerchant = (await finance.ListMerchants()).find((m) => m.name === 'Apple Store')!
    ok(await finance.UpdateMerchant(storeMerchant.id, 'Apple Tienda'))
    expect((await finance.ListMerchantRules()).find((r) => r.pattern === 'apple store')?.merchant).toBe('Apple Tienda')

    // A catalog rule with no category ("mercado libre" sells everything) takes
    // the merchant's usual category once the user sets one.
    const ml = (await finance.ListMerchants()).find((m) => m.name === 'Mercado Libre')!
    ok(await finance.SetMerchantCategory(ml.id, 'Gadgets'))
    const candidate: ImportCandidate = {
      date: '2026-09-10',
      description: 'MERCADO LIBRE COMPRA 12345',
      amount: '999990',
      currency: '',
      cardLastDigits: '',
      account: 'x',
      reference: '',
      installmentsTotal: 1,
      hint: '',
    }
    ok(await finance.StageImport({ source: 'pdf_account', issuer: 'itau', items: [candidate] }))
    const item = ok(await finance.ListImportItems('pendiente')).data!.find((i) => i.description === candidate.description)
    expect([item?.suggestedMerchant, item?.suggestedCategory]).toEqual(['Mercado Libre', 'Gadgets'])
  })
})
