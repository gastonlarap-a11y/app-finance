// Main-thread side of the web engine: one lazily-created worker shared by all
// services (opfs-sahpool allows a single connection), wrapped with Comlink.
import * as Comlink from 'comlink'
import type { WorkerApi } from '@/engine/db/worker'

let remote: Comlink.Remote<WorkerApi> | null = null

function workerApi(): Comlink.Remote<WorkerApi> {
  if (!remote) {
    const worker = new Worker(new URL('../../engine/db/worker.ts', import.meta.url), { type: 'module' })
    remote = Comlink.wrap<WorkerApi>(worker)
  }
  return remote
}

// remoteService builds a service object whose method calls travel to the worker
// as (service, method, args). The Proxy itself is untyped by nature; T (a
// service contract) is the compile-time source of truth for callers.
export function remoteService<T extends object>(service: 'finance' | 'users'): T {
  return new Proxy({} as T, {
    get(_target, prop) {
      if (typeof prop !== 'string') return undefined
      if (prop === 'then') return undefined // never look like a thenable
      return (...args: unknown[]) => workerApi().call(service, prop, args)
    },
  })
}

export function exportDbBytes(): Promise<Uint8Array> {
  return workerApi().exportDb()
}

export async function importDbBytes(bytes: ArrayBuffer): Promise<void> {
  await workerApi().importDb(bytes)
}
