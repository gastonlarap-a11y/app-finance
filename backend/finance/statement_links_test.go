package finance

import (
	"slices"
	"testing"
)

// Card statements beyond one import: the cutoff they reveal, the card they
// belong to, the purchase seen again next month and the bank's codes.

func installmentPeriods(t *testing.T, s *FinanceService, expenseID int64) []string {
	t.Helper()
	var insts []Installment
	if err := s.db.NewSelect().Model(&insts).Where("expense_id = ?", expenseID).Order("number ASC").Scan(t.Context()); err != nil {
		t.Fatal(err)
	}
	out := make([]string, len(insts))
	for i, inst := range insts {
		out[i] = inst.Period
	}
	return out
}

func TestCutoffFollowsStatementWindows(t *testing.T) {
	ctx := t.Context()
	s := newTestService(t)
	card := s.CreateCard(ctx, "Itaú", "1000000", 24, "4321")
	mustOK(t, "CreateCard", card.Error)
	// Billed 2026-07-28..2026-08-25; announces 2026-08-26..2026-09-23.
	importStatement(t, s, nationalStatement())

	for _, tc := range []struct {
		name, date, want string
	}{
		{"the bank closed on the 25th, after the card's day 24", "2026-08-25", "2026-08"},
		{"the announced period closes on the 23rd", "2026-09-23", "2026-09"},
		{"past every window: the card's billing day", "2026-09-24", "2026-10"},
		{"before every window: the card's billing day", "2026-07-27", "2026-08"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ex := s.CreateExpense(ctx, tc.date, "Compra", "", "", &card.Data.ID, KindUnico, "1000", 1)
			mustOK(t, "CreateExpense", ex.Error)
			if got := installmentPeriods(t, s, ex.Data.ID); !slices.Equal(got, []string{tc.want}) {
				t.Fatalf("periods = %v, want [%s]", got, tc.want)
			}
		})
	}

	// Without a card nothing rolls.
	cash := s.CreateExpense(ctx, "2026-08-25", "Efectivo", "", "", nil, KindUnico, "1000", 1)
	mustOK(t, "CreateExpense", cash.Error)
	if got := installmentPeriods(t, s, cash.Data.ID); !slices.Equal(got, []string{"2026-08"}) {
		t.Fatalf("cash periods = %v, want [2026-08]", got)
	}
}

func TestCardDigitsLinkItsStatements(t *testing.T) {
	ctx := t.Context()
	s := newTestService(t)
	card := s.CreateCard(ctx, "Itaú", "1000000", 24, "") // digits not filled in yet
	mustOK(t, "CreateCard", card.Error)
	importStatement(t, s, nationalStatement())
	importStatement(t, s, internationalStatement())

	cardNames := func() []string {
		t.Helper()
		list := s.ListCardStatements(ctx, "2026-08")
		mustOK(t, "ListCardStatements", list.Error)
		out := make([]string, 0, len(list.Data))
		for _, v := range list.Data {
			out = append(out, v.Kind+":"+v.CardName)
		}
		slices.Sort(out)
		return out
	}
	if got := cardNames(); !slices.Equal(got, []string{"internacional:", "nacional:"}) {
		t.Fatalf("before the digits = %v, want no card", got)
	}

	mustOK(t, "UpdateCard", s.UpdateCard(ctx, card.Data.ID, "Itaú", "1000000", 24, "4321").Error)
	if got := cardNames(); !slices.Equal(got, []string{"internacional:Itaú", "nacional:Itaú"}) {
		t.Fatalf("with the digits = %v, want both statements on the card", got)
	}

	mustOK(t, "UpdateCard", s.UpdateCard(ctx, card.Data.ID, "Itaú", "1000000", 24, "9999").Error)
	if got := cardNames(); !slices.Equal(got, []string{"internacional:", "nacional:"}) {
		t.Fatalf("after a digits fix = %v, want no card", got)
	}

	other := s.CreateCard(ctx, "Itaú nueva", "1000000", 24, "4321")
	mustOK(t, "CreateCard", other.Error)
	if got := cardNames(); !slices.Equal(got, []string{"internacional:Itaú nueva", "nacional:Itaú nueva"}) {
		t.Fatalf("a new card with the digits = %v, want both statements on it", got)
	}
}

func TestPurchaseSeenAgainIsTheSameItem(t *testing.T) {
	ctx := t.Context()
	s := newTestService(t)
	importStatement(t, s, nationalStatement())
	dos := pendingByDescription(t, s)["TIENDA DOS"]
	mustOK(t, "DiscardImportItem", s.DiscardImportItem(ctx, dos.ID).Error)

	// Next month, from the bank's web PDF: another reference prefix, other wording.
	next := nationalStatement()
	next.StatementDate, next.PeriodFrom, next.PeriodTo = "2026-09-23", "2026-08-26", "2026-09-23"
	next.Lines = []CardStatementLineInput{{Section: LinePurchase, OperationDate: "2026-06-20", Reference: "2026062022222222",
		Description: "Tienda Dos", OperationAmount: "60001", TotalAmount: "60001",
		InstallmentNumber: 4, InstallmentsTotal: 6, InstallmentAmount: "10000"}}
	if got := importStatement(t, s, next); got.Duplicates != 1 || got.Added != 0 {
		t.Fatalf("next month = %+v, want the discarded purchase recognized", got)
	}
	if _, ok := pendingByDescription(t, s)["Tienda Dos"]; ok {
		t.Fatal("a discarded purchase came back to the inbox")
	}

	// A different purchase on the same day and plan is not mistaken for it, and
	// both counts survive a statement that has one of each.
	later := nationalStatement()
	later.StatementDate, later.PeriodFrom, later.PeriodTo = "2026-10-23", "2026-09-24", "2026-10-23"
	later.Lines = []CardStatementLineInput{
		{Section: LinePurchase, OperationDate: "2026-06-20", Reference: "2310 22222222",
			Description: "TIENDA DOS", OperationAmount: "60001", TotalAmount: "60001",
			InstallmentNumber: 5, InstallmentsTotal: 6, InstallmentAmount: "10000"},
		{Section: LinePurchase, OperationDate: "2026-06-20", Reference: "2310 55555555",
			Description: "OTRA TIENDA", OperationAmount: "60001", TotalAmount: "60001",
			InstallmentNumber: 5, InstallmentsTotal: 6, InstallmentAmount: "10000"},
	}
	if got := importStatement(t, s, later); got.Added != 1 || got.Duplicates != 1 {
		t.Fatalf("mixed statement = %+v, want 1 staged and 1 recognized", got)
	}
}

func TestDeferredPurchaseStartsNextPeriod(t *testing.T) {
	ctx := t.Context()
	s := newTestService(t)
	aug := nationalStatement()
	aug.Lines = append(aug.Lines, CardStatementLineInput{Section: LineDeferred, OperationDate: "2026-08-20",
		Reference: "2008 44444444", Description: "TIENDA TRES", OperationAmount: "30000", TotalAmount: "30000",
		InstallmentNumber: 0, InstallmentsTotal: 3, InstallmentAmount: "10000"})
	importStatement(t, s, aug)

	tres := pendingByDescription(t, s)["TIENDA TRES"]
	if tres.FirstPeriod != "2026-09" || tres.InstallmentNumber != 1 || tres.InstallmentsTotal != 3 ||
		tres.InstallmentAmount != "10000" || tres.Amount.String() != "30000" || tres.Reference != "2008 44444444" {
		t.Fatalf("deferred item = %+v, want 3 cuotas of 10000 from 2026-09", tres)
	}
	list := s.ListCardStatements(ctx, "2026-08")
	mustOK(t, "ListCardStatements", list.Error)
	if got := list.Data[0].BankCharges.String(); got != "42340" {
		t.Fatalf("bank charges = %s, want 42340 (nothing of the deferred purchase billed yet)", got)
	}

	// Next statement bills its cuota 1/3 under another reference prefix.
	sep := nationalStatement()
	sep.StatementDate, sep.PeriodFrom, sep.PeriodTo = "2026-09-23", "2026-08-26", "2026-09-23"
	sep.Lines = []CardStatementLineInput{{Section: LinePurchase, OperationDate: "2026-08-20", Reference: "2309 44444444",
		Description: "TIENDA TRES", OperationAmount: "30000", TotalAmount: "30000",
		InstallmentNumber: 1, InstallmentsTotal: 3, InstallmentAmount: "10000"}}
	if got := importStatement(t, s, sep); got.Duplicates != 1 || got.Added != 0 {
		t.Fatalf("cuota 1 next month = %+v, want the deferred item recognized", got)
	}
}

func TestExpenseReferences(t *testing.T) {
	ctx := t.Context()
	s := newTestService(t)
	card := s.CreateCard(ctx, "Itaú", "1000000", 24, "4321")
	mustOK(t, "CreateCard", card.Error)
	importStatement(t, s, nationalStatement())
	dos := pendingByDescription(t, s)["TIENDA DOS"]
	if dos.Reference != "2508 22222222" {
		t.Fatalf("item reference = %q, want the printed code", dos.Reference)
	}
	ex := s.ConfirmImportItem(ctx, dos.ID, dos.Date, "Tienda dos", "Hogar", "", &card.Data.ID, KindCuotas, dos.InstallmentAmount, 6, "")
	mustOK(t, "ConfirmImportItem", ex.Error)

	next := nationalStatement()
	next.StatementDate, next.PeriodFrom, next.PeriodTo = "2026-09-23", "2026-08-26", "2026-09-23"
	next.Lines = []CardStatementLineInput{{Section: LinePurchase, OperationDate: "2026-06-20", Reference: "2309 22222222",
		Description: "TIENDA DOS", OperationAmount: "60001", TotalAmount: "60001",
		InstallmentNumber: 4, InstallmentsTotal: 6, InstallmentAmount: "10000"}}
	importStatement(t, s, next)

	want := []string{"2309 22222222", "2508 22222222"}
	sum := s.MonthlySummary(ctx, "2026-09")
	mustOK(t, "MonthlySummary", sum.Error)
	var refs []string
	for _, mv := range sum.Data.Movimientos {
		if mv.ExpenseID == ex.Data.ID {
			refs = mv.References
		}
	}
	if !slices.Equal(refs, want) {
		t.Fatalf("movimiento references = %v, want %v", refs, want)
	}

	found := s.SearchExpenses(ctx, ExpenseFilter{Text: "22222222"})
	mustOK(t, "SearchExpenses", found.Error)
	if found.Data.Count != 1 || !slices.Equal(found.Data.Items[0].References, want) {
		t.Fatalf("search by code = %+v, want the expense with its codes", found.Data)
	}
	if none := s.SearchExpenses(ctx, ExpenseFilter{Text: "99999999"}); none.Data.Count != 0 {
		t.Fatalf("unknown code found %d expenses", none.Data.Count)
	}
}

func TestOperationNumber(t *testing.T) {
	for ref, want := range map[string]string{
		"2508 12345678":    "12345678", // Itaú, emailed PDF
		"2026061612345678": "12345678", // Itaú, web PDF
		"060787654321":     "87654321", // Banco de Chile
		"1008 00000000":    "",         // payment: no operation number
		"3007":             "",
		"":                 "",
	} {
		if got := operationNumber(ref); got != want {
			t.Errorf("operationNumber(%q) = %q, want %q", ref, got, want)
		}
	}
}
