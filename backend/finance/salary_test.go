package finance

import (
	"testing"

	"github.com/gastonlarap-a11y/app-finance/backend/shared"
)

// A base salary counts every month it is in effect as expected, like a fixed
// expense does; a month's confirmed salary wins; and it reaches the month, the
// carried balance, the year, the forecast and the accounts alike.
func TestBaseSalaryIsExpectedEveryMonth(t *testing.T) {
	ctx := t.Context()
	s := newTestService(t)
	mustOK(t, "SetBaseSalary", s.SetBaseSalary(ctx, "2030-01", "1000000").Error)

	mar := monthly(t, s, "2030-03")
	wantMoney(t, "March salary", mar.Salary, "1000000")
	if !mar.SalaryExpected {
		t.Fatal("March salary not flagged as expected")
	}
	got := s.GetSalary(ctx, "2030-03")
	if got.Error != nil || got.Data.Amount.String() != "1000000" || !got.Data.Expected {
		t.Fatalf("GetSalary = %+v, want the expected 1.000.000", got)
	}
	wantMoney(t, "before the base", monthly(t, s, "2029-12").Salary, "0")

	// A confirmed salary wins for its month only.
	mustOK(t, "SetSalary", s.SetSalary(ctx, "2030-03", "1050000").Error)
	mar = monthly(t, s, "2030-03")
	if mar.Salary.String() != "1050000" || mar.SalaryExpected {
		t.Fatalf("March = %s expected=%v, want the confirmed 1.050.000", mar.Salary, mar.SalaryExpected)
	}
	wantMoney(t, "carried into April", monthly(t, s, "2030-04").Acumulado, "3050000")

	// From May there is no base salary: nothing expected.
	mustOK(t, "EndBaseSalary", s.EndBaseSalary(ctx, "2030-05").Error)
	wantMoney(t, "May salary", monthly(t, s, "2030-05").Salary, "0")
	year := s.YearSummary(ctx, 2030)
	mustOK(t, "YearSummary", year.Error)
	wantMoney(t, "2030 ingresos (Jan..Apr)", year.Data.TotalIngresos, "4050000")
	fc := s.CommitmentsForecast(ctx, "2030-04", 2)
	mustOK(t, "CommitmentsForecast", fc.Error)
	if fc.Data[0].Ingresos.String() != "1000000" || !fc.Data[0].IngresoEstimado {
		t.Fatalf("April forecast = %+v, want the expected base salary", fc.Data[0])
	}
	if !fc.Data[1].Ingresos.IsZero() {
		t.Fatalf("May forecast = %s, want nothing after the base salary ended", fc.Data[1].Ingresos)
	}

	// A new base salary takes over from its month; earlier months keep theirs.
	mustOK(t, "raise", s.SetBaseSalary(ctx, "2030-07", "1200000").Error)
	wantMoney(t, "June", monthly(t, s, "2030-06").Salary, "0")
	wantMoney(t, "July", monthly(t, s, "2030-07").Salary, "1200000")
	base := s.GetBaseSalary(ctx, "2030-08")
	if base.Error != nil || base.Data == nil || base.Data.Amount.String() != "1200000" || base.Data.EffectiveFrom != "2030-07" {
		t.Fatalf("GetBaseSalary = %+v, want 1.200.000 from 2030-07", base)
	}
	if none := s.GetBaseSalary(ctx, "2030-06"); none.Error != nil || none.Data != nil {
		t.Fatalf("GetBaseSalary in June = %+v, want none", none)
	}

	// Forgetting the confirmed salary brings the expected one back.
	mustOK(t, "DeleteSalary", s.DeleteSalary(ctx, "2030-03").Error)
	if mar := monthly(t, s, "2030-03"); mar.Salary.String() != "1000000" || !mar.SalaryExpected {
		t.Fatalf("March after DeleteSalary = %+v", mar.Salary)
	}
	wantCode(t, "DeleteSalary twice", s.DeleteSalary(ctx, "2030-03").Error, shared.ErrNotFound)
}

// The expected salary lands in the salary account, and a salary_rest transfer
// passes it on instead of moving nothing before the salary is confirmed.
func TestBaseSalaryFeedsTheAccounts(t *testing.T) {
	ctx := t.Context()
	s := newTestService(t)
	chile := s.CreateAccount(ctx, "Banco de Chile", "corriente", "0", "2030-01", true)
	mustOK(t, "chile", chile.Error)
	itau := s.CreateAccount(ctx, "Itaú", "corriente", "0", "2030-01", false)
	mustOK(t, "itau", itau.Error)
	mustOK(t, "rest", s.CreateTransfer(ctx, chile.Data.ID, itau.Data.ID, "Sueldo a Itaú", TransferSalaryRest, "470000", "2030-01", true).Error)
	mustOK(t, "SetBaseSalary", s.SetBaseSalary(ctx, "2030-01", "2300000").Error)

	c := accountByName(t, s, "2030-01", "Banco de Chile")
	wantMoney(t, "salary in", c.Ingresos, "2300000")
	wantMoney(t, "rest out", c.TransferOut, "1830000")
	wantMoney(t, "stays", c.Balance, "470000")
}

func TestBaseSalaryValidation(t *testing.T) {
	ctx := t.Context()
	s := newTestService(t)
	for _, tc := range []struct{ name, period, amount string }{
		{"bad period", "2030-13", "1000"},
		{"zero", "2030-01", "0"},
		{"negative", "2030-01", "-5"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			wantCode(t, "SetBaseSalary", s.SetBaseSalary(ctx, tc.period, tc.amount).Error, shared.ErrValidation)
		})
	}
	wantCode(t, "EndBaseSalary without one", s.EndBaseSalary(ctx, "2030-01").Error, shared.ErrValidation)
	wantCode(t, "GetBaseSalary bad period", s.GetBaseSalary(ctx, "2030-1").Error, shared.ErrValidation)
	wantCode(t, "DeleteSalary without one", s.DeleteSalary(ctx, "2030-01").Error, shared.ErrNotFound)
}
