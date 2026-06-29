package types

import (
	"database/sql/driver"
	"fmt"
	"strings"

	"github.com/shopspring/decimal"
)

// Decimal wraps shopspring/decimal for safe monetary values.
//   - Stored/scanned transparently as TEXT (SQLite) / NUMERIC (PostgreSQL) by bun.
//   - Marshalled to JSON as a string (never a float) to avoid JS precision loss.
type Decimal struct {
	decimal.Decimal
}

func New(value string) (Decimal, error) {
	d, err := decimal.NewFromString(value)
	return Decimal{d}, err
}

func FromInt(v int64) Decimal { return Decimal{decimal.NewFromInt(v)} }

// Zero returns a Decimal valued 0.
func Zero() Decimal { return Decimal{decimal.Zero} }

// Add, Sub return new Decimals (shadowing the embedded decimal.Decimal methods so
// callers keep working with the wrapper type instead of the bare shopspring type).
func (d Decimal) Add(o Decimal) Decimal { return Decimal{d.Decimal.Add(o.Decimal)} }
func (d Decimal) Sub(o Decimal) Decimal { return Decimal{d.Decimal.Sub(o.Decimal)} }

// GTE reports whether d >= o. IsNegative/IsZero are promoted from decimal.Decimal.
func (d Decimal) GTE(o Decimal) bool { return d.Decimal.Cmp(o.Decimal) >= 0 }

// Value implements driver.Valuer — stored as a string.
func (d Decimal) Value() (driver.Value, error) {
	return d.Decimal.String(), nil
}

// Scan implements sql.Scanner.
func (d *Decimal) Scan(value any) error {
	switch v := value.(type) {
	case nil:
		d.Decimal = decimal.Zero
	case string:
		dec, err := decimal.NewFromString(v)
		if err != nil {
			return err
		}
		d.Decimal = dec
	case []byte:
		dec, err := decimal.NewFromString(string(v))
		if err != nil {
			return err
		}
		d.Decimal = dec
	case float64:
		d.Decimal = decimal.NewFromFloat(v)
	case int64:
		d.Decimal = decimal.NewFromInt(v)
	default:
		return fmt.Errorf("decimal: cannot scan %T", value)
	}
	return nil
}

// MarshalJSON renders as a quoted string.
func (d Decimal) MarshalJSON() ([]byte, error) {
	return []byte("\"" + d.Decimal.String() + "\""), nil
}

func (d *Decimal) UnmarshalJSON(data []byte) error {
	dec, err := decimal.NewFromString(strings.Trim(string(data), "\""))
	if err != nil {
		return err
	}
	d.Decimal = dec
	return nil
}
