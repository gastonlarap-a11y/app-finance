import { describe, expect, it } from 'vitest'
import { exportBasename, toCsv } from '@/lib/exportTables'
import type { ExportTable } from '@/services/contract'

describe('toCsv', () => {
  it('usa ; como separador, BOM y comillas RFC 4180', () => {
    const t: ExportTable = {
      sheet: 'x',
      columns: [
        { title: 'Descripción', kind: 'text' },
        { title: 'Monto', kind: 'money' },
      ],
      rows: [
        ['Pan; leche', '1500'],
        ['Dice "hola"', '9007199254740993'],
        ['Multi\nlínea', ''],
      ],
    }
    expect(toCsv(t)).toBe(
      '﻿Descripción;Monto\r\n"Pan; leche";1500\r\n"Dice ""hola""";9007199254740993\r\n"Multi\nlínea";\r\n',
    )
  })
})

describe('exportBasename', () => {
  it('deja un nombre de archivo seguro', () => {
    expect(exportBasename('mes', '2026-09')).toBe('app-finance-mes-2026-09')
    expect(exportBasename('búsqueda', 'a/b c')).toBe('app-finance-b-squeda-a-b-c')
  })
})
