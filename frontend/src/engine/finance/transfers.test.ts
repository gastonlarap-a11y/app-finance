// Mirror of backend/finance/transfer_test.go and catalog_test.go: same
// scenarios, same numbers.
import { beforeEach, describe, expect, it } from 'vitest'
import { createTestDb } from '@/engine/testing/db'
import { createFinanceService } from '@/engine/finance/service'
import { createSession } from '@/engine/users/service'
import { CATALOG } from '@/engine/finance/catalog'
import { LOOK_COLORS, LOOK_ICONS } from '@/engine/finance/looks'
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

    const salaryMove = ok(await finance.CreateTransfer(chile.id, itau.id, 'Sueldo a Itaú', '1500000', '2026-08', true)).data!
    const once = ok(await finance.CreateTransfer(itau.id, mp.id, 'Carga', '50000', '2026-09', false)).data!
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

    ok(await finance.UpdateTransfer(once.id, itau.id, mp.id, 'Carga MP', '80000'))
    expect((await account('2026-09', 'Mercado Pago')).balance).toBe('80000')

    ok(await finance.DeleteTransfer(once.id))
    expect(await finance.ListTransfers()).toHaveLength(1)
    ok(await finance.DeleteAccount(itau.id))
    expect(await finance.ListTransfers()).toHaveLength(0)
  })

  it('validate like Go', async () => {
    const a = ok(await finance.CreateAccount('A', 'corriente', '0', '2026-09', false)).data!
    const b = ok(await finance.CreateAccount('B', 'vista', '0', '2026-09', false)).data!
    const cases: Array<[string, number, number, string, string, string | undefined]> = [
      ['same account', a.id, a.id, '1000', '2026-09', 'VALIDATION_ERROR'],
      ['zero amount', a.id, b.id, '0', '2026-09', 'VALIDATION_ERROR'],
      ['negative amount', a.id, b.id, '-5', '2026-09', 'VALIDATION_ERROR'],
      ['not a number', a.id, b.id, 'mucho', '2026-09', 'VALIDATION_ERROR'],
      ['bad period', a.id, b.id, '1000', '2026-13', 'VALIDATION_ERROR'],
      ['unknown account', a.id, 9999, '1000', '2026-09', 'NOT_FOUND'],
      ['valid', a.id, b.id, '1000', '2026-09', undefined],
    ]
    for (const [name, from, to, amount, period, code] of cases) {
      expect((await finance.CreateTransfer(from, to, '', amount, period, false)).error?.code, name).toBe(code)
    }
    ok(await finance.CreateAccount('Mercado Pago', 'digital', '0', '2026-09', false))
    expect((await finance.CreateAccount('X', 'prepago', '0', '2026-09', false)).error?.code).toBe('VALIDATION_ERROR')
  })

  it("a fixed expense's own account wins over its card's", async () => {
    const chile = ok(await finance.CreateAccount('Banco de Chile', 'corriente', '0', '2026-09', false)).data!
    const itau = ok(await finance.CreateAccount('Itaú', 'corriente', '0', '2026-09', false)).data!
    const card = ok(await finance.CreateCard('Visa', '1000000', 24, '')).data!
    ok(await finance.SetCardAccount(card.id, itau.id))
    const mortgage = ok(await finance.CreateFixedExpense('Dividendo', 'Vivienda', null, '2026-09', '600000', 1, 'CLP')).data!
    const netflix = ok(await finance.CreateFixedExpense('Netflix', 'Suscripciones', card.id, '2026-09', '9000', 1, 'CLP')).data!

    ok(await finance.SetFixedExpenseAccount(mortgage.id, chile.id))
    expect((await account('2026-09', 'Banco de Chile')).gastos).toBe('600000')
    expect((await account('2026-09', 'Itaú')).gastos).toBe('9000')
    ok(await finance.SetFixedExpenseAccount(netflix.id, chile.id))
    expect((await account('2026-09', 'Banco de Chile')).gastos).toBe('609000')
    ok(await finance.UpdateFixedExpense(mortgage.id, 'Dividendo casa', 'Vivienda', null))
    expect((await account('2026-09', 'Banco de Chile')).gastos).toBe('609000')
    expect((await finance.SetFixedExpenseAccount(mortgage.id, 9999)).error?.code).toBe('NOT_FOUND')
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
