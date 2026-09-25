// Money wrapper mirroring backend/shared/types.Decimal (shopspring) on top of
// decimal.js. Values enter and leave the engine as strings — the same TEXT
// representation Go writes to SQLite and marshals to JSON — and never as JS
// numbers, so no float precision is lost.
import DecimalJs from 'decimal.js'

// CLP amounts are integers; 40 significant digits leaves huge headroom for sums.
const Big = DecimalJs.clone({ precision: 40 })

export class Money {
  private constructor(private readonly v: DecimalJs) {}

  // fromString mirrors types.New: throws on an unparseable value.
  static fromString(s: string): Money {
    return new Money(new Big(s))
  }

  static zero(): Money {
    return new Money(new Big(0))
  }

  add(o: Money): Money {
    return new Money(this.v.plus(o.v))
  }

  sub(o: Money): Money {
    return new Money(this.v.minus(o.v))
  }

  // mulInt returns this × n (e.g. a monthly amount over n months).
  mulInt(n: number): Money {
    return new Money(this.v.times(n))
  }

  // divCeil mirrors types.Decimal.DivCeil: this / n rounded up to a whole unit.
  divCeil(n: number): Money {
    return new Money(this.v.div(n).toDecimalPlaces(0, Big.ROUND_CEIL))
  }

  // divRound mirrors types.Decimal.DivRound: half away from zero, whole units.
  divRound(n: number): Money {
    return new Money(this.v.div(n).toDecimalPlaces(0, Big.ROUND_HALF_UP))
  }

  abs(): Money {
    return new Money(this.v.abs())
  }

  neg(): Money {
    return new Money(this.v.neg())
  }

  // times multiplies by another decimal (e.g. a USD amount by a CLP/USD rate).
  times(o: Money): Money {
    return new Money(this.v.times(o.v))
  }

  // div divides by another decimal; callers round the result with round().
  div(o: Money): Money {
    return new Money(this.v.div(o.v))
  }

  // round mirrors shopspring's Round: half away from zero, to `places` decimals.
  round(places: number): Money {
    return new Money(this.v.toDecimalPlaces(places, Big.ROUND_HALF_UP))
  }

  gte(o: Money): boolean {
    return this.v.gte(o.v)
  }

  gt(o: Money): boolean {
    return this.v.gt(o.v)
  }

  cmp(o: Money): number {
    return this.v.cmp(o.v)
  }

  isZero(): boolean {
    return this.v.isZero()
  }

  isNegative(): boolean {
    return this.v.isNegative()
  }

  toString(): string {
    return this.v.toString()
  }
}

// parseAmount mirrors the Go helper: trims, validates, rejects negatives.
// Returns null when invalid so callers build the matching AppError.
export function parseAmount(s: string): Money | null {
  try {
    const m = Money.fromString(s.trim())
    return m.isNegative() ? null : m
  } catch {
    return null
  }
}
