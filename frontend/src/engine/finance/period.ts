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

// addMonths advances a YYYY-MM period by n months (n may be negative).
// Mirrors Go: an unparseable period is returned unchanged.
export function addMonths(period: string, n: number): string {
  if (!validPeriod(period)) return period
  const year = Number(period.slice(0, 4))
  const month = Number(period.slice(5, 7))
  const total = year * 12 + (month - 1) + n
  return fmtPeriod(Math.floor(total / 12), (((total % 12) + 12) % 12) + 1)
}

// currentPeriod is today's YYYY-MM (local time, matching time.Now() on desktop).
export function currentPeriod(): string {
  const d = new Date()
  return fmtPeriod(d.getFullYear(), d.getMonth() + 1)
}

// validPeriod reports whether s parses as YYYY-MM.
export function validPeriod(s: string): boolean {
  return PERIOD_RE.test(s)
}

function fmtPeriod(year: number, month: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`
}
