package finance

import (
	"slices"
	"testing"

	"github.com/gastonlarap-a11y/app-finance/backend/shared"
)

func cuotaAmounts(t *testing.T, s *FinanceService, expenseID int64) []string {
	t.Helper()
	var insts []Installment
	if err := s.db.NewSelect().Model(&insts).Where("expense_id = ?", expenseID).Order("number ASC").Scan(t.Context()); err != nil {
		t.Fatal(err)
	}
	out := make([]string, len(insts))
	for i, inst := range insts {
		out[i] = inst.Amount.String()
	}
	return out
}

func TestConfirmSettlesTheBanksRoundingInTheLastCuota(t *testing.T) {
	ctx := t.Context()
	s := newTestService(t)
	card := s.CreateCard(ctx, "Itaú", "1000000", 26, "4321")
	mustOK(t, "CreateCard", card.Error)
	importStatement(t, s, nationalStatement())
	// TIENDA DOS: 60.001 in 6 cuotas of 10.000.
	dos := pendingByDescription(t, s)["TIENDA DOS"]
	ex := s.ConfirmImportItem(ctx, dos.ID, dos.Date, "Tienda dos", "", "", &card.Data.ID, KindCuotas, dos.InstallmentAmount, 6, "")
	mustOK(t, "ConfirmImportItem", ex.Error)
	want := []string{"10000", "10000", "10000", "10000", "10000", "10001"}
	if got := cuotaAmounts(t, s, ex.Data.ID); !slices.Equal(got, want) {
		t.Fatalf("cuotas = %v, want %v", got, want)
	}
}

func TestSetInstallmentAmountOnlyOnPendingCuotas(t *testing.T) {
	ctx := t.Context()
	s := newTestService(t)
	ex := s.CreateExpense(ctx, "2030-01-10", "Notebook", "", "", nil, KindCuotas, "100000", 3)
	mustOK(t, "CreateExpense", ex.Error)
	var insts []Installment
	if err := s.db.NewSelect().Model(&insts).Where("expense_id = ?", ex.Data.ID).Order("number ASC").Scan(ctx); err != nil {
		t.Fatal(err)
	}
	mustOK(t, "SetInstallmentAmount", s.SetInstallmentAmount(ctx, insts[2].ID, "99998").Error)
	if got := cuotaAmounts(t, s, ex.Data.ID); !slices.Equal(got, []string{"100000", "100000", "99998"}) {
		t.Fatalf("cuotas = %v", got)
	}
	mustOK(t, "SetInstallmentPaid", s.SetInstallmentPaid(ctx, insts[0].ID, true).Error)
	if r := s.SetInstallmentAmount(ctx, insts[0].ID, "1"); r.Error == nil || r.Error.Code != shared.ErrValidation {
		t.Fatalf("a paid cuota = %+v, want VALIDATION", r.Error)
	}
	if r := s.SetInstallmentAmount(ctx, insts[1].ID, "0"); r.Error == nil || r.Error.Code != shared.ErrValidation {
		t.Fatalf("zero = %+v, want VALIDATION", r.Error)
	}
	if r := s.SetInstallmentAmount(ctx, 999, "1"); r.Error == nil || r.Error.Code != shared.ErrNotFound {
		t.Fatalf("unknown cuota = %+v, want NOT_FOUND", r.Error)
	}
}

func TestPrepayMovesOnlyPendingCuotas(t *testing.T) {
	ctx := t.Context()
	s := newTestService(t)
	ex := s.CreateExpense(ctx, "2030-01-10", "Notebook", "", "", nil, KindCuotas, "100000", 4)
	mustOK(t, "CreateExpense", ex.Error)
	var first Installment
	if err := s.db.NewSelect().Model(&first).Where("expense_id = ? AND number = 1", ex.Data.ID).Scan(ctx); err != nil {
		t.Fatal(err)
	}
	mustOK(t, "SetInstallmentPaid", s.SetInstallmentPaid(ctx, first.ID, true).Error)

	mustOK(t, "PrepayExpense", s.PrepayExpense(ctx, ex.Data.ID, "2030-02").Error)
	want := []string{"2030-01", "2030-02", "2030-02", "2030-02"}
	if got := installmentPeriods(t, s, ex.Data.ID); !slices.Equal(got, want) {
		t.Fatalf("periods = %v, want %v", got, want)
	}
	sum := s.MonthlySummary(ctx, "2030-02")
	mustOK(t, "MonthlySummary", sum.Error)
	if sum.Data.Gastos.String() != "300000" {
		t.Fatalf("february gastos = %s, want the 300.000 balance", sum.Data.Gastos)
	}
	if r := s.PrepayExpense(ctx, 999, "2030-02"); r.Error == nil || r.Error.Code != shared.ErrNotFound {
		t.Fatalf("unknown expense = %+v, want NOT_FOUND", r.Error)
	}
	if r := s.PrepayExpense(ctx, ex.Data.ID, "2030-2"); r.Error == nil || r.Error.Code != shared.ErrValidation {
		t.Fatalf("bad period = %+v, want VALIDATION", r.Error)
	}
}
