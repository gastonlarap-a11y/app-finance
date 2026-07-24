// Mirror of backend/shared/errors.go: business errors travel inside Result
// structs as {code, message}; unexpected engine failures are thrown instead
// (rejecting the promise, like a native Go error does on desktop).
import type { AppError } from '@/services/contract'

export const ErrNotFound = 'NOT_FOUND'
export const ErrValidation = 'VALIDATION_ERROR'
export const ErrConflict = 'CONFLICT'
export const ErrInternal = 'INTERNAL_ERROR'

export function newError(code: string, message: string): AppError {
  return { code, message }
}

// isUniqueViolation mirrors the Go check: SQLite reports UNIQUE constraint
// failures by message, driver-agnostically.
export function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && err.message.includes('UNIQUE constraint failed')
}
