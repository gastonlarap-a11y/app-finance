import { describe, expect, it } from 'vitest'
import {
  CHILEAN_FORMATS,
  buildBatch,
  decodeText,
  detectFormats,
  guessMapping,
  parseAmount,
  parseCsv,
  parseDate,
} from '@/lib/statements/csv'

const parseAmountCL = (raw: string) => parseAmount(raw, 'cl')
const parseDateCL = (raw: string) => parseDate(raw, 'dmy')

describe('parseAmount', () => {
  it('lee los formatos chilenos', () => {
    for (const [raw, want] of [
      ['1.234.567', '1234567'],
      ['$ 12.345', '12345'],
      ['-12.345', '-12345'],
      ['(3.000)', '-3000'],
      ['3.000-', '-3000'],
      ['1.234,50', '1234.50'],
      ['1234,5', '1234.5'],
      ['1234.5', '1234.5'],
      ['12345', '12345'],
      ['0', '0'],
      ['0,00', '0'],
    ] as const) {
      expect(parseAmountCL(raw), raw).toBe(want)
    }
  })
  it('rechaza lo que no es monto', () => {
    for (const raw of ['', 'abc', '1,2,3', '12.34.5', '$', '1.2345']) expect(parseAmountCL(raw), raw).toBeNull()
  })
  it('lee el formato de EE. UU.: la coma agrupa miles', () => {
    for (const [raw, want] of [
      ['1,234', '1234'],
      ['1,234,567', '1234567'],
      ['$ 1,234.50', '1234.50'],
      ['(3,000)', '-3000'],
      ['1234.5', '1234.5'],
    ] as const) {
      expect(parseAmount(raw, 'us'), raw).toBe(want)
    }
    for (const raw of ['1.234,50', '12,5', '1.234.567']) expect(parseAmount(raw, 'us'), raw).toBeNull()
  })
})

describe('parseDate', () => {
  it('lee mes/día cuando el archivo es de EE. UU.', () => {
    expect(parseDate('9/5/2026', 'mdy')).toBe('2026-09-05')
    expect(parseDate('9/5/2026', 'dmy')).toBe('2026-05-09')
    expect(parseDate('2026-09-05', 'mdy')).toBe('2026-09-05')
    expect(parseDate('13/05/2026', 'mdy')).toBeNull()
  })
  it('lee fechas chilenas e ISO', () => {
    expect(parseDateCL('05/09/2026')).toBe('2026-09-05')
    expect(parseDateCL('5-9-2026')).toBe('2026-09-05')
    expect(parseDateCL('05.09.26')).toBe('2026-09-05')
    expect(parseDateCL('2026-09-05')).toBe('2026-09-05')
    expect(parseDateCL('2026-09-05 00:00:00')).toBe('2026-09-05')
  })
  it('rechaza fechas imposibles', () => {
    for (const raw of ['31/02/2026', '2026-13-01', 'ayer', '']) expect(parseDateCL(raw), raw).toBeNull()
  })
})

describe('parseCsv', () => {
  it('detecta ; con comillas y saltos de línea dentro de un campo', () => {
    const text = 'Fecha;Descripción;Monto\r\n01/09/2026;"PAGO ""LUZ""\nENEL";-45.990\r\n02/09/2026;SUELDO;1.500.000\r\n'
    expect(parseCsv(text)).toEqual([
      ['Fecha', 'Descripción', 'Monto'],
      ['01/09/2026', 'PAGO "LUZ"\nENEL', '-45.990'],
      ['02/09/2026', 'SUELDO', '1.500.000'],
    ])
  })
  it('detecta la coma y el tabulador', () => {
    expect(parseCsv('a,b\n1,2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
    expect(parseCsv('a\tb\n1\t2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })
})

describe('decodeText', () => {
  it('usa Windows-1252 cuando no es UTF-8 válido y quita el BOM', () => {
    expect(decodeText(new Uint8Array([0x44, 0x65, 0x73, 0x63, 0x72, 0x69, 0x70, 0x63, 0x69, 0xf3, 0x6e]))).toBe('Descripción')
    // UTF-8 byte-order mark (EF BB BF) before "Fecha".
    expect(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, 0x46, 0x65, 0x63, 0x68, 0x61]))).toBe('Fecha')
  })
})

// A cartola exported to CSV: a title block, the header, movements, a total row.
const cartola = parseCsv(
  [
    'Cartola Cuenta Corriente;;;;',
    'Titular: X;;;;',
    'Fecha;Descripción;Cargos;Abonos;Saldo',
    '01/09/2026;COMPRA LIDER;25.990;;974.010',
    '02/09/2026;TRASPASO DE: EMPRESA;;1.500.000;2.474.010',
    '03/09/2026;PAGO LUZ;45.990;;2.428.020',
    ';Total;71.980;1.500.000;',
  ].join('\n'),
)

describe('guessMapping + buildBatch', () => {
  it('reconoce Cargos/Abonos bajo un bloque de título', () => {
    expect(guessMapping(cartola)).toEqual({ headerRow: 2, date: 0, description: 1, amount: { kind: 'split', charge: 2, credit: 3 } })
  })

  it('arma el lote: cargos como gastos, abonos como abonos, salta el total', () => {
    const { batch, skipped } = buildBatch(cartola, guessMapping(cartola)!, CHILEAN_FORMATS, ' Banco de Chile ')
    expect(skipped).toBe(1)
    expect(batch.source).toBe('csv')
    expect(batch.issuer).toBe('Banco de Chile')
    expect(batch.items.map((i) => [i.date, i.description, i.amount, i.kind])).toEqual([
      ['2026-09-01', 'COMPRA LIDER', '25990', 'gasto'],
      ['2026-09-02', 'TRASPASO DE: EMPRESA', '1500000', 'abono'],
      ['2026-09-03', 'PAGO LUZ', '45990', 'gasto'],
    ])
  })

  it('una columna con signo o una de cargos de tarjeta', () => {
    const rows = parseCsv('Fecha,Detalle,Monto\n2026-09-01,UBER,-8.500\n2026-09-02,REVERSO,8.500')
    const mapping = guessMapping(rows)!
    expect(mapping.amount).toEqual({ kind: 'signed', column: 2 })
    expect(buildBatch(rows, mapping, CHILEAN_FORMATS, 'x').batch.items.map((i) => [i.amount, i.kind])).toEqual([
      ['8500', 'gasto'],
      ['8500', 'abono'],
    ])
    const card = { ...mapping, amount: { kind: 'charges', column: 2 } as const }
    expect(buildBatch(rows, card, CHILEAN_FORMATS, 'x').batch.items.map((i) => i.kind)).toEqual(['abono', 'gasto'])
  })
})

describe('detectFormats', () => {
  const mappingOf = (rows: string[][]) => guessMapping(rows)!

  it('una cartola chilena se lee como chilena, con certeza', () => {
    expect(detectFormats(cartola, mappingOf(cartola))).toEqual({ dates: 'dmy', numbers: 'cl', sure: true })
  })

  it('un archivo de EE. UU. se reconoce por un día sobre 12 y por la coma de miles', () => {
    const rows = parseCsv('Fecha;Detalle;Monto\n9/5/2026;UBER;-1,234\n9/25/2026;NETFLIX;-8,990\n10/1/2026;SUELDO;1,500,000')
    const mapping = mappingOf(rows)
    const formats = detectFormats(rows, mapping)
    expect(formats).toEqual({ dates: 'mdy', numbers: 'us', sure: true })
    expect(buildBatch(rows, mapping, formats, 'x').batch.items.map((i) => [i.date, i.amount])).toEqual([
      ['2026-09-05', '1234'],
      ['2026-09-25', '8990'],
      ['2026-10-01', '1500000'],
    ])
  })

  it('las fechas ambiguas siguen al formato de los montos', () => {
    const rows = parseCsv('Fecha;Detalle;Monto\n05/09/2026;UBER;-8,500\n07/09/2026;LIDER;-12,990')
    expect(detectFormats(rows, mappingOf(rows))).toEqual({ dates: 'mdy', numbers: 'us', sure: true })
  })

  it('si nada lo dice no hay certeza: parte en chileno y pide revisar', () => {
    const rows = parseCsv('Fecha;Detalle;Monto\n05/09/2026;UBER;-8500\n07/09/2026;LIDER;-12990')
    expect(detectFormats(rows, mappingOf(rows))).toEqual({ dates: 'dmy', numbers: 'cl', sure: false })
  })

  it('las fechas ISO no dicen nada y no piden revisar', () => {
    const rows = parseCsv('Fecha;Detalle;Monto\n2026-09-05;UBER;-8.500')
    expect(detectFormats(rows, mappingOf(rows))).toEqual({ dates: 'dmy', numbers: 'cl', sure: true })
  })
})
