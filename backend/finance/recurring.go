package finance

import (
	"cmp"
	"context"
	"slices"
	"strings"

	"github.com/gastonlarap-a11y/app-finance/backend/shared/types"
)

const (
	recurringWindowMonths = 6  // look back this many months (selected month included)
	recurringMinMonths    = 3  // distinct months a charge must appear in
	recurringTolerancePct = 15 // max deviation from the median amount
)

// normalizeKey makes "  Netflix  CL" and "netflix cl" the same grouping key.
func normalizeKey(s string) string {
	return strings.ToLower(strings.Join(strings.Fields(s), " "))
}

type recurringHit struct {
	period string
	amount types.Decimal
	ex     *Expense
}

// DetectRecurring finds one-off expenses that repeat month after month with a
// similar amount (same merchant, or same description when there is none) in the
// window ending at `period`, and are not already a fixed expense — candidates to
// convert into a fixed expense starting the month after their last charge.
func (s *FinanceService) DetectRecurring(ctx context.Context, period string) RecurringResult {
	if !validPeriod(period) {
		return RecurringResult{Error: invalidPeriod()}
	}
	out, err := s.detectRecurring(ctx, s.uid(), period)
	if err != nil {
		return RecurringResult{Error: internalErr(err)}
	}
	return RecurringResult{Data: out}
}

func (s *FinanceService) detectRecurring(ctx context.Context, uid int64, period string) ([]RecurringSuggestion, error) {
	from := addMonths(period, -(recurringWindowMonths - 1))
	var insts []Installment
	if err := s.db.NewSelect().Model(&insts).Relation("Expense").
		Where("inst.user_id = ? AND inst.period >= ? AND inst.period <= ?", uid, from, period).
		Where("inst.expense_id IN (SELECT id FROM expenses WHERE deleted_at IS NULL AND kind = ?)", KindUnico).
		Scan(ctx); err != nil {
		return nil, err
	}

	groups := map[string][]recurringHit{}
	for _, inst := range insts {
		ex := inst.Expense
		if ex == nil {
			continue
		}
		key := normalizeKey(ex.Merchant)
		if key == "" {
			key = normalizeKey(ex.Description)
		}
		groups[key] = append(groups[key], recurringHit{period: inst.Period, amount: inst.Amount, ex: ex})
	}

	fixed, _, err := s.loadFixed(ctx, uid, false)
	if err != nil {
		return nil, err
	}
	alreadyFixed := map[string]bool{}
	for _, fe := range fixed {
		if fe.EndPeriod == "" || fe.EndPeriod >= period {
			alreadyFixed[normalizeKey(fe.Description)] = true
		}
	}

	out := []RecurringSuggestion{}
	for _, hits := range groups {
		sug, ok := recurringFrom(hits)
		if !ok || alreadyFixed[normalizeKey(sug.Description)] || alreadyFixed[normalizeKey(sug.Merchant)] {
			continue
		}
		out = append(out, sug)
	}
	slices.SortFunc(out, func(a, b RecurringSuggestion) int {
		return cmp.Or(cmp.Compare(len(b.Periods), len(a.Periods)), strings.Compare(a.Description, b.Description))
	})
	return out, nil
}

// recurringFrom keeps the hits whose amount is within the tolerance of the
// group's median and reports a suggestion when they span enough distinct months.
func recurringFrom(hits []recurringHit) (RecurringSuggestion, bool) {
	amounts := make([]types.Decimal, len(hits))
	for i, h := range hits {
		amounts[i] = h.amount
	}
	slices.SortFunc(amounts, func(a, b types.Decimal) int { return a.Cmp(b) })
	median := amounts[len(amounts)/2]
	if median.IsZero() {
		return RecurringSuggestion{}, false
	}
	limit := median.MulInt(recurringTolerancePct)

	months := map[string]bool{}
	var latest *recurringHit
	for i := range hits {
		h := &hits[i]
		// |amount − median| × 100 <= median × tolerance
		if h.amount.Sub(median).Abs().MulInt(100).GT(limit) {
			continue
		}
		months[h.period] = true
		if latest == nil || h.period > latest.period || (h.period == latest.period && h.ex.ID > latest.ex.ID) {
			latest = h
		}
	}
	if latest == nil || len(months) < recurringMinMonths {
		return RecurringSuggestion{}, false
	}
	periods := make([]string, 0, len(months))
	for p := range months {
		periods = append(periods, p)
	}
	slices.Sort(periods)
	return RecurringSuggestion{
		Description: latest.ex.Description,
		Merchant:    latest.ex.Merchant,
		Category:    latest.ex.Category,
		CardID:      latest.ex.CardID,
		Amount:      latest.amount,
		Periods:     periods,
		NextPeriod:  addMonths(latest.period, 1),
	}, true
}
