package users_test

import (
	"testing"

	"github.com/uptrace/bun"

	"github.com/gastonlarap-a11y/app-finance/backend/finance"
	"github.com/gastonlarap-a11y/app-finance/backend/shared"
	"github.com/gastonlarap-a11y/app-finance/backend/users"
)

// firstCuotaOf is the id of an expense's cuota 1.
func firstCuotaOf(t *testing.T, bdb *bun.DB, expenseID int64) int64 {
	t.Helper()
	var id int64
	if err := bdb.NewRaw("SELECT id FROM installments WHERE expense_id = ? AND number = 1", expenseID).Scan(t.Context(), &id); err != nil {
		t.Fatal(err)
	}
	return id
}

func rowsOf(t *testing.T, bdb *bun.DB, table string, userID int64) int {
	t.Helper()
	var n int
	if err := bdb.NewRaw("SELECT COUNT(*) FROM "+table+" WHERE user_id = ?", userID).Scan(t.Context(), &n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestPurgeUserDeletesTheProfileForGood(t *testing.T) {
	ctx := t.Context()
	bdb := openMigrated(t)
	session := users.NewSession()
	fin := finance.NewFinanceService(bdb, session)
	usr := users.NewService(bdb, session, "test-app-finance-purge")

	// Gastón (1) keeps his data; Camila gets some and is purged.
	mustExpense := func(desc string) {
		t.Helper()
		if r := fin.CreateExpense(ctx, "2030-01-10", desc, "Comida", "", nil, finance.KindCuotas, "1000", 3); r.Error != nil {
			t.Fatalf("CreateExpense: %v", r.Error)
		}
	}
	mustExpense("de Gastón")
	camila := usr.CreateUser(ctx, "Camila")
	if camila.Error != nil {
		t.Fatalf("CreateUser: %v", camila.Error)
	}
	id := camila.Data.ID
	if r := usr.SwitchUser(ctx, id); r.Error != nil {
		t.Fatalf("SwitchUser: %v", r.Error)
	}
	mustExpense("de Camila")
	if r := fin.CreateCategory(ctx, "Ropa"); r.Error != nil {
		t.Fatalf("CreateCategory: %v", r.Error)
	}

	if r := usr.PurgeUser(ctx, id); r.Error == nil || r.Error.Code != shared.ErrNotFound {
		t.Fatalf("purge of a live profile = %+v, want NOT_FOUND", r.Error)
	}
	if r := usr.DeleteUser(ctx, id); r.Error != nil {
		t.Fatalf("DeleteUser: %v", r.Error)
	}
	if r := usr.PurgeUser(ctx, id); r.Error != nil {
		t.Fatalf("PurgeUser: %v", r.Error)
	}
	for _, table := range []string{"expenses", "installments", "categories"} {
		if n := rowsOf(t, bdb, table, id); n != 0 {
			t.Errorf("%s of the purged profile = %d, want 0", table, n)
		}
	}
	if n := rowsOf(t, bdb, "expenses", 1); n != 1 {
		t.Fatalf("Gastón's expenses = %d, want his one untouched", n)
	}
	deleted, err := usr.ListDeletedUsers(ctx)
	if err != nil || len(deleted) != 0 {
		t.Fatalf("deleted users = %+v (%v), want none", deleted, err)
	}
}
