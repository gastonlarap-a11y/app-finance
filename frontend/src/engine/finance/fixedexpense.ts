// Pure effective-dated rules, ported verbatim from
// backend/finance/fixedexpense.go. Periods compare lexically (YYYY-MM).
import { Money } from '@/engine/decimal'
import type { FixedExpense } from '@/services/contract'
import { addMonths, monthsBetween } from '@/engine/finance/period'

// A row whose amount applies from effectiveFrom onward until the next row takes
// over (fixed-expense amounts, category budgets).
export interface EffectiveDated {
  effectiveFrom: string
  amount: string
}

// activeIn reports whether the fixed expense should be billed in the given month.
export function activeIn(fe: Pick<FixedExpense, 'startPeriod' | 'endPeriod'>, period: string): boolean {
  if (period < fe.startPeriod) return false
  if (fe.endPeriod !== '' && period > fe.endPeriod) return false
  return true
}

// latestAsOf returns the row in effect for `period`: the one with the greatest
// effectiveFrom that is <= period, or undefined when none applies yet. `rows`
// may be in any order.
export function latestAsOf<T extends EffectiveDated>(rows: readonly T[], period: string): T | undefined {
  let best: T | undefined
  for (const r of rows) {
    if (r.effectiveFrom <= period && (best === undefined || r.effectiveFrom >= best.effectiveFrom)) {
      best = r
    }
  }
  return best
}

// resolveAsOf returns the amount effective for `period`, or zero when no row
// applies yet.
export function resolveAsOf(rows: readonly EffectiveDated[], period: string): Money {
  const row = latestAsOf(rows, period)
  return row ? Money.fromString(row.amount) : Money.zero()
}

// sumAsOf totals resolveAsOf(rows, m) for every month m in [from, to] without
// walking month by month: each row covers a contiguous stretch (until the next
// row takes over), so its share is amount × months-in-overlap.
export function sumAsOf(rows: readonly EffectiveDated[], from: string, to: string): Money {
  let total = Money.zero()
  if (from > to) return total
  const sorted = [...rows].sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : a.effectiveFrom > b.effectiveFrom ? 1 : 0))
  sorted.forEach((r, i) => {
    let end = to
    const next = sorted[i + 1]
    if (next) {
      const beforeNext = addMonths(next.effectiveFrom, -1)
      if (beforeNext < end) end = beforeNext
    }
    const start = r.effectiveFrom > from ? r.effectiveFrom : from
    if (start > end) return
    total = total.add(Money.fromString(r.amount).mulInt(monthsBetween(start, end) + 1))
  })
  return total
}
