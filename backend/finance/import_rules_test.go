package finance

import (
	"testing"

	"github.com/gastonlarap-a11y/app-finance/backend/shared"
	"github.com/gastonlarap-a11y/app-finance/backend/shared/types"
)

func dec(t *testing.T, s string) types.Decimal {
	t.Helper()
	d, err := types.New(s)
	if err != nil {
		t.Fatalf("decimal %q: %v", s, err)
	}
	return d
}

func TestLineCandidateKindAndBillingMonth(t *testing.T) {
	st := &CardStatement{Kind: StatementNational, Currency: "CLP", Period: "2026-08"}
	for _, tc := range []struct {
		name            string
		line            CardStatementLine
		wantKind        string
		wantAmount      string
		wantFirstPeriod string
	}{
		{"one-payment purchase is billed in the statement month",
			CardStatementLine{Section: LinePurchase, OperationAmount: dec(t, "2340"), InstallmentAmount: dec(t, "2340"), InstallmentNumber: 1, InstallmentsTotal: 1},
			ImportKindExpense, "2340", "2026-08"},
		{"cuota 3/6 started two months before",
			CardStatementLine{Section: LinePurchase, OperationAmount: dec(t, "60000"), InstallmentAmount: dec(t, "10000"), InstallmentNumber: 3, InstallmentsTotal: 6},
			ImportKindExpense, "60000", "2026-06"},
		{"a fee is billed in the statement month",
			CardStatementLine{Section: LineCharge, OperationAmount: dec(t, "20000"), InstallmentAmount: dec(t, "20000"), InstallmentNumber: 1, InstallmentsTotal: 1},
			ImportKindExpense, "20000", "2026-08"},
		{"a reversed purchase is money back",
			CardStatementLine{Section: LinePurchase, OperationAmount: dec(t, "-15990"), InstallmentAmount: dec(t, "-15990"), InstallmentNumber: 1, InstallmentsTotal: 1},
			ImportKindCredit, "15990", ""},
		{"a refunded fee is money back",
			CardStatementLine{Section: LineCharge, OperationAmount: dec(t, "-20000"), InstallmentAmount: dec(t, "-20000"), InstallmentNumber: 1, InstallmentsTotal: 1},
			ImportKindCredit, "20000", ""},
		{"a credit stays a credit",
			CardStatementLine{Section: LineCredit, OperationAmount: dec(t, "-10000"), InstallmentAmount: dec(t, "-10000"), InstallmentNumber: 1, InstallmentsTotal: 1},
			ImportKindCredit, "10000", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := lineCandidate(st, &tc.line)
			kind := c.Kind
			if kind == "" {
				kind = ImportKindExpense
			}
			if kind != tc.wantKind || c.Amount != tc.wantAmount || c.FirstPeriod != tc.wantFirstPeriod {
				t.Fatalf("candidate = kind %q amount %q first %q, want %q %q %q",
					kind, c.Amount, c.FirstPeriod, tc.wantKind, tc.wantAmount, tc.wantFirstPeriod)
			}
		})
	}
}

// stageOne stages a single pdf_account candidate and returns its pending view.
func stageOne(t *testing.T, s *FinanceService, c ImportCandidate) ImportItemView {
	t.Helper()
	mustStage(t, s, pdfBatch(c))
	for _, it := range mustList(t, s, ImportPendiente) {
		if it.Description == c.Description && it.Date == c.Date {
			return it
		}
	}
	t.Fatalf("staged item %q not pending", c.Description)
	return ImportItemView{}
}

func TestConfirmPathsRequireKindAndPesos(t *testing.T) {
	ctx := t.Context()
	s := newTestService(t)
	credit := stageOne(t, s, ImportCandidate{Date: "2026-08-17", Description: "ABONO CANJE", Amount: "3145", Kind: ImportKindCredit})
	charge := stageOne(t, s, ImportCandidate{Date: "2026-08-12", Description: "TAXI", Amount: "5130"})
	usd := stageOne(t, s, ImportCandidate{Date: "2026-08-02", Description: "ANTHROPIC CLAUDE SUB", Amount: "119", Currency: "USD"})

	confirm := func(id int64, amount string) *shared.AppError {
		return s.ConfirmImportItem(ctx, id, "2026-08-02", "x", "", "", nil, KindUnico, amount, 1, "").Error
	}
	wantCode(t, "credit confirmed as expense", confirm(credit.ID, "3145"), shared.ErrValidation)
	wantCode(t, "credit linked to an expense", s.LinkImportItem(ctx, credit.ID, 1).Error, shared.ErrValidation)
	wantCode(t, "charge confirmed as income",
		s.ConfirmImportItemAsIncome(ctx, charge.ID, "2026-08", "x", "5130").Error, shared.ErrValidation)
	wantCode(t, "USD amount copied as pesos", confirm(usd.ID, "119"), shared.ErrValidation)
	wantCode(t, "USD amount with decimals", confirm(usd.ID, "112948.5"), shared.ErrValidation)

	mustOK(t, "USD converted to pesos", confirm(usd.ID, "112948"))
	mustOK(t, "credit as income", s.ConfirmImportItemAsIncome(ctx, credit.ID, "2026-08", "Canje", "3145").Error)
}

func TestLinkImportItemOncePerExpense(t *testing.T) {
	ctx := t.Context()
	s := newTestService(t)
	ex := s.CreateExpense(ctx, "2026-08-12", "Taxi", "", "", nil, KindUnico, "5130", 1)
	mustOK(t, "CreateExpense", ex.Error)
	first := stageOne(t, s, ImportCandidate{Date: "2026-08-12", Description: "TAXI UNO", Amount: "5130"})
	second := stageOne(t, s, ImportCandidate{Date: "2026-08-12", Description: "TAXI DOS", Amount: "5130"})

	mustOK(t, "first link", s.LinkImportItem(ctx, first.ID, ex.Data.ID).Error)
	wantCode(t, "second link to the same expense", s.LinkImportItem(ctx, second.ID, ex.Data.ID).Error, shared.ErrConflict)
}

func TestReopenConfirmedItemAfterTrash(t *testing.T) {
	ctx := t.Context()
	s := newTestService(t)
	it := stageOne(t, s, ImportCandidate{Date: "2026-08-12", Description: "TAXI", Amount: "5130"})
	r := s.ConfirmImportItem(ctx, it.ID, "2026-08-12", "Taxi", "", "", nil, KindUnico, "5130", 1, "")
	mustOK(t, "ConfirmImportItem", r.Error)

	wantCode(t, "reopen while the expense is live", s.RestoreImportItem(ctx, it.ID).Error, shared.ErrConflict)
	if got := mustList(t, s, ImportConfirmado); len(got) != 1 || got[0].Reopenable {
		t.Fatalf("confirmed = %+v, want one not reopenable", got)
	}

	mustOK(t, "DeleteExpense", s.DeleteExpense(ctx, r.Data.ID).Error)
	if got := mustList(t, s, ImportConfirmado); len(got) != 1 || !got[0].Reopenable {
		t.Fatalf("confirmed after trashing its expense = %+v, want reopenable", got)
	}
	mustOK(t, "RestoreImportItem", s.RestoreImportItem(ctx, it.ID).Error)
	pending := mustList(t, s, ImportPendiente)
	if len(pending) != 1 || pending[0].ExpenseID != nil {
		t.Fatalf("pending after reopen = %+v, want the item back without its old link", pending)
	}
}

func TestFixedExpenseSuggestionAndLink(t *testing.T) {
	ctx := t.Context()
	s := newTestService(t)
	fe := s.CreateFixedExpense(ctx, "Plan Entel", "Servicios", nil, "2026-07", "17000")
	mustOK(t, "CreateFixedExpense", fe.Error)

	bill := stageOne(t, s, ImportCandidate{Date: "2026-08-05", Description: "ENTEL PCS PAGO ENSANTIAGO C", Amount: "16990"})
	if bill.SuggestedFixedID == nil || *bill.SuggestedFixedID != fe.Data.ID || bill.SuggestedFixedPeriod != "2026-08" {
		t.Fatalf("suggestion = %v %q, want Plan Entel for 2026-08", bill.SuggestedFixedID, bill.SuggestedFixedPeriod)
	}
	for _, c := range []ImportCandidate{
		{Date: "2026-08-06", Description: "TRANSFERENCIA A JUAN", Amount: "17000"}, // amount only
		{Date: "2026-08-07", Description: "ENTEL TIENDA EQUIPO", Amount: "250000"}, // name only
		{Date: "2026-06-05", Description: "ENTEL PCS PAGO JUNIO", Amount: "17000"}, // before it starts
	} {
		if v := stageOne(t, s, c); v.SuggestedFixedID != nil {
			t.Fatalf("%q suggested %s, want no suggestion", c.Description, v.SuggestedFixedDescription)
		}
	}

	mustOK(t, "LinkImportItemToFixed", s.LinkImportItemToFixed(ctx, bill.ID, fe.Data.ID, "2026-08").Error)

	// August is paid at the bank's real amount; September keeps the plan.
	for _, tc := range []struct{ period, amount, status string }{
		{"2026-08", "16990", StatusPagado},
		{"2026-09", "17000", StatusPendiente},
	} {
		sum := s.MonthlySummary(ctx, tc.period)
		mustOK(t, "MonthlySummary", sum.Error)
		var found bool
		for _, m := range sum.Data.Movimientos {
			if m.FixedID != nil && *m.FixedID == fe.Data.ID {
				found = true
				if m.Amount.String() != tc.amount || m.Status != tc.status {
					t.Fatalf("%s fixed movement = %s %s, want %s %s", tc.period, m.Amount, m.Status, tc.amount, tc.status)
				}
			}
		}
		if !found {
			t.Fatalf("%s has no fixed movement", tc.period)
		}
	}

	again := stageOne(t, s, ImportCandidate{Date: "2026-08-20", Description: "ENTEL PCS PAGO OTRO", Amount: "16990"})
	if again.SuggestedFixedID != nil {
		t.Fatalf("a paid month is still suggested: %+v", again)
	}
	wantCode(t, "second link to the same month",
		s.LinkImportItemToFixed(ctx, again.ID, fe.Data.ID, "2026-08").Error, shared.ErrConflict)
	wantCode(t, "link outside the fixed expense's months",
		s.LinkImportItemToFixed(ctx, again.ID, fe.Data.ID, "2026-06").Error, shared.ErrValidation)
}

func TestNamesMatch(t *testing.T) {
	for _, tc := range []struct {
		fixed, descriptor string
		want              bool
	}{
		{"Plan Entel", "ENTEL PCS PAGO ENSANTIAGO C", true},
		{"Claude", "ANTHROPIC* CLAUDE SUB", true},
		{"Proseguro", "PROSEGUR ACTIVA", true},
		{"Netflix", "APPLE.COM/BILL", false},
		{"Luz", "ENEL DISTRIBUCION", false}, // too short to match anything
	} {
		if got := namesMatch(tc.fixed, tc.descriptor); got != tc.want {
			t.Errorf("namesMatch(%q, %q) = %v, want %v", tc.fixed, tc.descriptor, got, tc.want)
		}
	}
}

// A card payment the user already discarded (it is not an expense) still
// reconciles with the statement and teaches the USD rate.
func TestDiscardedPaymentTeachesTheRate(t *testing.T) {
	ctx := t.Context()
	s := newTestService(t)
	payment := stageOne(t, s, ImportCandidate{Date: "2026-07-31", Description: "PAGO DEUDA INTER. TC CTA CLP",
		Amount: "94900", Hint: HintCardPayment})
	mustOK(t, "DiscardImportItem", s.DiscardImportItem(ctx, payment.ID).Error)

	got := importStatement(t, s, internationalStatement()) // pays US$100 on 2026-07-30
	if got.PaymentsMatched != 1 {
		t.Fatalf("PaymentsMatched = %d, want the discarded payment reconciled", got.PaymentsMatched)
	}
	usd := pendingByDescription(t, s)["SERVICIO WEB SUB"]
	if usd.SuggestedAmountClp != "18980" { // US$20 × 949
		t.Fatalf("SuggestedAmountClp = %q, want 18980", usd.SuggestedAmountClp)
	}
}
