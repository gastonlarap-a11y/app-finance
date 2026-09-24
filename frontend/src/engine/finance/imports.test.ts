// Mirror of backend/finance/imports_test.go: same scenarios and expected values,
// so the web engine's import inbox can never drift from the Go backend.
import { beforeEach, describe, expect, it } from 'vitest'
import { createTestDb } from '@/engine/testing/db'
import { createFinanceService } from '@/engine/finance/service'
import { createSession } from '@/engine/users/service'
import { normalizeDescriptor, ruleFor, suggestPattern } from '@/engine/finance/descriptor'
import type {
  FinanceServiceContract,
  ImportBatch,
  ImportCandidate,
  ImportItemView,
  MerchantRule,
  StageSummary,
} from '@/services/contract'

let finance: FinanceServiceContract

beforeEach(async () => {
  const db = await createTestDb()
  finance = createFinanceService(db, createSession(db))
})

const candidate = (c: Partial<ImportCandidate>): ImportCandidate => ({
  date: '',
  description: '',
  amount: '',
  currency: '',
  cardLastDigits: '',
  account: '',
  reference: '',
  installmentsTotal: 0,
  hint: '',
  ...c,
})

const pdfBatch = (...items: Partial<ImportCandidate>[]): ImportBatch => ({
  source: 'pdf_account',
  issuer: 'Itau',
  items: items.map(candidate),
})

async function stage(batch: ImportBatch): Promise<StageSummary> {
  const r = await finance.StageImport(batch)
  expect(r.error).toBeUndefined()
  return r.data!
}

async function list(status: string): Promise<ImportItemView[]> {
  const r = await finance.ListImportItems(status)
  expect(r.error).toBeUndefined()
  return r.data!
}

describe('descriptores', () => {
  it.each([
    ['CRUZ VERDE L9093 CHILLAN  C', 'cruz verde chillan', 'cruz verde'],
    ['ENTEL PCS PAGO ENSANTIAGO C', 'entel pcs pago ensantiago', 'entel pcs'],
    ['TRANSFERENCIA A JUAN SOTO', 'transferencia juan soto', 'transferencia juan'],
    ['UBER *TRIP 4521', 'uber *trip', 'uber *trip'],
    ['  9093  C ', '', ''],
  ])('%s', (input, norm, pattern) => {
    expect(normalizeDescriptor(input)).toBe(norm)
    expect(suggestPattern(input)).toBe(pattern)
  })

  it('la regla más larga que calza en borde de palabra gana', () => {
    const rule = (pattern: string, merchant: string): MerchantRule => ({
      id: 0, userId: 1, pattern, merchant, category: '', createdAt: '',
    })
    const rules = [rule('cruz verde', 'Cruz Verde'), rule('cruz verde chillan', 'Cruz Verde Chillán'), rule('cruz', 'Cruz')]
    expect(ruleFor(rules, 'CRUZ VERDE L9093 CHILLAN C')?.merchant).toBe('Cruz Verde Chillán')
    expect(ruleFor(rules, 'CRUZ VERDE L1 SANTIAGO C')?.merchant).toBe('Cruz Verde')
    expect(ruleFor(rules, 'CRUZADA SPA')).toBeNull()
    expect(ruleFor(rules, 'FARMACIA AHUMADA')).toBeNull()
  })
})

describe('StageImport', () => {
  it('reimportar no duplica; compras idénticas del mismo día son dos ítems', async () => {
    const batch = pdfBatch(
      { date: '2026-07-31', description: 'TRANSFERENCIA A LAURA MUNOZ', amount: '2172638', account: '0222222255', reference: '100000010' },
      { date: '2026-07-17', description: 'CRUZ VERDE L9093 CHILLAN C', amount: '16182', account: '0222222255' },
      { date: '2026-07-17', description: 'CRUZ VERDE L9093 CHILLAN C', amount: '16182', account: '0222222255' },
    )
    expect(await stage(batch)).toEqual({ added: 3, duplicates: 0, reconciled: 0 })
    expect(await stage(batch)).toEqual({ added: 0, duplicates: 3, reconciled: 0 })
    const items = await list('pendiente')
    expect(items).toHaveLength(3)
    expect(items[0]).toMatchObject({ issuer: 'itau', currency: 'CLP', installmentsTotal: 1 })
  })

  it('rechaza el lote completo si un movimiento es inválido', async () => {
    const valid = { date: '2026-07-17', description: 'CRUZ VERDE', amount: '16182' }
    const withBad = (bad: Partial<ImportCandidate>) => pdfBatch(valid, { ...valid, ...bad })
    const cases: Array<[ImportBatch, string]> = [
      [{ source: 'fax', issuer: 'itau', items: [] }, 'origen'],
      [{ source: 'email', issuer: ' ', items: [] }, 'emisor'],
      [withBad({ date: '17/07/2026' }), 'movimiento 2: fecha'],
      [withBad({ amount: '16.182.000' }), 'movimiento 2: monto'],
      [withBad({ amount: '0' }), 'mayor a 0'],
      [withBad({ description: ' ' }), 'descripción'],
      [withBad({ cardLastDigits: '12a4' }), '4 números'],
      [withBad({ hint: 'otro' }), 'pista'],
    ]
    for (const [batch, want] of cases) {
      const r = await finance.StageImport(batch)
      expect(r.error?.code).toBe('VALIDATION_ERROR')
      expect(r.error?.message).toContain(want)
    }
    expect(await list('pendiente')).toHaveLength(0)
  })

  it('concilia la alerta de correo con la línea del estado de cuenta', async () => {
    const alert: ImportBatch = {
      source: 'email',
      issuer: 'itau',
      items: [candidate({ date: '2026-07-10', description: 'COMPRA FALABELLA', amount: '90000', cardLastDigits: '1234', reference: '<msg-1@itau.cl>' })],
    }
    expect(await stage(alert)).toEqual({ added: 1, duplicates: 0, reconciled: 0 })
    const statement: ImportBatch = {
      source: 'pdf_card',
      issuer: 'itau',
      items: [
        candidate({ date: '2026-07-10', description: 'COMPRA FALABELLA', amount: '90000', cardLastDigits: '9999' }),
        candidate({ date: '2026-07-11', description: 'FALABELLA PARQUE ARAUCO', amount: '90000', cardLastDigits: '1234', installmentsTotal: 3 }),
        candidate({ date: '2026-07-11', description: 'FALABELLA PARQUE ARAUCO', amount: '90000', cardLastDigits: '1234', installmentsTotal: 3 }),
      ],
    }
    expect(await stage(statement)).toEqual({ added: 2, duplicates: 0, reconciled: 1 })

    const conc = await list('conciliado')
    expect(conc).toHaveLength(1)
    expect(conc[0]).toMatchObject({ matchedSource: 'email', matchedDate: '2026-07-10' })
    const emailItem = (await list('pendiente')).find((it) => it.source === 'email')
    expect(emailItem?.installmentsTotal).toBe(3)
  })
})

describe('revisión de la bandeja', () => {
  it('confirmar crea el gasto y aprende la regla', async () => {
    const card = await finance.CreateCard('Itaú Visa', '1000000', 24, '1234')
    expect(card.error).toBeUndefined()
    await stage({
      source: 'email',
      issuer: 'itau',
      items: [candidate({ date: '2026-07-17', description: 'CRUZ VERDE L9093 CHILLAN C', amount: '16182', cardLastDigits: '1234' })],
    })
    const item = (await list('pendiente'))[0]!
    expect(item).toMatchObject({ cardId: card.data!.id, cardName: 'Itaú Visa', suggestedPattern: 'cruz verde' })

    const res = await finance.ConfirmImportItem(
      item.id, item.date, 'Farmacia', 'Salud', 'Cruz Verde', item.cardId, 'unico', item.amount, 1, '  CRUZ VERDE ',
    )
    expect(res.error).toBeUndefined()
    expect((await finance.MonthlySummary('2026-07')).data?.gastos).toBe('16182')
    const confirmed = await list('confirmado')
    expect(confirmed).toHaveLength(1)
    expect(confirmed[0]?.expenseId).toBe(res.data!.id)

    const again = await finance.ConfirmImportItem(item.id, item.date, 'Farmacia', '', '', null, 'unico', '1', 1, '')
    expect(again.error?.code).toBe('CONFLICT')

    await stage({
      source: 'email',
      issuer: 'itau',
      items: [candidate({ date: '2026-07-20', description: 'CRUZ VERDE L0001 SANTIAGO C', amount: '5990', cardLastDigits: '1234' })],
    })
    expect((await list('pendiente'))[0]).toMatchObject({
      rulePattern: 'cruz verde',
      suggestedMerchant: 'Cruz Verde',
      suggestedCategory: 'Salud',
    })
  })

  it('un patrón sin palabras válidas no confirma nada', async () => {
    await stage(pdfBatch({ date: '2026-07-17', description: 'X', amount: '1' }))
    const item = (await list('pendiente'))[0]!
    const r = await finance.ConfirmImportItem(item.id, item.date, 'X', '', '', null, 'unico', '1', 1, '123 C')
    expect(r.error?.code).toBe('VALIDATION_ERROR')
    expect(await list('pendiente')).toHaveLength(1)
  })

  it('sugiere el gasto manual equivalente y permite enlazarlo', async () => {
    const manual = await finance.CreateExpense('2026-07-16', 'Remedios', 'Salud', '', null, 'unico', '16182', 1)
    const cuotas = await finance.CreateExpense('2026-07-01', 'Notebook', 'Tecnología', '', null, 'cuotas', '100000', 6)
    await stage(
      pdfBatch(
        { date: '2026-07-17', description: 'CRUZ VERDE L9093 CHILLAN C', amount: '16182' },
        { date: '2026-07-02', description: 'PARIS.CL', amount: '600000' },
        { date: '2026-07-25', description: 'CRUZ VERDE L9093 CHILLAN C', amount: '16182' },
      ),
    )
    const byDate = new Map((await list('pendiente')).map((it) => [it.date, it]))
    expect(byDate.get('2026-07-17')).toMatchObject({ duplicateExpenseId: manual.data!.id, duplicateDescription: 'Remedios' })
    expect(byDate.get('2026-07-02')?.duplicateExpenseId).toBe(cuotas.data!.id)
    expect(byDate.get('2026-07-25')?.duplicateExpenseId).toBeNull()

    expect((await finance.LinkImportItem(byDate.get('2026-07-17')!.id, manual.data!.id)).error).toBeUndefined()
    expect((await finance.LinkImportItem(byDate.get('2026-07-25')!.id, 999)).error?.code).toBe('NOT_FOUND')

    await stage(pdfBatch({ date: '2026-07-16', description: 'OTRA', amount: '16182' }))
    const other = (await list('pendiente')).find((it) => it.date === '2026-07-16')
    expect(other?.duplicateExpenseId).toBeNull()
  })

  it('descartar y restaurar', async () => {
    await stage(pdfBatch({ date: '2026-07-31', description: 'PAGO DEUDA INTER. TC CTA CLP', amount: '137150', hint: 'card_payment' }))
    const item = (await list('pendiente'))[0]!
    expect(item.hint).toBe('card_payment')

    expect((await finance.DiscardImportItem(item.id)).error).toBeUndefined()
    expect((await finance.DiscardImportItem(item.id)).error?.code).toBe('CONFLICT')
    expect(await list('descartado')).toHaveLength(1)
    expect((await finance.RestoreImportItem(item.id)).error).toBeUndefined()
    expect(await list('pendiente')).toHaveLength(1)
    expect((await finance.DiscardImportItem(999)).error?.code).toBe('NOT_FOUND')
    expect((await finance.ListImportItems('todos')).error?.code).toBe('VALIDATION_ERROR')
  })

  it('últimos dígitos de la tarjeta', async () => {
    expect((await finance.CreateCard('Visa', '0', 24, '12a4')).error?.code).toBe('VALIDATION_ERROR')
    const c = await finance.CreateCard('Visa', '0', 24, ' 4321 ')
    expect(c.data?.lastDigits).toBe('4321')
    const u = await finance.UpdateCard(c.data!.id, 'Visa', '0', 24, '')
    expect(u.data?.lastDigits).toBe('')
  })

  it('dígitos compartidos por dos tarjetas no resuelven ninguna', async () => {
    await finance.CreateCard('A', '0', 24, '2222')
    await finance.CreateCard('B', '0', 24, '2222')
    await stage(pdfBatch({ date: '2026-07-17', description: 'X', amount: '1', cardLastDigits: '2222' }))
    expect((await list('pendiente'))[0]).toMatchObject({ cardId: null, cardName: '' })
  })
})
