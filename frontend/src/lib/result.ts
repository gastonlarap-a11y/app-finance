// Helpers for the {data, error} Result pattern returned by FinanceService.
import { notify } from '@/lib/notify'

export interface HasError {
  error?: { code: string; message: string } | null
}

export function errMsg(r: HasError | null | undefined): string | null {
  return r?.error ? r.error.message : null
}

// Surfaces a business error (toast) and returns true when the op failed.
export function failed(r: HasError | null | undefined): boolean {
  const m = errMsg(r)
  if (m) {
    notify(m)
    return true
  }
  return false
}
