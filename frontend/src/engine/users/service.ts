// TypeScript port of backend/users for the web build: multi-profile switching
// with the active id in memory, persisted in a small web_prefs KV table inside
// the same SQLite file (the web counterpart of desktop's prefs.json — desktop
// ignores the extra table when a web-exported DB is imported there).
import type { OpResult, User, UserResult, UsersServiceContract } from '@/services/contract'
import { ErrConflict, ErrInternal, ErrNotFound, ErrValidation, newError } from '@/engine/errors'
import { asNumber, asNullableString, asString, type SqlDb, type SqlRow } from '@/engine/db/types'
import type { ActiveSession } from '@/engine/finance/service'

export interface Session extends ActiveSession {
  setActive(id: number): void
}

function rowToUser(r: SqlRow): User {
  return {
    id: asNumber(r.id),
    name: asString(r.name),
    createdAt: asString(r.created_at),
    deletedAt: asNullableString(r.deleted_at),
  }
}

const ACTIVE_USER_KEY = 'active_user_id'

// createSession mirrors users.Session + ResolveActiveID: start from the
// persisted id when that user still exists, else the first available user.
export function createSession(db: SqlDb): Session {
  db.exec('CREATE TABLE IF NOT EXISTS web_prefs (key TEXT PRIMARY KEY, value TEXT NOT NULL)')

  let active = 1
  const stored = db.query('SELECT value FROM web_prefs WHERE key = ?', [ACTIVE_USER_KEY])[0]
  const preferred = stored ? Number(stored.value) : 0
  if (preferred > 0) {
    const exists = db.query('SELECT id FROM users WHERE id = ? AND deleted_at IS NULL', [preferred])[0]
    if (exists) active = preferred
    else active = firstUserId(db)
  } else {
    active = firstUserId(db)
  }

  return {
    active: () => active,
    setActive(id: number) {
      active = id
      db.exec(
        'INSERT INTO web_prefs (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
        [ACTIVE_USER_KEY, String(id)],
      )
    },
  }
}

function firstUserId(db: SqlDb): number {
  const first = db.query('SELECT id FROM users WHERE deleted_at IS NULL ORDER BY id ASC LIMIT 1')[0]
  return first ? asNumber(first.id) : 1
}

export function createUsersService(db: SqlDb, session: Session): UsersServiceContract {
  function findActive(id: number): User | null {
    const row = db.query('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL', [id])[0]
    return row ? rowToUser(row) : null
  }

  return {
    async ListUsers(): Promise<User[]> {
      return db.query('SELECT * FROM users WHERE deleted_at IS NULL ORDER BY id ASC').map(rowToUser)
    },

    async ActiveUser(): Promise<UserResult> {
      const u = findActive(session.active())
      if (!u) return { error: newError(ErrNotFound, 'usuario activo no encontrado') }
      return { data: u }
    },

    async CreateUser(name: string): Promise<UserResult> {
      const n = name.trim()
      if (n === '') return { error: newError(ErrValidation, 'el nombre es obligatorio') }
      const row = db.query('INSERT INTO users (name, created_at) VALUES (?, ?) RETURNING *', [
        n,
        new Date().toISOString(),
      ])[0]
      if (!row) return { error: newError(ErrInternal, 'no se pudo crear el usuario') }
      const u = rowToUser(row)
      session.setActive(u.id)
      return { data: u }
    },

    async SwitchUser(id: number): Promise<UserResult> {
      const u = findActive(id)
      if (!u) return { error: newError(ErrNotFound, 'usuario no encontrado') }
      session.setActive(id)
      return { data: u }
    },

    async RenameUser(id: number, name: string): Promise<UserResult> {
      const n = name.trim()
      if (n === '') return { error: newError(ErrValidation, 'el nombre es obligatorio') }
      db.exec('UPDATE users SET name = ? WHERE id = ? AND deleted_at IS NULL', [n, id])
      if (db.changes() === 0) return { error: newError(ErrNotFound, 'usuario no encontrado') }
      const u = findActive(id)
      if (!u) return { error: newError(ErrNotFound, 'usuario no encontrado') }
      return { data: u }
    },

    async DeleteUser(id: number): Promise<UserResult> {
      const countRow = db.query('SELECT COUNT(*) AS n FROM users WHERE deleted_at IS NULL')[0]
      if (asNumber(countRow?.n) <= 1) {
        return { error: newError(ErrConflict, 'no podés eliminar el último usuario') }
      }
      db.exec('UPDATE users SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL', [new Date().toISOString(), id])
      if (db.changes() === 0) return { error: newError(ErrNotFound, 'usuario no encontrado') }
      if (id !== session.active()) return {}
      const nextRow = db.query('SELECT * FROM users WHERE deleted_at IS NULL ORDER BY id ASC LIMIT 1')[0]
      if (!nextRow) return { error: newError(ErrInternal, 'no quedan usuarios activos') }
      const next = rowToUser(nextRow)
      session.setActive(next.id)
      return { data: next }
    },

    async RestoreUser(id: number): Promise<OpResult> {
      db.exec('UPDATE users SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL', [id])
      if (db.changes() === 0) {
        return { error: newError(ErrNotFound, 'usuario no encontrado o no estaba eliminado') }
      }
      return {}
    },

    async ListDeletedUsers(): Promise<User[]> {
      return db.query('SELECT * FROM users WHERE deleted_at IS NOT NULL ORDER BY id ASC').map(rowToUser)
    },
  }
}
