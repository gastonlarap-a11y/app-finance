package finance

import (
	"slices"
	"testing"
)

// A purchase entered by hand and then seen in a card statement: one expense,
// with the bank's date, amount and month, the user's words and the bank's code.

// taxiStatement bills one purchase: TAXI VIAJE 2.340 on 2026-08-12.
func taxiStatement() CardStatementInput {
	st := nationalStatement()
	st.Lines = []CardStatementLineInput{{Section: LinePurchase, OperationDate: "2026-08-12", Reference: "1308 33333333",
		Description: "TAXI VIAJE", OperationAmount: "2340", TotalAmount: "2340",
		InstallmentNumber: 1, InstallmentsTotal: 1, InstallmentAmount: "2340"}}
	return st
}

func loadExpense(t *testing.T, s *FinanceService, id int64) Expense {
	t.Helper()
	var ex Expense
	if err := s.db.NewSelect().Model(&ex).Where("id = ?", id).Scan(t.Context()); err != nil {
		t.Fatal(err)
	}
	return ex
}

func TestStatementMergesTheExpenseEnteredByHand(t *testing.T) {
	ctx := t.Context()
	s := newTestService(t)
	card := s.CreateCard(ctx, "Itaú", "1000000", 24, "4321")
	mustOK(t, "CreateCard", card.Error)
	// Typed a week off, on the right card and amount.
	manual := s.CreateExpense(ctx, "2026-08-05", "Taxi al aeropuerto", "Transporte", "Uber", &card.Data.ID, KindUnico, "2340", 1)
	mustOK(t, "CreateExpense", manual.Error)
	mustOK(t, "SetExpenseTags", s.SetExpenseTags(ctx, manual.Data.ID, []string{"viaje"}).Error)

	if got := importStatement(t, s, taxiStatement()); got.Merged != 1 || got.Added != 0 {
		t.Fatalf("import = %+v, want the manual expense merged", got)
	}
	ex := loadExpense(t, s, manual.Data.ID)
	if ex.Date.UTC().Format(dateLayout) != "2026-08-12" || ex.Description != "Taxi al aeropuerto" ||
		ex.Category != "Transporte" || ex.Merchant != "Uber" || ex.BankDescription != "TAXI VIAJE" {
		t.Fatalf("merged = %+v, want the bank's date and the user's words", ex)
	}
	sum := s.MonthlySummary(ctx, "2026-08")
	mustOK(t, "MonthlySummary", sum.Error)
	var mv *Movimiento
	for i := range sum.Data.Movimientos {
		if sum.Data.Movimientos[i].ExpenseID == manual.Data.ID {
			mv = &sum.Data.Movimientos[i]
		}
	}
	if mv == nil || !slices.Equal(mv.Tags, []string{"viaje"}) || !slices.Equal(mv.References, []string{"1308 33333333"}) ||
		mv.BankDescription != "TAXI VIAJE" {
		t.Fatalf("movimiento = %+v, want tags kept, the bank's code and descriptor", mv)
	}
	if n := len(mustList(t, s, ImportPendiente)); n != 0 {
		t.Fatalf("pending = %d, want nothing left to review", n)
	}
}

func TestMergeMovesTheExpenseToTheBanksMonth(t *testing.T) {
	ctx := t.Context()
	s := newTestService(t)
	card := s.CreateCard(ctx, "Itaú", "1000000", 5, "4321") // a wrong billing day: 12th rolls to September
	mustOK(t, "CreateCard", card.Error)
	manual := s.CreateExpense(ctx, "2026-08-12", "Taxi", "", "", &card.Data.ID, KindUnico, "2340", 1)
	mustOK(t, "CreateExpense", manual.Error)
	if got := installmentPeriods(t, s, manual.Data.ID); !slices.Equal(got, []string{"2026-09"}) {
		t.Fatalf("before = %v", got)
	}
	importStatement(t, s, taxiStatement())
	if got := installmentPeriods(t, s, manual.Data.ID); !slices.Equal(got, []string{"2026-08"}) {
		t.Fatalf("after = %v, want the month the bank billed", got)
	}
}

func TestAmbiguousOrFarPurchasesWaitInTheInbox(t *testing.T) {
	ctx := t.Context()
	s := newTestService(t)
	card := s.CreateCard(ctx, "Itaú", "1000000", 24, "4321")
	mustOK(t, "CreateCard", card.Error)
	first := s.CreateExpense(ctx, "2026-08-10", "Taxi uno", "", "", &card.Data.ID, KindUnico, "2340", 1)
	mustOK(t, "CreateExpense", first.Error)
	second := s.CreateExpense(ctx, "2026-08-14", "Taxi dos", "", "", &card.Data.ID, KindUnico, "2340", 1)
	mustOK(t, "CreateExpense", second.Error)

	if got := importStatement(t, s, taxiStatement()); got.Merged != 0 || got.Added != 1 {
		t.Fatalf("import = %+v, want two candidates left to the user", got)
	}
	item := pendingByDescription(t, s)["TAXI VIAJE"]
	if item.DuplicateExpenseID == nil || item.DuplicateDate == "" {
		t.Fatalf("item = %+v, want a suggestion with its date", item)
	}
	// The user picks the second one: it is completed like an automatic merge.
	mustOK(t, "LinkImportItem", s.LinkImportItem(ctx, item.ID, second.Data.ID).Error)
	ex := loadExpense(t, s, second.Data.ID)
	if ex.Description != "Taxi dos" || ex.BankDescription != "TAXI VIAJE" || ex.Date.UTC().Format(dateLayout) != "2026-08-12" {
		t.Fatalf("linked = %+v, want it merged", ex)
	}
	if untouched := loadExpense(t, s, first.Data.ID); untouched.BankDescription != "" {
		t.Fatalf("the other candidate changed: %+v", untouched)
	}

	// Eleven days away is no longer the same purchase.
	far := newTestService(t)
	farCard := far.CreateCard(ctx, "Itaú", "1000000", 24, "4321")
	mustOK(t, "CreateCard", farCard.Error)
	mustOK(t, "CreateExpense", far.CreateExpense(ctx, "2026-08-01", "Taxi", "", "", &farCard.Data.ID, KindUnico, "2340", 1).Error)
	if got := importStatement(t, far, taxiStatement()); got.Merged != 0 || got.Added != 1 {
		t.Fatalf("far = %+v, want no merge", got)
	}
}

func TestMergeWithoutTheCardOrOnAnotherCardAsks(t *testing.T) {
	ctx := t.Context()
	s := newTestService(t)
	other := s.CreateCard(ctx, "Otra", "1000000", 24, "9999")
	mustOK(t, "CreateCard", other.Error)
	mustOK(t, "CreateExpense", s.CreateExpense(ctx, "2026-08-12", "Taxi", "", "", &other.Data.ID, KindUnico, "2340", 1).Error)
	// The statement's card (4321) is not in the app: never merged blindly.
	if got := importStatement(t, s, taxiStatement()); got.Merged != 0 || got.Added != 1 {
		t.Fatalf("import = %+v, want the item left to review", got)
	}
}

func TestMergeNeverMovesPaidCuotas(t *testing.T) {
	ctx := t.Context()
	s := newTestService(t)
	card := s.CreateCard(ctx, "Itaú", "1000000", 5, "4321")
	mustOK(t, "CreateCard", card.Error)
	manual := s.CreateExpense(ctx, "2026-08-12", "Taxi", "", "", &card.Data.ID, KindUnico, "2340", 1)
	mustOK(t, "CreateExpense", manual.Error)
	var inst Installment
	if err := s.db.NewSelect().Model(&inst).Where("expense_id = ?", manual.Data.ID).Scan(ctx); err != nil {
		t.Fatal(err)
	}
	mustOK(t, "SetInstallmentPaid", s.SetInstallmentPaid(ctx, inst.ID, true).Error)

	if got := importStatement(t, s, taxiStatement()); got.Merged != 1 {
		t.Fatalf("import = %+v, want it merged", got)
	}
	if got := installmentPeriods(t, s, manual.Data.ID); !slices.Equal(got, []string{"2026-09"}) {
		t.Fatalf("periods = %v, want the paid cuota where the user paid it", got)
	}
	if ex := loadExpense(t, s, manual.Data.ID); ex.BankDescription != "TAXI VIAJE" {
		t.Fatalf("merged = %+v, want the bank's words even so", ex)
	}
}
