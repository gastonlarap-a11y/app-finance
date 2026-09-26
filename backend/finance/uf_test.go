package finance

import (
	"slices"
	"testing"

	"github.com/gastonlarap-a11y/app-finance/backend/shared"
)

func fixedAmountIn(t *testing.T, s *FinanceService, period string, id int64) (*Movimiento, bool) {
	t.Helper()
	for _, mv := range monthly(t, s, period).Movimientos {
		if mv.FixedID != nil && *mv.FixedID == id {
			return &mv, true
		}
	}
	return nil, false
}

func TestQuarterlyFixedExpenseBillsOnItsSchedule(t *testing.T) {
	ctx := t.Context()
	s := newTestService(t)
	fe := s.CreateFixedExpense(ctx, "Seguro auto", "Auto", nil, "2026-01", "90000", 3, CurrencyCLP)
	mustOK(t, "CreateFixedExpense", fe.Error)
	id := fe.Data.ID

	for _, tt := range []struct {
		period string
		bills  bool
	}{{"2026-01", true}, {"2026-02", false}, {"2026-03", false}, {"2026-04", true}, {"2026-07", true}} {
		mv, ok := fixedAmountIn(t, s, tt.period, id)
		if ok != tt.bills {
			t.Fatalf("%s billed = %v, want %v", tt.period, ok, tt.bills)
		}
		if ok {
			wantMoney(t, tt.period+" amount", mv.Amount, "90000")
		}
	}

	year := s.YearSummary(ctx, 2026)
	mustOK(t, "YearSummary", year.Error)
	wantMoney(t, "year gastos", year.Data.TotalGastos, "360000") // Jan, Apr, Jul, Oct
	wantMoney(t, "Feb gastos", year.Data.Months[1].Gastos, "0")
	// The carried balance counts the same four charges.
	wantMoney(t, "carried into 2027", monthly(t, s, "2027-01").Acumulado, "-360000")

	fc := s.CommitmentsForecast(ctx, "2026-03", 2)
	mustOK(t, "CommitmentsForecast", fc.Error)
	wantMoney(t, "forecast Mar fijos", fc.Data[0].Fijos, "0")
	wantMoney(t, "forecast Apr fijos", fc.Data[1].Fijos, "90000")

	if r := s.SetFixedExpensePaid(ctx, id, "2026-02", true); r.Error == nil || r.Error.Code != shared.ErrValidation {
		t.Fatalf("paying an off-schedule month = %+v, want VALIDATION_ERROR", r.Error)
	}
	mustOK(t, "SetFixedExpensePaid Apr", s.SetFixedExpensePaid(ctx, id, "2026-04", true).Error)
}

func TestNextBilling(t *testing.T) {
	yearly := FixedExpense{StartPeriod: "2026-03", IntervalMonths: 12}
	quarterly := FixedExpense{StartPeriod: "2026-01", IntervalMonths: 3, EndPeriod: "2026-06"}
	tests := []struct {
		name string
		fe   FixedExpense
		from string
		want string
	}{
		{"before the start", yearly, "2025-01", "2026-03"},
		{"on a billing month", yearly, "2027-03", "2027-03"},
		{"between billings", yearly, "2026-04", "2027-03"},
		{"quarterly mid-cycle", quarterly, "2026-02", "2026-04"},
		{"after it ended", quarterly, "2026-05", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.fe.nextBilling(tt.from); got != tt.want {
				t.Fatalf("nextBilling(%s) = %q, want %q", tt.from, got, tt.want)
			}
		})
	}
}

func TestUFFixedExpenseConvertsWithTheMonthValue(t *testing.T) {
	ctx := t.Context()
	s := newTestService(t)
	fe := s.CreateFixedExpense(ctx, "Arriendo", "Hogar", nil, "2026-01", "12.5", 1, CurrencyUF)
	mustOK(t, "CreateFixedExpense", fe.Error)
	id := fe.Data.ID

	// No UF value yet: the charge is 0 and flagged as an estimate.
	mv, _ := fixedAmountIn(t, s, "2026-01", id)
	if !mv.Amount.IsZero() || !mv.Estimado {
		t.Fatalf("without UF values: %+v, want 0 estimated", mv)
	}

	mustOK(t, "SetUFValues", s.SetUFValues(ctx, []UFValueInput{
		{Period: "2026-01", Value: "39000.04"}, // 12.5 × = 487500.5 → rounds half away from zero
		{Period: "2026-02", Value: "39100.50"}, // 488756.25 → 488756
	}).Error)

	for _, tt := range []struct {
		period, amount string
		estimated      bool
	}{
		{"2026-01", "487501", false},
		{"2026-02", "488756", false},
		{"2026-03", "488756", true}, // not downloaded: February's value
	} {
		mv, ok := fixedAmountIn(t, s, tt.period, id)
		if !ok {
			t.Fatalf("%s: UF fixed expense missing", tt.period)
		}
		wantMoney(t, tt.period+" CLP", mv.Amount, tt.amount)
		if mv.UFAmount == nil || mv.UFAmount.String() != "12.5" || mv.Estimado != tt.estimated {
			t.Fatalf("%s: ufAmount %v estimado %v, want 12.5 / %v", tt.period, mv.UFAmount, mv.Estimado, tt.estimated)
		}
	}
	wantMoney(t, "carried into Apr", monthly(t, s, "2026-04").Acumulado, "-1465013")

	// Replacing a stored month re-prices it.
	mustOK(t, "SetUFValues replace", s.SetUFValues(ctx, []UFValueInput{{Period: "2026-01", Value: "40000"}}).Error)
	mv, _ = fixedAmountIn(t, s, "2026-01", id)
	wantMoney(t, "Jan after replace", mv.Amount, "500000")

	list, err := s.ListFixedExpenses(ctx)
	if err != nil || len(list) != 1 || list[0].Currency != CurrencyUF || list[0].CurrentAmount.String() != "12.5" {
		t.Fatalf("ListFixedExpenses = %+v (err %v)", list, err)
	}
}

func TestUFMonthsNeeded(t *testing.T) {
	ctx := t.Context()
	s := newTestService(t)
	mustOK(t, "CLP fixed", s.CreateFixedExpense(ctx, "Luz", "", nil, "2026-01", "1000", 1, CurrencyCLP).Error)
	uf := s.CreateFixedExpense(ctx, "Dividendo", "", nil, "2026-01", "20", 2, CurrencyUF)
	mustOK(t, "UF fixed", uf.Error)
	mustOK(t, "EndFixedExpense", s.EndFixedExpense(ctx, uf.Data.ID, "2026-07").Error) // last month 2026-06
	mustOK(t, "SetUFValues", s.SetUFValues(ctx, []UFValueInput{{Period: "2026-03", Value: "39000"}}).Error)

	got, err := s.UFMonthsNeeded(ctx)
	if err != nil {
		t.Fatal(err)
	}
	// Every other month from January to June, minus the one already stored.
	if want := []string{"2026-01", "2026-05"}; !slices.Equal(got, want) {
		t.Fatalf("UFMonthsNeeded = %v, want %v", got, want)
	}
}

func TestScheduleAndUFValidation(t *testing.T) {
	ctx := t.Context()
	s := newTestService(t)
	for _, tt := range []struct {
		name     string
		interval int
		currency string
	}{
		{"five months", 5, CurrencyCLP},
		{"zero", 0, CurrencyCLP},
		{"dollars", 1, "USD"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			r := s.CreateFixedExpense(ctx, "x", "", nil, "2026-01", "1", tt.interval, tt.currency)
			if r.Error == nil || r.Error.Code != shared.ErrValidation {
				t.Fatalf("CreateFixedExpense(%d, %s) = %+v, want VALIDATION_ERROR", tt.interval, tt.currency, r.Error)
			}
		})
	}
	for _, v := range []UFValueInput{{"2026-13", "1"}, {"2026-01", "0"}, {"2026-01", "-5"}, {"2026-01", "mucho"}} {
		if r := s.SetUFValues(ctx, []UFValueInput{v}); r.Error == nil || r.Error.Code != shared.ErrValidation {
			t.Fatalf("SetUFValues(%+v) = %+v, want VALIDATION_ERROR", v, r.Error)
		}
	}
}
