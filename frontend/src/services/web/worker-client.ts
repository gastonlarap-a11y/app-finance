// Main-thread side of the web engine: one lazily-created worker shared by all
// services (opfs-sahpool allows a single connection), wrapped with Comlink.
import * as Comlink from 'comlink'
import type { ImportSummary, WorkerApi } from '@/engine/db/worker'

let remote: Comlink.Remote<WorkerApi> | null = null

// workerFailed rejects once the worker cannot run at all (its script failed to
// load — typically a chunk a new deploy no longer serves — or a message could
// not be decoded). Comlink knows nothing of those events: without this, every
// call would hang and the app would sit on its spinner forever.
let workerFailed: Promise<never> | null = null

function workerApi(): { api: Comlink.Remote<WorkerApi>; failed: Promise<never> } {
  if (!remote || !workerFailed) {
    const worker = new Worker(new URL('../../engine/db/worker.ts', import.meta.url), { type: 'module' })
    workerFailed = new Promise<never>((_, reject) => {
      worker.addEventListener('error', (e) => {
        const detail = e.message ? ` (${e.message})` : ''
        reject(new Error(`No se pudo cargar el motor de datos${detail}. Recarga la página: puede haber una versión nueva.`))
      })
      worker.addEventListener('messageerror', () => {
        reject(new Error('El motor de datos respondió algo ilegible. Recarga la página.'))
      })
    })
    // Surfaced through each call's race below, never as an unhandled rejection.
    workerFailed.catch(() => undefined)
    remote = Comlink.wrap<WorkerApi>(worker)
  }
  return { api: remote, failed: workerFailed }
}

// call runs one worker request, failing fast if the worker itself is broken.
function call<T>(run: (api: Comlink.Remote<WorkerApi>) => Promise<T>): Promise<T> {
  const { api, failed } = workerApi()
  return Promise.race([run(api), failed])
}

// remoteService builds a service object whose method calls travel to the worker
// as (service, method, args). The Proxy itself is untyped by nature; T (a
// service contract) is the compile-time source of truth for callers.
export function remoteService<T extends object>(service: 'finance' | 'users'): T {
  return new Proxy({} as T, {
    get(_target, prop) {
      if (typeof prop !== 'string') return undefined
      if (prop === 'then') return undefined // never look like a thenable
      return (...args: unknown[]) => call((api) => api.call(service, prop, args))
    },
  })
}

export function exportDbBytes(): Promise<Uint8Array> {
  return call((api) => api.exportDb())
}

export function importDbBytes(bytes: Uint8Array): Promise<ImportSummary> {
  return call((api) => api.importDb(bytes))
}

// DB_LOCK is held by the one tab that owns the database: opfs-sahpool admits a
// single connection, and a second tab opening it fails deep inside SQLite with
// an access-handle error (NoModificationAllowedError) the user cannot act on.
const DB_LOCK = 'app-finance-db'

// acquireDbLock takes the database for this tab, for as long as it stays open.
// false means another tab or window already has the app open.
export function acquireDbLock(): Promise<boolean> {
  if (!('locks' in navigator)) return Promise.resolve(true) // no Web Locks: behave as before
  return new Promise((resolve) => {
    // The request's promise settles only when the lock is released, i.e. when
    // this page closes: nothing to await here.
    void navigator.locks.request(DB_LOCK, { ifAvailable: true }, (lock) => {
      if (!lock) {
        resolve(false)
        return null
      }
      resolve(true)
      return new Promise<never>(() => undefined) // hold until the page closes
    })
  })
}
