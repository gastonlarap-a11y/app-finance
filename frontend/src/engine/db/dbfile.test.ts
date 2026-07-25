import { describe, expect, it } from 'vitest'
import { validateSqliteFile } from '@/engine/db/dbfile'
import { createTestDbBytes } from '@/engine/testing/db'

const HEADER = 'SQLite format 3\0'

// fakeDbBytes builds a byte array with a valid header and page-aligned size,
// enough to exercise the header/size guards without a real engine.
function fakeDbBytes(size = 1024): Uint8Array {
  const bytes = new Uint8Array(size)
  for (let i = 0; i < HEADER.length; i++) bytes[i] = HEADER.charCodeAt(i)
  return bytes
}

describe('validateSqliteFile', () => {
  it('acepta una base real exportada por el motor', async () => {
    expect(validateSqliteFile(await createTestDbBytes())).toBeNull()
  })

  it('rechaza un archivo vacío mencionando la descarga', () => {
    expect(validateSqliteFile(new Uint8Array())).toMatch(/vacío/)
  })

  it('rechaza un tamaño que no es múltiplo de página', () => {
    expect(validateSqliteFile(fakeDbBytes(1000))).toMatch(/incompleto o dañado/)
  })

  it('rechaza un archivo con otra cabecera', () => {
    const bytes = fakeDbBytes()
    bytes[0] = 'X'.charCodeAt(0)
    expect(validateSqliteFile(bytes)).toMatch(/no es una base de datos de App Finance/)
  })

  it('un archivo cualquiera se reporta como archivo equivocado, no como dañado', () => {
    const text = new TextEncoder().encode('module github.com/gastonlarap-a11y/app-finance\n')
    expect(validateSqliteFile(text)).toMatch(/no es una base de datos de App Finance/)
  })
})
