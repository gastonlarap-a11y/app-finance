package finance

import (
	"testing"
	"time"
)

func d(y int, m time.Month, day int) time.Time {
	return time.Date(y, m, day, 0, 0, 0, 0, time.UTC)
}

func TestPeriodOf(t *testing.T) {
	tests := []struct {
		name       string
		date       time.Time
		billingDay int
		want       string
	}{
		{"compra después del corte rueda al mes siguiente", d(2026, 6, 26), 24, "2026-07"},
		{"compra antes del corte queda en el mes", d(2026, 6, 23), 24, "2026-06"},
		{"compra el día del corte rueda al mes siguiente", d(2026, 6, 24), 24, "2026-07"},
		{"sin tarjeta (billingDay 0) no rueda", d(2026, 6, 26), 0, "2026-06"},
		{"diciembre rueda a enero del año siguiente", d(2026, 12, 31), 24, "2027-01"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := periodOf(tt.date, tt.billingDay); got != tt.want {
				t.Fatalf("periodOf(%s, %d) = %q, want %q", tt.date.Format("2006-01-02"), tt.billingDay, got, tt.want)
			}
		})
	}
}

func TestAddMonths(t *testing.T) {
	// MacBook: comprado 26/06/2026, 24 cuotas, corte 24 → cuota 1/24 en 2026-07,
	// cuota 24/24 en 2028-06.
	first := periodOf(d(2026, 6, 26), 24)
	if first != "2026-07" {
		t.Fatalf("primer período = %q, want 2026-07", first)
	}
	if got := addMonths(first, 23); got != "2028-06" {
		t.Fatalf("cuota 24/24 = %q, want 2028-06", got)
	}
	if got := addMonths("2026-12", 1); got != "2027-01" {
		t.Fatalf("addMonths cruce de año = %q, want 2027-01", got)
	}
}
