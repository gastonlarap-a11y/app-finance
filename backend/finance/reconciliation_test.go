package finance

import (
	"testing"

	"github.com/gastonlarap-a11y/app-finance/backend/shared"
	"github.com/gastonlarap-a11y/app-finance/backend/shared/types"
)

func wantMoney(t *testing.T, what string, got types.Decimal, want string) {
	t.Helper()
	if !got.Equal(dec(t, want).Decimal) {
		t.Fatalf("%s = %s, want %s", what, got, want)
	}
}

// seedReconciliationHistory builds Nov 2025 – Feb 2026:
//
//	Nov: fixed −10.000, ahorro −20.000                     → −30.000
//	Dec: fixed −10.000                                    → −10.000
//	Jan: sueldo 1.000.000, gasto 300.000, fixed 10.000    → +690.000
//	Feb: sueldo 1.000.000, gasto 200.000, fixed 10.000, ahorro 50.000
func seedReconciliationHistory(t *testing.T, s *FinanceService) {
	t.Helper()
	ctx := t.Context()
	mustOK(t, "CreateFixedExpense", s.CreateFixedExpense(ctx, "Luz", "Hogar", nil, "2025-11", "10000").Error)
	goal := s.CreateSavingsGoal(ctx, "Viaje", "1000000", "")
	mustOK(t, "CreateSavingsGoal", goal.Error)
	mustOK(t, "AddSavingsContribution", s.AddSavingsContribution(ctx, goal.Data.ID, "2025-11", "20000").Error)
	mustOK(t, "AddSavingsContribution", s.AddSavingsContribution(ctx, goal.Data.ID, "2026-02", "50000").Error)
	mustOK(t, "SetSalary", s.SetSalary(ctx, "2026-01", "1000000").Error)
	mustOK(t, "SetSalary", s.SetSalary(ctx, "2026-02", "1000000").Error)
	mustOK(t, "CreateExpense", s.CreateExpense(ctx, "2026-01-10", "Super", "Comida", "", nil, KindUnico, "300000", 1).Error)
	mustOK(t, "CreateExpense", s.CreateExpense(ctx, "2026-02-10", "Super", "Comida", "", nil, KindUnico, "200000", 1).Error)
}

func monthly(t *testing.T, s *FinanceService, period string) *MonthlySummary {
	t.Helper()
	res := s.MonthlySummary(t.Context(), period)
	mustOK(t, "MonthlySummary "+period, res.Error)
	return res.Data
}

func TestReconciliationRestartsTheCarriedBalance(t *testing.T) {
	ctx := t.Context()
	s := newTestService(t)
	seedReconciliationHistory(t, s)

	// Without reconciling, the carried balance sums the whole history.
	feb := monthly(t, s, "2026-02")
	wantMoney(t, "Feb acumulado (history)", feb.Acumulado, "650000")
	if feb.AcumuladoDesde != "" || feb.Conciliacion != nil {
		t.Fatalf("unreconciled Feb: desde %q, conciliacion %+v", feb.AcumuladoDesde, feb.Conciliacion)
	}

	// Opening balance: the real balance before January (flows before it no longer count).
	mustOK(t, "SetReconciliation opening", s.SetReconciliation(ctx, "2025-12", "100000").Error)
	jan := monthly(t, s, "2026-01")
	wantMoney(t, "Jan acumulado", jan.Acumulado, "100000")
	if jan.AcumuladoDesde != "2025-12" {
		t.Fatalf("Jan acumuladoDesde = %q, want 2025-12", jan.AcumuladoDesde)
	}
	wantMoney(t, "Jan balance", jan.Balance, "790000")

	// Closing January 50.000 short (unrecorded cash): the difference shows and
	// February starts from the real balance.
	mustOK(t, "SetReconciliation Jan", s.SetReconciliation(ctx, "2026-01", "740000").Error)
	jan = monthly(t, s, "2026-01")
	if jan.Conciliacion == nil {
		t.Fatal("Jan has no reconciliation status")
	}
	wantMoney(t, "Jan saldo real", jan.Conciliacion.SaldoReal, "740000")
	wantMoney(t, "Jan calculado", jan.Conciliacion.Calculado, "790000")
	wantMoney(t, "Jan diferencia", jan.Conciliacion.Diferencia, "-50000")
	feb = monthly(t, s, "2026-02")
	wantMoney(t, "Feb acumulado", feb.Acumulado, "740000")
	if feb.AcumuladoDesde != "2026-01" {
		t.Fatalf("Feb acumuladoDesde = %q, want 2026-01", feb.AcumuladoDesde)
	}
	wantMoney(t, "Feb balance", feb.Balance, "1480000")

	// The year view resets its running balance at the reconciled close.
	year := s.YearSummary(ctx, 2026)
	mustOK(t, "YearSummary", year.Error)
	wantMoney(t, "Jan saldo", year.Data.Months[0].Saldo, "740000")
	wantMoney(t, "Feb saldo", year.Data.Months[1].Saldo, "1480000")
	if !year.Data.Months[0].Conciliado || year.Data.Months[1].Conciliado {
		t.Fatalf("conciliado flags = %v/%v, want true/false", year.Data.Months[0].Conciliado, year.Data.Months[1].Conciliado)
	}

	// So does the forecast.
	fc := s.CommitmentsForecast(ctx, "2026-01", 2)
	mustOK(t, "CommitmentsForecast", fc.Error)
	wantMoney(t, "forecast Jan saldo", fc.Data[0].SaldoProyectado, "740000")
	wantMoney(t, "forecast Feb saldo", fc.Data[1].SaldoProyectado, "1480000")

	// Replacing keeps one row per month; deleting falls back to the previous one.
	mustOK(t, "SetReconciliation Jan again", s.SetReconciliation(ctx, "2026-01", "-20000").Error)
	wantMoney(t, "Feb acumulado after replace", monthly(t, s, "2026-02").Acumulado, "-20000")
	mustOK(t, "DeleteReconciliation Jan", s.DeleteReconciliation(ctx, "2026-01").Error)
	feb = monthly(t, s, "2026-02")
	wantMoney(t, "Feb acumulado after delete", feb.Acumulado, "790000")
	if feb.AcumuladoDesde != "2025-12" {
		t.Fatalf("Feb acumuladoDesde after delete = %q, want 2025-12", feb.AcumuladoDesde)
	}
}

func TestReconciliationValidation(t *testing.T) {
	ctx := t.Context()
	s := newTestService(t)
	future := addMonths(currentPeriod(), 1)

	tests := []struct {
		name, period, amount string
		code                 string
	}{
		{"future month", future, "1000", shared.ErrValidation},
		{"bad period", "2026-13", "1000", shared.ErrValidation},
		{"out of range year", "1999-12", "1000", shared.ErrValidation},
		{"not a number", "2026-01", "mucho", shared.ErrValidation},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if r := s.SetReconciliation(ctx, tt.period, tt.amount); r.Error == nil || r.Error.Code != tt.code {
				t.Fatalf("SetReconciliation(%q, %q) error = %+v, want %s", tt.period, tt.amount, r.Error, tt.code)
			}
		})
	}
	if r := s.DeleteReconciliation(ctx, "2026-01"); r.Error == nil || r.Error.Code != shared.ErrNotFound {
		t.Fatalf("DeleteReconciliation of a missing month = %+v, want NOT_FOUND", r.Error)
	}
	// The current month may be closed (reconciled on its last day).
	mustOK(t, "SetReconciliation current month", s.SetReconciliation(ctx, currentPeriod(), "0").Error)
}
