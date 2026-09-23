package finance

import (
	"testing"

	"github.com/gastonlarap-a11y/app-finance/backend/shared/types"
)

func amt(t *testing.T, s string) types.Decimal {
	t.Helper()
	d, err := types.New(s)
	if err != nil {
		t.Fatalf("types.New(%q): %v", s, err)
	}
	return d
}

// sumMonthByMonth is the original O(months) implementation, kept as the oracle
// that sumAsOf must match.
func sumMonthByMonth(rows []FixedExpenseAmount, from, to string) types.Decimal {
	total := types.Zero()
	for m := from; m <= to; m = addMonths(m, 1) {
		total = total.Add(resolveAsOf(rows, m))
	}
	return total
}

func TestSumAsOfMatchesMonthByMonth(t *testing.T) {
	rows := []FixedExpenseAmount{
		// Deliberately unsorted: sumAsOf must not depend on input order.
		{EffectiveFrom: "2026-06", Amount: amt(t, "12000")},
		{EffectiveFrom: "2025-11", Amount: amt(t, "9990")},
		{EffectiveFrom: "2026-01", Amount: amt(t, "10500.50")},
	}
	tests := []struct {
		name     string
		from, to string
	}{
		{"rango completo con tres tramos", "2025-11", "2027-03"},
		{"empieza antes del primer monto (meses en cero)", "2025-06", "2026-02"},
		{"un solo mes", "2026-06", "2026-06"},
		{"termina justo antes de un cambio", "2025-12", "2026-05"},
		{"rango vacío (from > to)", "2026-05", "2026-04"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := sumAsOf(rows, tt.from, tt.to)
			want := sumMonthByMonth(rows, tt.from, tt.to)
			if got.Cmp(want) != 0 {
				t.Fatalf("sumAsOf(%s..%s) = %s, want %s", tt.from, tt.to, got, want)
			}
		})
	}
}

func TestLatestAsOf(t *testing.T) {
	rows := []FixedExpenseAmount{
		{EffectiveFrom: "2026-03", Amount: amt(t, "2")},
		{EffectiveFrom: "2026-01", Amount: amt(t, "1")},
	}
	tests := []struct {
		name     string
		period   string
		wantOK   bool
		wantFrom string
	}{
		{"antes de cualquier fila", "2025-12", false, ""},
		{"en la primera fila", "2026-01", true, "2026-01"},
		{"entre filas usa la anterior", "2026-02", true, "2026-01"},
		{"después de la última", "2027-01", true, "2026-03"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			row, ok := latestAsOf(rows, tt.period)
			if ok != tt.wantOK || (ok && row.EffectiveFrom != tt.wantFrom) {
				t.Fatalf("latestAsOf(%s) = (%+v, %v), want from %q ok %v", tt.period, row, ok, tt.wantFrom, tt.wantOK)
			}
		})
	}
}
