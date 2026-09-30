package finance

import (
	"testing"

	"github.com/gastonlarap-a11y/app-finance/backend/shared"
)

func accountByName(t *testing.T, s *FinanceService, period, name string) AccountView {
	t.Helper()
	res := s.ListAccounts(t.Context(), period)
	mustOK(t, "ListAccounts", res.Error)
	for _, a := range res.Data.Accounts {
		if a.Name == name {
			return a
		}
	}
	t.Fatalf("account %q not listed", name)
	return AccountView{}
}

func TestTransfersMoveBalancesNotTotals(t *testing.T) {
	ctx := t.Context()
	s := newTestService(t)
	chile := s.CreateAccount(ctx, "Banco de Chile", "corriente", "0", "2026-07", true)
	mustOK(t, "chile", chile.Error)
	itau := s.CreateAccount(ctx, "Itaú", "corriente", "0", "2026-07", false)
	mustOK(t, "itau", itau.Error)
	mp := s.CreateAccount(ctx, "Mercado Pago", "digital", "0", "2026-07", false)
	mustOK(t, "mercado pago", mp.Error)
	for _, p := range []string{"2026-07", "2026-08", "2026-09"} {
		mustOK(t, "salary "+p, s.SetSalary(ctx, p, "2000000").Error)
	}

	salaryMove := s.CreateTransfer(ctx, chile.Data.ID, itau.Data.ID, "Sueldo a Itaú", TransferFixed, "1500000", "2026-08", true)
	mustOK(t, "monthly", salaryMove.Error)
	once := s.CreateTransfer(ctx, itau.Data.ID, mp.Data.ID, "Carga", TransferFixed, "50000", "2026-09", false)
	mustOK(t, "once", once.Error)
	if once.Data.EndPeriod != "2026-09" || salaryMove.Data.EndPeriod != "" {
		t.Fatalf("end periods = %q / %q, want 2026-09 / \"\"", once.Data.EndPeriod, salaryMove.Data.EndPeriod)
	}

	tests := []struct {
		period, account, balance, transferIn, transferOut string
	}{
		{"2026-07", "Banco de Chile", "2000000", "0", "0"}, // before the monthly transfer starts
		{"2026-08", "Banco de Chile", "2500000", "0", "1500000"},
		{"2026-08", "Itaú", "1500000", "1500000", "0"},
		{"2026-09", "Banco de Chile", "3000000", "0", "1500000"},
		{"2026-09", "Itaú", "2950000", "1500000", "50000"},
		{"2026-09", "Mercado Pago", "50000", "50000", "0"},
	}
	for _, tc := range tests {
		t.Run(tc.period+" "+tc.account, func(t *testing.T) {
			a := accountByName(t, s, tc.period, tc.account)
			wantMoney(t, "balance", a.Balance, tc.balance)
			wantMoney(t, "transferIn", a.TransferIn, tc.transferIn)
			wantMoney(t, "transferOut", a.TransferOut, tc.transferOut)
			wantMoney(t, "gastos", a.Gastos, "0") // a transfer is not spending
		})
	}
	// The app's balance ignores transfers: no money left the household. It is the
	// three salaries carried month to month, as without any transfer.
	wantMoney(t, "september balance", monthly(t, s, "2026-09").Balance, "6000000")

	// Ending the monthly transfer keeps its past months.
	mustOK(t, "EndTransfer", s.EndTransfer(ctx, salaryMove.Data.ID, "2026-08").Error)
	wantMoney(t, "itau after end", accountByName(t, s, "2026-09", "Itaú").Balance, "1450000")
	if r := s.EndTransfer(ctx, salaryMove.Data.ID, "2026-07"); r.Error == nil || r.Error.Code != shared.ErrNotFound {
		t.Fatalf("ending before its start: %v, want not found", r.Error)
	}

	mustOK(t, "UpdateTransfer", s.UpdateTransfer(ctx, once.Data.ID, itau.Data.ID, mp.Data.ID, "Carga MP", TransferFixed, "80000").Error)
	wantMoney(t, "mp after update", accountByName(t, s, "2026-09", "Mercado Pago").Balance, "80000")

	mustOK(t, "DeleteTransfer", s.DeleteTransfer(ctx, once.Data.ID).Error)
	list, err := s.ListTransfers(ctx)
	if err != nil || len(list) != 1 {
		t.Fatalf("ListTransfers = %+v, %v; want the monthly one", list, err)
	}
	// An account a transfer still moves money for is not deleted.
	wantCode(t, "DeleteAccount with a transfer", s.DeleteAccount(ctx, itau.Data.ID).Error, shared.ErrConflict)
	if list, _ := s.ListTransfers(ctx); len(list) != 1 {
		t.Fatalf("transfers after a refused delete = %+v, want the monthly one kept", list)
	}
}

func TestTransferValidation(t *testing.T) {
	ctx := t.Context()
	s := newTestService(t)
	a := s.CreateAccount(ctx, "A", "corriente", "0", "2026-09", false)
	mustOK(t, "a", a.Error)
	b := s.CreateAccount(ctx, "B", "vista", "0", "2026-09", false)
	mustOK(t, "b", b.Error)
	salary := s.CreateAccount(ctx, "Sueldo", "corriente", "0", "2026-09", true)
	mustOK(t, "salary account", salary.Error)

	tests := []struct {
		name     string
		from, to int64
		mode     string
		amount   string
		period   string
		wantCode string
	}{
		{"same account", a.Data.ID, a.Data.ID, TransferFixed, "1000", "2026-09", shared.ErrValidation},
		{"zero amount", a.Data.ID, b.Data.ID, TransferFixed, "0", "2026-09", shared.ErrValidation},
		{"negative amount", a.Data.ID, b.Data.ID, TransferFixed, "-5", "2026-09", shared.ErrValidation},
		{"not a number", a.Data.ID, b.Data.ID, TransferFixed, "mucho", "2026-09", shared.ErrValidation},
		{"bad period", a.Data.ID, b.Data.ID, TransferFixed, "1000", "2026-13", shared.ErrValidation},
		{"unknown account", a.Data.ID, 9999, TransferFixed, "1000", "2026-09", shared.ErrNotFound},
		{"unknown mode", a.Data.ID, b.Data.ID, "percent", "1000", "2026-09", shared.ErrValidation},
		{"salary rest not from the salary account", a.Data.ID, b.Data.ID, TransferSalaryRest, "1000", "2026-09", shared.ErrValidation},
		{"salary rest keeping a negative amount", salary.Data.ID, b.Data.ID, TransferSalaryRest, "-1", "2026-09", shared.ErrValidation},
		{"salary rest keeping nothing", salary.Data.ID, b.Data.ID, TransferSalaryRest, "0", "2026-09", ""},
		{"valid", a.Data.ID, b.Data.ID, TransferFixed, "1000", "2026-09", ""},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			res := s.CreateTransfer(ctx, tc.from, tc.to, "", tc.mode, tc.amount, tc.period, false)
			if tc.wantCode == "" {
				mustOK(t, "CreateTransfer", res.Error)
				return
			}
			if res.Error == nil || res.Error.Code != tc.wantCode {
				t.Fatalf("error = %v, want %s", res.Error, tc.wantCode)
			}
		})
	}
}

// The salary lands in Banco de Chile and all of it but the mortgage goes on to
// Itaú, whatever the salary is each month.
func TestSalaryRestTransferFollowsTheSalary(t *testing.T) {
	ctx := t.Context()
	s := newTestService(t)
	chile := s.CreateAccount(ctx, "Banco de Chile", "corriente", "0", "2026-09", true)
	mustOK(t, "chile", chile.Error)
	itau := s.CreateAccount(ctx, "Itaú", "corriente", "0", "2026-09", false)
	mustOK(t, "itau", itau.Error)
	mustOK(t, "september salary", s.SetSalary(ctx, "2026-09", "2300000").Error)
	mustOK(t, "october salary", s.SetSalary(ctx, "2026-10", "2550000").Error)
	mustOK(t, "tiny salary", s.SetSalary(ctx, "2026-12", "300000").Error)

	rest := s.CreateTransfer(ctx, chile.Data.ID, itau.Data.ID, "Sueldo a Itaú", TransferSalaryRest, "470000", "2026-09", true)
	mustOK(t, "salary rest", rest.Error)
	if rest.Data.Mode != TransferSalaryRest {
		t.Fatalf("mode = %q, want %q", rest.Data.Mode, TransferSalaryRest)
	}

	tests := []struct {
		period, moved, chileBalance string
	}{
		{"2026-09", "1830000", "470000"},
		{"2026-10", "2080000", "940000"},
		{"2026-11", "0", "940000"},  // no salary yet: nothing moves
		{"2026-12", "0", "1240000"}, // a salary below what stays: nothing moves, never less
	}
	for _, tc := range tests {
		t.Run(tc.period, func(t *testing.T) {
			wantMoney(t, "itau in", accountByName(t, s, tc.period, "Itaú").TransferIn, tc.moved)
			c := accountByName(t, s, tc.period, "Banco de Chile")
			wantMoney(t, "chile out", c.TransferOut, tc.moved)
			wantMoney(t, "chile balance", c.Balance, tc.chileBalance)
		})
	}

	// Back to a fixed amount.
	mustOK(t, "UpdateTransfer", s.UpdateTransfer(ctx, rest.Data.ID, chile.Data.ID, itau.Data.ID, "Sueldo a Itaú", TransferFixed, "2000000").Error)
	wantMoney(t, "fixed again", accountByName(t, s, "2026-11", "Itaú").TransferIn, "2000000")
}

// A live salary_rest transfer pins where the salary lands: moving or clearing
// «recibe el sueldo» would leave it passing on a salary that lands elsewhere.
func TestSalaryAccountStaysUnderALiveSalaryRestTransfer(t *testing.T) {
	ctx := t.Context()
	s := newTestService(t)
	chile := s.CreateAccount(ctx, "Banco de Chile", "corriente", "0", "2020-01", true)
	mustOK(t, "chile", chile.Error)
	itau := s.CreateAccount(ctx, "Itaú", "corriente", "0", "2020-01", false)
	mustOK(t, "itau", itau.Error)
	rest := s.CreateTransfer(ctx, chile.Data.ID, itau.Data.ID, "Sueldo a Itaú", TransferSalaryRest, "470000", "2020-01", true)
	mustOK(t, "salary rest", rest.Error)

	wantCode(t, "salary moved to Itaú",
		s.UpdateAccount(ctx, itau.Data.ID, "Itaú", "corriente", "0", "2020-01", true).Error, shared.ErrConflict)
	wantCode(t, "salary cleared",
		s.UpdateAccount(ctx, chile.Data.ID, "Banco de Chile", "corriente", "0", "2020-01", false).Error, shared.ErrConflict)
	wantCode(t, "a new salary account",
		s.CreateAccount(ctx, "Cuenta RUT", "vista", "0", "2020-01", true).Error, shared.ErrConflict)
	mustOK(t, "rename keeping the salary",
		s.UpdateAccount(ctx, chile.Data.ID, "Chile", "corriente", "0", "2020-01", true).Error)
	if a := accountByName(t, s, "2020-01", "Chile"); !a.ReceivesSalary {
		t.Fatal("a refused edit moved the salary")
	}

	// Once the transfer has ended, the salary may land elsewhere.
	mustOK(t, "EndTransfer", s.EndTransfer(ctx, rest.Data.ID, "2020-06").Error)
	mustOK(t, "salary moved to Itaú",
		s.UpdateAccount(ctx, itau.Data.ID, "Itaú", "corriente", "0", "2020-01", true).Error)
	if a := accountByName(t, s, "2020-01", "Chile"); a.ReceivesSalary {
		t.Fatal("two accounts receive the salary")
	}
}

func TestDigitalAccountKind(t *testing.T) {
	s := newTestService(t)
	mustOK(t, "digital", s.CreateAccount(t.Context(), "Mercado Pago", "digital", "0", "2026-09", false).Error)
	if r := s.CreateAccount(t.Context(), "X", "prepago", "0", "2026-09", false); r.Error == nil {
		t.Fatal("an unknown account kind was accepted")
	}
}

func TestFixedExpenseAccountWinsOverCard(t *testing.T) {
	ctx := t.Context()
	s := newTestService(t)
	chile := s.CreateAccount(ctx, "Banco de Chile", "corriente", "0", "2026-09", false)
	mustOK(t, "chile", chile.Error)
	itau := s.CreateAccount(ctx, "Itaú", "corriente", "0", "2026-09", false)
	mustOK(t, "itau", itau.Error)
	card := s.CreateCard(ctx, "Visa", "1000000", 24, "")
	mustOK(t, "card", card.Error)
	mustOK(t, "card account", s.SetCardAccount(ctx, card.Data.ID, &itau.Data.ID).Error)

	mortgage := s.CreateFixedExpense(ctx, "Dividendo", "Vivienda", nil, "2026-09", "600000", 1, CurrencyCLP)
	mustOK(t, "mortgage", mortgage.Error)
	netflix := s.CreateFixedExpense(ctx, "Netflix", "Suscripciones", &card.Data.ID, "2026-09", "9000", 1, CurrencyCLP)
	mustOK(t, "netflix", netflix.Error)

	// A fixed charge on the card leaves the account when the card is paid: September's
	// Netflix in October, next to October's mortgage.
	mustOK(t, "SetFixedExpenseAccount", s.SetFixedExpenseAccount(ctx, mortgage.Data.ID, &chile.Data.ID).Error)
	wantMoney(t, "chile pays the mortgage", accountByName(t, s, "2026-10", "Banco de Chile").Gastos, "600000")
	wantMoney(t, "itau pays the card's fixed", accountByName(t, s, "2026-10", "Itaú").Gastos, "9000")

	// Its own account wins over its card's.
	mustOK(t, "netflix from chile", s.SetFixedExpenseAccount(ctx, netflix.Data.ID, &chile.Data.ID).Error)
	wantMoney(t, "chile pays both", accountByName(t, s, "2026-10", "Banco de Chile").Gastos, "609000")
	// Editing the fixed expense keeps its account.
	mustOK(t, "UpdateFixedExpense", s.UpdateFixedExpense(ctx, mortgage.Data.ID, "Dividendo casa", "Vivienda", nil).Error)
	wantMoney(t, "still chile", accountByName(t, s, "2026-10", "Banco de Chile").Gastos, "609000")

	if r := s.SetFixedExpenseAccount(ctx, mortgage.Data.ID, new(int64(9999))); r.Error == nil || r.Error.Code != shared.ErrNotFound {
		t.Fatalf("unknown account: %v, want not found", r.Error)
	}
}
