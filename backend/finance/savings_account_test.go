package finance

import (
	"testing"

	"github.com/gastonlarap-a11y/app-finance/backend/shared"
)

// A goal that follows a savings account holds that account's balance, and the
// money transferred into it each month is that month's Ahorro — in the month,
// the carried balance, the year and the forecast alike.
func TestGoalFollowingASavingsAccount(t *testing.T) {
	ctx := t.Context()
	s := newTestService(t)
	itau := s.CreateAccount(ctx, "Itaú", "corriente", "1000000", "2026-09", false)
	mustOK(t, "itau", itau.Error)
	ahorro := s.CreateAccount(ctx, "Cuenta de ahorro", "ahorro", "2000000", "2026-09", false)
	mustOK(t, "ahorro", ahorro.Error)
	mustOK(t, "monthly saving", s.CreateTransfer(ctx, itau.Data.ID, ahorro.Data.ID, "Ahorro mensual", TransferFixed, "150000", "2026-09", true).Error)
	for _, p := range []string{"2026-09", "2026-10"} {
		mustOK(t, "SetSalary "+p, s.SetSalary(ctx, p, "1500000").Error)
	}
	goal := s.CreateSavingsGoal(ctx, "Fondo de emergencia", "5000000", "")
	mustOK(t, "CreateSavingsGoal", goal.Error)

	// Unlinked, a transfer between own accounts is neither spending nor saving.
	wantMoney(t, "September Ahorro unlinked", monthly(t, s, "2026-09").Ahorro, "0")

	mustOK(t, "SetSavingsGoalAccount", s.SetSavingsGoalAccount(ctx, goal.Data.ID, &ahorro.Data.ID).Error)
	sep := monthly(t, s, "2026-09")
	wantMoney(t, "September Ahorro", sep.Ahorro, "150000")
	wantMoney(t, "September Balance", sep.Balance, "1350000")
	wantMoney(t, "October carried", monthly(t, s, "2026-10").Acumulado, "1350000")
	year := s.YearSummary(ctx, 2026)
	mustOK(t, "YearSummary", year.Error)
	wantMoney(t, "2026 Ahorro (Sep..Dec)", year.Data.TotalAhorro, "600000")
	fc := s.CommitmentsForecast(ctx, "2026-11", 2)
	mustOK(t, "CommitmentsForecast", fc.Error)
	wantMoney(t, "forecast Ahorro", fc.Data[1].Ahorro, "150000")
	// The accounts themselves do not change: the transfer already moved them.
	wantMoney(t, "Itaú in October", accountByName(t, s, "2026-10", "Itaú").Balance, "700000")

	goals, err := s.listSavingsGoals(ctx, s.uid(), "2026-10")
	if err != nil || len(goals) != 1 {
		t.Fatalf("listSavingsGoals = %+v (err %v)", goals, err)
	}
	wantMoney(t, "saved = the account's balance", goals[0].Saved, "2300000")
	wantMoney(t, "remaining", goals[0].Remaining, "2700000")

	// Money taken back out of the account lowers that month's Ahorro.
	mustOK(t, "withdrawal", s.CreateTransfer(ctx, ahorro.Data.ID, itau.Data.ID, "Imprevisto", TransferFixed, "100000", "2026-10", false).Error)
	wantMoney(t, "October Ahorro net", monthly(t, s, "2026-10").Ahorro, "50000")

	// A goal that follows an account takes no contributions by hand.
	wantCode(t, "AddSavingsContribution", s.AddSavingsContribution(ctx, goal.Data.ID, "2026-10", "1000").Error, shared.ErrValidation)
	wantCode(t, "WithdrawSavings", s.WithdrawSavings(ctx, goal.Data.ID, "2026-10", "1000").Error, shared.ErrValidation)

	// Trashed, its transfers stop counting as Ahorro, like a trashed goal's contributions.
	mustOK(t, "DeleteSavingsGoal", s.DeleteSavingsGoal(ctx, goal.Data.ID).Error)
	wantMoney(t, "September Ahorro, goal trashed", monthly(t, s, "2026-09").Ahorro, "0")
	other := s.CreateSavingsGoal(ctx, "Viaje", "1000000", "")
	mustOK(t, "other goal", other.Error)
	mustOK(t, "the account backs the other goal", s.SetSavingsGoalAccount(ctx, other.Data.ID, &ahorro.Data.ID).Error)
	wantCode(t, "RestoreSavingsGoal onto a taken account", s.RestoreSavingsGoal(ctx, goal.Data.ID).Error, shared.ErrConflict)

	// Back to contributions by hand.
	mustOK(t, "unlink", s.SetSavingsGoalAccount(ctx, other.Data.ID, nil).Error)
	wantMoney(t, "September Ahorro unlinked again", monthly(t, s, "2026-09").Ahorro, "0")
	mustOK(t, "RestoreSavingsGoal", s.RestoreSavingsGoal(ctx, goal.Data.ID).Error)
	wantMoney(t, "September Ahorro restored", monthly(t, s, "2026-09").Ahorro, "150000")
}

func TestSetSavingsGoalAccountValidation(t *testing.T) {
	ctx := t.Context()
	s := newTestService(t)
	acc := s.CreateAccount(ctx, "Ahorro", "ahorro", "0", "2026-09", false)
	mustOK(t, "CreateAccount", acc.Error)
	byHand := s.CreateSavingsGoal(ctx, "Auto", "3000000", "")
	mustOK(t, "CreateSavingsGoal", byHand.Error)
	mustOK(t, "AddSavingsContribution", s.AddSavingsContribution(ctx, byHand.Data.ID, "2026-09", "50000").Error)
	linked := s.CreateSavingsGoal(ctx, "Casa", "9000000", "")
	mustOK(t, "CreateSavingsGoal", linked.Error)
	mustOK(t, "link", s.SetSavingsGoalAccount(ctx, linked.Data.ID, &acc.Data.ID).Error)
	fresh := s.CreateSavingsGoal(ctx, "Viaje", "1000000", "")
	mustOK(t, "CreateSavingsGoal", fresh.Error)

	missing := int64(999)
	for _, tc := range []struct {
		name    string
		goal    int64
		account *int64
		code    string
	}{
		{"a goal with contributions by hand", byHand.Data.ID, &acc.Data.ID, shared.ErrConflict},
		{"an account that backs another goal", fresh.Data.ID, &acc.Data.ID, shared.ErrConflict},
		{"an unknown account", linked.Data.ID, &missing, shared.ErrNotFound},
		{"an unknown goal", missing, &acc.Data.ID, shared.ErrNotFound},
	} {
		t.Run(tc.name, func(t *testing.T) {
			wantCode(t, "SetSavingsGoalAccount", s.SetSavingsGoalAccount(ctx, tc.goal, tc.account).Error, tc.code)
		})
	}
}
