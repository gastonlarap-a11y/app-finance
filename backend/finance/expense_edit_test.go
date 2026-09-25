package finance

import (
	"testing"

	"github.com/gastonlarap-a11y/app-finance/backend/shared"
)

// cuotaRow is one installment as the edit tests inspect it.
type cuotaRow struct {
	ID     int64  `bun:"id"`
	Number int    `bun:"number"`
	Total  int    `bun:"total"`
	Period string `bun:"period"`
	Amount string `bun:"amount"`
	Status string `bun:"status"`
	PaidAt string `bun:"paid_at"`
}

func cuotas(t *testing.T, s *FinanceService, expenseID int64) []cuotaRow {
	t.Helper()
	var rows []cuotaRow
	if err := s.db.NewRaw(
		"SELECT id, number, total, period, amount, status, COALESCE(paid_at, '') AS paid_at FROM installments WHERE expense_id = ? ORDER BY number",
		expenseID).Scan(t.Context(), &rows); err != nil {
		t.Fatalf("loading cuotas: %v", err)
	}
	return rows
}

func wantCode(t *testing.T, what string, err *shared.AppError, code string) {
	t.Helper()
	if err == nil || err.Code != code {
		t.Fatalf("%s error = %+v, want %s", what, err, code)
	}
}

// newPlan creates a 4-cuota cash expense billed 2026-07..2026-10.
func newPlan(t *testing.T, s *FinanceService) *Expense {
	t.Helper()
	r := s.CreateExpense(t.Context(), "2026-07-10", "Sofá", "Hogar", "", nil, KindCuotas, "25000", 4)
	mustOK(t, "CreateExpense", r.Error)
	return r.Data
}

func TestUpdateExpenseKeepsPaidCuotasAndIDs(t *testing.T) {
	ctx := t.Context()
	s := newTestService(t)
	ex := newPlan(t, s)
	before := cuotas(t, s, ex.ID)
	// Pay cuota 2 only: the old count-based replan would have marked cuota 1 instead.
	mustOK(t, "SetInstallmentPaid", s.SetInstallmentPaid(ctx, before[1].ID, true).Error)
	paid := cuotas(t, s, ex.ID)[1]

	r := s.UpdateExpense(ctx, ex.ID, "2026-07-10", "Sofá cama", "Hogar", "", nil, KindCuotas, "30000", 4)
	mustOK(t, "UpdateExpense", r.Error)

	after := cuotas(t, s, ex.ID)
	for i := range after {
		if after[i].ID != before[i].ID {
			t.Fatalf("cuota %d id %d -> %d, want stable ids", i+1, before[i].ID, after[i].ID)
		}
		if after[i].Period != before[i].Period {
			t.Fatalf("cuota %d moved %s -> %s", i+1, before[i].Period, after[i].Period)
		}
	}
	if after[1] != paid {
		t.Fatalf("paid cuota rewritten: %+v, want untouched %+v", after[1], paid)
	}
	for _, i := range []int{0, 2, 3} {
		if after[i].Status != StatusPendiente || after[i].Amount != "30000" {
			t.Fatalf("pending cuota %d = %+v, want pendiente at the new amount", i+1, after[i])
		}
	}
}

func TestUpdateExpenseKeepsStatementPlacement(t *testing.T) {
	ctx := t.Context()
	s := newTestService(t)
	ex := newPlan(t, s)
	// A card statement placed cuota 1 in 2026-05 (ConfirmImportItem's FirstPeriod),
	// not where the date and cutoff would put it.
	for i, p := range []string{"2026-05", "2026-06", "2026-07", "2026-08"} {
		if _, err := s.db.NewRaw("UPDATE installments SET period = ? WHERE expense_id = ? AND number = ?", p, ex.ID, i+1).Exec(ctx); err != nil {
			t.Fatalf("placing cuota %d: %v", i+1, err)
		}
	}

	// Same billing month (the day moves within July): placement is kept.
	mustOK(t, "UpdateExpense", s.UpdateExpense(ctx, ex.ID, "2026-07-12", "Sofá", "Casa", "", nil, KindCuotas, "25000", 4).Error)
	if got := cuotas(t, s, ex.ID)[0].Period; got != "2026-05" {
		t.Fatalf("cuota 1 period = %s, want the statement's 2026-05 kept", got)
	}

	// A date in another month re-places the plan (nothing is paid).
	mustOK(t, "UpdateExpense", s.UpdateExpense(ctx, ex.ID, "2026-09-01", "Sofá", "Casa", "", nil, KindCuotas, "25000", 4).Error)
	got := cuotas(t, s, ex.ID)
	if got[0].Period != "2026-09" || got[3].Period != "2026-12" {
		t.Fatalf("periods = %s..%s, want 2026-09..2026-12", got[0].Period, got[3].Period)
	}
}

func TestUpdateExpenseResizesPlan(t *testing.T) {
	ctx := t.Context()
	s := newTestService(t)
	ex := newPlan(t, s)
	first := cuotas(t, s, ex.ID)[0]
	mustOK(t, "SetInstallmentPaid", s.SetInstallmentPaid(ctx, first.ID, true).Error)

	mustOK(t, "grow", s.UpdateExpense(ctx, ex.ID, "2026-07-10", "Sofá", "", "", nil, KindCuotas, "25000", 6).Error)
	got := cuotas(t, s, ex.ID)
	if len(got) != 6 || got[5].Period != "2026-12" || got[5].Status != StatusPendiente || got[0].Total != 6 {
		t.Fatalf("after growing to 6: %+v", got)
	}

	mustOK(t, "shrink", s.UpdateExpense(ctx, ex.ID, "2026-07-10", "Sofá", "", "", nil, KindUnico, "25000", 1).Error)
	got = cuotas(t, s, ex.ID)
	if len(got) != 1 || got[0].ID != first.ID || got[0].Status != StatusPagado || got[0].Total != 1 {
		t.Fatalf("after shrinking to one payment: %+v, want only the paid cuota 1", got)
	}
}

func TestUpdateExpenseRefusesRewritingPaidCuotas(t *testing.T) {
	ctx := t.Context()
	s := newTestService(t)
	ex := newPlan(t, s)
	third := cuotas(t, s, ex.ID)[2]
	mustOK(t, "SetInstallmentPaid", s.SetInstallmentPaid(ctx, third.ID, true).Error)

	for _, tc := range []struct {
		name, date string
		total      int
	}{
		{name: "drop a paid cuota", date: "2026-07-10", total: 2},
		{name: "move a plan with paid cuotas", date: "2026-08-10", total: 4},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := s.UpdateExpense(ctx, ex.ID, tc.date, "Sofá", "", "", nil, KindCuotas, "25000", tc.total)
			wantCode(t, "UpdateExpense", r.Error, shared.ErrValidation)
			if got := cuotas(t, s, ex.ID); len(got) != 4 || got[2].Status != StatusPagado {
				t.Fatalf("plan changed by a refused edit: %+v", got)
			}
		})
	}
}

func TestEditsMayKeepATrashedCard(t *testing.T) {
	ctx := t.Context()
	s := newTestService(t)
	card := s.CreateCard(ctx, "Vieja", "500000", 20, "")
	mustOK(t, "CreateCard", card.Error)
	other := s.CreateCard(ctx, "Otra", "500000", 20, "")
	mustOK(t, "CreateCard", other.Error)
	ex := s.CreateExpense(ctx, "2026-07-05", "Zapatos", "", "", &card.Data.ID, KindUnico, "40000", 1)
	mustOK(t, "CreateExpense", ex.Error)
	fe := s.CreateFixedExpense(ctx, "Spotify", "", &card.Data.ID, "2026-07", "6000")
	mustOK(t, "CreateFixedExpense", fe.Error)
	mustOK(t, "DeleteCard", s.DeleteCard(ctx, card.Data.ID).Error)
	mustOK(t, "DeleteCard", s.DeleteCard(ctx, other.Data.ID).Error)

	mustOK(t, "UpdateExpense keeping the trashed card",
		s.UpdateExpense(ctx, ex.Data.ID, "2026-07-05", "Zapatillas", "", "", &card.Data.ID, KindUnico, "40000", 1).Error)
	mustOK(t, "UpdateFixedExpense keeping the trashed card",
		s.UpdateFixedExpense(ctx, fe.Data.ID, "Spotify Duo", "", &card.Data.ID).Error)

	wantCode(t, "UpdateExpense onto another trashed card",
		s.UpdateExpense(ctx, ex.Data.ID, "2026-07-05", "Zapatillas", "", "", &other.Data.ID, KindUnico, "40000", 1).Error,
		shared.ErrValidation)
	wantCode(t, "UpdateFixedExpense onto another trashed card",
		s.UpdateFixedExpense(ctx, fe.Data.ID, "Spotify Duo", "", &other.Data.ID).Error, shared.ErrValidation)
	wantCode(t, "CreateExpense on a trashed card",
		s.CreateExpense(ctx, "2026-07-05", "Polera", "", "", &card.Data.ID, KindUnico, "9000", 1).Error, shared.ErrValidation)
}

func TestFixedExpenseMonthsMustBeActive(t *testing.T) {
	ctx := t.Context()
	s := newTestService(t)
	fe := s.CreateFixedExpense(ctx, "Gimnasio", "", nil, "2026-03", "30000")
	mustOK(t, "CreateFixedExpense", fe.Error)
	id := fe.Data.ID

	wantCode(t, "EndFixedExpense at its first month", s.EndFixedExpense(ctx, id, "2026-03").Error, shared.ErrValidation)
	wantCode(t, "EndFixedExpense before it starts", s.EndFixedExpense(ctx, id, "2026-01").Error, shared.ErrValidation)
	mustOK(t, "EndFixedExpense", s.EndFixedExpense(ctx, id, "2026-07").Error) // last billed month: 2026-06

	for _, tc := range []struct{ name, period string }{
		{"before start", "2026-02"},
		{"after end", "2026-07"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			wantCode(t, "SetFixedExpensePaid", s.SetFixedExpensePaid(ctx, id, tc.period, true).Error, shared.ErrValidation)
			wantCode(t, "SetFixedExpenseAmount", s.SetFixedExpenseAmount(ctx, id, tc.period, "35000").Error, shared.ErrValidation)
			mustOK(t, "unmarking is always allowed", s.SetFixedExpensePaid(ctx, id, tc.period, false).Error)
		})
	}
	mustOK(t, "SetFixedExpensePaid inside", s.SetFixedExpensePaid(ctx, id, "2026-06", true).Error)
	mustOK(t, "SetFixedExpenseAmount inside", s.SetFixedExpenseAmount(ctx, id, "2026-05", "35000").Error)
}

func TestChildrenOfTrashedParentsAreFrozen(t *testing.T) {
	ctx := t.Context()
	s := newTestService(t)
	ex := newPlan(t, s)
	cuota := cuotas(t, s, ex.ID)[0]
	mustOK(t, "DeleteExpense", s.DeleteExpense(ctx, ex.ID).Error)
	wantCode(t, "SetInstallmentPaid on a trashed expense", s.SetInstallmentPaid(ctx, cuota.ID, true).Error, shared.ErrNotFound)
	mustOK(t, "RestoreExpense", s.RestoreExpense(ctx, ex.ID).Error)
	mustOK(t, "SetInstallmentPaid after restore", s.SetInstallmentPaid(ctx, cuota.ID, true).Error)

	g := s.CreateSavingsGoal(ctx, "Viaje", "500000", "")
	mustOK(t, "CreateSavingsGoal", g.Error)
	c := s.AddSavingsContribution(ctx, g.Data.ID, "2026-07", "50000")
	mustOK(t, "AddSavingsContribution", c.Error)
	mustOK(t, "DeleteSavingsGoal", s.DeleteSavingsGoal(ctx, g.Data.ID).Error)
	wantCode(t, "DeleteSavingsContribution of a trashed goal", s.DeleteSavingsContribution(ctx, c.Data.ID).Error, shared.ErrNotFound)
}

func TestInputRanges(t *testing.T) {
	ctx := t.Context()
	s := newTestService(t)
	for _, tc := range []struct {
		name, date string
		total      int
	}{
		{"year before 2000", "1999-12-31", 1},
		{"year after 2099", "2100-01-01", 1},
		{"typo year 0226", "0226-07-01", 1},
		{"more than 120 cuotas", "2026-07-01", maxInstallments + 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := s.CreateExpense(ctx, tc.date, "x", "", "", nil, KindCuotas, "1000", tc.total)
			wantCode(t, "CreateExpense", r.Error, shared.ErrValidation)
		})
	}
	mustOK(t, "120 cuotas", s.CreateExpense(ctx, "2099-12-01", "x", "", "", nil, KindCuotas, "1000", maxInstallments).Error)
	wantCode(t, "MonthlySummary out of range", s.MonthlySummary(ctx, "1999-12").Error, shared.ErrValidation)
}
