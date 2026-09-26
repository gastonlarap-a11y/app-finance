package finance

import (
	"slices"
	"strings"
	"testing"

	"github.com/gastonlarap-a11y/app-finance/backend/shared"
)

func movTags(t *testing.T, s *FinanceService, period string, expenseID int64) []string {
	t.Helper()
	for _, mv := range monthly(t, s, period).Movimientos {
		if mv.Source == SourceCuota && mv.ExpenseID == expenseID {
			return mv.Tags
		}
	}
	t.Fatalf("expense %d not in %s", expenseID, period)
	return nil
}

func TestTagsAcrossCategories(t *testing.T) {
	ctx := t.Context()
	s := newTestService(t)
	hotel := s.CreateExpense(ctx, "2026-02-10", "Hotel", "Alojamiento", "", nil, KindUnico, "300000", 1)
	mustOK(t, "hotel", hotel.Error)
	flight := s.CreateExpense(ctx, "2026-01-15", "Pasaje", "Transporte", "", nil, KindCuotas, "100000", 3)
	mustOK(t, "flight", flight.Error)
	mustOK(t, "other", s.CreateExpense(ctx, "2026-02-11", "Super", "Comida", "", nil, KindUnico, "50000", 1).Error)

	mustOK(t, "tag hotel", s.SetExpenseTags(ctx, hotel.Data.ID, []string{" Viaje ", "trabajo", "VIAJE", ""}).Error)
	mustOK(t, "tag flight", s.SetExpenseTags(ctx, flight.Data.ID, []string{"viaje"}).Error)
	if got := movTags(t, s, "2026-02", hotel.Data.ID); !slices.Equal(got, []string{"trabajo", "Viaje"}) {
		t.Fatalf("hotel tags = %v, want [trabajo Viaje]", got)
	}
	tags, err := s.ListTags(ctx)
	if err != nil || len(tags) != 2 || tags[0].Name != "trabajo" || tags[1].Name != "Viaje" || tags[1].Count != 2 {
		t.Fatalf("ListTags = %+v (err %v), want trabajo(1), Viaje(2)", tags, err)
	}

	// Search by tag, any case; the sum covers every match even across pages.
	res := s.SearchExpenses(ctx, ExpenseFilter{Tag: "viaje", Limit: 1})
	mustOK(t, "SearchExpenses", res.Error)
	if res.Data.Count != 2 || len(res.Data.Items) != 1 {
		t.Fatalf("search = %d hits, %d items; want 2 and 1", res.Data.Count, len(res.Data.Items))
	}
	wantMoney(t, "trip total", res.Data.Sum, "600000") // 300.000 + 3 × 100.000
	if !slices.Equal(res.Data.Items[0].Tags, []string{"trabajo", "Viaje"}) {
		t.Fatalf("hit tags = %v", res.Data.Items[0].Tags)
	}
	all := s.SearchExpenses(ctx, ExpenseFilter{})
	mustOK(t, "SearchExpenses all", all.Error)
	wantMoney(t, "all total", all.Data.Sum, "650000")

	// Rename and delete.
	mustOK(t, "RenameTag", s.RenameTag(ctx, tags[1].ID, "Vacaciones").Error)
	if r := s.SearchExpenses(ctx, ExpenseFilter{Tag: "vacaciones"}); r.Error != nil || r.Data.Count != 2 {
		t.Fatalf("search after rename = %+v", r)
	}
	if r := s.RenameTag(ctx, tags[1].ID, "TRABAJO"); r.Error == nil || r.Error.Code != shared.ErrConflict {
		t.Fatalf("rename onto another tag = %+v, want CONFLICT", r.Error)
	}
	mustOK(t, "DeleteTag", s.DeleteTag(ctx, tags[0].ID).Error)
	if got := movTags(t, s, "2026-02", hotel.Data.ID); !slices.Equal(got, []string{"Vacaciones"}) {
		t.Fatalf("hotel tags after delete = %v", got)
	}
	mustOK(t, "clear", s.SetExpenseTags(ctx, hotel.Data.ID, nil).Error)
	if got := movTags(t, s, "2026-02", hotel.Data.ID); len(got) != 0 {
		t.Fatalf("hotel tags after clearing = %v", got)
	}

	// A trashed expense takes no tags and stops counting.
	mustOK(t, "DeleteExpense", s.DeleteExpense(ctx, flight.Data.ID).Error)
	if r := s.SetExpenseTags(ctx, flight.Data.ID, []string{"x"}); r.Error == nil || r.Error.Code != shared.ErrNotFound {
		t.Fatalf("tagging a trashed expense = %+v, want NOT_FOUND", r.Error)
	}
	tags, err = s.ListTags(ctx)
	if err != nil || len(tags) != 1 || tags[0].Count != 0 {
		t.Fatalf("ListTags after trash = %+v (err %v), want Vacaciones(0)", tags, err)
	}
}

func TestTagValidation(t *testing.T) {
	ctx := t.Context()
	s := newTestService(t)
	ex := s.CreateExpense(ctx, "2026-02-10", "Hotel", "", "", nil, KindUnico, "1000", 1)
	mustOK(t, "CreateExpense", ex.Error)
	eleven := make([]string, 11)
	for i := range eleven {
		eleven[i] = strings.Repeat("a", i+1)
	}
	for _, tt := range []struct {
		name  string
		names []string
	}{
		{"too many", eleven},
		{"too long", []string{strings.Repeat("x", 31)}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			if r := s.SetExpenseTags(ctx, ex.Data.ID, tt.names); r.Error == nil || r.Error.Code != shared.ErrValidation {
				t.Fatalf("SetExpenseTags = %+v, want VALIDATION_ERROR", r.Error)
			}
		})
	}
	if r := s.RenameTag(ctx, 999, "x"); r.Error == nil || r.Error.Code != shared.ErrNotFound {
		t.Fatalf("RenameTag missing = %+v, want NOT_FOUND", r.Error)
	}
	if r := s.DeleteTag(ctx, 999); r.Error == nil || r.Error.Code != shared.ErrNotFound {
		t.Fatalf("DeleteTag missing = %+v, want NOT_FOUND", r.Error)
	}
}
