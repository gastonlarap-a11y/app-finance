// Mirror of backend/finance/import_rules_test.go: item kinds and billing
// months from a statement, the confirm paths' kind/currency guards, one link
// per expense, reopening confirmed items, and fixed-expense bills.
import { beforeEach, describe, expect, it } from 'vitest'
import { createTestDb } from '@/engine/testing/db'
import { createFinanceService } from '@/engine/finance/service'
import { createSession } from '@/engine/users/service'
import { namesMatch } from '@/engine/finance/fixedmatch'
import { blankStatement, statementLine as line } from '@/engine/testing/cardStatement'
import type { FinanceServiceContract, ImportCandidate, ImportItemView } from '@/services/contract'

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

async function pending(): Promise<ImportItemView[]> {
  const r = await finance.ListImportItems('pendiente')
  expect(r.error).toBeUndefined()
  return r.data ?? []
}

async function stageOne(c: Partial<ImportCandidate>): Promise<ImportItemView> {
  const r = await finance.StageImport({ source: 'pdf_account', issuer: 'Itau', items: [candidate(c)] })
  expect(r.error).toBeUndefined()
  const it = (await pending()).find((i) => i.description === c.description && i.date === c.date)
  if (!it) throw new Error(`staged item ${c.description ?? ''} not pending`)
  return it
}

describe('statement lines', () => {
  it('fijan el tipo del movimiento y el mes de facturación', async () => {
    const r = await finance.ImportCardStatement({
      ...blankStatement,
      issuer: 'itau', kind: 'nacional', currency: 'CLP', cardLastDigits: '4321',
      statementDate: '2026-08-25', periodTo: '2026-08-25', totalBilled: '0',
      lines: [
        line({ section: 'compra', operationDate: '2026-08-12', reference: 'a', description: 'TAXI VIAJE',
          operationAmount: '2340', installmentAmount: '2340' }),
        line({ section: 'compra', operationDate: '2026-06-20', reference: 'b', description: 'TIENDA DOS',
          operationAmount: '60000', installmentNumber: 3, installmentsTotal: 6, installmentAmount: '10000' }),
        line({ section: 'cargo', operationDate: '2026-08-25', reference: 'c', description: 'COMISION MENSUAL',
          operationAmount: '20000', installmentAmount: '20000' }),
        line({ section: 'compra', operationDate: '2026-08-14', reference: 'd', description: 'ANULACION COMPRA',
          operationAmount: '-15990', installmentAmount: '-15990' }),
      ],
    })
    expect(r.error).toBeUndefined()
    const byDesc = new Map((await pending()).map((i) => [i.description, i]))
    expect(byDesc.get('TAXI VIAJE')).toMatchObject({ kind: 'gasto', firstPeriod: '2026-08' })
    expect(byDesc.get('TIENDA DOS')).toMatchObject({ kind: 'gasto', firstPeriod: '2026-06' })
    expect(byDesc.get('COMISION MENSUAL')).toMatchObject({ kind: 'gasto', firstPeriod: '2026-08' })
    expect(byDesc.get('ANULACION COMPRA')).toMatchObject({ kind: 'abono', amount: '15990' })
  })
})

describe('confirm paths', () => {
  it('exigen el tipo correcto y pesos para montos en otra moneda', async () => {
    const credit = await stageOne({ date: '2026-08-17', description: 'ABONO CANJE', amount: '3145', kind: 'abono' })
    const charge = await stageOne({ date: '2026-08-12', description: 'TAXI', amount: '5130' })
    const usd = await stageOne({ date: '2026-08-02', description: 'ANTHROPIC CLAUDE SUB', amount: '119', currency: 'USD' })
    const confirm = (id: number, amount: string) =>
      finance.ConfirmImportItem(id, '2026-08-02', 'x', '', '', null, 'unico', amount, 1, '')

    expect((await confirm(credit.id, '3145')).error?.code).toBe('VALIDATION_ERROR')
    expect((await finance.LinkImportItem(credit.id, 1)).error?.code).toBe('VALIDATION_ERROR')
    expect((await finance.ConfirmImportItemAsIncome(charge.id, '2026-08', 'x', '5130')).error?.code).toBe(
      'VALIDATION_ERROR',
    )
    expect((await confirm(usd.id, '119')).error?.code).toBe('VALIDATION_ERROR')
    expect((await confirm(usd.id, '112948.5')).error?.code).toBe('VALIDATION_ERROR')
    expect((await confirm(usd.id, '112948')).error).toBeUndefined()
    expect((await finance.ConfirmImportItemAsIncome(credit.id, '2026-08', 'Canje', '3145')).error).toBeUndefined()
  })

  it('un gasto acepta un solo movimiento enlazado', async () => {
    const ex = await finance.CreateExpense('2026-08-12', 'Taxi', '', '', null, 'unico', '5130', 1)
    const first = await stageOne({ date: '2026-08-12', description: 'TAXI UNO', amount: '5130' })
    const second = await stageOne({ date: '2026-08-12', description: 'TAXI DOS', amount: '5130' })
    expect((await finance.LinkImportItem(first.id, ex.data!.id)).error).toBeUndefined()
    expect((await finance.LinkImportItem(second.id, ex.data!.id)).error?.code).toBe('CONFLICT')
  })

  it('un confirmado se puede reabrir cuando su gasto va a la papelera', async () => {
    const it0 = await stageOne({ date: '2026-08-12', description: 'TAXI', amount: '5130' })
    const r = await finance.ConfirmImportItem(it0.id, '2026-08-12', 'Taxi', '', '', null, 'unico', '5130', 1, '')
    expect((await finance.RestoreImportItem(it0.id)).error?.code).toBe('CONFLICT')
    expect((await finance.ListImportItems('confirmado')).data?.[0]?.reopenable).toBe(false)

    await finance.DeleteExpense(r.data!.id)
    expect((await finance.ListImportItems('confirmado')).data?.[0]?.reopenable).toBe(true)
    expect((await finance.RestoreImportItem(it0.id)).error).toBeUndefined()
    const back = await pending()
    expect(back).toHaveLength(1)
    expect(back[0]?.expenseId).toBeNull()
  })
})

describe('fixed-expense bills', () => {
  it('sugiere el gasto fijo y al enlazar marca el mes pagado con el monto real', async () => {
    const fe = await finance.CreateFixedExpense('Plan Entel', 'Servicios', null, '2026-07', '17000')
    const bill = await stageOne({ date: '2026-08-05', description: 'ENTEL PCS PAGO ENSANTIAGO C', amount: '16990' })
    expect(bill.suggestedFixedId).toBe(fe.data!.id)
    expect(bill.suggestedFixedPeriod).toBe('2026-08')
    for (const c of [
      { date: '2026-08-06', description: 'TRANSFERENCIA A JUAN', amount: '17000' },
      { date: '2026-08-07', description: 'ENTEL TIENDA EQUIPO', amount: '250000' },
      { date: '2026-06-05', description: 'ENTEL PCS PAGO JUNIO', amount: '17000' },
    ]) {
      expect((await stageOne(c)).suggestedFixedId, c.description).toBeNull()
    }

    expect((await finance.LinkImportItemToFixed(bill.id, fe.data!.id, '2026-08')).error).toBeUndefined()
    for (const [period, amount, status] of [
      ['2026-08', '16990', 'pagado'],
      ['2026-09', '17000', 'pendiente'],
    ] as const) {
      const mov = (await finance.MonthlySummary(period)).data?.movimientos.find((m) => m.fixedId === fe.data!.id)
      expect(mov, period).toMatchObject({ amount, status })
    }

    const again = await stageOne({ date: '2026-08-20', description: 'ENTEL PCS PAGO OTRO', amount: '16990' })
    expect(again.suggestedFixedId).toBeNull()
    expect((await finance.LinkImportItemToFixed(again.id, fe.data!.id, '2026-08')).error?.code).toBe('CONFLICT')
    expect((await finance.LinkImportItemToFixed(again.id, fe.data!.id, '2026-06')).error?.code).toBe(
      'VALIDATION_ERROR',
    )
  })

  it('namesMatch compara palabras significativas', () => {
    expect(namesMatch('Plan Entel', 'ENTEL PCS PAGO ENSANTIAGO C')).toBe(true)
    expect(namesMatch('Claude', 'ANTHROPIC* CLAUDE SUB')).toBe(true)
    expect(namesMatch('Proseguro', 'PROSEGUR ACTIVA')).toBe(true)
    expect(namesMatch('Netflix', 'APPLE.COM/BILL')).toBe(false)
    expect(namesMatch('Luz', 'ENEL DISTRIBUCION')).toBe(false)
  })
})

describe('international payments', () => {
  it('un pago ya descartado igual concilia y enseña la tasa', async () => {
    const payment = await stageOne({
      date: '2026-07-31', description: 'PAGO DEUDA INTER. TC CTA CLP', amount: '94900', hint: 'card_payment',
    })
    await finance.DiscardImportItem(payment.id)
    const r = await finance.ImportCardStatement({
      ...blankStatement,
      issuer: 'itau', kind: 'internacional', currency: 'USD', cardLastDigits: '4321',
      statementDate: '2026-08-25', periodTo: '2026-08-25', totalBilled: '20',
      lines: [
        line({ section: 'pago', operationDate: '2026-07-30', reference: '3007', description: 'MONTO CANCELADO',
          installmentAmount: '-100', originAmount: '-100' }),
        line({ section: 'compra', operationDate: '2026-08-02', reference: '0308 99', description: 'SERVICIO WEB SUB',
          installmentAmount: '20', originAmount: '20' }),
      ],
    })
    expect(r.data?.paymentsMatched).toBe(1)
    expect((await pending()).find((i) => i.description === 'SERVICIO WEB SUB')?.suggestedAmountClp).toBe('18980')
  })
})
