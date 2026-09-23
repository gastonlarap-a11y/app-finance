// Money comparisons on the decimal strings the backend sends. Never parseFloat /
// Number() for decisions (sign, over-limit…): decimal.js keeps them exact.
// `ratio` is the one place a JS number is produced, for display-only widths.
import Decimal from 'decimal.js'

function dec(v: string | null | undefined): Decimal {
  try {
    return new Decimal(v ?? 0)
  } catch {
    return new Decimal(0)
  }
}

export function isNegative(v: string): boolean {
  return dec(v).isNegative()
}

export function isZero(v: string): boolean {
  return dec(v).isZero()
}

// compare returns -1, 0 or 1 as a is less than, equal to or greater than b.
export function compare(a: string, b: string): number {
  return dec(a).comparedTo(dec(b))
}

// sum adds decimal strings exactly.
export function sum(values: readonly string[]): string {
  return values.reduce((acc, v) => acc.plus(dec(v)), new Decimal(0)).toString()
}

// greaterThan reports a > b.
export function greaterThan(a: string, b: string): boolean {
  return dec(a).gt(dec(b))
}

// ratio is |part| / |whole| clamped to [0, 1] — for bar widths and heatmap
// intensity only. A zero whole yields 0.
export function ratio(part: string, whole: string): number {
  const w = dec(whole).abs()
  if (w.isZero()) return 0
  return Decimal.min(1, dec(part).abs().div(w)).toNumber()
}

// maxOf returns the largest absolute value among amounts (as a decimal string).
export function maxAbs(values: readonly string[]): string {
  return values.reduce((acc, v) => Decimal.max(acc, dec(v).abs()), new Decimal(0)).toString()
}

// pctChange is the whole-number percent change from `base` to `current`
// ("+18", "-5", "0"), or null when there is no base to compare with.
export function pctChange(current: string, base: string): number | null {
  const b = dec(base)
  if (b.isZero()) return null
  return dec(current).minus(b).div(b.abs()).times(100).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber()
}

// times returns a × n (e.g. cuota × número de cuotas), for previews.
export function times(a: string, n: number): string {
  return dec(a).times(n).toString()
}
