package finance

import (
	"testing"

	"github.com/gastonlarap-a11y/app-finance/backend/shared"
)

func accountsAt(t *testing.T, s *FinanceService, period string) *AccountsSummary {
	t.Helper()
	r := s.ListAccounts(t.Context(), period)
	mustOK(t, "ListAccounts", r.Error)
	return r.Data
}

func TestAccountsFollowTheirMovements(t *testing.T) {
	ctx := t.Context()
	s := newTestService(t)
	checking := s.CreateAccount(ctx, "Cuenta corriente", "corriente", "100000", "2030-01", true)
	mustOK(t, "CreateAccount", checking.Error)
	cash := s.CreateAccount(ctx, "Efectivo", "efectivo", "20000", "2030-01", false)
	mustOK(t, "CreateAccount", cash.Error)
	card := s.CreateCard(ctx, "Visa", "1000000", 24, "")
	mustOK(t, "CreateCard", card.Error)
	mustOK(t, "SetCardAccount", s.SetCardAccount(ctx, card.Data.ID, &checking.Data.ID).Error)

	mustOK(t, "SetSalary", s.SetSalary(ctx, "2030-01", "500000").Error)
	onCard := s.CreateExpense(ctx, "2030-01-05", "Super", "", "", &card.Data.ID, KindUnico, "80000", 1)
	mustOK(t, "CreateExpense", onCard.Error)
	lunch := s.CreateExpense(ctx, "2030-01-06", "Almuerzo", "", "", nil, KindUnico, "5000", 1)
	mustOK(t, "CreateExpense", lunch.Error)
	mustOK(t, "SetExpenseAccount", s.SetExpenseAccount(ctx, lunch.Data.ID, &cash.Data.ID).Error)
	bonus := s.CreateIncome(ctx, "2030-01", "Venta", "30000")
	mustOK(t, "CreateIncome", bonus.Error)
	mustOK(t, "SetIncomeAccount", s.SetIncomeAccount(ctx, bonus.Data.ID, &cash.Data.ID).Error)
	mustOK(t, "CreateExpense", s.CreateExpense(ctx, "2030-01-07", "Sin cuenta", "", "", nil, KindUnico, "1000", 1).Error)

	jan := accountsAt(t, s, "2030-01")
	byName := map[string]AccountView{}
	for _, a := range jan.Accounts {
		byName[a.Name] = a
	}
	// Checking: 100.000 + salary 500.000; the card's 80.000 leaves it when
	// January's statement is paid, in February.
	if a := byName["Cuenta corriente"]; a.Balance.String() != "600000" || a.Ingresos.String() != "500000" || !a.Gastos.IsZero() {
		t.Fatalf("checking = %+v", a)
	}
	// Cash: 20.000 + 30.000 − 5.000.
	if a := byName["Efectivo"]; a.Balance.String() != "45000" {
		t.Fatalf("cash = %+v", a)
	}
	if jan.UnassignedGastos.String() != "1000" || !jan.UnassignedIngreso.IsZero() {
		t.Fatalf("unassigned = %+v", jan)
	}
	// Balances carry into the next month, where the card is paid.
	if a := accountsAt(t, s, "2030-02").Accounts[0]; a.Balance.String() != "520000" || a.Gastos.String() != "80000" {
		t.Fatalf("february checking = %+v", a)
	}

	// Only one account receives the salary.
	mustOK(t, "UpdateAccount", s.UpdateAccount(ctx, cash.Data.ID, "Efectivo", "efectivo", "20000", "2030-01", true).Error)
	for _, a := range accountsAt(t, s, "2030-01").Accounts {
		if a.ReceivesSalary != (a.ID == cash.Data.ID) {
			t.Fatalf("salary account = %+v", a)
		}
	}
	mustOK(t, "DeleteAccount", s.DeleteAccount(ctx, cash.Data.ID).Error)
	if got := accountsAt(t, s, "2030-01"); len(got.Accounts) != 1 || got.UnassignedGastos.String() != "6000" {
		t.Fatalf("after deleting cash = %+v, want its expense unassigned", got)
	}

	for _, bad := range [][4]string{{"", "corriente", "0", "2030-01"}, {"X", "banco", "0", "2030-01"}, {"X", "vista", "abc", "2030-01"}, {"X", "vista", "0", "2030-1"}} {
		if r := s.CreateAccount(ctx, bad[0], bad[1], bad[2], bad[3], false); r.Error == nil || r.Error.Code != shared.ErrValidation {
			t.Fatalf("CreateAccount%v = %+v, want VALIDATION", bad, r.Error)
		}
	}
	missing := int64(999)
	if r := s.SetExpenseAccount(ctx, lunch.Data.ID, &missing); r.Error == nil || r.Error.Code != shared.ErrNotFound {
		t.Fatalf("unknown account = %+v, want NOT_FOUND", r.Error)
	}
}
