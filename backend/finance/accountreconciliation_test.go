package finance

import (
	"testing"

	"github.com/gastonlarap-a11y/app-finance/backend/shared"
)

func TestAccountReconciliationRestartsTheBalance(t *testing.T) {
	ctx := t.Context()
	s := newTestService(t)
	itau := s.CreateAccount(ctx, "Itaú", "corriente", "100000", "2026-07", true)
	mustOK(t, "itau", itau.Error)
	other := s.CreateAccount(ctx, "Otra", "vista", "5000", "2026-07", false)
	mustOK(t, "other", other.Error)
	for _, p := range []string{"2026-07", "2026-08", "2026-09"} {
		mustOK(t, "salary "+p, s.SetSalary(ctx, p, "1000000").Error)
	}
	monthSummary := monthly(t, s, "2026-09").Balance.String()

	// Computed: 100.000 + 1.000.000 a month. The bank says August closed at 1.950.000
	// (a fee nobody recorded).
	wantMoney(t, "before", accountByName(t, s, "2026-09", "Itaú").Balance, "3100000")
	mustOK(t, "reconcile", s.SetAccountReconciliation(ctx, itau.Data.ID, "2026-08", "1950000").Error)

	aug := accountByName(t, s, "2026-08", "Itaú")
	wantMoney(t, "august stays computed", aug.Balance, "2100000")
	if aug.Conciliacion == nil {
		t.Fatal("august is reconciled but has no status")
	}
	wantMoney(t, "real", aug.Conciliacion.SaldoReal, "1950000")
	wantMoney(t, "computed", aug.Conciliacion.Calculado, "2100000")
	wantMoney(t, "difference", aug.Conciliacion.Diferencia, "-150000")

	sep := accountByName(t, s, "2026-09", "Itaú")
	wantMoney(t, "september starts from the real close", sep.Balance, "2950000")
	if sep.Conciliacion != nil {
		t.Fatalf("september is not reconciled: %+v", sep.Conciliacion)
	}
	wantMoney(t, "other account untouched", accountByName(t, s, "2026-09", "Otra").Balance, "5000")
	// A view: the month's summary does not change.
	wantMoney(t, "month summary", monthly(t, s, "2026-09").Balance, monthSummary)

	// Saving again replaces it.
	mustOK(t, "replace", s.SetAccountReconciliation(ctx, itau.Data.ID, "2026-08", "2000000").Error)
	wantMoney(t, "replaced", accountByName(t, s, "2026-09", "Itaú").Balance, "3000000")

	mustOK(t, "delete", s.DeleteAccountReconciliation(ctx, itau.Data.ID, "2026-08").Error)
	wantMoney(t, "back to the opening", accountByName(t, s, "2026-09", "Itaú").Balance, "3100000")
	if r := s.DeleteAccountReconciliation(ctx, itau.Data.ID, "2026-08"); r.Error == nil || r.Error.Code != shared.ErrNotFound {
		t.Fatalf("deleting twice: %v, want not found", r.Error)
	}

	// Moving the opening after a reconciliation leaves it out.
	mustOK(t, "reconcile july", s.SetAccountReconciliation(ctx, itau.Data.ID, "2026-07", "0").Error)
	mustOK(t, "later opening", s.UpdateAccount(ctx, itau.Data.ID, "Itaú", "corriente", "500000", "2026-09", true).Error)
	wantMoney(t, "opening wins over an earlier close", accountByName(t, s, "2026-09", "Itaú").Balance, "1500000")

	// Deleting the account takes its reconciliations along.
	mustOK(t, "DeleteAccount", s.DeleteAccount(ctx, itau.Data.ID).Error)
	var n int
	if err := s.db.NewRaw("SELECT COUNT(*) FROM account_reconciliations").Scan(ctx, &n); err != nil || n != 0 {
		t.Fatalf("reconciliations after deleting the account = %d, %v", n, err)
	}
}

// The accounts' real closing balances, minus what the cards owed then, are the
// app's balance per the bank — once every account that counts is reconciled.
// A savings goal's account stays apart: its money is already Ahorro.
func TestAccountsClosing(t *testing.T) {
	ctx := t.Context()
	s := newTestService(t)
	itau := s.CreateAccount(ctx, "Itaú", "corriente", "1000000", "2026-08", false)
	mustOK(t, "itau", itau.Error)
	mp := s.CreateAccount(ctx, "Mercado Pago", "digital", "0", "2026-08", false)
	mustOK(t, "mp", mp.Error)
	ahorro := s.CreateAccount(ctx, "Cuenta de ahorro", "ahorro", "2000000", "2026-08", false)
	mustOK(t, "ahorro", ahorro.Error)
	later := s.CreateAccount(ctx, "Cuenta nueva", "vista", "0", "2026-10", false)
	mustOK(t, "later", later.Error)
	goal := s.CreateSavingsGoal(ctx, "Pie departamento", "9000000", "")
	mustOK(t, "goal", goal.Error)
	mustOK(t, "SetSavingsGoalAccount", s.SetSavingsGoalAccount(ctx, goal.Data.ID, &ahorro.Data.ID).Error)
	card := s.CreateCard(ctx, "Visa", "2000000", 24, "")
	mustOK(t, "card", card.Error)
	mustOK(t, "SetCardAccount", s.SetCardAccount(ctx, card.Data.ID, &itau.Data.ID).Error)
	mustOK(t, "card purchase", s.CreateExpense(ctx, "2026-08-10", "Zapatillas", "", "", &card.Data.ID, KindUnico, "100000", 1).Error)

	closing := func() *AccountsClosing {
		t.Helper()
		r := s.AccountsClosing(ctx, "2026-08")
		mustOK(t, "AccountsClosing", r.Error)
		return r.Data
	}
	// The savings account and the one opened later do not count.
	if c := closing(); c.Complete || len(c.Missing) != 2 || c.Missing[0] != "Itaú" || c.Missing[1] != "Mercado Pago" {
		t.Fatalf("before reconciling = %+v, want Itaú and Mercado Pago missing", c)
	}
	mustOK(t, "itau close", s.SetAccountReconciliation(ctx, itau.Data.ID, "2026-08", "990000").Error)
	mustOK(t, "mp close", s.SetAccountReconciliation(ctx, mp.Data.ID, "2026-08", "20000").Error)

	c := closing()
	if !c.Complete || len(c.Missing) != 0 {
		t.Fatalf("after reconciling = %+v, want complete", c)
	}
	wantMoney(t, "accounts", c.Accounts, "1010000")
	wantMoney(t, "cards owed (August's statement, paid in September)", c.CardsOwed, "100000")
	wantMoney(t, "total", c.Total, "910000")
	wantMoney(t, "saved apart", c.Saved, "2000000")

	wantCode(t, "a month that has not started", s.AccountsClosing(ctx, addMonths(currentPeriod(), 1)).Error, shared.ErrValidation)
	wantCode(t, "a bad period", s.AccountsClosing(ctx, "2026-13").Error, shared.ErrValidation)
}

func TestAccountReconciliationValidation(t *testing.T) {
	ctx := t.Context()
	s := newTestService(t)
	acc := s.CreateAccount(ctx, "Itaú", "corriente", "0", "2026-07", false)
	mustOK(t, "account", acc.Error)

	tests := []struct {
		name     string
		account  int64
		period   string
		balance  string
		wantCode string
	}{
		{"bad period", acc.Data.ID, "2026-13", "1000", shared.ErrValidation},
		{"future month", acc.Data.ID, addMonths(currentPeriod(), 1), "1000", shared.ErrValidation},
		{"before the opening", acc.Data.ID, "2026-06", "1000", shared.ErrValidation},
		{"not a number", acc.Data.ID, "2026-08", "mucho", shared.ErrValidation},
		{"unknown account", 9999, "2026-08", "1000", shared.ErrNotFound},
		{"overdraft", acc.Data.ID, "2026-08", "-25000", ""},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			res := s.SetAccountReconciliation(ctx, tc.account, tc.period, tc.balance)
			if tc.wantCode == "" {
				mustOK(t, "SetAccountReconciliation", res.Error)
				return
			}
			if res.Error == nil || res.Error.Code != tc.wantCode {
				t.Fatalf("error = %v, want %s", res.Error, tc.wantCode)
			}
		})
	}
}
