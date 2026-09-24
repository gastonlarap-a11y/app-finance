// Chilean statement number and date formats.

const CL_AMOUNT = /^\d{1,3}(?:\.\d{3})*(?:,\d+)?$/
const CL_DATE = /^(\d{2})\/(\d{2})\/(\d{4})$/

export function isClAmount(s: string): boolean {
  return CL_AMOUNT.test(s.trim())
}

// parseClAmount turns "1.086.319" into "1086319" and "1.234,50" into
// "1234.50": thousands dots out, decimal comma to a point. Returns null for
// anything that is not an amount in that format.
export function parseClAmount(s: string): string | null {
  const t = s.trim()
  if (!CL_AMOUNT.test(t)) return null
  return t.replaceAll('.', '').replace(',', '.')
}

export function isClDate(s: string): boolean {
  return CL_DATE.test(s.trim())
}

// parseClDate turns "31/07/2026" into "2026-07-31" (null when not a date).
export function parseClDate(s: string): string | null {
  const m = CL_DATE.exec(s.trim())
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null
}
