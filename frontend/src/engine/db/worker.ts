// Dedicated worker hosting the whole web engine: sqlite-wasm over the
// opfs-sahpool VFS (persistent, no COOP/COEP needed), the shared migrations,
// and the finance/users services. The main thread talks to it through a single
// Comlink endpoint (WorkerApi); UI-facing typing lives in the service contracts.
import sqlite3InitModule from '@sqlite.org/sqlite-wasm'
import * as Comlink from 'comlink'
import { wrapOo1Db } from '@/engine/db/sqlite'
import { runMigrations } from '@/engine/db/migrator'
import { createFinanceService } from '@/engine/finance/service'
import { createSession, createUsersService } from '@/engine/users/service'
import { asNullableString, asNumber } from '@/engine/db/types'

export const DB_PATH = '/app-finance.sqlite3'

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

export interface WorkerApi {
  call(service: 'finance' | 'users', method: string, args: unknown[]): Promise<unknown>
  exportDb(): Promise<Uint8Array>
  // importDb replaces the whole database file and reports what came in. The
  // caller must reload the page afterwards: this worker's `ready` still holds
  // the handle of the database that was just replaced.
  importDb(bytes: Uint8Array): Promise<ImportSummary>
}

// stage labels a startup failure so the UI can say where it broke. Without it a
// rejected `ready` surfaces as a raw SQLite message — or, on a tablet with no
// console, as an app that simply looks empty.
async function stage<T>(name: string, fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    throw new Error(`${name}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

const ready = (async () => {
  const sqlite3 = await stage('no se pudo iniciar el motor SQLite', () => sqlite3InitModule())
  const poolUtil = await stage('no se pudo abrir el almacenamiento local', () =>
    sqlite3.installOpfsSAHPoolVfs({}),
  )
  const handle = await stage('no se pudo abrir la base de datos', () => new poolUtil.OpfsSAHPoolDb(DB_PATH))
  const db = wrapOo1Db(handle)
  // Desktop opens with _foreign_keys=on; keep the same integrity rules here.
  db.exec('PRAGMA foreign_keys = ON')
  await stage('no se pudieron aplicar las migraciones', () => runMigrations(db))
  const session = await stage('no se pudo abrir el perfil activo', () => createSession(db))
  const services: Record<'finance' | 'users', object> = {
    finance: createFinanceService(db, session),
    users: createUsersService(db, session),
  }
  return { services, poolUtil, handle }
})()

// summarize reads the freshly imported database. Counts ignore soft-deleted
// rows: those live in the Papelera and would inflate a "your data is here" number.
function summarize(db: ReturnType<typeof wrapOo1Db>, migrated: number): ImportSummary {
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

const api: WorkerApi = {
  async call(service, method, args) {
    const { services } = await ready
    // Dispatch by name: the client-side Proxy is typed by the service
    // contracts, so `method` is always a contract method at compile time.
    const svc = services[service] as Record<string, (...a: unknown[]) => Promise<unknown>>
    const fn = svc[method]
    if (typeof fn !== 'function') {
      throw new Error(`unknown method ${service}.${String(method)}`)
    }
    return fn.apply(svc, args)
  },

  async exportDb() {
    const { poolUtil } = await ready
    return poolUtil.exportFile(DB_PATH)
  },

  async importDb(bytes) {
    const { poolUtil, handle } = await ready
    handle.close()
    await poolUtil.importDb(DB_PATH, bytes)

    // Reopen the imported file to prove it is usable and report its contents.
    // A backup older than the current schema catches up here, exactly like a
    // desktop startup would. This connection is closed right after: the page
    // reload that follows builds the real one.
    const probe = new poolUtil.OpfsSAHPoolDb(DB_PATH)
    try {
      const db = wrapOo1Db(probe)
      db.exec('PRAGMA foreign_keys = ON')
      return summarize(db, runMigrations(db))
    } finally {
      probe.close()
    }
  },
}

Comlink.expose(api)
