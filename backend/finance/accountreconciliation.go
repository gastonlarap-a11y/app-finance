package finance

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/uptrace/bun"

	"github.com/gastonlarap-a11y/app-finance/backend/shared"
	"github.com/gastonlarap-a11y/app-finance/backend/shared/types"
)

// AccountReconciliation is one account's real balance at the close of a
// month, as its bank shows it — the month's Reconciliation, per account. From
// the next month on, the account's balance starts from it instead of adding
// every flow since the opening, so a fee or an interest nobody recorded stops
// skewing it. A view like the accounts themselves: the month's summary does not
// change. One per account and month; it may be negative (an overdraft).
type AccountReconciliation struct {
	bun.BaseModel `bun:"table:account_reconciliations,alias:arec"`

	ID        int64         `bun:"id,pk,autoincrement" json:"id"`
	UserID    int64         `bun:"user_id,notnull" json:"userId"`
	AccountID int64         `bun:"account_id,notnull" json:"accountId"`
	Period    string        `bun:"period,notnull" json:"period"` // YYYY-MM of the close
	Balance   types.Decimal `bun:"balance,notnull" json:"balance"`
	CreatedAt time.Time     `bun:"created_at,nullzero,default:current_timestamp" json:"createdAt"`
	UpdatedAt time.Time     `bun:"updated_at,nullzero,default:current_timestamp" json:"updatedAt"`
}

// SetAccountReconciliation records (or replaces) an account's real balance at
// the close of `period`. A month that has not started yet cannot be closed,
// nor one before the account's opening.
func (s *FinanceService) SetAccountReconciliation(ctx context.Context, accountID int64, period, balance string) OpResult {
	if !validPeriod(period) {
		return OpResult{Error: invalidPeriod()}
	}
	if period > currentPeriod() {
		return OpResult{Error: shared.NewError(shared.ErrValidation, "no se puede conciliar un mes que aún no empieza")}
	}
	bal, aerr := parseBalance(balance)
	if aerr != nil {
		return OpResult{Error: aerr}
	}
	uid := s.uid()
	acc := new(Account)
	err := s.db.NewSelect().Model(acc).Where("id = ? AND user_id = ?", accountID, uid).Scan(ctx)
	if errors.Is(err, sql.ErrNoRows) {
		return OpResult{Error: shared.NewError(shared.ErrNotFound, "cuenta no encontrada")}
	}
	if err != nil {
		return OpResult{Error: internalErr(err)}
	}
	if period < acc.OpeningPeriod {
		return OpResult{Error: shared.NewError(shared.ErrValidation, "la cuenta empieza en "+acc.OpeningPeriod+": concilia desde ese mes")}
	}
	rec := &AccountReconciliation{UserID: uid, AccountID: accountID, Period: period, Balance: bal, UpdatedAt: time.Now()}
	if _, err := s.db.NewInsert().Model(rec).
		On("CONFLICT (account_id, period) DO UPDATE").
		Set("balance = EXCLUDED.balance").
		Set("updated_at = EXCLUDED.updated_at").
		Exec(ctx); err != nil {
		return OpResult{Error: internalErr(err)}
	}
	return OpResult{}
}

// DeleteAccountReconciliation forgets an account's real balance of `period`:
// its balance goes back to the previous reconciliation (or the opening).
func (s *FinanceService) DeleteAccountReconciliation(ctx context.Context, accountID int64, period string) OpResult {
	if !validPeriod(period) {
		return OpResult{Error: invalidPeriod()}
	}
	res, err := s.db.NewDelete().Model((*AccountReconciliation)(nil)).
		Where("user_id = ? AND account_id = ? AND period = ?", s.uid(), accountID, period).Exec(ctx)
	return OpResult{Error: requireOne(res, err, "esa cuenta no tiene conciliación en ese mes")}
}

// accountReconciliationsUpTo returns uid's account reconciliations up to
// `period`, by account and oldest first.
func (s *FinanceService) accountReconciliationsUpTo(ctx context.Context, uid int64, period string) (map[int64][]AccountReconciliation, error) {
	var recs []AccountReconciliation
	if err := s.db.NewSelect().Model(&recs).Where("user_id = ? AND period <= ?", uid, period).
		Order("period ASC").Scan(ctx); err != nil {
		return nil, fmt.Errorf("account reconciliations up to %s: %w", period, err)
	}
	out := map[int64][]AccountReconciliation{}
	for _, r := range recs {
		out[r.AccountID] = append(out[r.AccountID], r)
	}
	return out, nil
}

// accountStart is where an account's balance at `period` starts adding flows:
// its latest reconciliation before `period` (from the month after it) or its
// opening. A reconciliation before the opening (the opening was moved later)
// is ignored. `here` is the reconciliation of `period` itself, if any.
func accountStart(a Account, recs []AccountReconciliation, period string) (from string, balance types.Decimal, here *AccountReconciliation) {
	from, balance = a.OpeningPeriod, a.OpeningBalance
	for i := range recs {
		r := &recs[i]
		switch {
		case r.Period < a.OpeningPeriod:
		case r.Period < period:
			from, balance = addMonths(r.Period, 1), r.Balance
		case r.Period == period:
			here = r
		}
	}
	return from, balance, here
}
