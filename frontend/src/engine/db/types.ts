// Minimal synchronous SQL surface the engine codes against. The worker provides
// a sqlite-wasm (OPFS) implementation; tests provide an in-memory one. Keeping
// the engine off any concrete driver is what lets the same domain logic run in
// both places.

export type SqlValue = string | number | null

export type SqlRow = Record<string, SqlValue>

export interface SqlDb {
  // exec runs a statement for its side effects.
  exec(sql: string, params?: SqlValue[]): void
  // query runs a statement and returns every row as a column→value object.
  query(sql: string, params?: SqlValue[]): SqlRow[]
  // changes reports rows affected by the last INSERT/UPDATE/DELETE.
  changes(): number
  // transaction wraps fn in BEGIN/COMMIT, rolling back when fn throws.
  transaction<T>(fn: () => T): T
}

// row helpers — SQLite is dynamically typed, so coerce defensively at the edge.

export function asNumber(v: SqlValue | undefined): number {
  return typeof v === 'number' ? v : Number(v ?? 0)
}

export function asString(v: SqlValue | undefined): string {
  return v == null ? '' : String(v)
}

export function asNullableString(v: SqlValue | undefined): string | null {
  return v == null ? null : String(v)
}

export function asNullableNumber(v: SqlValue | undefined): number | null {
  if (v == null) return null
  return typeof v === 'number' ? v : Number(v)
}
