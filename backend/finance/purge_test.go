package finance

import (
	"testing"

	"github.com/gastonlarap-a11y/app-finance/backend/shared"
)

func countRows(t *testing.T, s *FinanceService, table string) int {
	t.Helper()
	var n int
	if err := s.db.NewRaw("SELECT COUNT(*) FROM "+table).Scan(t.Context(), &n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestPurgeTrashItemDeletesForGood(t *testing.T) {
	ctx := t.Context()
	s := newTestService(t)
	ex := s.CreateExpense(ctx, "2030-01-10", "Notebook", "", "", nil, KindCuotas, "100000", 3)
	mustOK(t, "CreateExpense", ex.Error)

	if r := s.PurgeTrashItem(ctx, "expense", ex.Data.ID); r.Error == nil || r.Error.Code != shared.ErrNotFound {
		t.Fatalf("purge of a live expense = %+v, want NOT_FOUND (only the trash is purged)", r.Error)
	}
	mustOK(t, "DeleteExpense", s.DeleteExpense(ctx, ex.Data.ID).Error)
	mustOK(t, "PurgeTrashItem", s.PurgeTrashItem(ctx, "expense", ex.Data.ID).Error)
	if n := countRows(t, s, "expenses"); n != 0 {
		t.Fatalf("expenses = %d, want 0", n)
	}
	if n := countRows(t, s, "installments"); n != 0 {
		t.Fatalf("installments = %d, want its cuotas gone too", n)
	}
	if r := s.RestoreExpense(ctx, ex.Data.ID); r.Error == nil {
		t.Fatal("a purged expense came back from the trash")
	}
	if r := s.PurgeTrashItem(ctx, "nope", 1); r.Error == nil || r.Error.Code != shared.ErrValidation {
		t.Fatalf("unknown type = %+v, want VALIDATION", r.Error)
	}
}

func TestEmptyTrashKeepsLiveRecords(t *testing.T) {
	ctx := t.Context()
	s := newTestService(t)
	gone := s.CreateCategory(ctx, "Viejo")
	mustOK(t, "CreateCategory", gone.Error)
	kept := s.CreateCategory(ctx, "Comida")
	mustOK(t, "CreateCategory", kept.Error)
	card := s.CreateCard(ctx, "Vieja", "100000", 24, "")
	mustOK(t, "CreateCard", card.Error)
	mustOK(t, "DeleteCategory", s.DeleteCategory(ctx, gone.Data.ID).Error)
	mustOK(t, "DeleteCard", s.DeleteCard(ctx, card.Data.ID).Error)

	mustOK(t, "EmptyTrash", s.EmptyTrash(ctx).Error)
	trash := s.ListTrash(ctx)
	mustOK(t, "ListTrash", trash.Error)
	if len(trash.Data) != 0 {
		t.Fatalf("trash = %+v, want empty", trash.Data)
	}
	if n := countRows(t, s, "categories"); n != 1 {
		t.Fatalf("categories = %d, want only the live one", n)
	}
}
