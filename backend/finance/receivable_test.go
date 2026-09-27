package finance

import (
	"testing"

	"github.com/gastonlarap-a11y/app-finance/backend/shared"
)

func TestReceivableIsSettledAsARefund(t *testing.T) {
	ctx := t.Context()
	s := newTestService(t)
	dinner := s.CreateExpense(ctx, "2030-03-10", "Cena", "Comida", "", nil, KindUnico, "60000", 1)
	mustOK(t, "CreateExpense", dinner.Error)

	ana := s.CreateReceivable(ctx, dinner.Data.ID, " Ana ", "20000")
	mustOK(t, "CreateReceivable", ana.Error)
	mustOK(t, "CreateReceivable", s.CreateReceivable(ctx, dinner.Data.ID, "Beto", "20000").Error)
	if r := s.CreateReceivable(ctx, dinner.Data.ID, "Carla", "20001"); r.Error == nil || r.Error.Code != shared.ErrValidation {
		t.Fatalf("owed beyond the expense = %+v, want VALIDATION", r.Error)
	}
	for _, bad := range []struct{ person, amount string }{{"", "1"}, {"Ana", "0"}} {
		if r := s.CreateReceivable(ctx, dinner.Data.ID, bad.person, bad.amount); r.Error == nil || r.Error.Code != shared.ErrValidation {
			t.Fatalf("CreateReceivable(%q, %q) = %+v, want VALIDATION", bad.person, bad.amount, r.Error)
		}
	}

	list := s.ListReceivables(ctx)
	mustOK(t, "ListReceivables", list.Error)
	if len(list.Data) != 2 || list.Data[0].Person != "Ana" || list.Data[0].ExpenseDescription != "Cena" ||
		list.Data[0].ExpenseDate != "2030-03-10" || list.Data[0].SettledPeriod != "" {
		t.Fatalf("receivables = %+v", list.Data)
	}

	mustOK(t, "SettleReceivable", s.SettleReceivable(ctx, ana.Data.ID, "2030-04").Error)
	if r := s.SettleReceivable(ctx, ana.Data.ID, "2030-04"); r.Error == nil || r.Error.Code != shared.ErrConflict {
		t.Fatalf("second settle = %+v, want CONFLICT", r.Error)
	}
	april := s.MonthlySummary(ctx, "2030-04")
	mustOK(t, "MonthlySummary", april.Error)
	if april.Data.Gastos.String() != "-20000" {
		t.Fatalf("april gastos = %s, want Ana's 20.000 back", april.Data.Gastos)
	}
	list = s.ListReceivables(ctx)
	if list.Data[0].Person != "Beto" || list.Data[1].SettledPeriod != "2030-04" {
		t.Fatalf("after settling = %+v, want Beto still owed first and Ana settled in April", list.Data)
	}

	// Undoing the collection (deleting its refund) leaves it owed again.
	mustOK(t, "DeleteRefund", s.DeleteRefund(ctx, *list.Data[1].RefundID).Error)
	list = s.ListReceivables(ctx)
	if list.Data[0].SettledPeriod != "" || list.Data[1].SettledPeriod != "" {
		t.Fatalf("after deleting the refund = %+v, want both owed", list.Data)
	}
	mustOK(t, "DeleteReceivable", s.DeleteReceivable(ctx, ana.Data.ID).Error)
	if list := s.ListReceivables(ctx); len(list.Data) != 1 {
		t.Fatalf("after deleting = %+v, want Beto's only", list.Data)
	}
}
