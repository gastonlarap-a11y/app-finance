package finance

import (
	"context"
	"slices"
	"strings"

	"github.com/uptrace/bun"

	"github.com/gastonlarap-a11y/app-finance/backend/shared"
	"github.com/gastonlarap-a11y/app-finance/backend/shared/types"
)

// CategoryBudget is a category's monthly cap from EffectiveFrom (YYYY-MM) onward,
// until a later row takes over — the same effective-dated scheme as
// FixedExpenseAmount, so changing a budget "from this month on" keeps history.
// Capped false means "no cap from this month on"; a capped row with amount
// zero is a real cap of $0 ("no spending in this category"). Rows carry no
// deleted_at: they ride along with their category into the trash and back.
type CategoryBudget struct {
	bun.BaseModel `bun:"table:category_budgets,alias:cb"`

	UserID        int64         `bun:"user_id,notnull" json:"userId"`
	CategoryID    int64         `bun:"category_id,pk" json:"categoryId"`
	EffectiveFrom string        `bun:"effective_from,pk" json:"effectiveFrom"` // YYYY-MM
	Amount        types.Decimal `bun:"amount,notnull" json:"amount"`
	Capped        bool          `bun:"capped,notnull" json:"capped"`
}

func (b CategoryBudget) effective() (string, types.Decimal) { return b.EffectiveFrom, b.Amount }

// SetCategoryBudget sets the category's cap from `fromPeriod` onward without
// touching earlier months. An amount of 0 is a cap of $0: any spending in the
// category is over budget (RemoveCategoryBudget lifts the cap instead).
func (s *FinanceService) SetCategoryBudget(ctx context.Context, categoryID int64, fromPeriod, amount string) OpResult {
	amt, aerr := parseAmount(amount)
	if aerr != nil {
		return OpResult{Error: aerr}
	}
	return s.putCategoryBudget(ctx, categoryID, fromPeriod, amt, true)
}

// RemoveCategoryBudget lifts the category's cap from `fromPeriod` onward;
// earlier months keep theirs.
func (s *FinanceService) RemoveCategoryBudget(ctx context.Context, categoryID int64, fromPeriod string) OpResult {
	return s.putCategoryBudget(ctx, categoryID, fromPeriod, types.Zero(), false)
}

// SetCategoryRollover turns the carry-over of unspent budget on or off for a
// live category of the profile.
func (s *FinanceService) SetCategoryRollover(ctx context.Context, categoryID int64, on bool) OpResult {
	res, err := s.db.NewUpdate().Model((*Category)(nil)).Set("rollover = ?", on).
		Where("id = ? AND user_id = ?", categoryID, s.uid()).Exec(ctx)
	return OpResult{Error: requireOne(res, err, "categoría no encontrada")}
}

func (s *FinanceService) putCategoryBudget(ctx context.Context, categoryID int64, fromPeriod string, amt types.Decimal, capped bool) OpResult {
	if !validPeriod(fromPeriod) {
		return OpResult{Error: invalidPeriod()}
	}
	uid := s.uid()
	err := s.db.RunInTx(ctx, nil, func(ctx context.Context, tx bun.Tx) error {
		ok, err := tx.NewSelect().Model((*Category)(nil)).Where("id = ? AND user_id = ?", categoryID, uid).Exists(ctx)
		if err != nil {
			return err
		}
		if !ok {
			return shared.NewError(shared.ErrNotFound, "categoría no encontrada")
		}
		row := &CategoryBudget{UserID: uid, CategoryID: categoryID, EffectiveFrom: fromPeriod, Amount: amt, Capped: capped}
		_, err = tx.NewInsert().Model(row).
			On("CONFLICT (category_id, effective_from) DO UPDATE").
			Set("amount = EXCLUDED.amount").Set("capped = EXCLUDED.capped").Exec(ctx)
		return err
	})
	if err != nil {
		return OpResult{Error: appErr(err)}
	}
	return OpResult{}
}

// ListCategoryBudgets returns the cap in effect at `period` for every active
// category that has one ($0 included), ordered by category name.
func (s *FinanceService) ListCategoryBudgets(ctx context.Context, period string) CategoryBudgetsResult {
	if !validPeriod(period) {
		return CategoryBudgetsResult{Error: invalidPeriod()}
	}
	views, err := s.budgetsInEffect(ctx, s.uid(), period)
	if err != nil {
		return CategoryBudgetsResult{Error: internalErr(err)}
	}
	return CategoryBudgetsResult{Data: views}
}

func (s *FinanceService) budgetsInEffect(ctx context.Context, uid int64, period string) ([]CategoryBudgetView, error) {
	var cats []Category
	if err := s.db.NewSelect().Model(&cats).Where("user_id = ?", uid).Scan(ctx); err != nil {
		return nil, err
	}
	var rows []CategoryBudget
	if err := s.db.NewSelect().Model(&rows).
		Where("user_id = ? AND effective_from <= ?", uid, period).Scan(ctx); err != nil {
		return nil, err
	}
	byCat := map[int64][]CategoryBudget{}
	for _, r := range rows {
		byCat[r.CategoryID] = append(byCat[r.CategoryID], r)
	}

	out := []CategoryBudgetView{}
	for _, c := range cats {
		b, ok := latestAsOf(byCat[c.ID], period)
		if !ok || !b.Capped {
			continue
		}
		out = append(out, CategoryBudgetView{
			CategoryID:    c.ID,
			Category:      c.Name,
			Amount:        b.Amount,
			EffectiveFrom: b.EffectiveFrom,
			Rollover:      c.Rollover,
		})
	}
	slices.SortFunc(out, func(a, b CategoryBudgetView) int { return strings.Compare(a.Category, b.Category) })
	return out, nil
}

// budgetStatuses compares each cap in effect at `period` (plus what a rollover
// category carries in) with what the month charges to that category
// (catTotals, keyed by category name as in PorCategoria).
func (s *FinanceService) budgetStatuses(ctx context.Context, uid int64, period string, catTotals map[string]types.Decimal) ([]BudgetStatus, error) {
	views, err := s.budgetsInEffect(ctx, uid, period)
	if err != nil {
		return nil, err
	}
	carried, err := s.rolloverCarries(ctx, uid, period, views)
	if err != nil {
		return nil, err
	}
	out := make([]BudgetStatus, 0, len(views))
	for _, v := range views {
		spent := catTotals[v.Category]
		carry := carried[v.CategoryID]
		available := v.Amount.Add(carry)
		over := spent.GT(available)
		out = append(out, BudgetStatus{
			CategoryID: v.CategoryID,
			Category:   v.Category,
			Budget:     v.Amount,
			Carried:    carry,
			Spent:      spent,
			Remaining:  available.Sub(spent),
			Over:       over,
			Near:       !over && nearCap(spent, available),
		})
	}
	return out, nil
}

// rolloverCarries is what each rollover category brings into `period`: every
// earlier month with a cap passes on what it left unspent — never a debt, as
// in YNAB, so one bad month does not shrink every later one — and a month
// without a cap starts over from zero.
func (s *FinanceService) rolloverCarries(ctx context.Context, uid int64, period string, views []CategoryBudgetView) (map[int64]types.Decimal, error) {
	out := map[int64]types.Decimal{}
	ids := []int64{}
	for _, v := range views {
		if v.Rollover {
			ids = append(ids, v.CategoryID)
		}
	}
	if len(ids) == 0 {
		return out, nil
	}
	var rows []CategoryBudget
	if err := s.db.NewSelect().Model(&rows).
		Where("user_id = ? AND category_id IN (?) AND effective_from < ?", uid, bun.List(ids), period).
		Scan(ctx); err != nil {
		return nil, err
	}
	byCat := map[int64][]CategoryBudget{}
	start := ""
	for _, r := range rows {
		byCat[r.CategoryID] = append(byCat[r.CategoryID], r)
		if start == "" || r.EffectiveFrom < start {
			start = r.EffectiveFrom
		}
	}
	if start == "" {
		return out, nil
	}
	spent, err := s.categorySpentByMonth(ctx, uid, start, addMonths(period, -1))
	if err != nil {
		return nil, err
	}
	for _, v := range views {
		if !v.Rollover {
			continue
		}
		carry := types.Zero()
		for m := start; m < period; m = addMonths(m, 1) {
			b, ok := latestAsOf(byCat[v.CategoryID], m)
			if !ok || !b.Capped {
				carry = types.Zero()
				continue
			}
			carry = b.Amount.Add(carry).Sub(spent[v.Category][m])
			if carry.IsNegative() {
				carry = types.Zero()
			}
		}
		out[v.CategoryID] = carry
	}
	return out, nil
}

// categorySpentByMonth is what each category was charged each month from
// `from` to `to` (YYYY-MM, inclusive): cuotas of live expenses, fixed charges
// and refunds — the same sources as a month's PorCategoria.
func (s *FinanceService) categorySpentByMonth(ctx context.Context, uid int64, from, to string) (map[string]map[string]types.Decimal, error) {
	out := map[string]map[string]types.Decimal{}
	add := func(cat, period string, amt types.Decimal) {
		if out[cat] == nil {
			out[cat] = map[string]types.Decimal{}
		}
		out[cat][period] = out[cat][period].Add(amt)
	}
	if from > to {
		return out, nil
	}
	var insts []Installment
	if err := s.db.NewSelect().Model(&insts).Relation("Expense").
		Where("inst.user_id = ? AND inst.period >= ? AND inst.period <= ?", uid, from, to).
		Where("inst.expense_id IN (SELECT id FROM expenses WHERE deleted_at IS NULL)").
		Scan(ctx); err != nil {
		return nil, err
	}
	for _, inst := range insts {
		if inst.Expense != nil {
			add(inst.Expense.Category, inst.Period, inst.Amount)
		}
	}
	fixed, amountsByID, err := s.loadFixed(ctx, uid, false)
	if err != nil {
		return nil, err
	}
	uf, err := s.loadUF(ctx)
	if err != nil {
		return nil, err
	}
	for m := from; m <= to; m = addMonths(m, 1) {
		for _, fe := range fixed {
			if fe.billsIn(m) {
				amt, _, _ := fixedCharge(fe, amountsByID[fe.ID], uf, m)
				add(fe.Category, m, amt)
			}
		}
	}
	refunds, err := s.refundsIn(ctx, uid, from, to)
	if err != nil {
		return nil, err
	}
	for _, r := range refunds {
		add(r.Category, r.Period, types.Zero().Sub(r.Amount))
	}
	return out, nil
}

// budgetAlertPercent is the share of a monthly cap that raises the early
// warning — the 80 % most budgeting apps (YNAB, Mint) alert at.
const budgetAlertPercent = 80

// nearCap reports whether spent has reached budgetAlertPercent of a positive cap.
func nearCap(spent, budget types.Decimal) bool {
	return budget.GT(types.Zero()) && spent.MulInt(100).GTE(budget.MulInt(budgetAlertPercent))
}
