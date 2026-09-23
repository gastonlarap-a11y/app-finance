package finance

import (
	"cmp"
	"context"
	"slices"
	"strings"

	"github.com/gastonlarap-a11y/app-finance/backend/shared"
	"github.com/gastonlarap-a11y/app-finance/backend/shared/types"
)

const (
	minTrendMonths = 2
	maxTrendMonths = 24
)

// SpendingTrend returns the last `months` months of spending ending at `period`
// (oldest first) and compares `period` with the previous month and with the
// average of the earlier months of the window — overall and per category.
func (s *FinanceService) SpendingTrend(ctx context.Context, period string, months int) SpendingTrendResult {
	if !validPeriod(period) {
		return SpendingTrendResult{Error: invalidPeriod()}
	}
	if months < minTrendMonths || months > maxTrendMonths {
		return SpendingTrendResult{Error: shared.NewError(shared.ErrValidation, "la tendencia debe ser de 2 a 24 meses")}
	}
	out, err := s.spendingTrend(ctx, s.uid(), period, months)
	if err != nil {
		return SpendingTrendResult{Error: internalErr(err)}
	}
	return SpendingTrendResult{Data: out}
}

func (s *FinanceService) spendingTrend(ctx context.Context, uid int64, period string, months int) (*SpendingTrend, error) {
	from := addMonths(period, -(months - 1))
	totals, byCat, err := s.spendingByMonth(ctx, uid, from, period)
	if err != nil {
		return nil, err
	}

	out := &SpendingTrend{Months: make([]TrendMonth, 0, months)}
	earlier := types.Zero()
	for i := range months {
		p := addMonths(from, i)
		out.Months = append(out.Months, TrendMonth{Period: p, Gastos: totals[p]})
		if p != period {
			earlier = earlier.Add(totals[p])
		}
	}
	prev := addMonths(period, -1)
	out.Current = totals[period]
	out.Previous = totals[prev]
	out.Average = earlier.DivRound(int64(months - 1))

	// Every category seen in the window, compared the same way.
	cats := map[string]struct{}{}
	for _, m := range byCat {
		for c := range m {
			cats[c] = struct{}{}
		}
	}
	out.Categories = make([]CategoryTrend, 0, len(cats))
	for c := range cats {
		sumEarlier := types.Zero()
		for i := range months - 1 {
			sumEarlier = sumEarlier.Add(byCat[addMonths(from, i)][c])
		}
		out.Categories = append(out.Categories, CategoryTrend{
			Category: c,
			Current:  byCat[period][c],
			Previous: byCat[prev][c],
			Average:  sumEarlier.DivRound(int64(months - 1)),
		})
	}
	slices.SortFunc(out.Categories, func(a, b CategoryTrend) int {
		return cmp.Or(b.Current.Cmp(a.Current), b.Average.Cmp(a.Average), strings.Compare(a.Category, b.Category))
	})
	return out, nil
}

// spendingByMonth totals what each month in [from, to] charges — installments of
// live expenses plus active fixed expenses — overall and per category (the same
// numbers MonthlySummary reports as Gastos / PorCategoria).
func (s *FinanceService) spendingByMonth(ctx context.Context, uid int64, from, to string) (map[string]types.Decimal, map[string]map[string]types.Decimal, error) {
	totals := map[string]types.Decimal{}
	byCat := map[string]map[string]types.Decimal{}
	add := func(period, category string, amount types.Decimal) {
		totals[period] = totals[period].Add(amount)
		if byCat[period] == nil {
			byCat[period] = map[string]types.Decimal{}
		}
		c := categoryOrDefault(category)
		byCat[period][c] = byCat[period][c].Add(amount)
	}

	var insts []Installment
	if err := s.db.NewSelect().Model(&insts).Relation("Expense").
		Where("inst.user_id = ? AND inst.period >= ? AND inst.period <= ?", uid, from, to).
		Where("inst.expense_id IN (SELECT id FROM expenses WHERE deleted_at IS NULL)").
		Scan(ctx); err != nil {
		return nil, nil, err
	}
	for _, inst := range insts {
		cat := ""
		if inst.Expense != nil {
			cat = inst.Expense.Category
		}
		add(inst.Period, cat, inst.Amount)
	}

	fixed, amountsByID, err := s.loadFixed(ctx, uid, false)
	if err != nil {
		return nil, nil, err
	}
	for p := from; p <= to; p = addMonths(p, 1) {
		for _, fe := range fixed {
			if fe.activeIn(p) {
				add(p, fe.Category, resolveAsOf(amountsByID[fe.ID], p))
			}
		}
	}
	return totals, byCat, nil
}
