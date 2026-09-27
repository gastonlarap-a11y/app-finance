// Credit-card statement formats beyond Itaú's emailed PDF (cardStatement.test.ts):
// Banco de Chile's (same CMF standard, other issuer and text runs) and Itaú's
// downloaded from its website (another layout).
import { describe, expect, it } from 'vitest'
import { parseStatement } from '@/lib/statements/detect'
import { syntheticBancoChileRuns as bancoChile } from '@/lib/statements/bancochile/testdata/cardStatementRuns'
import { syntheticItauWebRuns as itauWeb } from '@/lib/statements/itau/testdata/webCardStatementRuns'
import type { TextRun } from '@/lib/statements/layout'
import type { CardStatementInput } from '@/services/contract'
import { createTestDb } from '@/engine/testing/db'
import { createFinanceService } from '@/engine/finance/service'
import { createSession } from '@/engine/users/service'

function parse(runs: readonly TextRun[]) {
  const parsed = parseStatement(runs)
  if (parsed.kind !== 'cardStatements') throw new Error(`parsed as ${parsed.kind}`)
  return { ...parsed, list: parsed.statements }
}

const lineTuple = (l: CardStatementInput['lines'][number]) => [
  l.section, l.place, l.operationDate, l.reference, l.description, l.interestRate,
  l.operationAmount, `${l.installmentNumber}/${l.installmentsTotal}`, l.installmentAmount,
]

describe('estado de cuenta tarjeta Banco de Chile', () => {
  it('se reconoce como Banco de Chile, no como Itaú, y se lee completo', () => {
    const { list, warnings, notes, format } = parse(bancoChile)
    expect(format).toBe('Estado de cuenta tarjeta de crédito Banco de Chile')
    expect(warnings).toEqual([])
    expect(list).toHaveLength(1)
    const { lines, schedule, ...head } = list[0]!
    expect(head).toEqual({
      issuer: 'bancochile', kind: 'nacional', currency: 'CLP', cardLastDigits: '4321', statementDate: '2026-07-22',
      periodFrom: '2026-06-19', periodTo: '2026-07-22', dueDate: '2026-08-04',
      previousPeriodFrom: '2026-05-20', previousPeriodTo: '2026-06-18', nextPeriodFrom: '2026-07-23', nextPeriodTo: '2026-08-19',
      creditLimit: '1000000', creditUsed: '425960', creditAvailable: '574040',
      cashLimit: '900000', cashUsed: '0', cashAvailable: '574040',
      previousBalanceStart: '0', previousBilled: '0', previousPaid: '0', previousBalanceEnd: '0',
      transferFromNational: '', totalOperations: '', voluntaryProducts: '0', chargesNet: '5960', totalBilled: '75960',
      minimumPayment: '20000', prepaymentCost: '425960', automaticCharge: '0', unbilledBalance: '350000',
      rateRevolving: '2.55', rateInstallments: '2.87', rateCashAdvance: '2.87',
      caeRevolving: '50.23', caeInstallments: '42.18', caeCashAdvance: '49.36', caePrepayment: '10.67',
      lateInterestRate: '30.60', fileHash: '',
    })
    expect(schedule).toEqual([
      { period: '2026-08', amount: '20000' },
      { period: '2026-09', amount: '20000' },
      { period: '2026-10', amount: '20000' },
      { period: '2026-11', amount: '20000' },
    ])
    expect(lines.map(lineTuple)).toEqual([
      ['compra', 'SANTIAGO', '2026-07-04', '060711111111', 'ZAPATERIA UNO', '', '50000', '1/1', '50000'],
      ['compra', 'LAS CONDES', '2026-07-10', '130722222222', 'MERCADOPAGO*TIENDA DOS', '', '10000', '1/1', '10000'],
      ['compra', 'LAS CONDES', '2026-07-03', '220733333333', 'TIENDA TRES', '0.00', '120000', '1/12', '10000'],
      ['cargo', '', '2026-07-22', '220700000000', 'COMISION ADMINISTRACION MENSUAL', '', '5000', '1/1', '5000'],
      ['cargo', '', '2026-07-06', '060744444444', 'IMPUESTO DECRETO LEY 3475 TASA 0,800 %', '', '960', '1/1', '960'],
      ['diferida', 'LAS CONDES', '2026-07-06', '070744444444', 'TIENDA CUATRO', '0.00', '240000', '0/24', '10000'],
    ])
    expect(notes).toEqual([
      'Estado nacional ••4321 al 22/07/2026 (CLP): 3 compras, 1 compra en cuotas por comenzar, 2 cargos.',
    ])
  })

  it('no depende del orden en que el PDF entrega el texto', () => {
    expect(parse(bancoChile.toReversed()).list).toEqual(parse(bancoChile).list)
  })

  it('avisa cuando las compras no suman los totales de una cuota y en cuotas', () => {
    const tampered = bancoChile.map((r) => (r.page === 2 && r.y === 546 && r.str === '60.000' ? { ...r, str: '60.001' } : r))
    expect(parse(tampered).warnings).toEqual([
      'Estado nacional: el total de compras no cuadra (calculado 70000, informado 70001). Revisa el estado de cuenta.',
    ])
  })

  it('el motor guarda la compra por comenzar con su primera cuota el mes siguiente', async () => {
    const db = await createTestDb()
    const finance = createFinanceService(db, createSession(db))
    const r = await finance.ImportCardStatement(parse(bancoChile).list[0]!)
    expect(r.error).toBeUndefined()
    expect(r.data).toMatchObject({ added: 6 })
    const items = (await finance.ListImportItems('pendiente')).data!
    expect(items.find((it) => it.description === 'TIENDA CUATRO')).toMatchObject({
      issuer: 'bancochile', firstPeriod: '2026-08', installmentNumber: 1, installmentsTotal: 24,
      installmentAmount: '10000', amount: '240000', reference: '070744444444',
    })
  })
})

describe('estado de cuenta tarjeta Itaú descargado de la web', () => {
  it('se lee completo y cuadra con el total facturado', () => {
    const { list, warnings, notes, format } = parse(itauWeb)
    expect(format).toBe('Estado de cuenta tarjeta de crédito Itaú (descargado de la web)')
    expect(warnings).toEqual([])
    const { lines, schedule, ...head } = list[0]!
    expect(head).toEqual({
      issuer: 'itau', kind: 'nacional', currency: 'CLP', cardLastDigits: '4321', statementDate: '2026-09-23',
      periodFrom: '2026-08-26', periodTo: '2026-09-23', dueDate: '2026-10-06',
      previousPeriodFrom: '2026-07-28', previousPeriodTo: '2026-08-25', nextPeriodFrom: '2026-09-24', nextPeriodTo: '2026-10-26',
      creditLimit: '1000000', creditUsed: '224300', creditAvailable: '775700',
      cashLimit: '1000000', cashUsed: '0', cashAvailable: '775700',
      previousBalanceStart: '0', previousBilled: '50000', previousPaid: '-50000', previousBalanceEnd: '0',
      transferFromNational: '', totalOperations: '-20000', voluntaryProducts: '0', chargesNet: '4300', totalBilled: '34300',
      minimumPayment: '34300', prepaymentCost: '224300', automaticCharge: '0', unbilledBalance: '190000',
      rateRevolving: '2.5', rateInstallments: '4.16', rateCashAdvance: '4.16',
      caeRevolving: '64.13', caeInstallments: '61.94', caeCashAdvance: '71.5', caePrepayment: '14.05',
      lateInterestRate: '30', fileHash: '',
    })
    expect(schedule).toEqual([
      { period: '2026-10', amount: '40000' },
      { period: '2026-11', amount: '40000' },
      { period: '2026-12', amount: '40000' },
      { period: '2027-01', amount: '10000' },
    ])
    expect(lines.map(lineTuple)).toEqual([
      ['compra', '', '2026-08-14', '2026081411111111', 'Tienda Uno', '0.00', '120000', '2/12', '10000'],
      ['compra', '', '2026-08-28', '2026082822222222', 'Seguro Hogar Santiago', '', '20000', '1/1', '20000'],
      ['pago', '', '2026-08-28', '2026082800000000', 'Monto Cancelado', '', '-50000', '1/1', '-50000'],
      ['cargo', '', '2026-09-14', '2026091433333333', 'Impuesto Decreto Ley 3475 Tasa 0,264 %', '', '300', '1/1', '300'],
      ['abono', '', '2026-09-21', '2026092100000000', 'Cashback Com Sep26', '', '-1000', '1/1', '-1000'],
      ['cargo', '', '2026-09-23', '2026092300000000', 'Comision Administracion Mensual', '', '5000', '1/1', '5000'],
      ['diferida', '', '2026-09-12', '2026091244444444', 'Tienda Cinco', '0.00', '90000', '0/3', '30000'],
    ])
    expect(notes).toEqual([
      'Estado nacional ••4321 al 23/09/2026 (CLP): 1 pago, 2 compras, 1 compra en cuotas por comenzar, 2 cargos, 1 abono.',
    ])
  })

  it('no depende del orden en que el PDF entrega el texto', () => {
    expect(parse(itauWeb.toReversed()).list).toEqual(parse(itauWeb).list)
  })

  it('avisa cuando los movimientos no suman el total facturado', () => {
    const tampered = itauWeb.filter((r) => !(r.page === 2 && r.y === 506))
    expect(parse(tampered).warnings).toEqual([
      'Estado nacional: el total facturado no cuadra (calculado 35300, informado 34300). Revisa el estado de cuenta.',
    ])
  })

  it('rechaza el estado internacional de la web, que aún no se admite', () => {
    const international = itauWeb.map((r) => (r.str === 'Estado de cuenta nacional' ? { ...r, str: 'Estado de cuenta internacional' } : r))
    expect(() => parseStatement(international)).toThrow(/internacional descargado de la web/)
  })
})
