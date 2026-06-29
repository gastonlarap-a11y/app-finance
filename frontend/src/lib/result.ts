// Helpers for the {data, error} Result pattern returned by FinanceService.
export interface HasError {
  error?: { code: string; message: string } | null
}

export function errMsg(r: HasError | null | undefined): string | null {
  return r && r.error ? r.error.message : null
}

// Surfaces a business error (alert) and returns true when the op failed.
export function failed(r: HasError | null | undefined): boolean {
  const m = errMsg(r)
  if (m) {
    window.alert(m)
    return true
  }
  return false
}
