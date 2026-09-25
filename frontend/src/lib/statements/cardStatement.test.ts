import { describe, expect, it } from 'vitest'
import { parseStatement } from '@/lib/statements/detect'
import { syntheticCardStatementRuns as fixture } from '@/lib/statements/itau/testdata/cardStatementRuns'
import type { TextRun } from '@/lib/statements/layout'
import type { CardStatementInput } from '@/services/contract'
import { createTestDb } from '@/engine/testing/db'
import { createFinanceService } from '@/engine/finance/service'
import { createSession } from '@/engine/users/service'

function statements(runs: readonly TextRun[]): { list: CardStatementInput[]; warnings: string[]; notes: string[] } {
  const parsed = parseStatement(runs)
  if (parsed.kind !== 'cardStatements') throw new Error(`parsed as ${parsed.kind}`)
  return { list: parsed.statements, warnings: parsed.warnings, notes: parsed.notes }
}

const lineTuple = (l: CardStatementInput['lines'][number]) => [
  l.section, l.place, l.operationDate, l.reference, l.description, l.interestRate,
  l.operationAmount, `${l.installmentNumber}/${l.installmentsTotal}`, l.installmentAmount,
]

describe('estado de cuenta tarjeta Itaú', () => {
  it('lee el estado nacional completo: cabecera, cupos, tasas, período anterior, movimientos y calendario', () => {
    const { list, warnings, notes } = statements(fixture)
    expect(warnings).toEqual([])
    expect(list).toHaveLength(2)
    const { lines, schedule, ...head } = list[0]!
    expect(head).toEqual({
      issuer: 'itau', kind: 'nacional', currency: 'CLP', cardLastDigits: '4321', statementDate: '2026-08-25',
      periodFrom: '2026-07-28', periodTo: '2026-08-25', dueDate: '2026-09-08',
      previousPeriodFrom: '2026-06-24', previousPeriodTo: '2026-07-27', nextPeriodFrom: '2026-08-26', nextPeriodTo: '2026-09-23',
      creditLimit: '2000000', creditUsed: '450000', creditAvailable: '1550000',
      cashLimit: '2000000', cashUsed: '0', cashAvailable: '1550000',
      previousBalanceStart: '0', previousBilled: '50000', previousPaid: '-50000', previousBalanceEnd: '0',
      transferFromNational: '', totalOperations: '4685', voluntaryProducts: '0', chargesNet: '7810', totalBilled: '62495',
      minimumPayment: '62495', prepaymentCost: '450000', automaticCharge: '0', unbilledBalance: '387505',
      rateRevolving: '2.10', rateInstallments: '3.90', rateCashAdvance: '3.95',
      caeRevolving: '60.10', caeInstallments: '58.20', caeCashAdvance: '66.40', caePrepayment: '12.50',
      lateInterestRate: '28.50', fileHash: '',
    })
    expect(schedule).toEqual([
      { period: '2026-09', amount: '40000' },
      { period: '2026-10', amount: '40000' },
      { period: '2026-11', amount: '30000' },
      { period: '2026-12', amount: '30000' },
    ])
    expect(lines.map(lineTuple)).toEqual([
      ['pago', '', '2026-08-10', '1008 00000000', 'MONTO CANCELADO', '', '-50000', '1/1', '-50000'],
      ['compra', 'SANTIAGO', '2026-06-16', '2508 11111111', 'TIENDA UNO', '0.00', '30000', '2/3', '10000'],
      ['compra', 'SANTIAGO', '2026-06-20', '2508 22222222', 'MP *TIENDA DOS', '0.00', '60001', '3/6', '10000'],
      ['compra', 'SANTIAGO', '2026-08-12', '1308 33333333', 'TAXI *VIAJE', '', '2340', '1/1', '2340'],
      ['compra', 'CHILLAN', '2026-08-14', '1408 44444444', 'FARMACIA CENTRO CHILLAN', '', '12345', '1/1', '12345'],
      ['compra', 'Las Condes', '2026-08-20', '2508 55555555', 'ELECTRO HOGAR', '0.00', '240000', '1/12', '20000'],
      ['cargo', '', '2026-08-10', '1008 00000000', 'IMPUESTO DECRETO LEY 3475 TASA 0,066 %', '', '150', '1/1', '150'],
      ['abono', '', '2026-08-17', '1708 00000000', 'ABONO CANJE COMPRA TC', '', '-2340', '1/1', '-2340'],
      ['abono', '', '2026-08-21', '2108 00000000', 'CASHBACK COM AGO26', '', '-10000', '1/1', '-10000'],
      ['cargo', '', '2026-08-25', '2508 00000000', 'COMISION ADMINISTRACION MENSUAL', '', '20000', '1/1', '20000'],
    ])
    expect(notes).toEqual([
      'Estado nacional ••4321 al 25/08/2026 (CLP): 1 pago, 5 compras, 2 cargos, 2 abonos.',
      'Estado internacional ••4321 al 25/08/2026 (USD): 1 pago, 1 compra, 1 abono.',
    ])
  })

  it('lee el estado internacional en dólares con ciudad, país y monto de origen', () => {
    const { lines, schedule, ...head } = statements(fixture).list[1]!
    expect(head).toMatchObject({
      kind: 'internacional', currency: 'USD', cardLastDigits: '4321', statementDate: '2026-08-25',
      periodFrom: '2026-07-28', periodTo: '2026-08-25', dueDate: '2026-09-08',
      creditLimit: '2500.00', creditUsed: '17.75', creditAvailable: '2482.25', cashUsed: '0.00',
      previousBilled: '100.00', previousPaid: '-100.00', transferFromNational: '0.00', totalBilled: '17.75', chargesNet: '-2.25',
    })
    expect(schedule).toEqual([])
    expect(lines.map((l) => [l.section, l.reference, l.operationDate, l.description, l.city, l.country, l.originAmount, l.installmentAmount]))
      .toEqual([
        ['pago', '3007', '2026-07-30', 'MONTO CANCELADO', '', 'CL', '-100.00', '-100.00'],
        ['compra', '0308 11112222333344445555666', '2026-08-02', 'SERVICIO WEB SUB', 'SAN FRANCISCO', 'US', '20.00', '20.00'],
        ['abono', '1008 99998888777766665555444', '2026-08-07', 'TIENDA APPS', 'CUPERTINO', 'US', '-2027.00', '-2.25'],
      ])
  })

  it('no depende del orden en que el PDF entrega el texto', () => {
    expect(statements(fixture.toReversed()).list).toEqual(statements(fixture).list)
  })

  it('avisa cuando una fila no se pudo leer y los totales dejan de cuadrar', () => {
    // Drop the charged amount of the FARMACIA purchase.
    const tampered = fixture.filter((r) => !(r.page === 2 && r.str === '$12.345' && r.x > 540))
    const { list, warnings } = statements(tampered)
    expect(list[0]!.lines.some((l) => l.description.startsWith('FARMACIA'))).toBe(false)
    expect(warnings).toEqual([
      expect.stringMatching(/^Página 2: la fila «CHILLAN 14\/08\/26 .*» no tiene monto legible\.$/),
      'Estado nacional: el total de compras no cuadra (calculado 42340, informado 54685). Revisa el estado de cuenta.',
      'Estado nacional: el total de operaciones (B) no cuadra (calculado -7660, informado 4685). Revisa el estado de cuenta.',
    ])
  })

  it('avisa cuando A+B+C+D no es el total facturado', () => {
    const tampered = fixture.map((r) => (r.page === 3 && r.str === '$62.495' ? { ...r, str: '$62.496' } : r))
    expect(statements(tampered).warnings).toEqual([
      'Estado nacional: el total facturado (A+B+C+D) no cuadra (calculado 62495, informado 62496). Revisa el estado de cuenta.',
      'Estado nacional: el cupo utilizado no cuadra (calculado 450001, informado 450000). Revisa el estado de cuenta.',
    ])
  })

  it('el motor acepta lo leído y concilia la cuota con el gasto existente', async () => {
    const db = await createTestDb()
    const finance = createFinanceService(db, createSession(db))
    const card = await finance.CreateCard('Tarjeta', '2000000', 25, '4321')
    await finance.CreateExpense('2026-06-16', 'Tienda uno', '', '', card.data!.id, 'cuotas', '10000', 3)
    const [national, international] = statements(fixture).list
    const r = await finance.ImportCardStatement(national!)
    expect(r.error).toBeUndefined()
    // 10 lines: 1 payment (nothing to reconcile), 1 cuota linked, 8 staged.
    expect(r.data).toMatchObject({ linkedInstallments: 1, added: 8, paymentsMatched: 0 })
    const usd = await finance.ImportCardStatement(international!)
    expect(usd.error).toBeUndefined()
    expect(usd.data).toMatchObject({ added: 2 })
  })
})
