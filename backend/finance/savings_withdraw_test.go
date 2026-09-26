package finance

import (
	"testing"

	"github.com/gastonlarap-a11y/app-finance/backend/shared"
)

func TestSavingsWithdrawalGivesTheMoneyBack(t *testing.T) {
	ctx := t.Context()
	s := newTestService(t)
	goal := s.CreateSavingsGoal(ctx, "Viaje", "500000", "2026-06")
	mustOK(t, "CreateSavingsGoal", goal.Error)
	id := goal.Data.ID
	jan := s.AddSavingsContribution(ctx, id, "2026-01", "200000")
	mustOK(t, "contribute Jan", jan.Error)
	mustOK(t, "contribute Feb", s.AddSavingsContribution(ctx, id, "2026-02", "100000").Error)

	w := s.WithdrawSavings(ctx, id, "2026-03", "150000")
	mustOK(t, "WithdrawSavings", w.Error)
	wantMoney(t, "withdrawal row", w.Data.Amount, "-150000")
	mar := monthly(t, s, "2026-03")
	wantMoney(t, "Mar ahorro", mar.Ahorro, "-150000")
	wantMoney(t, "Mar balance", mar.Balance, "-150000") // carried −300.000, the withdrawal returns 150.000
	wantMoney(t, "carried into Apr", monthly(t, s, "2026-04").Acumulado, "-150000")
	year := s.YearSummary(ctx, 2026)
	mustOK(t, "YearSummary", year.Error)
	wantMoney(t, "year ahorro", year.Data.TotalAhorro, "150000")

	if r := s.WithdrawSavings(ctx, id, "2026-03", "150001"); r.Error == nil || r.Error.Code != shared.ErrValidation {
		t.Fatalf("withdrawing more than saved = %+v, want VALIDATION_ERROR", r.Error)
	}
	if r := s.WithdrawSavings(ctx, id, "2026-03", "0"); r.Error == nil || r.Error.Code != shared.ErrValidation {
		t.Fatalf("zero withdrawal = %+v, want VALIDATION_ERROR", r.Error)
	}

	// Past its target month and still short, the goal is overdue.
	for _, tt := range []struct {
		now     string
		overdue bool
	}{{"2026-05", false}, {"2026-06", false}, {"2026-07", true}} {
		goals, err := s.listSavingsGoals(ctx, s.uid(), tt.now)
		if err != nil || len(goals) != 1 {
			t.Fatalf("listSavingsGoals(%s) = %+v (err %v)", tt.now, goals, err)
		}
		wantMoney(t, "saved", goals[0].Saved, "150000")
		if goals[0].Overdue != tt.overdue {
			t.Fatalf("overdue at %s = %v, want %v", tt.now, goals[0].Overdue, tt.overdue)
		}
	}

	// Deleting the January contribution would leave the goal below zero.
	if r := s.DeleteSavingsContribution(ctx, jan.Data.ID); r.Error == nil || r.Error.Code != shared.ErrConflict {
		t.Fatalf("delete leaving the goal negative = %+v, want CONFLICT", r.Error)
	}
	mustOK(t, "delete the withdrawal", s.DeleteSavingsContribution(ctx, w.Data.ID).Error)
	mustOK(t, "then the contribution", s.DeleteSavingsContribution(ctx, jan.Data.ID).Error)

	// A goal in the trash takes no withdrawals.
	mustOK(t, "DeleteSavingsGoal", s.DeleteSavingsGoal(ctx, id).Error)
	if r := s.WithdrawSavings(ctx, id, "2026-03", "1"); r.Error == nil || r.Error.Code != shared.ErrNotFound {
		t.Fatalf("withdraw from a trashed goal = %+v, want NOT_FOUND", r.Error)
	}
}

func TestReachedGoalIsNotOverdue(t *testing.T) {
	ctx := t.Context()
	s := newTestService(t)
	goal := s.CreateSavingsGoal(ctx, "Bici", "100000", "2026-02")
	mustOK(t, "CreateSavingsGoal", goal.Error)
	mustOK(t, "contribute", s.AddSavingsContribution(ctx, goal.Data.ID, "2026-01", "100000").Error)
	goals, err := s.listSavingsGoals(ctx, s.uid(), "2026-09")
	if err != nil || len(goals) != 1 || goals[0].Overdue {
		t.Fatalf("reached goal = %+v (err %v), want not overdue", goals, err)
	}
}
