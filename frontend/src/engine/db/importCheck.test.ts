import { describe, expect, it } from 'vitest'
import sqlite3InitModule from '@sqlite.org/sqlite-wasm'
import { ImportRejected, inspectBackup } from '@/engine/db/importCheck'
import { createTestDbBytes } from '@/engine/testing/db'
import { wrapOo1Db } from '@/engine/db/sqlite'

// dbBytes builds a database by running `sql` on an empty in-memory DB.
async function dbBytes(sql: string): Promise<Uint8Array> {
  const sqlite3 = await sqlite3InitModule()
  const handle = new sqlite3.oo1.DB(':memory:')
  try {
    handle.exec(sql)
    return sqlite3.capi.sqlite3_js_db_export(handle)
  } finally {
    handle.close()
  }
}

// appDbBytes runs `mutate` on a migrated App Finance DB and returns its bytes.
async function appDbBytes(mutate: (exec: (sql: string) => void) => void): Promise<Uint8Array> {
  const sqlite3 = await sqlite3InitModule()
  const handle = new sqlite3.oo1.DB(':memory:')
  try {
    const source = await createTestDbBytes()
    const p = sqlite3.wasm.allocFromTypedArray(source)
    sqlite3.capi.sqlite3_deserialize(
      handle.pointer!,
      'main',
      p,
      source.byteLength,
      source.byteLength,
      sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE,
    )
    const db = wrapOo1Db(handle)
    mutate((sql) => db.exec(sql))
    return sqlite3.capi.sqlite3_js_db_export(handle)
  } finally {
    handle.close()
  }
}

describe('inspectBackup', () => {
  it('acepta un respaldo real y resume su contenido sin tocar nada', async () => {
    const sqlite3 = await sqlite3InitModule()
    const bytes = await appDbBytes((exec) => {
      exec(`INSERT INTO expenses (user_id, date, description, category, merchant, kind, installment_amount, installments_total, created_at)
            VALUES (1, '2026-07-10T00:00:00Z', 'Sofá', '', '', 'unico', '1000', 1, '2026-07-10T00:00:00Z')`)
      exec(`INSERT INTO installments (user_id, expense_id, number, total, period, amount, status)
            VALUES (1, 1, 1, 1, '2026-07', '1000', 'pendiente')`)
    })
    const summary = inspectBackup(sqlite3, bytes)
    expect(summary).toMatchObject({ users: 1, expenses: 1, migrated: 0, firstPeriod: '2026-07', lastPeriod: '2026-07' })
  })

  it('pone al día un respaldo antiguo en la copia en memoria', async () => {
    const sqlite3 = await sqlite3InitModule()
    const bytes = await appDbBytes((exec) => exec("DELETE FROM bun_migrations WHERE name = '20260926019'"))
    expect(inspectBackup(sqlite3, bytes).migrated).toBe(1)
  })

  it('rechaza una base SQLite que no es de App Finance', async () => {
    const sqlite3 = await sqlite3InitModule()
    const bytes = await dbBytes('CREATE TABLE notas (id INTEGER PRIMARY KEY, texto TEXT)')
    expect(() => inspectBackup(sqlite3, bytes)).toThrow(/no de App Finance/)
  })

  it('rechaza un respaldo de una versión más nueva de la app', async () => {
    const sqlite3 = await sqlite3InitModule()
    const bytes = await appDbBytes((exec) =>
      exec("INSERT INTO bun_migrations (name, group_id) VALUES ('99991231999', 99)"),
    )
    expect(() => inspectBackup(sqlite3, bytes)).toThrow(/versión más nueva/)
  })

  it('rechaza un archivo dañado', async () => {
    const sqlite3 = await sqlite3InitModule()
    const bytes = await createTestDbBytes()
    // Scribble over the second page (a table b-tree) but keep the header.
    bytes.fill(0xff, 4096, 8192)
    expect(() => inspectBackup(sqlite3, bytes)).toThrow(ImportRejected)
  })
})
