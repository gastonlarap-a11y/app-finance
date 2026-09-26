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

// Currencies a fixed expense's amounts may be in (mirror of the Go constants).
export const CurrencyCLP = 'CLP'
export const CurrencyUF = 'UF'

// validIntervals: monthly, bimonthly, quarterly, every four months, half-yearly, yearly.
export const validIntervals: readonly number[] = [1, 2, 3, 4, 6, 12]

type Schedule = Pick<FixedExpense, 'startPeriod' | 'endPeriod' | 'intervalMonths'>

// activeIn reports whether `period` falls within the fixed expense's life
// [start, end]; whether it charges that month is billsIn.
export function activeIn(fe: Pick<FixedExpense, 'startPeriod' | 'endPeriod'>, period: string): boolean {
  if (period < fe.startPeriod) return false
  if (fe.endPeriod !== '' && period > fe.endPeriod) return false
  return true
}

// interval is intervalMonths, never below 1.
export function interval(fe: Pick<FixedExpense, 'intervalMonths'>): number {
  return Math.max(fe.intervalMonths, 1)
}

// billsIn reports whether the fixed expense charges in `period`: inside its
// [start, end] and on its schedule (every interval months from the start).
export function billsIn(fe: Schedule, period: string): boolean {
  return activeIn(fe, period) && monthsBetween(fe.startPeriod, period) % interval(fe) === 0
}

// nextBilling is the first month at or after `from` it bills in, or '' once it has ended.
export function nextBilling(fe: Schedule, from: string): string {
  let p = fe.startPeriod
  if (from > p) {
    const n = interval(fe)
    p = addMonths(fe.startPeriod, Math.ceil(monthsBetween(fe.startPeriod, from) / n) * n)
  }
  if (fe.endPeriod !== '' && p > fe.endPeriod) return ''
  return p
}

// UFRates are the stored UF values by month (mirror of ufRates in uf.go).
export class UFRates {
  private readonly periods: string[]
  constructor(private readonly values: ReadonlyMap<string, Money>) {
    this.periods = [...values.keys()].sort()
  }

  has(period: string): boolean {
    return this.values.has(period)
  }

  // valueFor is the UF value for `period` and whether it is an estimate: a
  // month not downloaded takes the closest earlier value, or the earliest one.
  valueFor(period: string): { value: Money; estimated: boolean } {
    const exact = this.values.get(period)
    if (exact) return { value: exact, estimated: false }
    const after = this.periods.findIndex((p) => p > period)
    const idx = after === -1 ? this.periods.length - 1 : after > 0 ? after - 1 : 0
    const near = this.periods[idx]
    return { value: near ? (this.values.get(near) ?? Money.zero()) : Money.zero(), estimated: true }
  }
}

type Priced = Schedule & Pick<FixedExpense, 'currency'>

// fixedCharge is what a fixed expense bills in pesos in `period` (the caller
// has checked billsIn), the amount in its own currency, and whether the peso
// figure rests on an estimated UF value.
export function fixedCharge(
  fe: Priced,
  amounts: readonly EffectiveDated[],
  uf: UFRates,
  period: string,
): { clp: Money; original: Money; estimated: boolean } {
  const original = resolveAsOf(amounts, period)
  if (fe.currency !== CurrencyUF) return { clp: original, original, estimated: false }
  const { value, estimated } = uf.valueFor(period)
  return { clp: original.mulRound(value), original, estimated }
}

// fixedTotal sums a fixed expense's charges over the months [from, to] it
// bills in ('' from = its start): monthly CLP multiplies stretches out
// (sumAsOf); the rest walk their billing months.
export function fixedTotal(fe: Priced, amounts: readonly EffectiveDated[], uf: UFRates, from: string, to: string): Money {
  const start = from > fe.startPeriod ? from : fe.startPeriod
  const end = fe.endPeriod !== '' && fe.endPeriod < to ? fe.endPeriod : to
  if (start > end) return Money.zero()
  if (interval(fe) === 1 && fe.currency !== CurrencyUF) return sumAsOf(amounts, start, end)
  let total = Money.zero()
  for (let p = nextBilling(fe, start); p !== '' && p <= end; p = addMonths(p, interval(fe))) {
    total = total.add(fixedCharge(fe, amounts, uf, p).clp)
  }
  return total
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
