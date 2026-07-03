package finance

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"

	"github.com/uptrace/bun"
	"github.com/uptrace/bun/dialect/sqlitedialect"
	"github.com/uptrace/bun/driver/sqliteshim"

	"github.com/gastonlarap-a11y/app-finance/backend/shared/db"
	"github.com/gastonlarap-a11y/app-finance/backend/users"
)

func openTestDB(t *testing.T) *bun.DB {
	t.Helper()
	dsn := filepath.Join(t.TempDir(), "test.db") + "?_journal=WAL&_foreign_keys=on"
	sqldb, err := sql.Open(sqliteshim.ShimName, dsn)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	sqldb.SetMaxOpenConns(1)
	bdb := bun.NewDB(sqldb, sqlitedialect.New())
	if err := db.RunMigrations(context.Background(), bdb); err != nil {
		t.Fatalf("migrations: %v", err)
	}
	t.Cleanup(func() { bdb.Close() })
	return bdb
}

func newTestService(t *testing.T) *FinanceService {
	return NewFinanceService(openTestDB(t), users.NewSession())
}

func TestSoftDeleteRestoreRoundTrip(t *testing.T) {
	ctx := context.Background()
	s := newTestService(t)

	cardRes := s.CreateCard(ctx, "Itau", "1000000", 24)
	if cardRes.Error != nil {
		t.Fatalf("CreateCard: %v", cardRes.Error)
	}
	card := cardRes.Data

	catRes := s.CreateCategory(ctx, "Comida")
	if catRes.Error != nil {
		t.Fatalf("CreateCategory: %v", catRes.Error)
	}

	period := currentPeriod()
	incRes := s.CreateIncome(ctx, period, "Bono", "5000")
	if incRes.Error != nil {
		t.Fatalf("CreateIncome: %v", incRes.Error)
	}

	exRes := s.CreateExpense(ctx, "2026-06-15", "Super", "Comida", "", &card.ID, KindUnico, "10000", 1)
	if exRes.Error != nil {
		t.Fatalf("CreateExpense: %v", exRes.Error)
	}

	feRes := s.CreateFixedExpense(ctx, "Netflix", "Comida", &card.ID, period, "8000")
	if feRes.Error != nil {
		t.Fatalf("CreateFixedExpense: %v", feRes.Error)
	}

	if r := s.DeleteCard(ctx, card.ID); r.Error != nil {
		t.Fatalf("DeleteCard: %v", r.Error)
	}
	if r := s.DeleteCategory(ctx, catRes.Data.ID); r.Error != nil {
		t.Fatalf("DeleteCategory: %v", r.Error)
	}
	if r := s.DeleteIncome(ctx, incRes.Data.ID); r.Error != nil {
		t.Fatalf("DeleteIncome: %v", r.Error)
	}
	if r := s.DeleteExpense(ctx, exRes.Data.ID); r.Error != nil {
		t.Fatalf("DeleteExpense: %v", r.Error)
	}
	if r := s.DeleteFixedExpense(ctx, feRes.Data.ID); r.Error != nil {
		t.Fatalf("DeleteFixedExpense: %v", r.Error)
	}

	if cards, _ := s.ListCards(ctx); len(cards) != 0 {
		t.Fatalf("ListCards after delete = %v, want empty", cards)
	}
	if cats, _ := s.ListCategories(ctx); len(cats) != 0 {
		t.Fatalf("ListCategories after delete = %v, want empty", cats)
	}
	if incs, _ := s.ListIncomes(ctx, period); len(incs) != 0 {
		t.Fatalf("ListIncomes after delete = %v, want empty", incs)
	}
	if exs, _ := s.ListExpenses(ctx, period); len(exs) != 0 {
		t.Fatalf("ListExpenses after delete = %v, want empty", exs)
	}
	if fes, _ := s.ListFixedExpenses(ctx); len(fes) != 0 {
		t.Fatalf("ListFixedExpenses after delete = %v, want empty", fes)
	}

	trash := s.ListTrash(ctx)
	if trash.Error != nil {
		t.Fatalf("ListTrash: %v", trash.Error)
	}
	if len(trash.Data) != 5 {
		t.Fatalf("ListTrash returned %d items, want 5: %+v", len(trash.Data), trash.Data)
	}

	if r := s.RestoreCard(ctx, card.ID); r.Error != nil {
		t.Fatalf("RestoreCard: %v", r.Error)
	}
	if r := s.RestoreCategory(ctx, catRes.Data.ID); r.Error != nil {
		t.Fatalf("RestoreCategory: %v", r.Error)
	}
	if r := s.RestoreIncome(ctx, incRes.Data.ID); r.Error != nil {
		t.Fatalf("RestoreIncome: %v", r.Error)
	}
	if r := s.RestoreExpense(ctx, exRes.Data.ID); r.Error != nil {
		t.Fatalf("RestoreExpense: %v", r.Error)
	}
	if r := s.RestoreFixedExpense(ctx, feRes.Data.ID); r.Error != nil {
		t.Fatalf("RestoreFixedExpense: %v", r.Error)
	}

	if cards, _ := s.ListCards(ctx); len(cards) != 1 {
		t.Fatalf("ListCards after restore = %v, want 1", cards)
	}
	if cats, _ := s.ListCategories(ctx); len(cats) != 1 {
		t.Fatalf("ListCategories after restore = %v, want 1", cats)
	}
	if incs, _ := s.ListIncomes(ctx, period); len(incs) != 1 {
		t.Fatalf("ListIncomes after restore = %v, want 1", incs)
	}
	if exs, _ := s.ListExpenses(ctx, period); len(exs) != 1 {
		t.Fatalf("ListExpenses after restore = %v, want 1", exs)
	}
	if fes, _ := s.ListFixedExpenses(ctx); len(fes) != 1 {
		t.Fatalf("ListFixedExpenses after restore = %v, want 1", fes)
	}

	trash2 := s.ListTrash(ctx)
	if trash2.Error != nil {
		t.Fatalf("ListTrash after restore: %v", trash2.Error)
	}
	if len(trash2.Data) != 0 {
		t.Fatalf("ListTrash after restore = %v, want empty", trash2.Data)
	}
}

// A soft-deleted card must keep resolving its name on old movimientos (history),
// while disappearing from the active card list/cupo summary.
func TestDeleteCardKeepsHistoricalCardName(t *testing.T) {
	ctx := context.Background()
	s := newTestService(t)

	cardRes := s.CreateCard(ctx, "Visa", "500000", 24)
	if cardRes.Error != nil {
		t.Fatalf("CreateCard: %v", cardRes.Error)
	}
	card := cardRes.Data

	period := currentPeriod()
	exRes := s.CreateExpense(ctx, "2026-06-10", "Compra", "General", "", &card.ID, KindUnico, "20000", 1)
	if exRes.Error != nil {
		t.Fatalf("CreateExpense: %v", exRes.Error)
	}

	before := s.MonthlySummary(ctx, period)
	if before.Error != nil {
		t.Fatalf("MonthlySummary: %v", before.Error)
	}
	if len(before.Data.PorTarjeta) != 1 {
		t.Fatalf("PorTarjeta before delete = %v, want 1 card", before.Data.PorTarjeta)
	}

	if r := s.DeleteCard(ctx, card.ID); r.Error != nil {
		t.Fatalf("DeleteCard: %v", r.Error)
	}

	after := s.MonthlySummary(ctx, period)
	if after.Error != nil {
		t.Fatalf("MonthlySummary after delete: %v", after.Error)
	}
	if len(after.Data.PorTarjeta) != 0 {
		t.Fatalf("PorTarjeta after delete = %v, want 0 (card hidden from active list)", after.Data.PorTarjeta)
	}

	var found bool
	for _, mv := range after.Data.Movimientos {
		if mv.ExpenseID == exRes.Data.ID {
			found = true
			if mv.CardName != "Visa" {
				t.Fatalf("movimiento CardName = %q, want %q (historical resolution via cardMapAll)", mv.CardName, "Visa")
			}
		}
	}
	if !found {
		t.Fatalf("expected movimiento for expense %d in summary", exRes.Data.ID)
	}
}

// A soft-deleted expense's installment must not leak into MonthlySummary totals
// (the Relation("Expense") join leaves Expense nil rather than dropping the row).
func TestDeleteExpenseExcludedFromSummaryTotals(t *testing.T) {
	ctx := context.Background()
	s := newTestService(t)
	period := currentPeriod()

	exRes := s.CreateExpense(ctx, "2026-06-05", "Compra suelta", "General", "", nil, KindUnico, "15000", 1)
	if exRes.Error != nil {
		t.Fatalf("CreateExpense: %v", exRes.Error)
	}

	before := s.MonthlySummary(ctx, period)
	if before.Error != nil {
		t.Fatalf("MonthlySummary: %v", before.Error)
	}
	if before.Data.Gastos.String() != "15000" {
		t.Fatalf("Gastos before delete = %s, want 15000", before.Data.Gastos.String())
	}

	if r := s.DeleteExpense(ctx, exRes.Data.ID); r.Error != nil {
		t.Fatalf("DeleteExpense: %v", r.Error)
	}

	after := s.MonthlySummary(ctx, period)
	if after.Error != nil {
		t.Fatalf("MonthlySummary after delete: %v", after.Error)
	}
	if !after.Data.Gastos.IsZero() {
		t.Fatalf("Gastos after delete = %s, want 0 (no ghost row)", after.Data.Gastos.String())
	}
	if len(after.Data.Movimientos) != 0 {
		t.Fatalf("Movimientos after delete = %v, want empty", after.Data.Movimientos)
	}

	if r := s.RestoreExpense(ctx, exRes.Data.ID); r.Error != nil {
		t.Fatalf("RestoreExpense: %v", r.Error)
	}
	restored := s.MonthlySummary(ctx, period)
	if restored.Error != nil {
		t.Fatalf("MonthlySummary after restore: %v", restored.Error)
	}
	if restored.Data.Gastos.String() != "15000" {
		t.Fatalf("Gastos after restore = %s, want 15000", restored.Data.Gastos.String())
	}
}

// Deleting and restoring a fixed expense must preserve its amount-override and
// paid-status history, since those child tables are never touched.
func TestFixedExpenseHistorySurvivesDeleteRestore(t *testing.T) {
	ctx := context.Background()
	s := newTestService(t)
	period := currentPeriod()

	feRes := s.CreateFixedExpense(ctx, "Spotify", "Servicios", nil, period, "5000")
	if feRes.Error != nil {
		t.Fatalf("CreateFixedExpense: %v", feRes.Error)
	}
	fe := feRes.Data

	if r := s.SetFixedExpenseAmount(ctx, fe.ID, period, "6000"); r.Error != nil {
		t.Fatalf("SetFixedExpenseAmount: %v", r.Error)
	}
	if r := s.SetFixedExpensePaid(ctx, fe.ID, period, true); r.Error != nil {
		t.Fatalf("SetFixedExpensePaid: %v", r.Error)
	}

	before := s.MonthlySummary(ctx, period)
	if before.Error != nil {
		t.Fatalf("MonthlySummary: %v", before.Error)
	}
	var beforeMv *Movimiento
	for i := range before.Data.Movimientos {
		if before.Data.Movimientos[i].FixedID != nil && *before.Data.Movimientos[i].FixedID == fe.ID {
			beforeMv = &before.Data.Movimientos[i]
		}
	}
	if beforeMv == nil || beforeMv.Amount.String() != "6000" || beforeMv.Status != StatusPagado {
		t.Fatalf("movimiento before delete = %+v, want amount 6000 status pagado", beforeMv)
	}

	if r := s.DeleteFixedExpense(ctx, fe.ID); r.Error != nil {
		t.Fatalf("DeleteFixedExpense: %v", r.Error)
	}
	if r := s.RestoreFixedExpense(ctx, fe.ID); r.Error != nil {
		t.Fatalf("RestoreFixedExpense: %v", r.Error)
	}

	after := s.MonthlySummary(ctx, period)
	if after.Error != nil {
		t.Fatalf("MonthlySummary after restore: %v", after.Error)
	}
	var afterMv *Movimiento
	for i := range after.Data.Movimientos {
		if after.Data.Movimientos[i].FixedID != nil && *after.Data.Movimientos[i].FixedID == fe.ID {
			afterMv = &after.Data.Movimientos[i]
		}
	}
	if afterMv == nil || afterMv.Amount.String() != "6000" || afterMv.Status != StatusPagado {
		t.Fatalf("movimiento after restore = %+v, want amount 6000 status pagado (history preserved)", afterMv)
	}
}

// Restoring a category whose name was reused by a new active one must fail with
// a conflict instead of violating the partial unique index silently.
func TestRestoreCategoryNameConflict(t *testing.T) {
	ctx := context.Background()
	s := newTestService(t)

	catRes := s.CreateCategory(ctx, "Comida")
	if catRes.Error != nil {
		t.Fatalf("CreateCategory: %v", catRes.Error)
	}
	if r := s.DeleteCategory(ctx, catRes.Data.ID); r.Error != nil {
		t.Fatalf("DeleteCategory: %v", r.Error)
	}
	if r := s.CreateCategory(ctx, "Comida"); r.Error != nil {
		t.Fatalf("CreateCategory (reuse name): %v", r.Error)
	}

	r := s.RestoreCategory(ctx, catRes.Data.ID)
	if r.Error == nil {
		t.Fatalf("RestoreCategory with reused name = nil error, want conflict")
	}
}
