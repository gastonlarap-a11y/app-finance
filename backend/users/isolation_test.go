package users_test

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"

	"github.com/uptrace/bun"
	"github.com/uptrace/bun/dialect/sqlitedialect"
	"github.com/uptrace/bun/driver/sqliteshim"

	"github.com/gastonlarap-a11y/app-finance/backend/finance"
	"github.com/gastonlarap-a11y/app-finance/backend/shared/db"
	"github.com/gastonlarap-a11y/app-finance/backend/users"
)

// openMigrated opens a fresh temp SQLite DB and runs all real migrations on it.
func openMigrated(t *testing.T) *bun.DB {
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

// TestUserIsolation verifies that each profile only sees its own finance data and
// that the seeded "Gastón" (id 1) owns everything created before switching.
func TestUserIsolation(t *testing.T) {
	ctx := context.Background()
	bdb := openMigrated(t)

	session := users.NewSession() // starts on user 1 (Gastón)
	fin := finance.NewFinanceService(bdb, session)
	usr := users.NewService(bdb, session, "test-app-finance-isolation")

	// Seeded Gastón exists.
	if got := session.Active(); got != 1 {
		t.Fatalf("active user = %d, want 1 (Gastón)", got)
	}

	// As Gastón: create a card and a category.
	if r := fin.CreateCard(ctx, "Itau", "1000000", 24); r.Error != nil {
		t.Fatalf("CreateCard: %v", r.Error)
	}
	if r := fin.CreateCategory(ctx, "Comida"); r.Error != nil {
		t.Fatalf("CreateCategory: %v", r.Error)
	}

	// Create + switch to a second user "Camila".
	cam := usr.CreateUser(ctx, "Camila")
	if cam.Error != nil {
		t.Fatalf("CreateUser: %v", cam.Error)
	}
	if session.Active() != cam.Data.ID {
		t.Fatalf("after CreateUser active = %d, want %d", session.Active(), cam.Data.ID)
	}

	// Camila sees nothing.
	if cards, err := fin.ListCards(ctx); err != nil || len(cards) != 0 {
		t.Fatalf("Camila ListCards = %v (err %v), want empty", cards, err)
	}
	if cats, err := fin.ListCategories(ctx); err != nil || len(cats) != 0 {
		t.Fatalf("Camila ListCategories = %v (err %v), want empty", cats, err)
	}

	// Camila can reuse the same category name (uniqueness is per-user).
	if r := fin.CreateCategory(ctx, "Comida"); r.Error != nil {
		t.Fatalf("Camila CreateCategory: %v", r.Error)
	}

	// Switch back to Gastón: original data is intact.
	if r := usr.SwitchUser(ctx, 1); r.Error != nil {
		t.Fatalf("SwitchUser(1): %v", r.Error)
	}
	cards, err := fin.ListCards(ctx)
	if err != nil || len(cards) != 1 || cards[0].Name != "Itau" {
		t.Fatalf("Gastón ListCards = %v (err %v), want [Itau]", cards, err)
	}
	cats, err := fin.ListCategories(ctx)
	if err != nil || len(cats) != 1 || cats[0].Name != "Comida" {
		t.Fatalf("Gastón ListCategories = %v (err %v), want [Comida]", cats, err)
	}
}

// TestDeleteUserSoftDeleteAndRestore covers: blocking the last-user delete,
// auto-switching when the active user is deleted, leaving the session alone
// when a non-active user is deleted, and restoring a deleted profile.
func TestDeleteUserSoftDeleteAndRestore(t *testing.T) {
	ctx := context.Background()
	bdb := openMigrated(t)
	session := users.NewSession() // starts on user 1 (Gastón)
	usr := users.NewService(bdb, session, "test-app-finance-delete")

	// Can't delete the only remaining user.
	if r := usr.DeleteUser(ctx, 1); r.Error == nil {
		t.Fatalf("DeleteUser(1) with a single user = nil error, want conflict")
	}

	cam := usr.CreateUser(ctx, "Camila")
	if cam.Error != nil {
		t.Fatalf("CreateUser: %v", cam.Error)
	}
	dani := usr.CreateUser(ctx, "Dani")
	if dani.Error != nil {
		t.Fatalf("CreateUser: %v", dani.Error)
	}
	// CreateUser switches to the new profile each time; back to Gastón to start.
	if r := usr.SwitchUser(ctx, 1); r.Error != nil {
		t.Fatalf("SwitchUser(1): %v", r.Error)
	}

	// Deleting a non-active user does not touch the session.
	if r := usr.DeleteUser(ctx, dani.Data.ID); r.Error != nil {
		t.Fatalf("DeleteUser(non-active): %v", r.Error)
	}
	if session.Active() != 1 {
		t.Fatalf("active after deleting non-active user = %d, want 1", session.Active())
	}
	list, err := usr.ListUsers(ctx)
	if err != nil || len(list) != 2 {
		t.Fatalf("ListUsers after delete = %v (err %v), want 2 active users", list, err)
	}

	// Deleting the active user auto-switches to another remaining user.
	del := usr.DeleteUser(ctx, 1)
	if del.Error != nil {
		t.Fatalf("DeleteUser(active): %v", del.Error)
	}
	if del.Data == nil {
		t.Fatalf("DeleteUser(active) returned nil Data, want the reassigned user")
	}
	if session.Active() == 1 {
		t.Fatalf("active user still 1 after deleting it")
	}
	if session.Active() != del.Data.ID {
		t.Fatalf("session.Active() = %d, want %d (the user DeleteUser reassigned to)", session.Active(), del.Data.ID)
	}

	deleted, err := usr.ListDeletedUsers(ctx)
	if err != nil || len(deleted) != 2 {
		t.Fatalf("ListDeletedUsers = %v (err %v), want 2 (Dani + Gastón)", deleted, err)
	}

	// ResolveActiveID must never resume into a deleted user.
	resolved := users.ResolveActiveID(ctx, bdb, 1)
	if resolved == 1 {
		t.Fatalf("ResolveActiveID(preferred=deleted id 1) = 1, want a non-deleted fallback")
	}

	// Restoring brings Gastón back into ListUsers (but does not re-activate it).
	if r := usr.RestoreUser(ctx, 1); r.Error != nil {
		t.Fatalf("RestoreUser(1): %v", r.Error)
	}
	// Gastón (restored) + Camila are active again; Dani stays deleted.
	list2, err := usr.ListUsers(ctx)
	if err != nil || len(list2) != 2 {
		t.Fatalf("ListUsers after restore = %v (err %v), want 2", list2, err)
	}
}
