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

export const DB_PATH = '/app-finance.sqlite3'

export interface WorkerApi {
  call(service: 'finance' | 'users', method: string, args: unknown[]): Promise<unknown>
  exportDb(): Promise<Uint8Array>
  // importDb replaces the whole database file; the caller must reload the page
  // afterwards (this worker keeps no usable handle once it runs).
  importDb(bytes: ArrayBuffer): Promise<void>
}

const ready = (async () => {
  const sqlite3 = await sqlite3InitModule()
  const poolUtil = await sqlite3.installOpfsSAHPoolVfs({})
  const handle = new poolUtil.OpfsSAHPoolDb(DB_PATH)
  const db = wrapOo1Db(handle)
  // Desktop opens with _foreign_keys=on; keep the same integrity rules here.
  db.exec('PRAGMA foreign_keys = ON')
  runMigrations(db)
  const session = createSession(db)
  const services: Record<'finance' | 'users', object> = {
    finance: createFinanceService(db, session),
    users: createUsersService(db, session),
  }
  return { services, poolUtil, handle }
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
    const { poolUtil, handle } = await ready
    handle.close()
    await poolUtil.importDb(DB_PATH, bytes)
  },
}

Comlink.expose(api)
