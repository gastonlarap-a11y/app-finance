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
// Amount zero means "no cap from this month on". Rows carry no deleted_at: they
// ride along with their category into the trash and back.
type CategoryBudget struct {
	bun.BaseModel `bun:"table:category_budgets,alias:cb"`

	UserID        int64         `bun:"user_id,notnull" json:"userId"`
	CategoryID    int64         `bun:"category_id,pk" json:"categoryId"`
	EffectiveFrom string        `bun:"effective_from,pk" json:"effectiveFrom"` // YYYY-MM
	Amount        types.Decimal `bun:"amount,notnull" json:"amount"`
}

func (b CategoryBudget) effective() (string, types.Decimal) { return b.EffectiveFrom, b.Amount }

// SetCategoryBudget sets the category's cap from `fromPeriod` onward without
// touching earlier months. An amount of 0 removes the cap from that month on.
func (s *FinanceService) SetCategoryBudget(ctx context.Context, categoryID int64, fromPeriod, amount string) OpResult {
	if !validPeriod(fromPeriod) {
		return OpResult{Error: invalidPeriod()}
	}
	amt, aerr := parseAmount(amount)
	if aerr != nil {
		return OpResult{Error: aerr}
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
		row := &CategoryBudget{UserID: uid, CategoryID: categoryID, EffectiveFrom: fromPeriod, Amount: amt}
		_, err = tx.NewInsert().Model(row).
			On("CONFLICT (category_id, effective_from) DO UPDATE").
			Set("amount = EXCLUDED.amount").Exec(ctx)
		return err
	})
	if err != nil {
		return OpResult{Error: appErr(err)}
	}
	return OpResult{}
}

// ListCategoryBudgets returns the cap in effect at `period` for every active
// category that has one (amount > 0), ordered by category name.
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
		if !ok || b.Amount.IsZero() {
			continue
		}
		out = append(out, CategoryBudgetView{
			CategoryID:    c.ID,
			Category:      c.Name,
			Amount:        b.Amount,
			EffectiveFrom: b.EffectiveFrom,
		})
	}
	slices.SortFunc(out, func(a, b CategoryBudgetView) int { return strings.Compare(a.Category, b.Category) })
	return out, nil
}

// budgetStatuses compares each cap in effect at `period` with what the month
// charges to that category (catTotals, keyed by category name as in PorCategoria).
func (s *FinanceService) budgetStatuses(ctx context.Context, uid int64, period string, catTotals map[string]types.Decimal) ([]BudgetStatus, error) {
	views, err := s.budgetsInEffect(ctx, uid, period)
	if err != nil {
		return nil, err
	}
	out := make([]BudgetStatus, 0, len(views))
	for _, v := range views {
		spent := catTotals[v.Category]
		out = append(out, BudgetStatus{
			CategoryID: v.CategoryID,
			Category:   v.Category,
			Budget:     v.Amount,
			Spent:      spent,
			Remaining:  v.Amount.Sub(spent),
			Over:       spent.GT(v.Amount),
		})
	}
	return out, nil
}
