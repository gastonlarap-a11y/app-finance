// Test-only helper: an in-memory sqlite-wasm database with the real migrations
// applied — the same engine build production uses, so SQL behavior matches.
import sqlite3InitModule from '@sqlite.org/sqlite-wasm'
import { wrapOo1Db } from '@/engine/db/sqlite'
import { runMigrations } from '@/engine/db/migrator'
import type { SqlDb } from '@/engine/db/types'

export async function createTestDb(): Promise<SqlDb> {
  const sqlite3 = await sqlite3InitModule()
  const handle = new sqlite3.oo1.DB(':memory:')
  const db = wrapOo1Db(handle)
  db.exec('PRAGMA foreign_keys = ON')
  runMigrations(db)
  return db
}

// createTestDbBytes serializes a migrated database to the same bytes an
// exported .db file holds — the input the import path has to accept.
export async function createTestDbBytes(): Promise<Uint8Array> {
  const sqlite3 = await sqlite3InitModule()
  const handle = new sqlite3.oo1.DB(':memory:')
  try {
    const db = wrapOo1Db(handle)
    db.exec('PRAGMA foreign_keys = ON')
    runMigrations(db)
    return sqlite3.capi.sqlite3_js_db_export(handle)
  } finally {
    handle.close()
  }
}
