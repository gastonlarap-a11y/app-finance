package finance

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/uptrace/bun"

	"github.com/gastonlarap-a11y/app-finance/backend/shared"
	"github.com/gastonlarap-a11y/app-finance/backend/shared/types"
)

// SavingsGoal is a target amount the user saves towards, optionally by a month.
// Soft-deleted into the Papelera like the other user entities; its
// contributions ride along (they have no deleted_at of their own).
//
// A goal either keeps contributions entered by hand or follows a real savings
// account (AccountID), the way Monarch and Copilot link goals to accounts:
// then what it holds is that account's balance, and the money transferred into
// the account each month is that month's Ahorro (goalTransfers).
type SavingsGoal struct {
	bun.BaseModel `bun:"table:savings_goals,alias:sg"`

	ID           int64         `bun:"id,pk,autoincrement" json:"id"`
	UserID       int64         `bun:"user_id,notnull" json:"userId"`
	Name         string        `bun:"name,notnull" json:"name"`
	TargetAmount types.Decimal `bun:"target_amount,notnull" json:"targetAmount"`
	TargetPeriod string        `bun:"target_period,notnull" json:"targetPeriod"` // YYYY-MM; "" = sin fecha
	Icon         string        `bun:"icon,notnull" json:"icon"`                  // clave de ícono de looks.json; "" = automático
	AccountID    *int64        `bun:"account_id" json:"accountId"`               // cuenta de ahorro que sigue; nil = aportes a mano
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

// RestoreSavingsGoal undoes a soft delete. Fails with ErrConflict when another
// live goal now follows the account this one followed.
func (s *FinanceService) RestoreSavingsGoal(ctx context.Context, id int64) OpResult {
	return s.restore(ctx, (*SavingsGoal)(nil), id, "meta no encontrada", "otra meta ya sigue la cuenta de esta meta")
}

// SetSavingsGoalAccount makes a live goal follow a savings account of the
// profile (nil = back to contributions by hand). A goal with contributions
// entered by hand cannot follow an account (both would count as Ahorro), and
// an account backs one live goal at most.
func (s *FinanceService) SetSavingsGoalAccount(ctx context.Context, goalID int64, accountID *int64) OpResult {
	uid := s.uid()
	err := s.db.RunInTx(ctx, nil, func(ctx context.Context, tx bun.Tx) error {
		if _, err := liveGoal(ctx, tx, uid, goalID); err != nil {
			return err
		}
		if accountID != nil {
			if aerr := ownAccount(ctx, tx, uid, accountID); aerr != nil {
				return aerr
			}
			saved, err := tx.NewSelect().Model((*SavingsContribution)(nil)).Where("goal_id = ?", goalID).Exists(ctx)
			if err != nil {
				return fmt.Errorf("checking contributions: %w", err)
			}
			if saved {
				return shared.NewError(shared.ErrConflict,
					"la meta tiene aportes anotados a mano: elimínalos antes de que siga a una cuenta")
			}
			var other []SavingsGoal
			if err := tx.NewSelect().Model(&other).Column("name").
				Where("user_id = ? AND account_id = ? AND id <> ?", uid, *accountID, goalID).Limit(1).Scan(ctx); err != nil {
				return fmt.Errorf("checking the account's goal: %w", err)
			}
			if len(other) > 0 {
				return shared.NewError(shared.ErrConflict, "esa cuenta ya respalda la meta «"+other[0].Name+"»")
			}
		}
		_, err := tx.NewUpdate().Model((*SavingsGoal)(nil)).Set("account_id = ?", accountID).
			Where("id = ? AND user_id = ?", goalID, uid).Exec(ctx)
		return err
	})
	if err != nil {
		return OpResult{Error: appErr(err)}
	}
	return OpResult{}
}

// liveGoal loads uid's goal `id` (not in the trash), or fails with NotFound.
func liveGoal(ctx context.Context, idb bun.IDB, uid, id int64) (*SavingsGoal, error) {
	goal := new(SavingsGoal)
	err := idb.NewSelect().Model(goal).Where("id = ? AND user_id = ?", id, uid).Scan(ctx)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, shared.NewError(shared.ErrNotFound, "meta no encontrada")
	}
	if err != nil {
		return nil, fmt.Errorf("loading goal: %w", err)
	}
	return goal, nil
}

// handGoal loads a goal that takes contributions by hand: a goal following an
// account is fed by transfers into it.
func handGoal(ctx context.Context, idb bun.IDB, uid, id int64) error {
	goal, err := liveGoal(ctx, idb, uid, id)
	if err != nil {
		return err
	}
	if goal.AccountID != nil {
		return shared.NewError(shared.ErrValidation,
			"la meta sigue el saldo de su cuenta: transfiere a esa cuenta en vez de anotar un aporte")
	}
	return nil
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
		if err := handGoal(ctx, tx, uid, goalID); err != nil {
			return err
		}
		_, err := tx.NewInsert().Model(c).Returning("*").Exec(ctx)
		return err
	})
	if err != nil {
		return SavingsContributionResult{Error: appErr(err)}
	}
	return SavingsContributionResult{Data: c}
}

// WithdrawSavings takes `amount` out of a (live, own) goal in `period`: stored
// as a negative contribution, it gives the money back to that month's
// disponible and to the carried balance through the same sums as a
// contribution. A goal never goes below zero.
func (s *FinanceService) WithdrawSavings(ctx context.Context, goalID int64, period, amount string) SavingsContributionResult {
	if !validPeriod(period) {
		return SavingsContributionResult{Error: invalidPeriod()}
	}
	amt, aerr := parseAmount(amount)
	if aerr != nil {
		return SavingsContributionResult{Error: aerr}
	}
	if amt.IsZero() {
		return SavingsContributionResult{Error: shared.NewError(shared.ErrValidation, "el retiro debe ser mayor a 0")}
	}
	uid := s.uid()
	c := &SavingsContribution{UserID: uid, GoalID: goalID, Period: period, Amount: types.Zero().Sub(amt)}
	err := s.db.RunInTx(ctx, nil, func(ctx context.Context, tx bun.Tx) error {
		if err := handGoal(ctx, tx, uid, goalID); err != nil {
			return err
		}
		headroom, err := goalHeadroom(ctx, tx, goalID, period)
		if err != nil {
			return err
		}
		if amt.GT(headroom) {
			return shared.NewError(shared.ErrValidation, fmt.Sprintf(
				"no puedes retirar más de lo que la meta tenía ahorrado en %s (%s)", period, headroom))
		}
		_, err = tx.NewInsert().Model(c).Returning("*").Exec(ctx)
		return err
	})
	if err != nil {
		return SavingsContributionResult{Error: appErr(err)}
	}
	return SavingsContributionResult{Data: c}
}

// goalHeadroom is the most a withdrawal in `period` may take so the goal never
// holds less than zero at any month's close, then or later: the lowest of its
// balance at `period` and its balance after each later month's movements.
func goalHeadroom(ctx context.Context, db bun.IDB, goalID int64, period string) (types.Decimal, error) {
	var rows []struct {
		Period string        `bun:"period"`
		Amount types.Decimal `bun:"amount"`
	}
	if err := db.NewSelect().Model((*SavingsContribution)(nil)).Column("period", "amount").
		Where("goal_id = ?", goalID).Order("period ASC").Scan(ctx, &rows); err != nil {
		return types.Zero(), fmt.Errorf("goal %d movements: %w", goalID, err)
	}
	byMonth := map[string]types.Decimal{}
	var months []string
	for _, r := range rows {
		if _, seen := byMonth[r.Period]; !seen {
			months = append(months, r.Period)
		}
		byMonth[r.Period] = byMonth[r.Period].Add(r.Amount)
	}
	// The balance at period's close…
	headroom, running := types.Zero(), types.Zero()
	for _, m := range months {
		running = running.Add(byMonth[m])
		if m <= period {
			headroom = running
		}
	}
	// …and never more than any later month's close holds.
	running = types.Zero()
	for _, m := range months {
		running = running.Add(byMonth[m])
		if m > period && running.Cmp(headroom) < 0 {
			headroom = running
		}
	}
	return types.Zero().Add(headroom), nil
}

// goalBalance is what a goal holds: its contributions minus its withdrawals.
func goalBalance(ctx context.Context, db bun.IDB, goalID int64) (types.Decimal, error) {
	saved, err := sumAmounts(ctx, db.NewSelect().Model((*SavingsContribution)(nil)).Where("goal_id = ?", goalID))
	if err != nil {
		return types.Zero(), fmt.Errorf("goal %d balance: %w", goalID, err)
	}
	return saved, nil
}

// DeleteSavingsContribution removes a contribution or withdrawal for good (a
// mistyped entry is simply re-added; they have no trash of their own), unless
// that would leave the goal below zero (delete the withdrawal first).
// Contributions of a goal in the trash ride along with it until restored.
func (s *FinanceService) DeleteSavingsContribution(ctx context.Context, id int64) OpResult {
	uid := s.uid()
	err := s.db.RunInTx(ctx, nil, func(ctx context.Context, tx bun.Tx) error {
		c := new(SavingsContribution)
		err := tx.NewSelect().Model(c).
			Where("id = ? AND user_id = ?", id, uid).
			Where("goal_id IN (SELECT id FROM savings_goals WHERE user_id = ? AND deleted_at IS NULL)", uid).
			Scan(ctx)
		if errors.Is(err, sql.ErrNoRows) {
			return shared.NewError(shared.ErrNotFound, "aporte no encontrado")
		}
		if err != nil {
			return fmt.Errorf("loading contribution: %w", err)
		}
		saved, err := goalBalance(ctx, tx, c.GoalID)
		if err != nil {
			return err
		}
		if saved.Sub(c.Amount).IsNegative() {
			return shared.NewError(shared.ErrConflict, "la meta quedaría negativa: elimina primero el retiro")
		}
		_, err = tx.NewDelete().Model((*SavingsContribution)(nil)).Where("id = ?", id).Exec(ctx)
		return err
	})
	if err != nil {
		return OpResult{Error: appErr(err)}
	}
	return OpResult{}
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
	// A goal that follows an account holds that account's balance this month.
	balances := map[int64]types.Decimal{}
	if slices.ContainsFunc(goals, func(g SavingsGoal) bool { return g.AccountID != nil }) {
		sum, err := s.accountsSummary(ctx, uid, now)
		if err != nil {
			return nil, err
		}
		for _, a := range sum.Accounts {
			balances[a.ID] = a.Balance
		}
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
		if g.AccountID != nil {
			v.Saved = types.Zero().Add(balances[*g.AccountID])
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
		// Past its target month and still short: the UI flags it.
		v.Overdue = g.TargetPeriod != "" && g.TargetPeriod < now && !v.Remaining.IsZero()
		out = append(out, v)
	}
	return out, nil
}

// A month's Ahorro is what live goals received that month: contributions by
// hand, plus the money transferred into (net of out of) the accounts that live
// goals follow. Every savings sum below adds both, so the month, the carried
// balance, the year and the forecast agree.

// savingsIn sums what live goals received in one month.
func (s *FinanceService) savingsIn(ctx context.Context, uid int64, period string) (types.Decimal, error) {
	byMonth, err := s.savingsByMonth(ctx, uid, period, period)
	if err != nil {
		return types.Zero(), err
	}
	return types.Zero().Add(byMonth[period]), nil
}

// savingsBetween sums what live goals received in every month strictly
// between `after` ("" = from the start) and `before`.
func (s *FinanceService) savingsBetween(ctx context.Context, uid int64, after, before string) (types.Decimal, error) {
	total, err := sumAmounts(ctx, s.db.NewSelect().Model((*SavingsContribution)(nil)).
		Where("user_id = ?", uid).Where(liveGoalContributions).Where("period > ? AND period < ?", after, before))
	if err != nil {
		return types.Zero(), err
	}
	from := ""
	if after != "" {
		from = addMonths(after, 1)
	}
	moved, err := s.goalTransfers(ctx, uid, from, addMonths(before, -1))
	if err != nil {
		return types.Zero(), err
	}
	for _, amt := range moved {
		total = total.Add(amt)
	}
	return total, nil
}

// savingsByMonth sums what live goals received per month in [from, to].
func (s *FinanceService) savingsByMonth(ctx context.Context, uid int64, from, to string) (map[string]types.Decimal, error) {
	var contribs []SavingsContribution
	if err := s.db.NewSelect().Model(&contribs).
		Where("user_id = ? AND period >= ? AND period <= ?", uid, from, to).Where(liveGoalContributions).Scan(ctx); err != nil {
		return nil, err
	}
	out, err := s.goalTransfers(ctx, uid, from, to)
	if err != nil {
		return nil, err
	}
	for _, c := range contribs {
		out[c.Period] = out[c.Period].Add(c.Amount)
	}
	return out, nil
}

// goalTransfers is, per month in [from, to] ("" from = the first transfer),
// the money transfers moved into the accounts live goals follow, net of what
// they moved out of them; a transfer between two such accounts nets zero.
func (s *FinanceService) goalTransfers(ctx context.Context, uid int64, from, to string) (map[string]types.Decimal, error) {
	out := map[string]types.Decimal{}
	var backing []int64
	if err := s.db.NewSelect().Model((*SavingsGoal)(nil)).Column("account_id").
		Where("user_id = ? AND account_id IS NOT NULL", uid).Scan(ctx, &backing); err != nil {
		return nil, fmt.Errorf("goal accounts: %w", err)
	}
	if len(backing) == 0 {
		return out, nil
	}
	var transfers []Transfer
	if err := s.db.NewSelect().Model(&transfers).Where("user_id = ?", uid).
		Where("(to_account_id IN (?) OR from_account_id IN (?))", bun.List(backing), bun.List(backing)).Scan(ctx); err != nil {
		return nil, fmt.Errorf("goal transfers: %w", err)
	}
	if len(transfers) == 0 {
		return out, nil
	}
	if from == "" {
		from = transfers[0].StartPeriod
		for _, t := range transfers {
			from = min(from, t.StartPeriod)
		}
	}
	salaryOf := map[string]types.Decimal{} // a salary_rest transfer follows the month's salary
	if slices.ContainsFunc(transfers, func(t Transfer) bool { return t.Mode == TransferSalaryRest }) {
		salaries, err := s.salaryByMonth(ctx, uid, from, to)
		if err != nil {
			return nil, err
		}
		for m, ms := range salaries {
			salaryOf[m] = ms.amount
		}
	}
	isBacking := make(map[int64]bool, len(backing))
	for _, id := range backing {
		isBacking[id] = true
	}
	for m := from; m <= to; m = addMonths(m, 1) {
		for _, t := range transfers {
			if !t.activeIn(m) || isBacking[t.ToAccountID] == isBacking[t.FromAccountID] {
				continue
			}
			amt := t.moved(salaryOf[m])
			if isBacking[t.FromAccountID] {
				amt = types.Zero().Sub(amt)
			}
			out[m] = out[m].Add(amt)
		}
	}
	return out, nil
}
