// Port of backend/finance/period.go — YYYY-MM math done with plain integer
// arithmetic (no Date objects, no timezone traps).

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/

export interface DateParts {
  year: number
  month: number // 1..12
  day: number // 1..31
}

// periodOf returns the billing period (YYYY-MM) a purchase falls into. When the
// purchase is on a card and day >= billingDay (cutoff is exclusive), it rolls to
// the next month. Pass billingDay <= 0 for non-card expenses (no roll).
export function periodOf(date: DateParts, billingDay: number): string {
  let { year, month } = date
  if (billingDay > 0 && date.day >= billingDay) {
    month += 1
    if (month > 12) {
      month = 1
      year += 1
    }
  }
  return fmtPeriod(year, month)
}

// wellFormed is the period format alone, without validPeriod's year range: the
// month math below mirrors Go's time.Parse, which works on any four-digit year
// (the last cuota of a long plan may land past MAX_YEAR).
function wellFormed(s: string): boolean {
  return PERIOD_RE.test(s)
}

// addMonths advances a YYYY-MM period by n months (n may be negative).
// Mirrors Go: an unparseable period is returned unchanged.
export function addMonths(period: string, n: number): string {
  if (!wellFormed(period)) return period
  const year = Number(period.slice(0, 4))
  const month = Number(period.slice(5, 7))
  const total = year * 12 + (month - 1) + n
  return fmtPeriod(Math.floor(total / 12), (((total % 12) + 12) % 12) + 1)
}

// monthsBetween returns how many months b is after a (negative when b < a).
// Mirrors Go: an unparseable period counts as 0 months apart.
export function monthsBetween(a: string, b: string): number {
  if (!wellFormed(a) || !wellFormed(b)) return 0
  const idx = (p: string) => Number(p.slice(0, 4)) * 12 + Number(p.slice(5, 7))
  return idx(b) - idx(a)
}

// monthOf returns the month number (1..12) of a period, or 0 if invalid.
export function monthOf(period: string): number {
  return wellFormed(period) ? Number(period.slice(5, 7)) : 0
}

// currentPeriod is today's YYYY-MM (local time, matching time.Now() on desktop).
export function currentPeriod(): string {
  const d = new Date()
  return fmtPeriod(d.getFullYear(), d.getMonth() + 1)
}

// The years a date or period may fall in (mirrors minYear/maxYear in Go).
// Periods are compared as strings, which only orders correctly while every year
// has exactly four digits; the bounds also keep typos like 0226 out.
export const MIN_YEAR = 2000
export const MAX_YEAR = 2099

export function inYearRange(year: number): boolean {
  return year >= MIN_YEAR && year <= MAX_YEAR
}

// validPeriod reports whether s parses as YYYY-MM inside the supported years.
export function validPeriod(s: string): boolean {
  return PERIOD_RE.test(s) && inYearRange(Number(s.slice(0, 4)))
}

function fmtPeriod(year: number, month: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`
}
