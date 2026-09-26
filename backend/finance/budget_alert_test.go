package finance

import "testing"

func TestBudgetAlertAtEightyPercent(t *testing.T) {
	ctx := t.Context()
	tests := []struct {
		name       string
		spent      string
		near, over bool
	}{
		{"under 80 %", "79999", false, false},
		{"exactly 80 %", "80000", true, false},
		{"at the cap", "100000", true, false},
		{"over the cap", "100001", false, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s := newTestService(t)
			cat := s.CreateCategory(ctx, "Comida")
			mustOK(t, "CreateCategory", cat.Error)
			mustOK(t, "SetCategoryBudget", s.SetCategoryBudget(ctx, cat.Data.ID, "2026-01", "100000").Error)
			mustOK(t, "CreateExpense", s.CreateExpense(ctx, "2026-01-10", "Super", "Comida", "", nil, KindUnico, tt.spent, 1).Error)
			b := monthly(t, s, "2026-01").Presupuestos
			if len(b) != 1 || b[0].Near != tt.near || b[0].Over != tt.over {
				t.Fatalf("budget = %+v, want near %v over %v", b, tt.near, tt.over)
			}
		})
	}
}

func TestNearCapIgnoresAZeroCap(t *testing.T) {
	if nearCap(dec(t, "0"), dec(t, "0")) {
		t.Fatal("a zero cap raised the alert")
	}
}
