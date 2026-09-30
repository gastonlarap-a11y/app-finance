package users_test

import (
	"testing"

	"github.com/uptrace/bun"

	"github.com/gastonlarap-a11y/app-finance/backend/finance"
	"github.com/gastonlarap-a11y/app-finance/backend/shared/db/dbtest"
	"github.com/gastonlarap-a11y/app-finance/backend/users"
)

// openMigrated opens a fresh temp SQLite DB and runs all real migrations on it.
func openMigrated(t *testing.T) *bun.DB {
	t.Helper()
	return dbtest.OpenMigrated(t)
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
	fe := fin.CreateFixedExpense(ctx, "Netflix", "Servicios", nil, period, "8000", 1, finance.CurrencyCLP)
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
		{Date: period + "-06", Description: "ENTEL PCS PAGO ENSANTIAGO C", Amount: "16990", Reference: "0606 77777777"},
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
	statement := finance.CardStatementInput{
		Issuer: "itau", Kind: finance.StatementNational, Currency: "CLP", CardLastDigits: "4321",
		StatementDate: period + "-25", PeriodTo: period + "-25", TotalBilled: "5000",
		Lines: []finance.CardStatementLineInput{{Section: finance.LineCredit, OperationDate: period + "-20",
			Description: "CASHBACK", InstallmentAmount: "-5000"}},
	}
	imported := fin.ImportCardStatement(ctx, statement)
	if imported.Error != nil || imported.Data.Added != 1 {
		t.Fatalf("ImportCardStatement = %+v", imported)
	}
	var creditID int64
	for _, it := range fin.ListImportItems(ctx, finance.ImportPendiente).Data {
		if it.Kind == finance.ImportKindCredit {
			creditID = it.ID
		}
	}
	// Reconciliations may not be in the future: this one closes a past month.
	const reconciled = "2026-01"
	if r := fin.SetReconciliation(ctx, reconciled, "123456"); r.Error != nil {
		t.Fatalf("SetReconciliation: %v", r.Error)
	}
	// UF values are public data, but which months are needed depends on the profile.
	if r := fin.CreateFixedExpense(ctx, "Arriendo", "", nil, reconciled, "10", 12, finance.CurrencyUF); r.Error != nil {
		t.Fatalf("CreateFixedExpense UF: %v", r.Error)
	}
	if need, err := fin.UFMonthsNeeded(ctx); err != nil || len(need) == 0 || need[0] != reconciled {
		t.Fatalf("Gastón UFMonthsNeeded = %v (err %v), want it to start at %s", need, err, reconciled)
	}
	refund := fin.CreateRefund(ctx, expense.Data.ID, period, "1000", "")
	if refund.Error != nil {
		t.Fatalf("CreateRefund: %v", refund.Error)
	}
	owed := fin.CreateReceivable(ctx, expense.Data.ID, "Ana", "1000")
	if owed.Error != nil {
		t.Fatalf("CreateReceivable: %v", owed.Error)
	}
	acct := fin.CreateAccount(ctx, "Corriente", "corriente", "0", period, true)
	if acct.Error != nil {
		t.Fatalf("CreateAccount: %v", acct.Error)
	}
	if r := fin.SetExpenseTags(ctx, expense.Data.ID, []string{"Salud"}); r.Error != nil {
		t.Fatalf("SetExpenseTags: %v", r.Error)
	}
	if r := fin.SearchExpenses(ctx, finance.ExpenseFilter{Text: "77777777"}); r.Error != nil || r.Data.Count != 1 {
		t.Fatalf("search by the Entel item's bank code = %+v, want Gastón's expense", r)
	}
	tags, err := fin.ListTags(ctx)
	if err != nil || len(tags) != 1 {
		t.Fatalf("ListTags = %+v (err %v), want 1", tags, err)
	}
	dueDay := 10
	if r := fin.SetFixedExpenseDueDay(ctx, fe.Data.ID, &dueDay); r.Error != nil {
		t.Fatalf("SetFixedExpenseDueDay: %v", r.Error)
	}
	if r := fin.UpcomingDues(ctx, period+"-05", 10); r.Error != nil || len(r.Data) != 1 {
		t.Fatalf("Gastón UpcomingDues = %+v, want his fixed expense", r)
	}

	// Created after the statement import so it plays no part in its card matching.
	card := fin.CreateCard(ctx, "Visa", "1000000", 24, "")
	if card.Error != nil {
		t.Fatalf("CreateCard: %v", card.Error)
	}
	savingsAcct := fin.CreateAccount(ctx, "Ahorro", "ahorro", "0", period, false)
	if savingsAcct.Error != nil {
		t.Fatalf("CreateAccount savings: %v", savingsAcct.Error)
	}
	transfer := fin.CreateTransfer(ctx, acct.Data.ID, savingsAcct.Data.ID, "Ahorro mensual", finance.TransferFixed, "1000", period, true)
	if transfer.Error != nil {
		t.Fatalf("CreateTransfer: %v", transfer.Error)
	}
	// A month already closed, so it can be reconciled (period is in the future).
	const closed = "2026-01"
	pastAcct := fin.CreateAccount(ctx, "Vista", "vista", "0", closed, false)
	if pastAcct.Error != nil {
		t.Fatalf("CreateAccount vista: %v", pastAcct.Error)
	}
	if r := fin.SetAccountReconciliation(ctx, pastAcct.Data.ID, closed, "1000"); r.Error != nil {
		t.Fatalf("SetAccountReconciliation: %v", r.Error)
	}
	merchant := fin.CreateMerchant(ctx, "Farmacia del barrio")
	if merchant.Error != nil {
		t.Fatalf("CreateMerchant: %v", merchant.Error)
	}

	if r := fin.SetBaseSalary(ctx, "2026-03", "1000000"); r.Error != nil {
		t.Fatalf("SetBaseSalary: %v", r.Error)
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
		{"EndFixedExpense", func() finance.OpResult { return fin.EndFixedExpense(ctx, fe.Data.ID, "2030-06") }},
		{"UpdateFixedExpense", func() finance.OpResult {
			return finance.OpResult{Error: fin.UpdateFixedExpense(ctx, fe.Data.ID, "x", "", nil).Error}
		}},
		{"UpdateExpense", func() finance.OpResult {
			return finance.OpResult{Error: fin.UpdateExpense(ctx, expense.Data.ID, period+"-05", "x", "", "", nil, finance.KindUnico, "1", 1).Error}
		}},
		{"SetCategoryBudget", func() finance.OpResult { return fin.SetCategoryBudget(ctx, cat.Data.ID, period, "1") }},
		{"RemoveCategoryBudget", func() finance.OpResult { return fin.RemoveCategoryBudget(ctx, cat.Data.ID, period) }},
		{"SetCategoryRollover", func() finance.OpResult { return fin.SetCategoryRollover(ctx, cat.Data.ID, true) }},
		{"PurgeTrashItem", func() finance.OpResult { return fin.PurgeTrashItem(ctx, "expense", expense.Data.ID) }},
		{"PrepayExpense", func() finance.OpResult { return fin.PrepayExpense(ctx, expense.Data.ID, period) }},
		{"SetExpenseCurrency", func() finance.OpResult { return fin.SetExpenseCurrency(ctx, expense.Data.ID, "USD", "1", "1") }},
		{"SetInstallmentAmount", func() finance.OpResult {
			return fin.SetInstallmentAmount(ctx, firstCuotaOf(t, bdb, expense.Data.ID), "1")
		}},
		{"SetFixedExpenseDueDay", func() finance.OpResult { return fin.SetFixedExpenseDueDay(ctx, fe.Data.ID, nil) }},
		{"DeleteFixedExpense", func() finance.OpResult { return fin.DeleteFixedExpense(ctx, fe.Data.ID) }},
		{"ConfirmImportItem", func() finance.OpResult {
			return finance.OpResult{Error: fin.ConfirmImportItem(ctx, itemID, period+"-05", "x", "", "", nil, finance.KindUnico, "1", 1, "").Error}
		}},
		{"LinkImportItem", func() finance.OpResult { return fin.LinkImportItem(ctx, itemID, expense.Data.ID) }},
		{"LinkImportItemToFixed", func() finance.OpResult { return fin.LinkImportItemToFixed(ctx, itemID, fe.Data.ID, period) }},
		{"LinkImportItemToTransfer", func() finance.OpResult {
			return fin.LinkImportItemToTransfer(ctx, itemID, transfer.Data.ID, period)
		}},
		{"DiscardImportItem", func() finance.OpResult { return fin.DiscardImportItem(ctx, itemID) }},
		{"RestoreImportItem", func() finance.OpResult { return fin.RestoreImportItem(ctx, itemID) }},
		{"DeleteMerchantRule", func() finance.OpResult { return fin.DeleteMerchantRule(ctx, rules[0].ID) }},
		{"ConfirmImportItemAsIncome", func() finance.OpResult {
			return finance.OpResult{Error: fin.ConfirmImportItemAsIncome(ctx, creditID, period, "x", "1").Error}
		}},
		{"GetCardStatement", func() finance.OpResult {
			return finance.OpResult{Error: fin.GetCardStatement(ctx, imported.Data.StatementID).Error}
		}},
		{"DeleteCardStatement", func() finance.OpResult { return fin.DeleteCardStatement(ctx, imported.Data.StatementID) }},
		{"DeleteReconciliation", func() finance.OpResult { return fin.DeleteReconciliation(ctx, reconciled) }},
		{"CreateRefund", func() finance.OpResult {
			return finance.OpResult{Error: fin.CreateRefund(ctx, expense.Data.ID, period, "1", "").Error}
		}},
		{"DeleteRefund", func() finance.OpResult { return fin.DeleteRefund(ctx, refund.Data.ID) }},
		{"CreateReceivable", func() finance.OpResult {
			return finance.OpResult{Error: fin.CreateReceivable(ctx, expense.Data.ID, "x", "1").Error}
		}},
		{"SettleReceivable", func() finance.OpResult {
			return finance.OpResult{Error: fin.SettleReceivable(ctx, owed.Data.ID, period).Error}
		}},
		{"DeleteReceivable", func() finance.OpResult { return fin.DeleteReceivable(ctx, owed.Data.ID) }},
		{"UpdateAccount", func() finance.OpResult {
			return finance.OpResult{Error: fin.UpdateAccount(ctx, acct.Data.ID, "x", "vista", "0", period, false).Error}
		}},
		{"DeleteAccount", func() finance.OpResult { return fin.DeleteAccount(ctx, acct.Data.ID) }},
		{"SetExpenseAccount", func() finance.OpResult { return fin.SetExpenseAccount(ctx, expense.Data.ID, &acct.Data.ID) }},
		{"SetExpenseAccount none", func() finance.OpResult { return fin.SetExpenseAccount(ctx, expense.Data.ID, nil) }},
		{"ConfirmImportItemAsRefund", func() finance.OpResult {
			return finance.OpResult{Error: fin.ConfirmImportItemAsRefund(ctx, creditID, expense.Data.ID, period, "1").Error}
		}},
		{"SetExpenseTags", func() finance.OpResult { return fin.SetExpenseTags(ctx, expense.Data.ID, []string{"x"}) }},
		{"RenameTag", func() finance.OpResult { return fin.RenameTag(ctx, tags[0].ID, "x") }},
		{"DeleteTag", func() finance.OpResult { return fin.DeleteTag(ctx, tags[0].ID) }},
		{"SetCategoryLook", func() finance.OpResult { return fin.SetCategoryLook(ctx, cat.Data.ID, "tag", "blue") }},
		{"SetCardColor", func() finance.OpResult { return fin.SetCardColor(ctx, card.Data.ID, "blue") }},
		{"SetCardPaymentDay", func() finance.OpResult { return fin.SetCardPaymentDay(ctx, card.Data.ID, nil) }},
		{"SetSavingsGoalIcon", func() finance.OpResult { return fin.SetSavingsGoalIcon(ctx, goal.Data.ID, "car") }},
		{"SetSavingsGoalAccount", func() finance.OpResult { return fin.SetSavingsGoalAccount(ctx, goal.Data.ID, nil) }},
		{"CreateTransfer", func() finance.OpResult {
			return finance.OpResult{Error: fin.CreateTransfer(ctx, acct.Data.ID, savingsAcct.Data.ID, "x", finance.TransferFixed, "1", period, false).Error}
		}},
		{"UpdateTransfer", func() finance.OpResult {
			return finance.OpResult{Error: fin.UpdateTransfer(ctx, transfer.Data.ID, acct.Data.ID, savingsAcct.Data.ID, "x", finance.TransferFixed, "1").Error}
		}},
		{"SetAccountReconciliation", func() finance.OpResult { return fin.SetAccountReconciliation(ctx, pastAcct.Data.ID, closed, "5") }},
		{"DeleteAccountReconciliation", func() finance.OpResult { return fin.DeleteAccountReconciliation(ctx, pastAcct.Data.ID, closed) }},
		{"EndTransfer", func() finance.OpResult { return fin.EndTransfer(ctx, transfer.Data.ID, period) }},
		{"DeleteTransfer", func() finance.OpResult { return fin.DeleteTransfer(ctx, transfer.Data.ID) }},
		{"SetFixedExpenseAccount", func() finance.OpResult { return fin.SetFixedExpenseAccount(ctx, fe.Data.ID, nil) }},
		{"SetMerchantCategory", func() finance.OpResult { return fin.SetMerchantCategory(ctx, merchant.Data.ID, "") }},
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
	if trs, err := fin.ListTransfers(ctx); err != nil || len(trs) != 0 {
		t.Fatalf("Camila ListTransfers = %+v (err %v), want none", trs, err)
	}
	if r := fin.AddSavingsContribution(ctx, goal.Data.ID, period, "1"); r.Error == nil || r.Error.Code != "NOT_FOUND" {
		t.Fatalf("Camila AddSavingsContribution on Gastón's goal = %+v, want NOT_FOUND", r.Error)
	}
	if r := fin.WithdrawSavings(ctx, goal.Data.ID, period, "1"); r.Error == nil || r.Error.Code != "NOT_FOUND" {
		t.Fatalf("Camila WithdrawSavings on Gastón's goal = %+v, want NOT_FOUND", r.Error)
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
	if r := fin.ListCardStatements(ctx, ""); r.Error != nil || len(r.Data) != 0 {
		t.Fatalf("Camila ListCardStatements = %+v, want none", r)
	}
	if r := fin.ImportCardStatement(ctx, statement); r.Error != nil || r.Data.AlreadyImported || r.Data.StatementID == imported.Data.StatementID {
		t.Fatalf("Camila ImportCardStatement = %+v, want her own new statement", r)
	}
	if r := fin.MonthlySummary(ctx, "2026-02"); r.Error != nil || r.Data.AcumuladoDesde != "" || !r.Data.Acumulado.IsZero() {
		t.Fatalf("Camila MonthlySummary after Gastón's reconciliation = %+v, want no carried balance", r)
	}
	if r := fin.MonthlySummary(ctx, "2026-03"); r.Error != nil || !r.Data.Salary.IsZero() || r.Data.SalaryExpected {
		t.Fatalf("Camila MonthlySummary with Gastón's base salary = %+v, want no salary", r.Data)
	}
	if r := fin.GetBaseSalary(ctx, "2026-03"); r.Error != nil || r.Data != nil {
		t.Fatalf("Camila GetBaseSalary = %+v, want none", r)
	}
	if need, err := fin.UFMonthsNeeded(ctx); err != nil || len(need) != 0 {
		t.Fatalf("Camila UFMonthsNeeded = %v (err %v), want none (the UF expense is Gastón's)", need, err)
	}
	if tags, err := fin.ListTags(ctx); err != nil || len(tags) != 0 {
		t.Fatalf("Camila ListTags = %+v (err %v), want none", tags, err)
	}
	if r := fin.SearchExpenses(ctx, finance.ExpenseFilter{Tag: "Salud"}); r.Error != nil || r.Data.Count != 0 {
		t.Fatalf("Camila search by Gastón's tag = %+v, want nothing", r)
	}
	if r := fin.SearchExpenses(ctx, finance.ExpenseFilter{Text: "77777777"}); r.Error != nil || r.Data.Count != 0 {
		t.Fatalf("Camila search by Gastón's bank code = %+v, want nothing", r)
	}
	if r := fin.ListReceivables(ctx); r.Error != nil || len(r.Data) != 0 {
		t.Fatalf("Camila ListReceivables = %+v, want none", r)
	}
	if r := fin.ListAccounts(ctx, period); r.Error != nil || len(r.Data.Accounts) != 0 {
		t.Fatalf("Camila ListAccounts = %+v, want none", r)
	}
	if r := fin.UpcomingDues(ctx, period+"-05", 10); r.Error != nil || len(r.Data) != 0 {
		t.Fatalf("Camila UpcomingDues = %+v, want none", r)
	}

	// The catalog lands in Camila's own profile, never in Gastón's (checked below).
	if applied := fin.ApplyCatalog(ctx); applied.Error != nil || applied.Data.Merchants == 0 {
		t.Fatalf("Camila ApplyCatalog = %+v", applied)
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
	pendingIDs := map[int64]bool{}
	for _, it := range fin.ListImportItems(ctx, finance.ImportPendiente).Data {
		pendingIDs[it.ID] = true
	}
	if len(pendingIDs) != 2 || !pendingIDs[itemID] || !pendingIDs[creditID] {
		t.Fatalf("Gastón's pending items after Camila = %v, want items %d and %d untouched", pendingIDs, itemID, creditID)
	}
	if r := fin.GetCardStatement(ctx, imported.Data.StatementID); r.Error != nil {
		t.Fatalf("Gastón's statement after Camila: %v", r.Error)
	}
	if r := fin.MonthlySummary(ctx, "2026-02"); r.Error != nil || r.Data.AcumuladoDesde != reconciled {
		t.Fatalf("Gastón's reconciliation after Camila = %+v, want the carried balance from %s", r, reconciled)
	}
	// Camila's catalog added nothing to Gastón's profile, and his transfer stands.
	if mers, err := fin.ListMerchants(ctx); err != nil || len(mers) != 1 {
		t.Fatalf("Gastón's merchants after Camila's catalog = %d (err %v), want his 1", len(mers), err)
	}
	if trs, err := fin.ListTransfers(ctx); err != nil || len(trs) != 1 || trs[0].EndPeriod != "" {
		t.Fatalf("Gastón's transfers after Camila = %+v (err %v), want his open monthly one", trs, err)
	}
	var vista *finance.AccountView
	if r := fin.ListAccounts(ctx, closed); r.Error == nil {
		for i := range r.Data.Accounts {
			if r.Data.Accounts[i].ID == pastAcct.Data.ID {
				vista = &r.Data.Accounts[i]
			}
		}
	}
	if vista == nil || vista.Conciliacion == nil || vista.Conciliacion.SaldoReal.String() != "1000" {
		t.Fatalf("Gastón's account reconciliation after Camila = %+v, want his 1000", vista)
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
