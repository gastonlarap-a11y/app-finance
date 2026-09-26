// Mirror of backend/shared/db/syncstate.go: the version vector that keeps the
// desktop ⇄ iPad file handoff from silently dropping changes. The tables and
// the triggers that mark changes come from migration 20260926026.
import { asNumber, asString, type SqlDb } from '@/engine/db/types'

// Vector counts, per device id, how many times the database left it with changes.
export type Vector = Record<string, number>

// How an incoming database relates to the local one (same strings as Go).
export const SyncSame = 'igual'
export const SyncNewer = 'mas-nueva'
export const SyncOlder = 'mas-antigua'
export const SyncDiverged = 'divergente'
export type SyncRelation = typeof SyncSame | typeof SyncNewer | typeof SyncOlder | typeof SyncDiverged

export function readSync(db: SqlDb): { vector: Vector; dirty: boolean } {
  const vector: Vector = {}
  for (const r of db.query('SELECT device_id, edits FROM sync_vector', [])) vector[asString(r.device_id)] = asNumber(r.edits)
  const dirty = asNumber(db.query('SELECT dirty FROM sync_state WHERE id = 1', [])[0]?.dirty) !== 0
  return { vector, dirty }
}

// markShared records that the database is about to leave this device (an
// export): pending changes become one more edit of deviceId.
export function markShared(db: SqlDb, deviceId: string): void {
  db.transaction(() => {
    db.exec('UPDATE sync_state SET dirty = 0 WHERE id = 1 AND dirty = 1', [])
    if (db.changes() === 0) return // not changed since the last time
    db.exec(
      `INSERT INTO sync_vector (device_id, edits) VALUES (?, 1)
       ON CONFLICT (device_id) DO UPDATE SET edits = edits + 1`,
      [deviceId],
    )
  })
}

// covers reports whether a holds at least every edit b has.
function covers(a: Vector, b: Vector): boolean {
  return Object.entries(b).every(([dev, n]) => (a[dev] ?? 0) >= n)
}

// compareSync tells how an incoming vector relates to the local database's;
// local changes not yet shared count as one more edit of this device.
export function compareSync(local: Vector, localDirty: boolean, deviceId: string, incoming: Vector): SyncRelation {
  const l: Vector = { ...local }
  if (localDirty) l[deviceId] = (l[deviceId] ?? 0) + 1
  const localCovered = covers(incoming, l)
  const incomingCovered = covers(l, incoming)
  if (localCovered && incomingCovered) return SyncSame
  if (localCovered) return SyncNewer
  if (incomingCovered) return SyncOlder
  return SyncDiverged
}
