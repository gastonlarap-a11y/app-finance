package finance

import (
	"context"
	"strings"

	"github.com/uptrace/bun"

	"github.com/gastonlarap-a11y/app-finance/backend/shared"
)

const (
	defaultSearchLimit = 50
	maxSearchLimit     = 200
)

// escapeLike escapes LIKE's wildcards so user text matches literally (used with
// ESCAPE '\').
func escapeLike(s string) string {
	return strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(s)
}

// SearchExpenses finds the active user's (non-deleted) expenses across all
// history, newest first, paginated. Text matches description or merchant
// (case-insensitive for ASCII, SQLite LIKE semantics).
func (s *FinanceService) SearchExpenses(ctx context.Context, f ExpenseFilter) ExpenseSearchResult {
	if f.FromPeriod != "" && !validPeriod(f.FromPeriod) || f.ToPeriod != "" && !validPeriod(f.ToPeriod) {
		return ExpenseSearchResult{Error: invalidPeriod()}
	}
	if f.FromPeriod != "" && f.ToPeriod != "" && f.FromPeriod > f.ToPeriod {
		return ExpenseSearchResult{Error: shared.NewError(shared.ErrValidation, "el período inicial es posterior al final")}
	}
	limit := f.Limit
	if limit <= 0 {
		limit = defaultSearchLimit
	}
	limit = min(limit, maxSearchLimit)
	offset := max(f.Offset, 0)

	uid := s.uid()
	var expenses []Expense
	q := s.db.NewSelect().Model(&expenses).Where("ex.user_id = ?", uid)
	if text := strings.TrimSpace(f.Text); text != "" {
		pattern := "%" + escapeLike(text) + "%"
		q = q.Where(`(ex.description LIKE ? ESCAPE '\' OR ex.merchant LIKE ? ESCAPE '\')`, pattern, pattern)
	}
	switch cat := strings.TrimSpace(f.Category); cat {
	case "":
	case uncategorized:
		q = q.Where("ex.category = ''")
	default:
		q = q.Where("ex.category = ?", cat)
	}
	if f.CardID != nil {
		q = q.Where("ex.card_id = ?", *f.CardID)
	}
	if f.FromPeriod != "" || f.ToPeriod != "" {
		from, to := f.FromPeriod, f.ToPeriod
		if from == "" {
			from = "0000-01"
		}
		if to == "" {
			to = "9999-12"
		}
		q = q.Where("ex.id IN (SELECT expense_id FROM installments WHERE user_id = ? AND period >= ? AND period <= ?)", uid, from, to)
	}
	count, err := q.Order("ex.date DESC", "ex.id DESC").Limit(limit).Offset(offset).ScanAndCount(ctx)
	if err != nil {
		return ExpenseSearchResult{Error: internalErr(err)}
	}

	hits, err := s.expenseHits(ctx, uid, expenses)
	if err != nil {
		return ExpenseSearchResult{Error: internalErr(err)}
	}
	return ExpenseSearchResult{Data: &ExpenseSearch{Items: hits, Count: count}}
}

// expenseHits enriches expenses with their card name and installment span/progress.
func (s *FinanceService) expenseHits(ctx context.Context, uid int64, expenses []Expense) ([]ExpenseHit, error) {
	hits := make([]ExpenseHit, 0, len(expenses))
	if len(expenses) == 0 {
		return hits, nil
	}
	ids := make([]int64, len(expenses))
	for i, ex := range expenses {
		ids[i] = ex.ID
	}
	var insts []Installment
	if err := s.db.NewSelect().Model(&insts).
		Where("user_id = ? AND expense_id IN (?)", uid, bun.List(ids)).Scan(ctx); err != nil {
		return nil, err
	}
	type span struct {
		first, last string
		paid        int
	}
	spans := map[int64]*span{}
	for _, inst := range insts {
		sp, ok := spans[inst.ExpenseID]
		if !ok {
			sp = &span{first: inst.Period, last: inst.Period}
			spans[inst.ExpenseID] = sp
		}
		sp.first = min(sp.first, inst.Period)
		sp.last = max(sp.last, inst.Period)
		if inst.Status == StatusPagado {
			sp.paid++
		}
	}
	cardByID, err := s.cardMapAll(ctx, uid)
	if err != nil {
		return nil, err
	}

	for _, ex := range expenses {
		hit := ExpenseHit{
			Expense: ex,
			Total:   ex.InstallmentAmount.MulInt(int64(max(ex.InstallmentsTotal, 1))),
		}
		if sp := spans[ex.ID]; sp != nil {
			hit.FirstPeriod, hit.LastPeriod, hit.PaidCount = sp.first, sp.last, sp.paid
		}
		if ex.CardID != nil {
			hit.CardName = cardByID[*ex.CardID].Name
		}
		hits = append(hits, hit)
	}
	return hits, nil
}
