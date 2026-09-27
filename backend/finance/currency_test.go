package finance

import (
	"testing"

	"github.com/gastonlarap-a11y/app-finance/backend/shared"
)

func TestConfirmingAForeignItemKeepsTheOriginal(t *testing.T) {
	ctx := t.Context()
	s := newTestService(t)
	mustStage(t, s, pdfBatch(ImportCandidate{Date: "2030-03-10", Description: "APP STORE", Amount: "20.50", Currency: "USD"}))
	item := mustList(t, s, ImportPendiente)[0]
	ex := s.ConfirmImportItem(ctx, item.ID, item.Date, "Suscripción", "", "", nil, KindUnico, "19475", 1, "")
	mustOK(t, "ConfirmImportItem", ex.Error)

	got := loadExpense(t, s, ex.Data.ID)
	if got.Currency != "USD" || got.OriginalAmount != "20.5" || got.FxRate != "950" || got.InstallmentAmount.String() != "19475" {
		t.Fatalf("expense = %+v, want USD 20.5 at 950 (pesos unchanged)", got)
	}
	sum := s.MonthlySummary(ctx, "2030-03")
	mustOK(t, "MonthlySummary", sum.Error)
	if mv := sum.Data.Movimientos[0]; mv.Currency != "USD" || mv.OriginalAmount != "20.5" || mv.Amount.String() != "19475" {
		t.Fatalf("movimiento = %+v, want the pesos with the original beside", mv)
	}
}

func TestSetExpenseCurrency(t *testing.T) {
	ctx := t.Context()
	s := newTestService(t)
	ex := s.CreateExpense(ctx, "2030-03-10", "Hotel", "", "", nil, KindUnico, "95000", 1)
	mustOK(t, "CreateExpense", ex.Error)
	if got := loadExpense(t, s, ex.Data.ID); got.Currency != "CLP" {
		t.Fatalf("new expense currency = %q, want CLP", got.Currency)
	}

	mustOK(t, "SetExpenseCurrency", s.SetExpenseCurrency(ctx, ex.Data.ID, "eur", "100", "950").Error)
	if got := loadExpense(t, s, ex.Data.ID); got.Currency != "EUR" || got.OriginalAmount != "100" || got.FxRate != "950" {
		t.Fatalf("after setting = %+v", got)
	}
	mustOK(t, "SetExpenseCurrency CLP", s.SetExpenseCurrency(ctx, ex.Data.ID, "CLP", "", "").Error)
	if got := loadExpense(t, s, ex.Data.ID); got.Currency != "CLP" || got.OriginalAmount != "" || got.FxRate != "" {
		t.Fatalf("after clearing = %+v", got)
	}
	for _, bad := range [][3]string{{"dólar", "1", "1"}, {"USD", "0", "950"}, {"USD", "10", ""}} {
		if r := s.SetExpenseCurrency(ctx, ex.Data.ID, bad[0], bad[1], bad[2]); r.Error == nil || r.Error.Code != shared.ErrValidation {
			t.Fatalf("SetExpenseCurrency%v = %+v, want VALIDATION", bad, r.Error)
		}
	}
	if r := s.SetExpenseCurrency(ctx, 999, "USD", "1", "1"); r.Error == nil || r.Error.Code != shared.ErrNotFound {
		t.Fatalf("unknown expense = %+v, want NOT_FOUND", r.Error)
	}
	if r := s.LatestFxRate(ctx); r.Error != nil || r.Data != "" {
		t.Fatalf("LatestFxRate without statements = %+v, want none", r)
	}
}
