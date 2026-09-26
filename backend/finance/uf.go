package finance

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/uptrace/bun"

	"github.com/gastonlarap-a11y/app-finance/backend/shared"
	"github.com/gastonlarap-a11y/app-finance/backend/shared/types"
)

// UFValue is the value in pesos of the Unidad de Fomento on the first day of a
// month: fixed expenses in UF (rent, mortgage, health plans) bill that month at
// amount × this value. It is public data shared by every profile, so the table
// has no user_id; the frontend downloads it (lib/uf.ts, from mindicador.cl) and
// stores it with SetUFValues — the backend never reaches the network for it.
type UFValue struct {
	bun.BaseModel `bun:"table:uf_values,alias:uf"`

	Period    string        `bun:"period,pk" json:"period"` // YYYY-MM
	Value     types.Decimal `bun:"value,notnull" json:"value"`
	UpdatedAt time.Time     `bun:"updated_at,nullzero,default:current_timestamp" json:"updatedAt"`
}

// UFValueInput is one month's UF value as the frontend sends it.
type UFValueInput struct {
	Period string `json:"period"` // YYYY-MM
	Value  string `json:"value"`  // pesos per UF, e.g. "40875.09"
}

// ufRates are the stored UF values, by month.
type ufRates struct {
	periods []string // sorted
	values  map[string]types.Decimal
}

func (s *FinanceService) loadUF(ctx context.Context) (ufRates, error) {
	var rows []UFValue
	if err := s.db.NewSelect().Model(&rows).Order("period ASC").Scan(ctx); err != nil {
		return ufRates{}, fmt.Errorf("uf values: %w", err)
	}
	r := ufRates{periods: make([]string, 0, len(rows)), values: make(map[string]types.Decimal, len(rows))}
	for _, row := range rows {
		r.periods = append(r.periods, row.Period)
		r.values[row.Period] = row.Value
	}
	return r, nil
}

// valueFor is the UF value for `period` and whether it is an estimate: a month
// not downloaded yet (the future, or offline) takes the closest earlier value,
// or the earliest one when there is none before; with no values at all it is 0.
func (r ufRates) valueFor(period string) (types.Decimal, bool) {
	if v, ok := r.values[period]; ok {
		return v, false
	}
	i, _ := slices.BinarySearch(r.periods, period) // first stored month after period
	switch {
	case i > 0:
		return r.values[r.periods[i-1]], true
	case i < len(r.periods):
		return r.values[r.periods[i]], true
	default:
		return types.Zero(), true
	}
}

// fixedCharge is what a fixed expense bills in pesos in `period` (the caller
// has checked billsIn), the amount in its own currency, and whether the peso
// figure rests on an estimated UF value. Every summary goes through here, so
// the month, year, forecast, trend, carried balance and inbox agree.
func fixedCharge(fe FixedExpense, amounts []FixedExpenseAmount, uf ufRates, period string) (clp, original types.Decimal, estimated bool) {
	amt := resolveAsOf(amounts, period)
	if fe.Currency != CurrencyUF {
		return amt, amt, false
	}
	value, est := uf.valueFor(period)
	return amt.MulRound(value), amt, est
}

// fixedTotal sums a fixed expense's charges over the months [from, to] it
// bills in. A monthly CLP one multiplies each amount stretch out (sumAsOf), so
// its cost does not grow with the history; the others walk their billing
// months (at most one per month, and UF needs each month's value).
func fixedTotal(fe FixedExpense, amounts []FixedExpenseAmount, uf ufRates, from, to string) types.Decimal {
	from = max(from, fe.StartPeriod)
	if fe.EndPeriod != "" {
		to = min(to, fe.EndPeriod)
	}
	if from > to {
		return types.Zero()
	}
	if fe.interval() == 1 && fe.Currency != CurrencyUF {
		return sumAsOf(amounts, from, to)
	}
	total := types.Zero()
	for p := fe.nextBilling(from); p != "" && p <= to; p = addMonths(p, fe.interval()) {
		clp, _, _ := fixedCharge(fe, amounts, uf, p)
		total = total.Add(clp)
	}
	return total
}

// UFMonthsNeeded lists the months whose UF value the active profile's UF fixed
// expenses bill in — up to next month, for the forecast — and the app does not
// have yet. The frontend downloads them and stores them with SetUFValues.
func (s *FinanceService) UFMonthsNeeded(ctx context.Context) ([]string, error) {
	fixed, _, err := s.loadFixed(ctx, s.uid(), false)
	if err != nil {
		return nil, err
	}
	uf, err := s.loadUF(ctx)
	if err != nil {
		return nil, err
	}
	horizon := addMonths(currentPeriod(), 1)
	need := map[string]bool{}
	for _, fe := range fixed {
		if fe.Currency != CurrencyUF || !validPeriod(fe.StartPeriod) {
			continue
		}
		last := horizon
		if fe.EndPeriod != "" {
			last = min(last, fe.EndPeriod)
		}
		for p := fe.StartPeriod; p <= last; p = addMonths(p, fe.interval()) {
			if _, ok := uf.values[p]; !ok {
				need[p] = true
			}
		}
	}
	out := make([]string, 0, len(need))
	for p := range need {
		out = append(out, p)
	}
	slices.Sort(out)
	return out, nil
}

// SetUFValues stores downloaded UF values (replacing a month already stored).
func (s *FinanceService) SetUFValues(ctx context.Context, values []UFValueInput) OpResult {
	rows := make([]UFValue, 0, len(values))
	now := time.Now()
	for _, v := range values {
		if !validPeriod(v.Period) {
			return OpResult{Error: invalidPeriod()}
		}
		value, err := types.New(strings.TrimSpace(v.Value))
		if err != nil || !value.IsPositive() {
			return OpResult{Error: shared.NewError(shared.ErrValidation, "valor UF inválido: "+v.Value)}
		}
		rows = append(rows, UFValue{Period: v.Period, Value: value, UpdatedAt: now})
	}
	if len(rows) == 0 {
		return OpResult{}
	}
	if _, err := s.db.NewInsert().Model(&rows).
		On("CONFLICT (period) DO UPDATE").
		Set("value = EXCLUDED.value").
		Set("updated_at = EXCLUDED.updated_at").
		Exec(ctx); err != nil {
		return OpResult{Error: internalErr(err)}
	}
	return OpResult{}
}
