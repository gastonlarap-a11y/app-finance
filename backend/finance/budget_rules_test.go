package finance

import (
	"testing"

	"github.com/gastonlarap-a11y/app-finance/backend/shared"
)

func TestUncategorizedIsReserved(t *testing.T) {
	ctx := t.Context()
	s := newTestService(t)
	for _, name := range []string{"Sin categoría", "  sin CATEGORÍA "} {
		if r := s.CreateCategory(ctx, name); r.Error == nil || r.Error.Code != shared.ErrValidation {
			t.Fatalf("CreateCategory(%q) = %+v, want VALIDATION", name, r.Error)
		}
	}
	cat := s.CreateCategory(ctx, "Comida")
	mustOK(t, "CreateCategory", cat.Error)
	if r := s.UpdateCategory(ctx, cat.Data.ID, "Sin categoría"); r.Error == nil || r.Error.Code != shared.ErrValidation {
		t.Fatalf("rename to the reserved name = %+v, want VALIDATION", r.Error)
	}
}

// budgetOf returns the month's status of the only budget in effect.
func budgetOf(t *testing.T, s *FinanceService, period string) BudgetStatus {
	t.Helper()
	sum := s.MonthlySummary(t.Context(), period)
	mustOK(t, "MonthlySummary", sum.Error)
	if len(sum.Data.Presupuestos) != 1 {
		t.Fatalf("%s: presupuestos = %+v, want 1", period, sum.Data.Presupuestos)
	}
	return sum.Data.Presupuestos[0]
}

func TestZeroBudgetIsACapNotItsAbsence(t *testing.T) {
	ctx := t.Context()
	s := newTestService(t)
	cat := s.CreateCategory(ctx, "Delivery")
	mustOK(t, "CreateCategory", cat.Error)
	mustOK(t, "SetCategoryBudget", s.SetCategoryBudget(ctx, cat.Data.ID, "2030-01", "0").Error)

	if b := budgetOf(t, s, "2030-01"); b.Over || b.Budget.String() != "0" {
		t.Fatalf("nothing spent = %+v, want within the $0 cap", b)
	}
	mustOK(t, "CreateExpense", s.CreateExpense(ctx, "2030-02-03", "Pizza", "Delivery", "", nil, KindUnico, "9990", 1).Error)
	if b := budgetOf(t, s, "2030-02"); !b.Over || b.Remaining.String() != "-9990" {
		t.Fatalf("any spending = %+v, want over the $0 cap", b)
	}
	mustOK(t, "RemoveCategoryBudget", s.RemoveCategoryBudget(ctx, cat.Data.ID, "2030-03").Error)
	if views := s.ListCategoryBudgets(ctx, "2030-03"); len(views.Data) != 0 {
		t.Fatalf("after removing the cap = %+v, want none", views.Data)
	}
	if views := s.ListCategoryBudgets(ctx, "2030-02"); len(views.Data) != 1 {
		t.Fatalf("February keeps its $0 cap: %+v", views.Data)
	}
}

func TestRolloverCarriesWhatWasLeftUnspent(t *testing.T) {
	ctx := t.Context()
	s := newTestService(t)
	cat := s.CreateCategory(ctx, "Comida")
	mustOK(t, "CreateCategory", cat.Error)
	id := cat.Data.ID
	mustOK(t, "SetCategoryBudget", s.SetCategoryBudget(ctx, id, "2030-01", "100000").Error)
	mustOK(t, "CreateExpense", s.CreateExpense(ctx, "2030-01-10", "Super", "Comida", "", nil, KindUnico, "70000", 1).Error)
	mustOK(t, "CreateExpense", s.CreateExpense(ctx, "2030-02-10", "Super", "Comida", "", nil, KindUnico, "150000", 1).Error)

	if b := budgetOf(t, s, "2030-02"); !b.Carried.IsZero() || !b.Over {
		t.Fatalf("without rollover = %+v, want nothing carried and over", b)
	}
	mustOK(t, "SetCategoryRollover", s.SetCategoryRollover(ctx, id, true).Error)
	// January left 30.000: February has 130.000 and spends 150.000.
	if b := budgetOf(t, s, "2030-02"); b.Carried.String() != "30000" || b.Remaining.String() != "-20000" || !b.Over {
		t.Fatalf("february = %+v, want 30.000 carried and 20.000 over", b)
	}
	// February overspent: March starts from its own cap, no debt carried.
	if b := budgetOf(t, s, "2030-03"); !b.Carried.IsZero() || b.Remaining.String() != "100000" {
		t.Fatalf("march = %+v, want a fresh 100.000", b)
	}
	// Two quiet months add up; a month without a cap starts over.
	if b := budgetOf(t, s, "2030-05"); b.Carried.String() != "200000" {
		t.Fatalf("may = %+v, want March and April carried (200.000)", b)
	}
	mustOK(t, "RemoveCategoryBudget", s.RemoveCategoryBudget(ctx, id, "2030-06").Error)
	mustOK(t, "SetCategoryBudget", s.SetCategoryBudget(ctx, id, "2030-07", "100000").Error)
	if b := budgetOf(t, s, "2030-07"); !b.Carried.IsZero() {
		t.Fatalf("july = %+v, want nothing carried across a month without a cap", b)
	}
	if r := s.SetCategoryRollover(ctx, 999, true); r.Error == nil || r.Error.Code != shared.ErrNotFound {
		t.Fatalf("unknown category = %+v, want NOT_FOUND", r.Error)
	}
}
