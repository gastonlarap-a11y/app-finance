// inspectBackup proves a picked .db file is a usable App Finance database
// BEFORE it replaces the live one in OPFS. sqlite-wasm's importDb only checks
// the header, and it overwrites the stored database first: a foreign SQLite
// file, a corrupt one, or one from a newer app version used to destroy the
// user's data with no way back. Here the bytes are opened in memory
// (sqlite3_deserialize), checked, and migrated on that copy only.
import type { Sqlite3Static } from '@sqlite.org/sqlite-wasm'
import { wrapOo1Db } from '@/engine/db/sqlite'
import { NewerSchemaError, runMigrations } from '@/engine/db/migrator'
import { asNullableString, asNumber, asString, type SqlDb } from '@/engine/db/types'

// ImportSummary is what the imported file actually turned out to contain. The
// UI shows it because "imported fine but you are looking at a month the backup
// has no data for" and "the import silently did nothing" look identical
// otherwise.
export interface ImportSummary {
  users: number
  expenses: number
  incomes: number
  // migrated counts migrations applied on top of the imported file (an old
  // backup catching up with the current schema).
  migrated: number
  // Period range holding data, YYYY-MM, null when the file has no movements.
  firstPeriod: string | null
  lastPeriod: string | null
}

// ImportRejected carries the Spanish sentence the backup screen shows.
export class ImportRejected extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ImportRejected'
  }
}

// Tables every App Finance database has had since its first migrations.
const REQUIRED_TABLES = ['bun_migrations', 'users', 'expenses', 'installments']

export function inspectBackup(sqlite3: Sqlite3Static, bytes: Uint8Array): ImportSummary {
  const handle = new sqlite3.oo1.DB(':memory:')
  try {
    // The cookbook way to open bytes in memory: sqlite takes ownership of the
    // wasm copy (FREEONCLOSE) and may grow it while migrating (RESIZEABLE).
    const p = sqlite3.wasm.allocFromTypedArray(bytes)
    const rc = sqlite3.capi.sqlite3_deserialize(
      handle.pointer!,
      'main',
      p,
      bytes.byteLength,
      bytes.byteLength,
      sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE,
    )
    if (rc !== 0) throw new ImportRejected('El archivo no se pudo abrir como base de datos SQLite.')

    const db = wrapOo1Db(handle)
    checkIntegrity(db)
    checkTables(db)
    db.exec('PRAGMA foreign_keys = ON')
    let migrated: number
    try {
      migrated = runMigrations(db)
    } catch (err) {
      if (err instanceof NewerSchemaError) {
        throw new ImportRejected(
          'Ese respaldo es de una versión más nueva de la app. Recarga la página para actualizarla y vuelve a importarlo.',
        )
      }
      throw new ImportRejected(
        `El respaldo no se pudo poner al día con esta versión de la app: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    return summarize(db, migrated)
  } catch (err) {
    if (err instanceof ImportRejected) throw err
    throw new ImportRejected(`El archivo está dañado o no es una base de datos: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    handle.close()
  }
}

function checkIntegrity(db: SqlDb): void {
  const rows = db.query('PRAGMA integrity_check')
  const first = rows[0] ? asString(Object.values(rows[0])[0] ?? '') : ''
  if (rows.length !== 1 || first !== 'ok') {
    throw new ImportRejected(`El archivo está dañado (integrity_check: ${first || 'sin respuesta'}). Usa otro respaldo.`)
  }
}

function checkTables(db: SqlDb): void {
  const placeholders = REQUIRED_TABLES.map(() => '?').join(', ')
  const found = db.query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${placeholders})`, REQUIRED_TABLES)
  if (found.length !== REQUIRED_TABLES.length) {
    throw new ImportRejected(
      'Ese archivo es una base de datos, pero no de App Finance. Elige el respaldo «app-finance.db» (o el .db que exportaste desde la app).',
    )
  }
}

// summarize reads the database. Counts ignore soft-deleted rows: those live in
// the Papelera and would inflate a "your data is here" number.
export function summarize(db: SqlDb, migrated: number): ImportSummary {
  const count = (sql: string) => asNumber(db.query(sql)[0]?.n)
  const periods = db.query(
    `SELECT MIN(period) AS first, MAX(period) AS last FROM (
       SELECT i.period FROM installments i
         JOIN expenses e ON e.id = i.expense_id
        WHERE e.deleted_at IS NULL
       UNION ALL
       SELECT period FROM incomes WHERE deleted_at IS NULL
     )`,
  )[0]
  return {
    users: count('SELECT COUNT(*) AS n FROM users WHERE deleted_at IS NULL'),
    expenses: count('SELECT COUNT(*) AS n FROM expenses WHERE deleted_at IS NULL'),
    incomes: count('SELECT COUNT(*) AS n FROM incomes WHERE deleted_at IS NULL'),
    migrated,
    firstPeriod: asNullableString(periods?.first),
    lastPeriod: asNullableString(periods?.last),
  }
}
