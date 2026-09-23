package finance

import (
	"context"
	"strings"
	"time"

	"github.com/uptrace/bun"

	"github.com/gastonlarap-a11y/app-finance/backend/shared"
	"github.com/gastonlarap-a11y/app-finance/backend/shared/types"
)

// SavingsGoal is a target amount the user saves towards, optionally by a month.
// Soft-deleted into the Papelera like the other user entities; its
// contributions ride along (they have no deleted_at of their own).
type SavingsGoal struct {
	bun.BaseModel `bun:"table:savings_goals,alias:sg"`

	ID           int64         `bun:"id,pk,autoincrement" json:"id"`
	UserID       int64         `bun:"user_id,notnull" json:"userId"`
	Name         string        `bun:"name,notnull" json:"name"`
	TargetAmount types.Decimal `bun:"target_amount,notnull" json:"targetAmount"`
	TargetPeriod string        `bun:"target_period,notnull" json:"targetPeriod"` // YYYY-MM; "" = sin fecha
	CreatedAt    time.Time     `bun:"created_at,nullzero,default:current_timestamp" json:"createdAt"`
	DeletedAt    *time.Time    `bun:",soft_delete" json:"deletedAt,omitempty"`
}

// SavingsContribution is money put towards a goal in a given month. It counts as
// an outflow of that month (lowers disponible and the carried balance) but is
// reported apart from gastos and never counts against category budgets.
type SavingsContribution struct {
	bun.BaseModel `bun:"table:savings_contributions,alias:sc"`

	ID        int64         `bun:"id,pk,autoincrement" json:"id"`
	UserID    int64         `bun:"user_id,notnull" json:"userId"`
	GoalID    int64         `bun:"goal_id,notnull" json:"goalId"`
	Period    string        `bun:"period,notnull" json:"period"` // YYYY-MM
	Amount    types.Decimal `bun:"amount,notnull" json:"amount"`
	CreatedAt time.Time     `bun:"created_at,nullzero,default:current_timestamp" json:"createdAt"`
}

// liveGoalContributions restricts a contributions query to goals that are not in
// the trash — the same rule as installments of a deleted expense.
const liveGoalContributions = "goal_id IN (SELECT id FROM savings_goals WHERE deleted_at IS NULL)"

func validateGoal(name, target, targetPeriod string) (string, types.Decimal, *shared.AppError) {
	name = strings.TrimSpace(name)
	if name == "" {
		return "", types.Zero(), shared.NewError(shared.ErrValidation, "el nombre es obligatorio")
	}
	amt, aerr := parseAmount(target)
	if aerr != nil {
		return "", types.Zero(), aerr
	}
	if amt.IsZero() {
		return "", types.Zero(), shared.NewError(shared.ErrValidation, "el monto objetivo debe ser mayor a 0")
	}
	if targetPeriod != "" && !validPeriod(targetPeriod) {
		return "", types.Zero(), shared.NewError(shared.ErrValidation, "fecha objetivo inválida (use YYYY-MM)")
	}
	return name, amt, nil
}

func (s *FinanceService) CreateSavingsGoal(ctx context.Context, name, targetAmount, targetPeriod string) SavingsGoalResult {
	name, amt, aerr := validateGoal(name, targetAmount, targetPeriod)
	if aerr != nil {
		return SavingsGoalResult{Error: aerr}
	}
	goal := &SavingsGoal{UserID: s.uid(), Name: name, TargetAmount: amt, TargetPeriod: targetPeriod}
	if _, err := s.db.NewInsert().Model(goal).Returning("*").Exec(ctx); err != nil {
		return SavingsGoalResult{Error: internalErr(err)}
	}
	return SavingsGoalResult{Data: goal}
}

func (s *FinanceService) UpdateSavingsGoal(ctx context.Context, id int64, name, targetAmount, targetPeriod string) SavingsGoalResult {
	name, amt, aerr := validateGoal(name, targetAmount, targetPeriod)
	if aerr != nil {
		return SavingsGoalResult{Error: aerr}
	}
	uid := s.uid()
	goal := new(SavingsGoal)
	err := s.db.RunInTx(ctx, nil, func(ctx context.Context, tx bun.Tx) error {
		res, err := tx.NewUpdate().Model((*SavingsGoal)(nil)).
			Set("name = ?", name).Set("target_amount = ?", amt).Set("target_period = ?", targetPeriod).
			Where("id = ? AND user_id = ?", id, uid).Exec(ctx)
		if aerr := requireOne(res, err, "meta no encontrada"); aerr != nil {
			return aerr
		}
		return tx.NewSelect().Model(goal).Where("id = ? AND user_id = ?", id, uid).Scan(ctx)
	})
	if err != nil {
		return SavingsGoalResult{Error: appErr(err)}
	}
	return SavingsGoalResult{Data: goal}
}

func (s *FinanceService) DeleteSavingsGoal(ctx context.Context, id int64) OpResult {
	return s.softDelete(ctx, (*SavingsGoal)(nil), id, "meta no encontrada")
}

func (s *FinanceService) RestoreSavingsGoal(ctx context.Context, id int64) OpResult {
	return s.restore(ctx, (*SavingsGoal)(nil), id, "meta no encontrada", "")
}

// AddSavingsContribution records money put towards a (live, own) goal in `period`.
func (s *FinanceService) AddSavingsContribution(ctx context.Context, goalID int64, period, amount string) SavingsContributionResult {
	if !validPeriod(period) {
		return SavingsContributionResult{Error: invalidPeriod()}
	}
	amt, aerr := parseAmount(amount)
	if aerr != nil {
		return SavingsContributionResult{Error: aerr}
	}
	if amt.IsZero() {
		return SavingsContributionResult{Error: shared.NewError(shared.ErrValidation, "el aporte debe ser mayor a 0")}
	}
	uid := s.uid()
	c := &SavingsContribution{UserID: uid, GoalID: goalID, Period: period, Amount: amt}
	err := s.db.RunInTx(ctx, nil, func(ctx context.Context, tx bun.Tx) error {
		ok, err := tx.NewSelect().Model((*SavingsGoal)(nil)).Where("id = ? AND user_id = ?", goalID, uid).Exists(ctx)
		if err != nil {
			return err
		}
		if !ok {
			return shared.NewError(shared.ErrNotFound, "meta no encontrada")
		}
		_, err = tx.NewInsert().Model(c).Returning("*").Exec(ctx)
		return err
	})
	if err != nil {
		return SavingsContributionResult{Error: appErr(err)}
	}
	return SavingsContributionResult{Data: c}
}

// DeleteSavingsContribution removes a contribution for good (a mistyped entry
// is simply re-added; contributions have no trash of their own).
func (s *FinanceService) DeleteSavingsContribution(ctx context.Context, id int64) OpResult {
	res, err := s.db.NewDelete().Model((*SavingsContribution)(nil)).Where("id = ? AND user_id = ?", id, s.uid()).Exec(ctx)
	return OpResult{Error: requireOne(res, err, "aporte no encontrado")}
}

// ListSavingsGoals returns the live goals with their progress and the monthly
// contribution still needed to reach each one by its target month.
func (s *FinanceService) ListSavingsGoals(ctx context.Context) ([]SavingsGoalView, error) {
	return s.listSavingsGoals(ctx, s.uid(), currentPeriod())
}

func (s *FinanceService) listSavingsGoals(ctx context.Context, uid int64, now string) ([]SavingsGoalView, error) {
	var goals []SavingsGoal
	if err := s.db.NewSelect().Model(&goals).Where("user_id = ?", uid).Order("created_at ASC", "id ASC").Scan(ctx); err != nil {
		return nil, err
	}
	var contribs []SavingsContribution
	if err := s.db.NewSelect().Model(&contribs).
		Where("user_id = ?", uid).Where(liveGoalContributions).
		Order("period DESC", "id DESC").Scan(ctx); err != nil {
		return nil, err
	}
	byGoal := map[int64][]SavingsContribution{}
	for _, c := range contribs {
		byGoal[c.GoalID] = append(byGoal[c.GoalID], c)
	}

	out := make([]SavingsGoalView, 0, len(goals))
	for _, g := range goals {
		v := SavingsGoalView{SavingsGoal: g, Saved: types.Zero(), Contributions: byGoal[g.ID]}
		if v.Contributions == nil {
			v.Contributions = []SavingsContribution{}
		}
		for _, c := range v.Contributions {
			v.Saved = v.Saved.Add(c.Amount)
		}
		v.Remaining = types.Zero()
		if g.TargetAmount.GT(v.Saved) {
			v.Remaining = g.TargetAmount.Sub(v.Saved)
		}
		v.MonthlyNeeded = types.Zero()
		if g.TargetPeriod != "" && g.TargetPeriod >= now {
			v.MonthsLeft = monthsBetween(now, g.TargetPeriod) + 1 // the current month counts
			v.MonthlyNeeded = v.Remaining.DivCeil(int64(v.MonthsLeft))
		}
		out = append(out, v)
	}
	return out, nil
}

// savingsIn sums the contributions of live goals for one month.
func (s *FinanceService) savingsIn(ctx context.Context, uid int64, period string) (types.Decimal, error) {
	return s.sumContributions(ctx, uid, "period = ?", period)
}

// savingsBefore sums the contributions of live goals for every month before `period`.
func (s *FinanceService) savingsBefore(ctx context.Context, uid int64, period string) (types.Decimal, error) {
	return s.sumContributions(ctx, uid, "period < ?", period)
}

func (s *FinanceService) sumContributions(ctx context.Context, uid int64, where string, arg any) (types.Decimal, error) {
	var contribs []SavingsContribution
	if err := s.db.NewSelect().Model(&contribs).
		Where("user_id = ?", uid).Where(liveGoalContributions).Where(where, arg).Scan(ctx); err != nil {
		return types.Zero(), err
	}
	total := types.Zero()
	for _, c := range contribs {
		total = total.Add(c.Amount)
	}
	return total, nil
}

// savingsByMonth sums live-goal contributions per month in [from, to].
func (s *FinanceService) savingsByMonth(ctx context.Context, uid int64, from, to string) (map[string]types.Decimal, error) {
	var contribs []SavingsContribution
	if err := s.db.NewSelect().Model(&contribs).
		Where("user_id = ? AND period >= ? AND period <= ?", uid, from, to).Where(liveGoalContributions).Scan(ctx); err != nil {
		return nil, err
	}
	out := map[string]types.Decimal{}
	for _, c := range contribs {
		out[c.Period] = out[c.Period].Add(c.Amount)
	}
	return out, nil
}
