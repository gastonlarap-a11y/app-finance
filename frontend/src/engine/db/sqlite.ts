// SqlDb adapter over a sqlite-wasm oo1 database handle. Typed structurally so
// it works with both an OpfsSAHPoolDb (worker/production) and an in-memory
// oo1.DB (Node/vitest) without depending on the package's class exports.
import type { SqlDb, SqlRow, SqlValue } from '@/engine/db/types'

interface Oo1Db {
  exec(sql: string, opts: { bind?: SqlValue[] }): unknown
  selectObjects(sql: string, bind?: SqlValue[]): Record<string, unknown>[]
  changes(): number | bigint
}

export function wrapOo1Db(db: Oo1Db): SqlDb {
  return {
    exec(sql, params) {
      db.exec(sql, { bind: params })
    },
    query(sql, params) {
      // sqlite-wasm may hand back bigints/typed arrays for exotic columns; this
      // schema only holds TEXT/INTEGER/NULL, so normalize to SqlValue.
      return db.selectObjects(sql, params).map((row) => {
        const out: Record<string, SqlValue> = {}
        for (const [k, v] of Object.entries(row)) {
          if (v == null) out[k] = null
          else if (typeof v === 'number' || typeof v === 'string') out[k] = v
          else if (typeof v === 'bigint') out[k] = Number(v)
          else out[k] = String(v)
        }
        return out satisfies SqlRow
      })
    },
    changes() {
      return Number(db.changes())
    },
    transaction<T>(fn: () => T): T {
      db.exec('BEGIN', {})
      try {
        const out = fn()
        db.exec('COMMIT', {})
        return out
      } catch (err) {
        db.exec('ROLLBACK', {})
        throw err
      }
    },
  }
}
