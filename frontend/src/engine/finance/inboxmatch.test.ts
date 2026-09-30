// Mirror of backend/finance/inboxmatch_test.go: same scenarios, same numbers.
import { beforeEach, describe, expect, it } from 'vitest'
import { createTestDb } from '@/engine/testing/db'
import { createFinanceService } from '@/engine/finance/service'
import { createSession } from '@/engine/users/service'
import type { FinanceServiceContract, ImportBatch, ImportCandidate, ImportItemView } from '@/services/contract'

let finance: FinanceServiceContract

beforeEach(async () => {
  const db = await createTestDb()
  finance = createFinanceService(db, createSession(db))
})

function ok<T extends { error?: unknown }>(r: T): T {
  expect(r.error).toBeUndefined()
  return r
}

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

async function list(status: string): Promise<ImportItemView[]> {
  return ok(await finance.ListImportItems(status)).data ?? []
}

async function stage(batch: ImportBatch): Promise<void> {
  ok(await finance.StageImport(batch))
}

async function stageOne(c: Partial<ImportCandidate>): Promise<ImportItemView> {
  await stage({ source: 'pdf_account', issuer: 'Itau', items: [candidate(c)] })
  return pending(c.description ?? '')
}

async function pending(description: string): Promise<ImportItemView> {
  const it = (await list('pendiente')).find((x) => x.description === description)
  expect(it, description).toBeDefined()
  return it!
}

describe('transferencias en la cartola', () => {
  it('un movimiento que mueve lo de una transferencia se sugiere, se enlaza y vuelve a revisión al borrarla', async () => {
    const itau = ok(await finance.CreateAccount('Itaú', 'corriente', '0', '2026-09', true)).data!
    const mp = ok(await finance.CreateAccount('Mercado Pago', 'digital', '0', '2026-09', false)).data!
    const load = ok(await finance.CreateTransfer(itau.id, mp.id, 'Carga Mercado Pago', 'fixed', '50000', '2026-09', true)).data!

    const out = await stageOne({ date: '2026-09-15', description: 'TRANSFERENCIA A MERCADOPAGO', amount: '50000' })
    expect(out).toMatchObject({
      suggestedTransferId: load.id,
      suggestedTransferPeriod: '2026-09',
      suggestedTransferDescription: 'Carga Mercado Pago',
    })
    expect((await stageOne({ date: '2026-09-16', description: 'COMPRA FERIA', amount: '49990' })).suggestedTransferId).toBeNull()

    expect((await finance.LinkImportItemToTransfer(out.id, load.id, '2026-08')).error?.code).toBe('VALIDATION_ERROR')
    expect((await finance.LinkImportItemToTransfer(out.id, 999, '2026-09')).error?.code).toBe('NOT_FOUND')
    ok(await finance.LinkImportItemToTransfer(out.id, load.id, '2026-09'))
    expect(ok(await finance.MonthlySummary('2026-09')).data!.gastos).toBe('0')

    const again = await stageOne({ date: '2026-09-20', description: 'TRANSFERENCIA A MERCADO PAGO', amount: '50000' })
    expect(again.suggestedTransferId).toBeNull()
    expect((await finance.LinkImportItemToTransfer(again.id, load.id, '2026-09')).error?.code).toBe('CONFLICT')
    const inLeg = await stageOne({ date: '2026-09-15', description: 'CARGA DESDE ITAU', amount: '50000', kind: 'abono' })
    expect(inLeg.suggestedTransferId).toBe(load.id)
    ok(await finance.LinkImportItemToTransfer(inLeg.id, load.id, '2026-09'))

    const confirmed = await list('confirmado')
    expect(confirmed).toHaveLength(2)
    expect(confirmed.every((c) => c.transferId === load.id && !c.reopenable)).toBe(true)
    ok(await finance.DeleteTransfer(load.id))
    expect((await list('confirmado')).every((c) => c.reopenable)).toBe(true)
    ok(await finance.RestoreImportItem(out.id))
    expect(await pending('TRANSFERENCIA A MERCADOPAGO')).toMatchObject({ transferId: null, transferPeriod: '' })
  })

  it('el «resto del sueldo» se reconoce por lo que mueve ese mes', async () => {
    const chile = ok(await finance.CreateAccount('Banco de Chile', 'corriente', '0', '2026-09', true)).data!
    const itau = ok(await finance.CreateAccount('Itaú', 'corriente', '0', '2026-09', false)).data!
    ok(await finance.CreateTransfer(chile.id, itau.id, '', 'salary_rest', '470000', '2026-09', true))
    ok(await finance.SetSalary('2026-09', '2300000'))
    const it = await stageOne({ date: '2026-09-30', description: 'TRASPASO A CTA ITAU', amount: '1830000' })
    expect(it.suggestedTransferDescription).toBe('Banco de Chile → Itaú')
  })
})

describe('duplicados entre formatos', () => {
  it('marca solo el segundo avistamiento y no borra nada', async () => {
    const pdf = await stageOne({ date: '2026-09-10', description: 'COMPRA PANADERIA LA ESPIGA', amount: '8450' })
    await stage({
      source: 'csv',
      issuer: 'Itaú CSV',
      items: [
        candidate({ date: '2026-09-11', description: 'Compra Panaderia La Espiga', amount: '8450' }),
        candidate({ date: '2026-09-11', description: 'Farmacia Ahumada', amount: '8450' }),
        candidate({ date: '2026-09-14', description: 'Panaderia La Espiga', amount: '8450' }),
      ],
    })
    expect((await pending('COMPRA PANADERIA LA ESPIGA')).duplicateItemId).toBeNull()
    expect(await pending('Compra Panaderia La Espiga')).toMatchObject({
      duplicateItemId: pdf.id,
      duplicateItemSource: 'pdf_account',
      duplicateItemStatus: 'pendiente',
      duplicateItemDescription: 'COMPRA PANADERIA LA ESPIGA',
    })
    expect((await pending('Farmacia Ahumada')).duplicateItemId).toBeNull()
    expect((await pending('Panaderia La Espiga')).duplicateItemId).toBeNull()
    expect(await list('pendiente')).toHaveLength(4)
  })
})
