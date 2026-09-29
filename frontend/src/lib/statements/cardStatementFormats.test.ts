// Credit-card statement formats beyond Itaú's emailed PDF (cardStatement.test.ts):
// Banco de Chile's (same CMF standard, other issuer and text runs), Itaú's
// downloaded from its website, Cencosud's and CMR's (layouts of their own).
import { describe, expect, it } from 'vitest'
import { parseStatement } from '@/lib/statements/detect'
import { syntheticBancoChileRuns as bancoChile } from '@/lib/statements/bancochile/testdata/cardStatementRuns'
import { syntheticItauWebRuns as itauWeb } from '@/lib/statements/itau/testdata/webCardStatementRuns'
import { syntheticCencosudRuns as cencosud } from '@/lib/statements/cencosud/testdata/cardStatementRuns'
import { syntheticCmrRuns as cmr } from '@/lib/statements/cmr/testdata/cardStatementRuns'
import { CMR_UNVERIFIED_NOTE } from '@/lib/statements/cmr/cardStatement'
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

describe('estado de cuenta tarjeta Cencosud Scotiabank', () => {
  it('se lee completo, sin las notas escritas encima, y cuadra con el total facturado y el cupo', () => {
    const { list, warnings, notes, format } = parse(cencosud)
    expect(format).toBe('Estado de cuenta tarjeta Cencosud Scotiabank')
    expect(warnings).toEqual([])
    const { lines, schedule, ...head } = list[0]!
    expect(head).toEqual({
      issuer: 'cencosud', kind: 'nacional', currency: 'CLP', cardLastDigits: '4321', statementDate: '2026-03-21',
      periodFrom: '2026-02-22', periodTo: '2026-03-21', dueDate: '2026-04-06',
      previousPeriodFrom: '2026-01-22', previousPeriodTo: '2026-02-21', nextPeriodFrom: '2026-03-22', nextPeriodTo: '2026-04-21',
      creditLimit: '3000000', creditUsed: '1153000', creditAvailable: '1847000',
      cashLimit: '', cashUsed: '0', cashAvailable: '1500000',
      previousBalanceStart: '0', previousBilled: '500000', previousPaid: '-500000', previousBalanceEnd: '0',
      transferFromNational: '', totalOperations: '-310000', voluntaryProducts: '1000', chargesNet: '2000', totalBilled: '193000',
      minimumPayment: '50000', prepaymentCost: '1153000', automaticCharge: '', unbilledBalance: '960000',
      rateRevolving: '2.46', rateInstallments: '3.40', rateCashAdvance: '3.40',
      caeRevolving: '50.85', caeInstallments: '64.18', caeCashAdvance: '64.18', caePrepayment: '3.39',
      lateInterestRate: '29.52', fileHash: '',
    })
    // Cencosud names each coming month by when it is paid: MAY is April's statement.
    expect(schedule).toEqual([
      { period: '2026-04', amount: '130000' },
      { period: '2026-05', amount: '130000' },
      { period: '2026-06', amount: '100000' },
      { period: '2026-07', amount: '100000' },
    ])
    expect(lines.map(lineTuple)).toEqual([
      ['pago', '', '2026-02-27', '', 'MONTO CANCELADO SERVIPAG APP', '', '500000', '1/1', '-500000'],
      ['compra', 'LAS CONDES', '2025-12-22', '', 'TIENDA UNO CL', '', '1200000', '3/12', '100000'],
      ['compra', 'SANTIAGO', '2026-02-21', '', 'MERCADOPAGO TIENDA DOS', '', '50000', '1/1', '50000'],
      ['compra', 'SANTIAGO', '2026-02-24', '', 'TIENDA TRES', '', '90000', '1/3', '30000'],
      // A reversal stays among the purchases: the inbox stages it as money back.
      ['compra', 'SANTIAGO', '2026-03-11', '', 'TIENDA TRES', '', '10000', '1/1', '-10000'],
      ['compra', '', '2026-03-04', '', 'SERVICIO DIGITAL 22 USD', '', '20000', '1/1', '20000'],
      ['voluntario', '', '2026-03-21', '', 'SEGURO DESGRAVAMEN', '', '1000', '1/1', '1000'],
      ['cargo', '', '2026-03-21', '', 'SERVICIO ADMINISTRACION MENSUAL', '', '2000', '1/1', '2000'],
    ])
    expect(notes).toEqual(['Estado nacional ••4321 al 21/03/2026 (CLP): 1 pago, 6 compras, 1 cargo.'])
  })

  it('no depende del orden en que el PDF entrega el texto', () => {
    expect(parse(cencosud.toReversed()).list).toEqual(parse(cencosud).list)
  })

  it('avisa cuando los movimientos no suman el total facturado', () => {
    // The monthly fee's charged amount read as 2.500 instead of 2.000.
    const tampered = cencosud.map((r) => (r.page === 2 && r.y === 366 && r.x > 540 ? { ...r, str: '2.500' } : r))
    expect(parse(tampered).warnings).toEqual([
      'Estado nacional: el total facturado no cuadra (calculado 193500, informado 193000). Revisa el estado de cuenta.',
    ])
  })

  it('el motor guarda las compras con el mes de su primera cuota y la reversa como abono', async () => {
    const db = await createTestDb()
    const finance = createFinanceService(db, createSession(db))
    const r = await finance.ImportCardStatement(parse(cencosud).list[0]!)
    expect(r.error).toBeUndefined()
    const items = (await finance.ListImportItems('pendiente')).data!
    expect(items.find((it) => it.description === 'TIENDA UNO CL')).toMatchObject({
      issuer: 'cencosud', firstPeriod: '2026-01', installmentNumber: 3, installmentsTotal: 12,
      installmentAmount: '100000', amount: '1200000',
    })
    expect(items.filter((it) => it.kind === 'abono').map((it) => [it.description, it.amount])).toEqual([['TIENDA TRES', '10000']])
    // The same file again adds nothing.
    expect((await finance.ImportCardStatement(parse(cencosud).list[0]!)).data?.alreadyImported).toBe(true)
  })
})

describe('estado de cuenta tarjeta CMR Falabella', () => {
  it('se lee completo, con la tarjeta del pie y el pago entre los cargos, y avisa que falta validarlo', () => {
    const { list, warnings, notes, format } = parse(cmr)
    expect(format).toBe('Estado de cuenta tarjeta CMR Falabella')
    expect(warnings).toEqual([])
    const { lines, schedule, ...head } = list[0]!
    expect(head).toEqual({
      issuer: 'cmr', kind: 'nacional', currency: 'CLP', cardLastDigits: '4321', statementDate: '2026-06-19',
      periodFrom: '2026-05-20', periodTo: '2026-06-19', dueDate: '2026-07-05',
      previousPeriodFrom: '2026-04-20', previousPeriodTo: '2026-05-19', nextPeriodFrom: '2026-06-20', nextPeriodTo: '2026-07-19',
      creditLimit: '2000000', creditUsed: '120000', creditAvailable: '1880000',
      cashLimit: '', cashUsed: '0', cashAvailable: '1880000',
      previousBalanceStart: '0', previousBilled: '44530', previousPaid: '-44530', previousBalanceEnd: '0',
      transferFromNational: '', totalOperations: '15470', voluntaryProducts: '0', chargesNet: '0', totalBilled: '60000',
      minimumPayment: '60000', prepaymentCost: '120000', automaticCharge: '', unbilledBalance: '60000',
      rateRevolving: '3.44', rateInstallments: '4.37', rateCashAdvance: '4.37',
      caeRevolving: '50.06', caeInstallments: '42.85', caeCashAdvance: '45.67', caePrepayment: '0.00',
      lateInterestRate: '3.44', fileHash: '',
    })
    expect(schedule).toEqual([]) // its coming months are not read until a real statement shows them
    expect(lines.map(lineTuple)).toEqual([
      ['compra', 'FALABELLA ONLINE', '2026-05-28', '', 'Tienda Uno', '', '30000', '1/1', '30000'],
      ['compra', 'SANTIAGO', '2026-06-10', '', 'Tienda Dos', '', '90000', '1/3', '30000'],
      ['pago', 'S/I', '2026-05-25', '', 'Pago Tarjeta Cmr', '', '-44530', '1/1', '-44530'],
    ])
    expect(notes).toEqual(['Estado nacional ••4321 al 19/06/2026 (CLP): 1 pago, 2 compras.', CMR_UNVERIFIED_NOTE])
  })

  it('no depende del orden en que el PDF entrega el texto', () => {
    expect(parse(cmr.toReversed()).list).toEqual(parse(cmr).list)
  })
})

describe('detección de emisores', () => {
  it.each([
    [cencosud, 'Estado de cuenta tarjeta Cencosud Scotiabank'],
    [cmr, 'Estado de cuenta tarjeta CMR Falabella'],
    [bancoChile, 'Estado de cuenta tarjeta de crédito Banco de Chile'],
    [itauWeb, 'Estado de cuenta tarjeta de crédito Itaú (descargado de la web)'],
  ])('cada formato se reconoce por sus marcas (%#)', (runs, format) => {
    expect(parseStatement(runs).format).toBe(format)
  })
})
