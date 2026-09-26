package finance

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/uptrace/bun"

	"github.com/gastonlarap-a11y/app-finance/backend/shared"
	"github.com/gastonlarap-a11y/app-finance/backend/shared/types"
)

// Reconciliation is the real account balance at the close of a month, as the
// bank shows it — the reconciliation of Actual Budget and YNAB, on this app's
// monthly grain. The carried balance restarts from the latest one before a
// month instead of summing the whole history, so an unrecorded cash expense
// stops skewing every later month once the user reconciles. The "saldo
// inicial" is a reconciliation on the month before the first one tracked.
// One per profile and month; the amount may be negative (an overdraft).
type Reconciliation struct {
	bun.BaseModel `bun:"table:reconciliations,alias:rec"`

	ID        int64         `bun:"id,pk,autoincrement" json:"id"`
	UserID    int64         `bun:"user_id,notnull" json:"userId"`
	Period    string        `bun:"period,notnull" json:"period"` // YYYY-MM of the close
	Amount    types.Decimal `bun:"amount,notnull" json:"amount"`
	CreatedAt time.Time     `bun:"created_at,nullzero,default:current_timestamp" json:"createdAt"`
	UpdatedAt time.Time     `bun:"updated_at,nullzero,default:current_timestamp" json:"updatedAt"`
}

// parseBalance reads a real account balance: unlike every other amount in the
// app it may be negative.
func parseBalance(s string) (types.Decimal, *shared.AppError) {
	d, err := types.New(strings.TrimSpace(s))
	if err != nil {
		return types.Zero(), shared.NewError(shared.ErrValidation, "saldo inválido: "+s)
	}
	return d, nil
}

// SetReconciliation records (or replaces) the real balance at the close of
// `period`. A month that has not started yet cannot be closed.
func (s *FinanceService) SetReconciliation(ctx context.Context, period, amount string) ReconciliationResult {
	if !validPeriod(period) {
		return ReconciliationResult{Error: invalidPeriod()}
	}
	if period > currentPeriod() {
		return ReconciliationResult{Error: shared.NewError(shared.ErrValidation, "no se puede conciliar un mes que aún no empieza")}
	}
	amt, aerr := parseBalance(amount)
	if aerr != nil {
		return ReconciliationResult{Error: aerr}
	}
	uid := s.uid()
	rec := &Reconciliation{UserID: uid, Period: period, Amount: amt, UpdatedAt: time.Now()}
	if _, err := s.db.NewInsert().Model(rec).
		On("CONFLICT (user_id, period) DO UPDATE").
		Set("amount = EXCLUDED.amount").
		Set("updated_at = EXCLUDED.updated_at").
		Returning("*").
		Exec(ctx); err != nil {
		return ReconciliationResult{Error: internalErr(err)}
	}
	return ReconciliationResult{Data: rec}
}

// DeleteReconciliation forgets the real balance of `period`: the carried
// balance goes back to the previous reconciliation (or the whole history).
func (s *FinanceService) DeleteReconciliation(ctx context.Context, period string) OpResult {
	if !validPeriod(period) {
		return OpResult{Error: invalidPeriod()}
	}
	res, err := s.db.NewDelete().Model((*Reconciliation)(nil)).
		Where("user_id = ? AND period = ?", s.uid(), period).Exec(ctx)
	return OpResult{Error: requireOne(res, err, "no hay conciliación para ese mes")}
}

// reconciliationBefore is the latest reconciliation strictly before `period`,
// or nil when the profile has none.
func (s *FinanceService) reconciliationBefore(ctx context.Context, uid int64, period string) (*Reconciliation, error) {
	rec := new(Reconciliation)
	err := s.db.NewSelect().Model(rec).
		Where("user_id = ? AND period < ?", uid, period).
		Order("period DESC").Limit(1).Scan(ctx)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("reconciliation before %s: %w", period, err)
	}
	return rec, nil
}

// reconciliationsIn maps each reconciled month in [from, to] to its real balance.
func (s *FinanceService) reconciliationsIn(ctx context.Context, uid int64, from, to string) (map[string]types.Decimal, error) {
	var recs []Reconciliation
	if err := s.db.NewSelect().Model(&recs).
		Where("user_id = ? AND period >= ? AND period <= ?", uid, from, to).Scan(ctx); err != nil {
		return nil, fmt.Errorf("reconciliations %s..%s: %w", from, to, err)
	}
	out := make(map[string]types.Decimal, len(recs))
	for _, r := range recs {
		out[r.Period] = r.Amount
	}
	return out, nil
}
