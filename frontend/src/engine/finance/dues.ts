// Pure date helpers of UpcomingDues (mirror of backend/finance/dues.go).
import { addMonths } from '@/engine/finance/period'

export const DueCard = 'tarjeta'
export const DueFixed = 'fijo'

// MAX_DUE_DAYS caps how far ahead UpcomingDues looks.
export const MAX_DUE_DAYS = 60
// DUE_LOOKBACK_DAYS keeps a missed due date on the list for a while: it is
// still unpaid, so it is the most urgent one, until it goes stale.
export const DUE_LOOKBACK_DAYS = 10

// shiftDays moves a YYYY-MM-DD date by n days (UTC, so no DST drift).
export function shiftDays(date: string, n: number): string {
  const [y, m, d] = [Number(date.slice(0, 4)), Number(date.slice(5, 7)), Number(date.slice(8, 10))]
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}

// monthsSpanned lists the YYYY-MM months from date `from` to date `to`.
export function monthsSpanned(from: string, to: string): string[] {
  const out: string[] = []
  for (let p = from.slice(0, 7); p <= to.slice(0, 7); p = addMonths(p, 1)) out.push(p)
  return out
}

// dayOfMonth is the date of `day` in `period`, or of its last day when the
// month is shorter (31 → 30 de abril).
export function dayOfMonth(period: string, day: number): string {
  const last = new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5, 7)), 0)).getUTCDate()
  return `${period}-${String(Math.min(day, last)).padStart(2, '0')}`
}
