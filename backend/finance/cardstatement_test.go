package finance

import (
	"strings"
	"testing"

	"github.com/gastonlarap-a11y/app-finance/backend/shared"
)

// Synthetic statements (invented merchants and amounts) shaped like Itaú's.

func nationalStatement() CardStatementInput {
	return CardStatementInput{
		Issuer: "itau", Kind: StatementNational, Currency: "CLP", CardLastDigits: "4321",
		StatementDate: "2026-08-25", PeriodFrom: "2026-07-28", PeriodTo: "2026-08-25", DueDate: "2026-09-08",
		PreviousPeriodFrom: "2026-06-24", PreviousPeriodTo: "2026-07-27",
		NextPeriodFrom: "2026-08-26", NextPeriodTo: "2026-09-23",
		CreditLimit: "1000000", CreditUsed: "300000", CreditAvailable: "700000",
		CashLimit: "1000000", CashUsed: "0", CashAvailable: "700000",
		PreviousBalanceStart: "0", PreviousBilled: "100000", PreviousPaid: "-100000", PreviousBalanceEnd: "0",
		TotalOperations: "22340", VoluntaryProducts: "0", ChargesNet: "8000", TotalBilled: "130340",
		MinimumPayment: "130340", PrepaymentCost: "300000", AutomaticCharge: "0", UnbilledBalance: "169660",
		RateRevolving: "2.56", RateInstallments: "4.25", RateCashAdvance: "4.25",
		CaeRevolving: "65.21", CaeInstallments: "62.28", CaeCashAdvance: "71.93", CaePrepayment: "13.33",
		LateInterestRate: "30.72",
		Lines: []CardStatementLineInput{
			{Section: LinePayment, OperationDate: "2026-08-10", Reference: "1008 00000000", Description: "MONTO CANCELADO",
				OperationAmount: "-100000", TotalAmount: "-100000", InstallmentAmount: "-100000"},
			// Cuota 2 of 3 of a purchase the user already has in the app.
			{Section: LinePurchase, Place: "SANTIAGO", OperationDate: "2026-06-16", Reference: "2508 11111111",
				Description: "TIENDA UNO", InterestRate: "0", OperationAmount: "30000", TotalAmount: "30000",
				InstallmentNumber: 2, InstallmentsTotal: 3, InstallmentAmount: "10000"},
			// Cuota 3 of 6 of a purchase the app does not have: 60001 / 6 billed as 10000.
			{Section: LinePurchase, Place: "SANTIAGO", OperationDate: "2026-06-20", Reference: "2508 22222222",
				Description: "TIENDA DOS", InterestRate: "0", OperationAmount: "60001", TotalAmount: "60001",
				InstallmentNumber: 3, InstallmentsTotal: 6, InstallmentAmount: "10000"},
			{Section: LinePurchase, Place: "SANTIAGO", OperationDate: "2026-08-12", Reference: "1308 33333333",
				Description: "TAXI VIAJE SANTIAGO", OperationAmount: "2340", TotalAmount: "2340",
				InstallmentNumber: 1, InstallmentsTotal: 1, InstallmentAmount: "2340"},
			{Section: LineCharge, OperationDate: "2026-08-25", Reference: "2508 00000000", Description: "COMISION ADMINISTRACION MENSUAL",
				OperationAmount: "20000", TotalAmount: "20000", InstallmentAmount: "20000"},
			{Section: LineCredit, OperationDate: "2026-08-21", Reference: "2108 00000000", Description: "CASHBACK COM AGO26",
				OperationAmount: "-10000", TotalAmount: "-10000", InstallmentAmount: "-10000"},
			{Section: LineCredit, OperationDate: "2026-08-17", Reference: "1708 00000000", Description: "ABONO CANJE COMPRA TC",
				OperationAmount: "-2340", TotalAmount: "-2340", InstallmentAmount: "-2340"},
		},
		Schedule: []ScheduleInput{{Period: "2026-09", Amount: "20000"}, {Period: "2026-10", Amount: "20000"}},
	}
}

func internationalStatement() CardStatementInput {
	return CardStatementInput{
		Issuer: "itau", Kind: StatementInternational, Currency: "USD", CardLastDigits: "4321",
		StatementDate: "2026-08-25", PeriodFrom: "2026-07-28", PeriodTo: "2026-08-25", DueDate: "2026-09-08",
		CreditLimit: "1000", CreditUsed: "20", CreditAvailable: "980",
		PreviousBilled: "100", PreviousPaid: "-100", TotalBilled: "20",
		Lines: []CardStatementLineInput{
			{Section: LinePayment, OperationDate: "2026-07-30", Reference: "3007", Description: "MONTO CANCELADO",
				Country: "CL", InstallmentAmount: "-100", OriginAmount: "-100"},
			{Section: LinePurchase, OperationDate: "2026-08-02", Reference: "0308 99", Description: "SERVICIO WEB SUB",
				City: "SAN FRANCISCO", Country: "US", InstallmentAmount: "20", OriginAmount: "20"},
		},
	}
}

func importStatement(t *testing.T, s *FinanceService, in CardStatementInput) CardStatementImport {
	t.Helper()
	r := s.ImportCardStatement(t.Context(), in)
	mustOK(t, "ImportCardStatement", r.Error)
	return *r.Data
}

func pendingByDescription(t *testing.T, s *FinanceService) map[string]ImportItemView {
	t.Helper()
	out := map[string]ImportItemView{}
	for _, it := range mustList(t, s, ImportPendiente) {
		out[it.Description] = it
	}
	return out
}

func TestImportCardStatementStoresEverythingAndFeedsTheInbox(t *testing.T) {
	ctx := t.Context()
	s := newTestService(t)
	card := s.CreateCard(ctx, "Itaú", "1000000", 26, "4321")
	mustOK(t, "CreateCard", card.Error)
	// The purchase whose cuota 2/3 the statement bills is already in the app.
	existing := s.CreateExpense(ctx, "2026-06-16", "Tienda uno", "Hogar", "", &card.Data.ID, KindCuotas, "10000", 3)
	mustOK(t, "CreateExpense", existing.Error)

	got := importStatement(t, s, nationalStatement())
	if got.AlreadyImported || got.LinkedInstallments != 1 || got.Added != 5 || got.PaymentsMatched != 0 {
		t.Fatalf("import = %+v, want 1 cuota linked and 5 new items", got)
	}

	pending := pendingByDescription(t, s)
	if _, ok := pending["TIENDA UNO"]; ok {
		t.Fatal("a cuota continuing an app expense must not be reviewed again")
	}
	dos := pending["TIENDA DOS"]
	if dos.Amount.String() != "60001" || dos.InstallmentsTotal != 6 || dos.InstallmentNumber != 3 ||
		dos.InstallmentAmount != "10000" || dos.FirstPeriod != "2026-06" || dos.CardName != "Itaú" {
		t.Fatalf("new cuotas purchase = %+v", dos)
	}
	if c := pending["CASHBACK COM AGO26"]; c.Kind != ImportKindCredit || c.Amount.String() != "10000" {
		t.Fatalf("cashback = %+v, want a credit of 10000", c)
	}
	if c := pending["COMISION ADMINISTRACION MENSUAL"]; c.Kind != ImportKindExpense || c.Amount.String() != "20000" {
		t.Fatalf("commission = %+v, want an expense of 20000", c)
	}

	list := s.ListCardStatements(ctx, "2026-08")
	mustOK(t, "ListCardStatements", list.Error)
	if len(list.Data) != 1 {
		t.Fatalf("statements for 2026-08 = %d, want 1", len(list.Data))
	}
	v := list.Data[0]
	if v.Period != "2026-08" || v.CardName != "Itaú" || v.TotalBilled.String() != "130340" || v.DueDate != "2026-09-08" ||
		v.BankCharges.String() != "42340" || v.BankCredits.String() != "12340" || v.PendingItems != 5 ||
		v.CaePrepayment != "13.33" || v.UnbilledBalance.String() != "169660" {
		t.Fatalf("statement view = %+v", v)
	}
	// The app has only the linked cuota (10000) on the card for 2026-08 so far.
	if v.AppCharges == nil || v.AppCharges.String() != "10000" {
		t.Fatalf("app charges = %v, want 10000", v.AppCharges)
	}

	detail := s.GetCardStatement(ctx, v.ID)
	mustOK(t, "GetCardStatement", detail.Error)
	if len(detail.Data.Lines) != 7 || len(detail.Data.Schedule) != 2 {
		t.Fatalf("detail has %d lines and %d schedule entries", len(detail.Data.Lines), len(detail.Data.Schedule))
	}
	for _, l := range detail.Data.Lines {
		switch l.Description {
		case "TIENDA UNO":
			if l.ExpenseID == nil || *l.ExpenseID != existing.Data.ID {
				t.Errorf("TIENDA UNO line = %+v, want linked to expense %d", l, existing.Data.ID)
			}
		case "ABONO CANJE COMPRA TC":
			if l.RedeemedPurchase != "TAXI VIAJE SANTIAGO" || l.ItemStatus != ImportPendiente {
				t.Errorf("points redemption = %+v, want the taxi purchase it pays", l)
			}
		}
	}

	again := importStatement(t, s, nationalStatement())
	if !again.AlreadyImported || again.StatementID != v.ID || again.Added != 0 {
		t.Fatalf("re-import = %+v, want already imported", again)
	}
}

func TestConfirmStatementItems(t *testing.T) {
	ctx := t.Context()
	s := newTestService(t)
	card := s.CreateCard(ctx, "Itaú", "1000000", 26, "4321")
	mustOK(t, "CreateCard", card.Error)
	importStatement(t, s, nationalStatement())
	pending := pendingByDescription(t, s)

	// Cuota 3/6: cuota 1 in 2026-06 and the first two already paid.
	dos := pending["TIENDA DOS"]
	ex := s.ConfirmImportItem(ctx, dos.ID, dos.Date, "Tienda dos", "Hogar", "", &card.Data.ID, KindCuotas, dos.InstallmentAmount, 6, "")
	mustOK(t, "ConfirmImportItem", ex.Error)
	var insts []Installment
	if err := s.db.NewSelect().Model(&insts).Where("expense_id = ?", ex.Data.ID).Order("number ASC").Scan(ctx); err != nil {
		t.Fatal(err)
	}
	if len(insts) != 6 || insts[0].Period != "2026-06" || insts[2].Period != "2026-08" ||
		insts[1].Status != StatusPagado || insts[2].Status != StatusPendiente {
		t.Fatalf("installments = %+v, want 2026-06..2026-11 with cuotas 1-2 paid", insts)
	}

	cash := pending["CASHBACK COM AGO26"]
	inc := s.ConfirmImportItemAsIncome(ctx, cash.ID, "2026-08", "Devolución comisión", cash.Amount.String())
	mustOK(t, "ConfirmImportItemAsIncome", inc.Error)
	sum := s.MonthlySummary(ctx, "2026-08")
	mustOK(t, "MonthlySummary", sum.Error)
	if sum.Data.Extras.String() != "10000" {
		t.Fatalf("extras = %s, want the 10000 cashback", sum.Data.Extras)
	}
	if again := s.ConfirmImportItemAsIncome(ctx, cash.ID, "2026-08", "x", "1"); again.Error == nil || again.Error.Code != shared.ErrConflict {
		t.Fatalf("second confirm = %+v, want CONFLICT", again.Error)
	}
	if bad := s.ConfirmImportItemAsIncome(ctx, pending["TAXI VIAJE SANTIAGO"].ID, "2026-8", "x", "1"); bad.Error == nil || bad.Error.Code != shared.ErrValidation {
		t.Fatalf("invalid period = %+v, want VALIDATION", bad.Error)
	}

	// Next month the confirmed purchase bills cuota 4/6: linked, not reviewed.
	next := nationalStatement()
	next.StatementDate, next.PeriodFrom, next.PeriodTo = "2026-09-23", "2026-08-26", "2026-09-23"
	next.Lines = []CardStatementLineInput{{Section: LinePurchase, OperationDate: "2026-06-20", Reference: "2508 22222222",
		Description: "TIENDA DOS", OperationAmount: "60001", TotalAmount: "60001",
		InstallmentNumber: 4, InstallmentsTotal: 6, InstallmentAmount: "10000"}}
	if got := importStatement(t, s, next); got.LinkedInstallments != 1 || got.Added != 0 {
		t.Fatalf("next month = %+v, want the cuota linked", got)
	}
	sep := s.ListCardStatements(ctx, "2026-09")
	mustOK(t, "ListCardStatements", sep.Error)
	if len(sep.Data) != 1 || sep.Data[0].AppCharges == nil || sep.Data[0].AppCharges.String() != "10000" {
		t.Fatalf("2026-09 = %+v, want the app to have cuota 4 (10000)", sep.Data)
	}
}

func TestUnconfirmedCuotaIsNotStagedTwice(t *testing.T) {
	s := newTestService(t)
	importStatement(t, s, nationalStatement())
	next := nationalStatement()
	next.StatementDate, next.PeriodTo = "2026-09-23", "2026-09-23"
	next.Lines = []CardStatementLineInput{{Section: LinePurchase, OperationDate: "2026-06-20", Reference: "2508 22222222",
		Description: "TIENDA DOS", OperationAmount: "60001", TotalAmount: "60001",
		InstallmentNumber: 4, InstallmentsTotal: 6, InstallmentAmount: "10000"}}
	if got := importStatement(t, s, next); got.Duplicates != 1 || got.Added != 0 {
		t.Fatalf("next month with the purchase still pending = %+v, want 1 duplicate", got)
	}
}

func TestStatementPaymentsReconcileTheCartola(t *testing.T) {
	ctx := t.Context()
	s := newTestService(t)
	// Cartola first: the national payment and the USD-debt payment in CLP.
	mustStage(t, s, ImportBatch{Source: ImportSourcePDFAccount, Issuer: "itau", Items: []ImportCandidate{
		{Date: "2026-08-09", Description: "PAGO DEUDA TC CTA", Amount: "100000", Hint: HintCardPayment},
		{Date: "2026-07-31", Description: "PAGO DEUDA INTER. TC CTA CLP", Amount: "95000", Hint: HintCardPayment},
	}})
	if got := importStatement(t, s, nationalStatement()); got.PaymentsMatched != 1 {
		t.Fatalf("national import = %+v, want the cartola payment matched", got)
	}
	if got := importStatement(t, s, internationalStatement()); got.PaymentsMatched != 1 {
		t.Fatalf("international import = %+v, want the USD payment matched", got)
	}
	conc := map[string]bool{}
	for _, it := range mustList(t, s, ImportConciliado) {
		conc[it.Description] = it.StatementLineID != nil
	}
	if !conc["PAGO DEUDA TC CTA"] || !conc["PAGO DEUDA INTER. TC CTA CLP"] {
		t.Fatalf("conciliado = %v, want both cartola payments linked to statement lines", conc)
	}
	// 95000 CLP paid 100 USD → 950 CLP/USD: the 20 USD purchase ≈ 19000 CLP.
	web := pendingByDescription(t, s)["SERVICIO WEB SUB"]
	if web.Currency != "USD" || web.Amount.String() != "20" || web.SuggestedAmountClp != "19000" {
		t.Fatalf("USD purchase = %+v, want 20 USD ≈ 19000 CLP", web)
	}

	// The other direction: the statement first, the cartola payment later.
	s2 := newTestService(t)
	importStatement(t, s2, nationalStatement())
	if got := mustStage(t, s2, ImportBatch{Source: ImportSourcePDFAccount, Issuer: "itau", Items: []ImportCandidate{
		{Date: "2026-08-11", Description: "PAGO DEUDA TC CTA", Amount: "100000", Hint: HintCardPayment},
	}}); got.Reconciled != 1 {
		t.Fatalf("cartola after statement = %+v, want the payment reconciled", got)
	}
	_ = ctx
}

func TestImportCardStatementValidation(t *testing.T) {
	s := newTestService(t)
	tests := []struct {
		name   string
		mutate func(*CardStatementInput)
		want   string
	}{
		{"kind", func(in *CardStatementInput) { in.Kind = "otro" }, "tipo"},
		{"digits", func(in *CardStatementInput) { in.CardLastDigits = "" }, "dígitos"},
		{"date", func(in *CardStatementInput) { in.StatementDate = "25/08/2026" }, "fecha del estado"},
		{"money", func(in *CardStatementInput) { in.TotalBilled = "1.234.567" }, "total facturado"},
		{"section", func(in *CardStatementInput) { in.Lines[0].Section = "x" }, "movimiento 1"},
		{"cuota", func(in *CardStatementInput) { in.Lines[1].InstallmentNumber = 4 }, "cuota 4 de 3"},
		{"schedule", func(in *CardStatementInput) { in.Schedule[0].Period = "sept" }, "calendario"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			in := nationalStatement()
			tt.mutate(&in)
			r := s.ImportCardStatement(t.Context(), in)
			if r.Error == nil || r.Error.Code != shared.ErrValidation || !strings.Contains(r.Error.Message, tt.want) {
				t.Fatalf("ImportCardStatement = %+v, want VALIDATION about %q", r.Error, tt.want)
			}
		})
	}
	if list := s.ListCardStatements(t.Context(), ""); len(list.Data) != 0 {
		t.Fatal("a rejected statement left rows behind")
	}
}

func TestDeleteCardStatement(t *testing.T) {
	ctx := t.Context()
	s := newTestService(t)
	got := importStatement(t, s, nationalStatement())
	mustOK(t, "DeleteCardStatement", s.DeleteCardStatement(ctx, got.StatementID).Error)
	if r := s.GetCardStatement(ctx, got.StatementID); r.Error == nil || r.Error.Code != shared.ErrNotFound {
		t.Fatalf("GetCardStatement after delete = %+v, want NOT_FOUND", r.Error)
	}
	// ON DELETE CASCADE takes the lines and the schedule along, and SET NULL
	// unhooks the staged items from the lines that are gone.
	for _, q := range []string{
		"SELECT count(*) FROM card_statement_lines WHERE statement_id = ?",
		"SELECT count(*) FROM card_statement_schedule WHERE statement_id = ?",
	} {
		var n int
		if err := s.db.NewRaw(q, got.StatementID).Scan(ctx, &n); err != nil || n != 0 {
			t.Fatalf("%s = %d (err %v), want 0 after the cascade", q, n, err)
		}
	}
	var linked int
	if err := s.db.NewRaw("SELECT count(*) FROM import_items WHERE statement_line_id IS NOT NULL").Scan(ctx, &linked); err != nil || linked != 0 {
		t.Fatalf("items still linked to deleted lines = %d (err %v), want 0", linked, err)
	}
	// No card nor prior expense here, so all 6 non-payment lines were staged.
	if n := len(mustList(t, s, ImportPendiente)); n != 6 {
		t.Fatalf("pending after delete = %d, want the 6 staged items kept", n)
	}
	if again := importStatement(t, s, nationalStatement()); again.AlreadyImported || again.Duplicates != 6 {
		t.Fatalf("re-import after delete = %+v, want stored again with its items as duplicates", again)
	}
}
