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
import { inspectBackup, type ImportSummary } from '@/engine/db/importCheck'

export type { ImportSummary } from '@/engine/db/importCheck'

export const DB_PATH = '/app-finance.sqlite3'

export interface WorkerApi {
  call(service: 'finance' | 'users', method: string, args: unknown[]): Promise<unknown>
  exportDb(): Promise<Uint8Array>
  // importDb checks the file in memory first (see inspectBackup), then replaces
  // the whole database, restoring the previous one if anything fails, and
  // reports what came in. The caller must reload the page afterwards (also
  // after a failure): this worker's `ready` handle was closed for the swap.
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
  return { sqlite3, services, poolUtil, handle }
})()

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
    const { sqlite3, poolUtil, handle } = await ready
    // Throws ImportRejected (a Spanish sentence) before OPFS is touched.
    const summary = inspectBackup(sqlite3, bytes)

    const previous = await poolUtil.exportFile(DB_PATH)
    handle.close()
    try {
      await poolUtil.importDb(DB_PATH, bytes)
      // Reopen the stored file and bring it to the current schema, exactly
      // like a desktop startup would. The page reload that follows builds the
      // real connection.
      const probe = new poolUtil.OpfsSAHPoolDb(DB_PATH)
      try {
        const db = wrapOo1Db(probe)
        db.exec('PRAGMA foreign_keys = ON')
        runMigrations(db)
      } finally {
        probe.close()
      }
      return summary
    } catch (err) {
      // Put the previous database back: a failed restore must not cost the
      // user the data they had.
      await poolUtil.importDb(DB_PATH, previous)
      throw new Error(
        `No se pudo importar; tus datos anteriores quedaron intactos (recarga la página): ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  },
}

Comlink.expose(api)
