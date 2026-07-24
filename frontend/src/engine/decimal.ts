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

  gte(o: Money): boolean {
    return this.v.gte(o.v)
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
