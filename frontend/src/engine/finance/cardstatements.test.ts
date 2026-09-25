// Mirror of backend/finance/cardstatement_test.go: same synthetic statements
// (invented merchants and amounts) and expected values, so the web engine's
// card-statement import can never drift from the Go backend.
import { beforeEach, describe, expect, it } from 'vitest'
import { createTestDb } from '@/engine/testing/db'
import { createFinanceService } from '@/engine/finance/service'
import { createSession } from '@/engine/users/service'
import { blankStatement, statementLine } from '@/engine/testing/cardStatement'
import type { SqlDb } from '@/engine/db/types'
import type {
  CardStatementImport,
  CardStatementInput,
  CardStatementLineInput,
  FinanceServiceContract,
  ImportBatch,
  ImportCandidate,
  ImportItemView,
} from '@/services/contract'

let db: SqlDb
let finance: FinanceServiceContract

async function newService(): Promise<FinanceServiceContract> {
  db = await createTestDb()
  return createFinanceService(db, createSession(db))
}

beforeEach(async () => {
  finance = await newService()
})

const line = statementLine

const tiendaDosCuota = (n: number): CardStatementLineInput =>
  line({
    section: 'compra', operationDate: '2026-06-20', reference: '2508 22222222', description: 'TIENDA DOS',
    operationAmount: '60001', totalAmount: '60001', installmentNumber: n, installmentsTotal: 6, installmentAmount: '10000',
  })

function nationalStatement(): CardStatementInput {
  return {
    ...blankStatement,
    issuer: 'itau', kind: 'nacional', currency: 'CLP', cardLastDigits: '4321',
    statementDate: '2026-08-25', periodFrom: '2026-07-28', periodTo: '2026-08-25', dueDate: '2026-09-08',
    previousPeriodFrom: '2026-06-24', previousPeriodTo: '2026-07-27',
    nextPeriodFrom: '2026-08-26', nextPeriodTo: '2026-09-23',
    creditLimit: '1000000', creditUsed: '300000', creditAvailable: '700000',
    cashLimit: '1000000', cashUsed: '0', cashAvailable: '700000',
    previousBalanceStart: '0', previousBilled: '100000', previousPaid: '-100000', previousBalanceEnd: '0',
    totalOperations: '22340', voluntaryProducts: '0', chargesNet: '8000', totalBilled: '130340',
    minimumPayment: '130340', prepaymentCost: '300000', automaticCharge: '0', unbilledBalance: '169660',
    rateRevolving: '2.56', rateInstallments: '4.25', rateCashAdvance: '4.25',
    caeRevolving: '65.21', caeInstallments: '62.28', caeCashAdvance: '71.93', caePrepayment: '13.33',
    lateInterestRate: '30.72',
    lines: [
      line({ section: 'pago', operationDate: '2026-08-10', reference: '1008 00000000', description: 'MONTO CANCELADO',
        operationAmount: '-100000', totalAmount: '-100000', installmentAmount: '-100000' }),
      // Cuota 2 of 3 of a purchase the user already has in the app.
      line({ section: 'compra', place: 'SANTIAGO', operationDate: '2026-06-16', reference: '2508 11111111',
        description: 'TIENDA UNO', interestRate: '0', operationAmount: '30000', totalAmount: '30000',
        installmentNumber: 2, installmentsTotal: 3, installmentAmount: '10000' }),
      // Cuota 3 of 6 of a purchase the app does not have: 60001 / 6 billed as 10000.
      { ...tiendaDosCuota(3), place: 'SANTIAGO', interestRate: '0' },
      line({ section: 'compra', place: 'SANTIAGO', operationDate: '2026-08-12', reference: '1308 33333333',
        description: 'TAXI VIAJE SANTIAGO', operationAmount: '2340', totalAmount: '2340',
        installmentNumber: 1, installmentsTotal: 1, installmentAmount: '2340' }),
      line({ section: 'cargo', operationDate: '2026-08-25', reference: '2508 00000000',
        description: 'COMISION ADMINISTRACION MENSUAL', operationAmount: '20000', totalAmount: '20000',
        installmentAmount: '20000' }),
      line({ section: 'abono', operationDate: '2026-08-21', reference: '2108 00000000', description: 'CASHBACK COM AGO26',
        operationAmount: '-10000', totalAmount: '-10000', installmentAmount: '-10000' }),
      line({ section: 'abono', operationDate: '2026-08-17', reference: '1708 00000000', description: 'ABONO CANJE COMPRA TC',
        operationAmount: '-2340', totalAmount: '-2340', installmentAmount: '-2340' }),
    ],
    schedule: [
      { period: '2026-09', amount: '20000' },
      { period: '2026-10', amount: '20000' },
    ],
  }
}

function internationalStatement(): CardStatementInput {
  return {
    ...blankStatement,
    issuer: 'itau', kind: 'internacional', currency: 'USD', cardLastDigits: '4321',
    statementDate: '2026-08-25', periodFrom: '2026-07-28', periodTo: '2026-08-25', dueDate: '2026-09-08',
    creditLimit: '1000', creditUsed: '20', creditAvailable: '980',
    previousBilled: '100', previousPaid: '-100', totalBilled: '20',
    lines: [
      line({ section: 'pago', operationDate: '2026-07-30', reference: '3007', description: 'MONTO CANCELADO',
        country: 'CL', installmentAmount: '-100', originAmount: '-100' }),
      line({ section: 'compra', operationDate: '2026-08-02', reference: '0308 99', description: 'SERVICIO WEB SUB',
        city: 'SAN FRANCISCO', country: 'US', installmentAmount: '20', originAmount: '20' }),
    ],
  }
}

// nextMonth is the following statement, billing only cuota n of TIENDA DOS.
function nextMonth(n: number): CardStatementInput {
  return {
    ...nationalStatement(),
    statementDate: '2026-09-23', periodFrom: '2026-08-26', periodTo: '2026-09-23',
    lines: [tiendaDosCuota(n)],
  }
}

async function importStatement(input: CardStatementInput, svc = finance): Promise<CardStatementImport> {
  const r = await svc.ImportCardStatement(input)
  expect(r.error).toBeUndefined()
  return r.data!
}

async function list(status: string, svc = finance): Promise<ImportItemView[]> {
  const r = await svc.ListImportItems(status)
  expect(r.error).toBeUndefined()
  return r.data!
}

async function pendingByDescription(svc = finance): Promise<Map<string, ImportItemView>> {
  return new Map((await list('pendiente', svc)).map((it) => [it.description, it]))
}

const candidate = (c: Partial<ImportCandidate>): ImportCandidate => ({
  date: '', description: '', amount: '', currency: '', cardLastDigits: '', account: '', reference: '',
  installmentsTotal: 0, hint: '', ...c,
})

async function stageCartola(svc: FinanceServiceContract, ...items: Partial<ImportCandidate>[]) {
  const batch: ImportBatch = { source: 'pdf_account', issuer: 'itau', items: items.map(candidate) }
  const r = await svc.StageImport(batch)
  expect(r.error).toBeUndefined()
  return r.data!
}

async function createCard(): Promise<number> {
  const card = await finance.CreateCard('Itaú', '1000000', 26, '4321')
  expect(card.error).toBeUndefined()
  return card.data!.id
}

describe('ImportCardStatement', () => {
  it('guarda todo el estado y alimenta la bandeja', async () => {
    const cardId = await createCard()
    // The purchase whose cuota 2/3 the statement bills is already in the app.
    const existing = await finance.CreateExpense('2026-06-16', 'Tienda uno', 'Hogar', '', cardId, 'cuotas', '10000', 3)
    expect(existing.error).toBeUndefined()

    const got = await importStatement(nationalStatement())
    expect(got).toMatchObject({ alreadyImported: false, linkedInstallments: 1, added: 5, paymentsMatched: 0 })

    const pending = await pendingByDescription()
    expect(pending.has('TIENDA UNO')).toBe(false)
    expect(pending.get('TIENDA DOS')).toMatchObject({
      amount: '60001', installmentsTotal: 6, installmentNumber: 3, installmentAmount: '10000',
      firstPeriod: '2026-06', cardName: 'Itaú',
    })
    expect(pending.get('CASHBACK COM AGO26')).toMatchObject({ kind: 'abono', amount: '10000' })
    expect(pending.get('COMISION ADMINISTRACION MENSUAL')).toMatchObject({ kind: 'gasto', amount: '20000' })

    const statements = await finance.ListCardStatements('2026-08')
    expect(statements.error).toBeUndefined()
    expect(statements.data).toHaveLength(1)
    const v = statements.data![0]!
    expect(v).toMatchObject({
      period: '2026-08', cardName: 'Itaú', totalBilled: '130340', dueDate: '2026-09-08',
      bankCharges: '42340', bankCredits: '12340', pendingItems: 5, caePrepayment: '13.33', unbilledBalance: '169660',
      // The app has only the linked cuota (10000) on the card for 2026-08 so far.
      appCharges: '10000',
    })

    const detail = await finance.GetCardStatement(v.id)
    expect(detail.error).toBeUndefined()
    expect(detail.data!.lines).toHaveLength(7)
    expect(detail.data!.schedule).toHaveLength(2)
    const byDesc = new Map(detail.data!.lines.map((l) => [l.description, l]))
    expect(byDesc.get('TIENDA UNO')?.expenseId).toBe(existing.data!.id)
    expect(byDesc.get('ABONO CANJE COMPRA TC')).toMatchObject({
      redeemedPurchase: 'TAXI VIAJE SANTIAGO', itemStatus: 'pendiente',
    })

    const again = await importStatement(nationalStatement())
    expect(again).toMatchObject({ alreadyImported: true, statementId: v.id, added: 0 })
  })

  it('confirma cuotas en su período y abonos como ingreso extra', async () => {
    const cardId = await createCard()
    await importStatement(nationalStatement())
    const pending = await pendingByDescription()

    // Cuota 3/6: cuota 1 in 2026-06 and the first two already paid.
    const dos = pending.get('TIENDA DOS')!
    const ex = await finance.ConfirmImportItem(dos.id, dos.date, 'Tienda dos', 'Hogar', '', cardId, 'cuotas', dos.installmentAmount, 6, '')
    expect(ex.error).toBeUndefined()
    const insts = db.query('SELECT period, status FROM installments WHERE expense_id = ? ORDER BY number ASC', [ex.data!.id])
    expect(insts.map((r) => r.period)).toEqual(['2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11'])
    expect(insts.map((r) => r.status)).toEqual(['pagado', 'pagado', 'pendiente', 'pendiente', 'pendiente', 'pendiente'])

    const cash = pending.get('CASHBACK COM AGO26')!
    const inc = await finance.ConfirmImportItemAsIncome(cash.id, '2026-08', 'Devolución comisión', cash.amount)
    expect(inc.error).toBeUndefined()
    const sum = await finance.MonthlySummary('2026-08')
    expect(sum.data!.extras).toBe('10000')
    expect((await finance.ConfirmImportItemAsIncome(cash.id, '2026-08', 'x', '1')).error?.code).toBe('CONFLICT')
    const taxi = pending.get('TAXI VIAJE SANTIAGO')!
    expect((await finance.ConfirmImportItemAsIncome(taxi.id, '2026-8', 'x', '1')).error?.code).toBe('VALIDATION_ERROR')

    // Next month the confirmed purchase bills cuota 4/6: linked, not reviewed.
    expect(await importStatement(nextMonth(4))).toMatchObject({ linkedInstallments: 1, added: 0 })
    const sep = await finance.ListCardStatements('2026-09')
    expect(sep.data).toHaveLength(1)
    expect(sep.data![0]!.appCharges).toBe('10000')
  })

  it('una cuota aún sin confirmar no entra dos veces a la bandeja', async () => {
    await importStatement(nationalStatement())
    expect(await importStatement(nextMonth(4))).toMatchObject({ duplicates: 1, added: 0 })
  })

  it('los pagos del estado concilian la cartola en ambos sentidos', async () => {
    // Cartola first: the national payment and the USD-debt payment in CLP.
    await stageCartola(
      finance,
      { date: '2026-08-09', description: 'PAGO DEUDA TC CTA', amount: '100000', hint: 'card_payment' },
      { date: '2026-07-31', description: 'PAGO DEUDA INTER. TC CTA CLP', amount: '95000', hint: 'card_payment' },
    )
    expect((await importStatement(nationalStatement())).paymentsMatched).toBe(1)
    expect((await importStatement(internationalStatement())).paymentsMatched).toBe(1)
    const conc = new Map((await list('conciliado')).map((it) => [it.description, it.statementLineId != null]))
    expect(conc.get('PAGO DEUDA TC CTA')).toBe(true)
    expect(conc.get('PAGO DEUDA INTER. TC CTA CLP')).toBe(true)
    // 95000 CLP paid 100 USD → 950 CLP/USD: the 20 USD purchase ≈ 19000 CLP.
    expect((await pendingByDescription()).get('SERVICIO WEB SUB')).toMatchObject({
      currency: 'USD', amount: '20', suggestedAmountClp: '19000',
    })

    // The other direction: the statement first, the cartola payment later.
    const other = await newService()
    await importStatement(nationalStatement(), other)
    const staged = await stageCartola(other, {
      date: '2026-08-11', description: 'PAGO DEUDA TC CTA', amount: '100000', hint: 'card_payment',
    })
    expect(staged.reconciled).toBe(1)
  })

  it.each<[string, (s: CardStatementInput) => void, string]>([
    ['kind', (s) => void (s.kind = 'otro'), 'tipo'],
    ['digits', (s) => void (s.cardLastDigits = ''), 'dígitos'],
    ['date', (s) => void (s.statementDate = '25/08/2026'), 'fecha del estado'],
    ['money', (s) => void (s.totalBilled = '1.234.567'), 'total facturado'],
    ['section', (s) => void (s.lines[0]!.section = 'x'), 'movimiento 1'],
    ['cuota', (s) => void (s.lines[1]!.installmentNumber = 4), 'cuota 4 de 3'],
    ['schedule', (s) => void (s.schedule[0]!.period = 'sept'), 'calendario'],
  ])('valida %s', async (_name, mutate, want) => {
    const input = nationalStatement()
    mutate(input)
    const r = await finance.ImportCardStatement(input)
    expect(r.error?.code).toBe('VALIDATION_ERROR')
    expect(r.error?.message).toContain(want)
    expect((await finance.ListCardStatements('')).data).toHaveLength(0)
  })

  it('borrar un estado conserva sus ítems y permite reimportarlo', async () => {
    const got = await importStatement(nationalStatement())
    expect((await finance.DeleteCardStatement(got.statementId)).error).toBeUndefined()
    expect((await finance.GetCardStatement(got.statementId)).error?.code).toBe('NOT_FOUND')
    // No card nor prior expense here, so all 6 non-payment lines were staged.
    expect(await list('pendiente')).toHaveLength(6)
    expect(await importStatement(nationalStatement())).toMatchObject({ alreadyImported: false, duplicates: 6 })
  })
})
