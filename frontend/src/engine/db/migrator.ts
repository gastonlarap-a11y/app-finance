// TS counterpart of backend/shared/db/migrator.go + bun/migrate's Migrator:
// applies pending .up.sql files in filename order and records them in the same
// bun_migrations bookkeeping table bun uses. Because both sides record the same
// names, a DB file exported from the desktop app is recognized as already
// migrated here, and vice versa.
import { splitStatements } from '@/engine/db/splitStatements'
import { migrationFiles, type MigrationFile } from '@/engine/db/migrations'
import { asNumber, asString, type SqlDb } from '@/engine/db/types'

// Schema-compatible with what bun's Migrator.Init creates for its Migration and
// migrationLock models (SQLite is dynamically typed; column names are what matter).
const INIT_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS bun_migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name VARCHAR,
    group_id INTEGER,
    migrated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS bun_migration_locks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    table_name VARCHAR UNIQUE
  )`,
]

// NewerSchemaError mirrors db.ErrNewerSchema: the database was migrated by a
// newer version of the app, so this engine's queries may not match its schema.
export class NewerSchemaError extends Error {
  constructor(readonly names: string[]) {
    super(
      'La base de datos es de una versión más nueva de la app. Actualiza la app (recarga la página) antes de abrirla.',
    )
    this.name = 'NewerSchemaError'
  }
}

// newerThanKnown mirrors the Go helper: applied migrations this engine does not
// know that sort after its latest one. Older unknown ones are retired or belong
// to the desktop only (window state, mail accounts) and say nothing about age.
function newerThanKnown(applied: Iterable<string>, files: MigrationFile[]): string[] {
  const known = new Set(files.map((f) => f.name))
  const latest = files.reduce((max, f) => (f.name > max ? f.name : max), '')
  return [...applied].filter((name) => !known.has(name) && name > latest)
}

// runMigrations is idempotent and safe to call on every startup, exactly like
// db.RunMigrations in main.go. Returns how many migrations were applied. Throws
// NewerSchemaError, before writing anything, on a database from a newer app.
export function runMigrations(db: SqlDb, files: MigrationFile[] = migrationFiles()): number {
  for (const stmt of INIT_STATEMENTS) db.exec(stmt)

  const applied = new Set(db.query('SELECT name FROM bun_migrations').map((r) => asString(r.name)))
  const newer = newerThanKnown(applied, files)
  if (newer.length > 0) throw new NewerSchemaError(newer)
  const pending = files.filter((f) => !applied.has(f.name))
  if (pending.length === 0) return 0

  const groupRows = db.query('SELECT COALESCE(MAX(group_id), 0) AS g FROM bun_migrations')
  const group = asNumber(groupRows[0]?.g) + 1

  for (const f of pending) {
    db.transaction(() => {
      for (const stmt of splitStatements(f.sql)) db.exec(stmt)
      db.exec('INSERT INTO bun_migrations (name, group_id) VALUES (?, ?)', [f.name, group])
    })
  }
  return pending.length
}
