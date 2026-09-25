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

const CL_SHORT_DATE = /^(\d{2})\/(\d{2})\/(\d{2})$/

// parseClShortDate turns "16/06/26" into "2026-06-16" (statements print
// two-digit years; every date they carry is in this century).
export function parseClShortDate(s: string): string | null {
  const m = CL_SHORT_DATE.exec(s.trim())
  return m ? `20${m[3]}-${m[2]}-${m[1]}` : null
}

const CL_MONEY = /^(US\$|\$)?\s*(-)?\s*(\d{1,3}(?:\.\d{3})*(?:,\d+)?)$/

// parseClMoney reads a signed amount with an optional currency symbol:
// "$-59.913" → "-59913", "US$ 15.300,00" → "15300.00", "-2.027,00" → "-2027.00".
export function parseClMoney(s: string): string | null {
  const m = CL_MONEY.exec(s.trim())
  const amount = m?.[3] !== undefined ? parseClAmount(m[3]) : null
  if (amount === null) return null
  return (m?.[2] ?? '') + amount
}

// hasCurrencySymbol tells "$ 1.000" / "US$ 1,00" from a bare number.
export function hasCurrencySymbol(s: string): boolean {
  return /^(US)?\$/.test(s.trim())
}

const CL_PERCENT = /^(\d+(?:,\d+)?)\s*%$/

// parseClPercent turns "2,56%" into "2.56" (null when not a percentage).
export function parseClPercent(s: string): string | null {
  const m = CL_PERCENT.exec(s.trim())
  return m?.[1] !== undefined ? m[1].replace(',', '.') : null
}
