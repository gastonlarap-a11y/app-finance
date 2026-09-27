package finance

import (
	"context"
	"strings"

	"github.com/uptrace/bun"

	"github.com/gastonlarap-a11y/app-finance/backend/shared"
	"github.com/gastonlarap-a11y/app-finance/backend/shared/types"
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
	count, err := s.db.NewSelect().Model(&expenses).
		Apply(expenseFilter(uid, f)).
		Order("ex.date DESC", "ex.id DESC").Limit(limit).Offset(offset).ScanAndCount(ctx)
	if err != nil {
		return ExpenseSearchResult{Error: internalErr(err)}
	}
	// The sum covers every match, not just this page ("¿cuánto costó el viaje?").
	var totals []struct {
		InstallmentAmount types.Decimal `bun:"installment_amount"`
		InstallmentsTotal int           `bun:"installments_total"`
	}
	if err := s.db.NewSelect().Model((*Expense)(nil)).Column("installment_amount", "installments_total").
		Apply(expenseFilter(uid, f)).Scan(ctx, &totals); err != nil {
		return ExpenseSearchResult{Error: internalErr(err)}
	}
	sum := types.Zero()
	for _, t := range totals {
		sum = sum.Add(t.InstallmentAmount.MulInt(int64(max(t.InstallmentsTotal, 1))))
	}

	hits, err := s.expenseHits(ctx, uid, expenses)
	if err != nil {
		return ExpenseSearchResult{Error: internalErr(err)}
	}
	return ExpenseSearchResult{Data: &ExpenseSearch{Items: hits, Count: count, Sum: sum}}
}

// expenseFilter applies f to a query over uid's (live) expenses aliased ex.
func expenseFilter(uid int64, f ExpenseFilter) func(*bun.SelectQuery) *bun.SelectQuery {
	return func(q *bun.SelectQuery) *bun.SelectQuery {
		q = q.Where("ex.user_id = ?", uid)
		if text := strings.TrimSpace(f.Text); text != "" {
			pattern := "%" + escapeLike(text) + "%"
			refCond, refArgs := referenceMatch(uid, pattern)
			q = q.Where(`(ex.description LIKE ? ESCAPE '\' OR ex.merchant LIKE ? ESCAPE '\' OR ex.bank_description LIKE ? ESCAPE '\' OR `+refCond+`)`,
				append([]any{pattern, pattern, pattern}, refArgs...)...)
		}
		switch cat := strings.TrimSpace(f.Category); cat {
		case "":
		case uncategorized:
			q = q.Where("ex.category = ''")
		default:
			q = q.Where("ex.category = ?", cat)
		}
		if tag := strings.Join(strings.Fields(f.Tag), " "); tag != "" {
			q = q.Where(`ex.id IN (SELECT et.expense_id FROM expense_tags AS et JOIN tags AS tg ON tg.id = et.tag_id
				WHERE tg.user_id = ? AND tg.name_key = ?)`, uid, tagKey(tag))
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
		return q
	}
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
	tags, err := s.tagsByExpense(ctx, uid, ids)
	if err != nil {
		return nil, err
	}
	refs, err := s.referencesByExpense(ctx, uid, ids)
	if err != nil {
		return nil, err
	}

	for _, ex := range expenses {
		hit := ExpenseHit{
			Expense:    ex,
			Total:      ex.InstallmentAmount.MulInt(int64(max(ex.InstallmentsTotal, 1))),
			Tags:       tags[ex.ID],
			References: refs[ex.ID],
		}
		if hit.Tags == nil {
			hit.Tags = []string{}
		}
		if hit.References == nil {
			hit.References = []string{}
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
