package users_test

import (
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
	if err := db.RunMigrations(t.Context(), bdb); err != nil {
		t.Fatalf("migrations: %v", err)
	}
	t.Cleanup(func() { bdb.Close() })
	return bdb
}

// TestUserIsolation verifies that each profile only sees its own finance data and
// that the seeded "Gastón" (id 1) owns everything created before switching.
func TestUserIsolation(t *testing.T) {
	ctx := t.Context()
	bdb := openMigrated(t)

	session := users.NewSession() // starts on user 1 (Gastón)
	fin := finance.NewFinanceService(bdb, session)
	usr := users.NewService(bdb, session, "test-app-finance-isolation")

	// Seeded Gastón exists.
	if got := session.Active(); got != 1 {
		t.Fatalf("active user = %d, want 1 (Gastón)", got)
	}

	// As Gastón: create a card and a category.
	if r := fin.CreateCard(ctx, "Itau", "1000000", 24, ""); r.Error != nil {
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

// TestCrossUserWritesAndReads verifies that a profile can neither modify nor see
// another profile's rows through id-based methods (fixed-expense amount/payment,
// category budgets) or the aggregate reads (search, forecast, budgets).
func TestCrossUserWritesAndReads(t *testing.T) {
	ctx := t.Context()
	bdb := openMigrated(t)
	session := users.NewSession() // starts on user 1 (Gastón)
	fin := finance.NewFinanceService(bdb, session)
	usr := users.NewService(bdb, session, "test-app-finance-crossuser")

	const period = "2030-01"
	fe := fin.CreateFixedExpense(ctx, "Netflix", "Servicios", nil, period, "8000")
	if fe.Error != nil {
		t.Fatalf("CreateFixedExpense: %v", fe.Error)
	}
	cat := fin.CreateCategory(ctx, "Servicios")
	if cat.Error != nil {
		t.Fatalf("CreateCategory: %v", cat.Error)
	}
	if r := fin.SetCategoryBudget(ctx, cat.Data.ID, period, "50000"); r.Error != nil {
		t.Fatalf("SetCategoryBudget: %v", r.Error)
	}
	if r := fin.CreateExpense(ctx, period+"-10", "Cine", "Servicios", "", nil, finance.KindCuotas, "10000", 3); r.Error != nil {
		t.Fatalf("CreateExpense: %v", r.Error)
	}
	goal := fin.CreateSavingsGoal(ctx, "Viaje", "500000", "")
	if goal.Error != nil {
		t.Fatalf("CreateSavingsGoal: %v", goal.Error)
	}
	contrib := fin.AddSavingsContribution(ctx, goal.Data.ID, period, "50000")
	if contrib.Error != nil {
		t.Fatalf("AddSavingsContribution: %v", contrib.Error)
	}
	batch := finance.ImportBatch{Source: finance.ImportSourcePDFAccount, Issuer: "itau", Items: []finance.ImportCandidate{
		{Date: period + "-05", Description: "CRUZ VERDE L9093 CHILLAN C", Amount: "16182"},
		{Date: period + "-06", Description: "ENTEL PCS PAGO ENSANTIAGO C", Amount: "16990"},
	}}
	if r := fin.StageImport(ctx, batch); r.Error != nil || r.Data.Added != 2 {
		t.Fatalf("StageImport = %+v, want 2 added", r)
	}
	pending := fin.ListImportItems(ctx, finance.ImportPendiente)
	if pending.Error != nil || len(pending.Data) != 2 {
		t.Fatalf("ListImportItems = %+v, want 2 pending", pending)
	}
	// Newest first: [0] is Entel (confirmed below), [1] Cruz Verde (stays pending).
	otherItemID, itemID := pending.Data[0].ID, pending.Data[1].ID
	expense := fin.CreateExpense(ctx, period+"-05", "Farmacia", "Salud", "", nil, finance.KindUnico, "16182", 1)
	if expense.Error != nil {
		t.Fatalf("CreateExpense: %v", expense.Error)
	}
	if r := fin.ConfirmImportItem(ctx, otherItemID, period+"-06", "Entel", "Servicios", "Entel", nil, finance.KindUnico, "16990", 1, "entel pcs"); r.Error != nil {
		t.Fatalf("ConfirmImportItem: %v", r.Error)
	}
	rules, err := fin.ListMerchantRules(ctx)
	if err != nil || len(rules) != 1 {
		t.Fatalf("ListMerchantRules = %+v (err %v), want 1", rules, err)
	}

	if cam := usr.CreateUser(ctx, "Camila"); cam.Error != nil {
		t.Fatalf("CreateUser: %v", cam.Error)
	}

	writes := []struct {
		name string
		run  func() finance.OpResult
	}{
		{"SetFixedExpenseAmount", func() finance.OpResult { return fin.SetFixedExpenseAmount(ctx, fe.Data.ID, period, "1") }},
		{"SetFixedExpensePaid", func() finance.OpResult { return fin.SetFixedExpensePaid(ctx, fe.Data.ID, period, true) }},
		{"SetCategoryBudget", func() finance.OpResult { return fin.SetCategoryBudget(ctx, cat.Data.ID, period, "1") }},
		{"DeleteFixedExpense", func() finance.OpResult { return fin.DeleteFixedExpense(ctx, fe.Data.ID) }},
		{"ConfirmImportItem", func() finance.OpResult {
			return finance.OpResult{Error: fin.ConfirmImportItem(ctx, itemID, period+"-05", "x", "", "", nil, finance.KindUnico, "1", 1, "").Error}
		}},
		{"LinkImportItem", func() finance.OpResult { return fin.LinkImportItem(ctx, itemID, expense.Data.ID) }},
		{"DiscardImportItem", func() finance.OpResult { return fin.DiscardImportItem(ctx, itemID) }},
		{"RestoreImportItem", func() finance.OpResult { return fin.RestoreImportItem(ctx, itemID) }},
		{"DeleteMerchantRule", func() finance.OpResult { return fin.DeleteMerchantRule(ctx, rules[0].ID) }},
	}
	for _, w := range writes {
		t.Run("Camila "+w.name, func(t *testing.T) {
			if r := w.run(); r.Error == nil || r.Error.Code != "NOT_FOUND" {
				t.Fatalf("%s on Gastón's row = %+v, want NOT_FOUND", w.name, r.Error)
			}
		})
	}

	if r := fin.SearchExpenses(ctx, finance.ExpenseFilter{}); r.Error != nil || r.Data.Count != 0 {
		t.Fatalf("Camila SearchExpenses = %+v, want 0 hits", r)
	}
	if r := fin.ListCategoryBudgets(ctx, period); r.Error != nil || len(r.Data) != 0 {
		t.Fatalf("Camila ListCategoryBudgets = %+v, want none", r)
	}
	forecast := fin.CommitmentsForecast(ctx, period, 3)
	if forecast.Error != nil {
		t.Fatalf("Camila CommitmentsForecast: %v", forecast.Error)
	}
	for _, m := range forecast.Data {
		if !m.Comprometido.IsZero() {
			t.Fatalf("Camila forecast %s comprometido = %s, want 0", m.Period, m.Comprometido)
		}
	}
	if y := fin.YearSummary(ctx, 2030); y.Error != nil || len(y.Data.CategoriaMeses) != 0 {
		t.Fatalf("Camila YearSummary.CategoriaMeses = %+v, want none", y)
	}
	if tr := fin.SpendingTrend(ctx, period, 3); tr.Error != nil || !tr.Data.Current.IsZero() || len(tr.Data.Categories) != 0 {
		t.Fatalf("Camila SpendingTrend = %+v, want empty", tr)
	}
	if goals, err := fin.ListSavingsGoals(ctx); err != nil || len(goals) != 0 {
		t.Fatalf("Camila ListSavingsGoals = %+v (err %v), want none", goals, err)
	}
	if r := fin.AddSavingsContribution(ctx, goal.Data.ID, period, "1"); r.Error == nil || r.Error.Code != "NOT_FOUND" {
		t.Fatalf("Camila AddSavingsContribution on Gastón's goal = %+v, want NOT_FOUND", r.Error)
	}
	if r := fin.DeleteSavingsContribution(ctx, contrib.Data.ID); r.Error == nil || r.Error.Code != "NOT_FOUND" {
		t.Fatalf("Camila DeleteSavingsContribution on Gastón's row = %+v, want NOT_FOUND", r.Error)
	}
	if r := fin.DeleteSavingsGoal(ctx, goal.Data.ID); r.Error == nil || r.Error.Code != "NOT_FOUND" {
		t.Fatalf("Camila DeleteSavingsGoal on Gastón's goal = %+v, want NOT_FOUND", r.Error)
	}
	for _, status := range []string{finance.ImportPendiente, finance.ImportConfirmado} {
		if r := fin.ListImportItems(ctx, status); r.Error != nil || len(r.Data) != 0 {
			t.Fatalf("Camila ListImportItems(%s) = %+v, want none", status, r)
		}
	}
	if rules, err := fin.ListMerchantRules(ctx); err != nil || len(rules) != 0 {
		t.Fatalf("Camila ListMerchantRules = %+v (err %v), want none", rules, err)
	}
	// The same statement is new for Camila: keys are per profile, and Gastón's
	// items are never reconciled against hers.
	if r := fin.StageImport(ctx, batch); r.Error != nil || r.Data.Added != 2 || r.Data.Reconciled != 0 {
		t.Fatalf("Camila StageImport = %+v, want 2 added", r)
	}

	// Back as Gastón, the fixed expense is untouched: amount 8000, still pending.
	if r := usr.SwitchUser(ctx, 1); r.Error != nil {
		t.Fatalf("SwitchUser(1): %v", r.Error)
	}
	sum := fin.MonthlySummary(ctx, period)
	if sum.Error != nil {
		t.Fatalf("MonthlySummary: %v", sum.Error)
	}
	for _, mv := range sum.Data.Movimientos {
		if mv.FixedID != nil && *mv.FixedID == fe.Data.ID && (mv.Amount.String() != "8000" || mv.Status != finance.StatusPendiente) {
			t.Fatalf("Gastón's fixed expense was modified by Camila: %+v", mv)
		}
	}
	if r := fin.ListImportItems(ctx, finance.ImportPendiente); r.Error != nil || len(r.Data) != 1 || r.Data[0].ID != itemID {
		t.Fatalf("Gastón's pending import items after Camila = %+v, want only item %d", r, itemID)
	}
}

// TestDeleteUserSoftDeleteAndRestore covers: blocking the last-user delete,
// auto-switching when the active user is deleted, leaving the session alone
// when a non-active user is deleted, and restoring a deleted profile.
func TestDeleteUserSoftDeleteAndRestore(t *testing.T) {
	ctx := t.Context()
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
