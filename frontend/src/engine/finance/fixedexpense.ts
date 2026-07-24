// Pure fixed-expense domain rules, ported verbatim from
// backend/finance/fixedexpense.go. Periods compare lexically (YYYY-MM).
import { Money } from '@/engine/decimal'
import type { FixedExpense } from '@/services/contract'
import type { FixedExpenseAmountRow } from '@/engine/finance/models'

// activeIn reports whether the fixed expense should be billed in the given month.
export function activeIn(fe: Pick<FixedExpense, 'startPeriod' | 'endPeriod'>, period: string): boolean {
  if (period < fe.startPeriod) return false
  if (fe.endPeriod !== '' && period > fe.endPeriod) return false
  return true
}

// resolveFixedAmount returns the amount effective for `period`: the entry with
// the greatest effectiveFrom that is <= period. `amounts` may be in any order.
// Returns zero when no entry applies yet.
export function resolveFixedAmount(amounts: FixedExpenseAmountRow[], period: string): Money {
  let best = ''
  let out = Money.zero()
  for (const a of amounts) {
    if (a.effectiveFrom <= period && a.effectiveFrom >= best) {
      best = a.effectiveFrom
      out = Money.fromString(a.amount)
    }
  }
  return out
}
