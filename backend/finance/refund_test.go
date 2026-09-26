package finance

import (
	"testing"

	"github.com/gastonlarap-a11y/app-finance/backend/shared"
)

func refundMovs(t *testing.T, s *FinanceService, period string) []Movimiento {
	t.Helper()
	var out []Movimiento
	for _, mv := range monthly(t, s, period).Movimientos {
		if mv.Source == SourceReembolso {
			out = append(out, mv)
		}
	}
	return out
}

func TestRefundLowersItsMonthAndCategory(t *testing.T) {
	ctx := t.Context()
	s := newTestService(t)
	card := s.CreateCard(ctx, "Visa", "1000000", 25, "")
	mustOK(t, "CreateCard", card.Error)
	cat := s.CreateCategory(ctx, "Ropa")
	mustOK(t, "CreateCategory", cat.Error)
	mustOK(t, "SetCategoryBudget", s.SetCategoryBudget(ctx, cat.Data.ID, "2026-01", "50000").Error)
	ex := s.CreateExpense(ctx, "2026-01-05", "Zapatillas", "Ropa", "Falabella", &card.Data.ID, KindUnico, "60000", 1)
	mustOK(t, "CreateExpense", ex.Error)

	// A partial refund the same month brings the category back under budget.
	mustOK(t, "CreateRefund Jan", s.CreateRefund(ctx, ex.Data.ID, "2026-01", "10000", "").Error)
	jan := monthly(t, s, "2026-01")
	wantMoney(t, "Jan gastos", jan.Gastos, "50000")
	wantMoney(t, "Jan pagado", jan.Pagado, "-10000") // the cuota is pending; the refund already arrived
	if len(jan.Presupuestos) != 1 || jan.Presupuestos[0].Over {
		t.Fatalf("Jan budget = %+v, want Ropa at its cap, not over", jan.Presupuestos)
	}
	wantMoney(t, "Jan Ropa spent", jan.Presupuestos[0].Spent, "50000")
	wantMoney(t, "Jan card", jan.PorTarjeta[0].GastoMes, "50000")
	movs := refundMovs(t, s, "2026-01")
	if len(movs) != 1 || movs[0].Description != "Reembolso: Zapatillas" || movs[0].RefundID == nil || movs[0].Category != "Ropa" {
		t.Fatalf("Jan refund movimientos = %+v", movs)
	}

	// Another refund arriving the next month lowers that month.
	mustOK(t, "CreateRefund Feb", s.CreateRefund(ctx, ex.Data.ID, "2026-02", "20000", "Devolución parcial").Error)
	wantMoney(t, "Feb gastos", monthly(t, s, "2026-02").Gastos, "-20000")
	wantMoney(t, "carried into Mar", monthly(t, s, "2026-03").Acumulado, "-30000") // −60.000 + 10.000 + 20.000
	year := s.YearSummary(ctx, 2026)
	mustOK(t, "YearSummary", year.Error)
	wantMoney(t, "year gastos", year.Data.TotalGastos, "30000")
	fc := s.CommitmentsForecast(ctx, "2026-02", 1)
	mustOK(t, "CommitmentsForecast", fc.Error)
	wantMoney(t, "forecast Feb libre", fc.Data[0].Libre, "20000")

	// Refunds never add up to more than the purchase cost.
	if r := s.CreateRefund(ctx, ex.Data.ID, "2026-02", "30001", ""); r.Error == nil || r.Error.Code != shared.ErrValidation {
		t.Fatalf("over-refund = %+v, want VALIDATION_ERROR", r.Error)
	}
	mustOK(t, "refund of the remaining 30.000", s.CreateRefund(ctx, ex.Data.ID, "2026-02", "30000", "").Error)

	// Trashing the purchase drops its refunds everywhere, like its cuotas.
	mustOK(t, "DeleteExpense", s.DeleteExpense(ctx, ex.Data.ID).Error)
	wantMoney(t, "Feb gastos after trash", monthly(t, s, "2026-02").Gastos, "0")
	wantMoney(t, "carried after trash", monthly(t, s, "2026-03").Acumulado, "0")
}

func TestRefundValidationAndDelete(t *testing.T) {
	ctx := t.Context()
	s := newTestService(t)
	ex := s.CreateExpense(ctx, "2026-01-05", "Tele", "", "", nil, KindCuotas, "100000", 3)
	mustOK(t, "CreateExpense", ex.Error)

	for _, tt := range []struct {
		name, period, amount string
		expenseID            int64
		code                 string
	}{
		{"zero", "2026-01", "0", ex.Data.ID, shared.ErrValidation},
		{"bad period", "2026-13", "1", ex.Data.ID, shared.ErrValidation},
		{"unknown expense", "2026-01", "1", 999, shared.ErrNotFound},
		{"more than the plan", "2026-02", "300001", ex.Data.ID, shared.ErrValidation},
	} {
		t.Run(tt.name, func(t *testing.T) {
			if r := s.CreateRefund(ctx, tt.expenseID, tt.period, tt.amount, ""); r.Error == nil || r.Error.Code != tt.code {
				t.Fatalf("CreateRefund = %+v, want %s", r.Error, tt.code)
			}
		})
	}
	// A cuotas purchase can be refunded up to its whole plan.
	rf := s.CreateRefund(ctx, ex.Data.ID, "2026-02", "300000", "")
	mustOK(t, "full refund of the plan", rf.Error)
	mustOK(t, "DeleteRefund", s.DeleteRefund(ctx, rf.Data.ID).Error)
	if r := s.DeleteRefund(ctx, rf.Data.ID); r.Error == nil || r.Error.Code != shared.ErrNotFound {
		t.Fatalf("DeleteRefund twice = %+v, want NOT_FOUND", r.Error)
	}
}

func TestBankCreditConfirmedAsRefund(t *testing.T) {
	ctx := t.Context()
	s := newTestService(t)
	ex := s.CreateExpense(ctx, "2026-03-02", "Zapatillas", "Ropa", "Falabella", nil, KindUnico, "45990", 1)
	mustOK(t, "CreateExpense", ex.Error)
	batch := ImportBatch{Source: ImportSourcePDFAccount, Issuer: "itau", Items: []ImportCandidate{
		{Date: "2026-03-20", Description: "FALABELLA DEVOLUCION", Amount: "45990", Kind: ImportKindCredit},
		{Date: "2026-03-21", Description: "CASHBACK PUNTOS", Amount: "3000", Kind: ImportKindCredit},
	}}
	st := s.StageImport(ctx, batch)
	mustOK(t, "StageImport", st.Error)

	items := s.ListImportItems(ctx, ImportPendiente)
	mustOK(t, "ListImportItems", items.Error)
	var refundItem, cashback ImportItemView
	for _, it := range items.Data {
		switch it.Description {
		case "FALABELLA DEVOLUCION":
			refundItem = it
		case "CASHBACK PUNTOS":
			cashback = it
		}
	}
	if refundItem.SuggestedRefundExpenseID == nil || *refundItem.SuggestedRefundExpenseID != ex.Data.ID {
		t.Fatalf("refund suggestion = %+v, want expense %d", refundItem.SuggestedRefundExpenseID, ex.Data.ID)
	}
	if cashback.SuggestedRefundExpenseID != nil {
		t.Fatalf("cashback got a refund suggestion: %d", *cashback.SuggestedRefundExpenseID)
	}

	rf := s.ConfirmImportItemAsRefund(ctx, refundItem.ID, ex.Data.ID, "2026-03", "45990")
	mustOK(t, "ConfirmImportItemAsRefund", rf.Error)
	wantMoney(t, "Mar gastos", monthly(t, s, "2026-03").Gastos, "0")
	if r := s.ConfirmImportItemAsRefund(ctx, refundItem.ID, ex.Data.ID, "2026-03", "1"); r.Error == nil || r.Error.Code != shared.ErrConflict {
		t.Fatalf("confirming twice = %+v, want CONFLICT", r.Error)
	}

	// Deleting the refund lets the credit go back to review.
	mustOK(t, "DeleteRefund", s.DeleteRefund(ctx, rf.Data.ID).Error)
	mustOK(t, "RestoreImportItem", s.RestoreImportItem(ctx, refundItem.ID).Error)
	pending := s.ListImportItems(ctx, ImportPendiente)
	mustOK(t, "ListImportItems", pending.Error)
	if len(pending.Data) != 2 {
		t.Fatalf("pending after reopening = %d items, want 2", len(pending.Data))
	}

	// A charge can never be confirmed as a refund.
	charge := s.StageImport(ctx, ImportBatch{Source: ImportSourcePDFAccount, Issuer: "itau", Items: []ImportCandidate{
		{Date: "2026-03-25", Description: "LIDER", Amount: "5000"},
	}})
	mustOK(t, "StageImport charge", charge.Error)
	for _, it := range s.ListImportItems(ctx, ImportPendiente).Data {
		if it.Description == "LIDER" {
			if r := s.ConfirmImportItemAsRefund(ctx, it.ID, ex.Data.ID, "2026-03", "5000"); r.Error == nil || r.Error.Code != shared.ErrValidation {
				t.Fatalf("charge as refund = %+v, want VALIDATION_ERROR", r.Error)
			}
		}
	}
}
