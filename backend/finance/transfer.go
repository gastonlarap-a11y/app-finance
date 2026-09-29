package finance

import (
	"context"
	"strings"
	"time"

	"github.com/uptrace/bun"

	"github.com/gastonlarap-a11y/app-finance/backend/shared"
	"github.com/gastonlarap-a11y/app-finance/backend/shared/types"
)

// How much a transfer moves each month.
const (
	TransferFixed      = "fixed"       // Amount, every month the transfer covers
	TransferSalaryRest = "salary_rest" // the month's salary minus Amount, which stays in the source account
)

// Transfer moves money between two of the profile's own accounts (the salary
// passed on to the everyday account, topping up a digital wallet). It is
// neither an expense nor an income: the app's total balance and every month's
// summary ignore it, and only the two accounts' balances move. One-off when
// EndPeriod == StartPeriod; every month from StartPeriod when EndPeriod is "".
type Transfer struct {
	bun.BaseModel `bun:"table:transfers,alias:tr"`

	ID            int64         `bun:"id,pk,autoincrement" json:"id"`
	UserID        int64         `bun:"user_id,notnull" json:"userId"`
	FromAccountID int64         `bun:"from_account_id,notnull" json:"fromAccountId"`
	ToAccountID   int64         `bun:"to_account_id,notnull" json:"toAccountId"`
	Description   string        `bun:"description,notnull" json:"description"`
	Mode          string        `bun:"mode,notnull" json:"mode"`                // TransferFixed | TransferSalaryRest
	Amount        types.Decimal `bun:"amount,notnull" json:"amount"`            // salary_rest: what stays behind
	StartPeriod   string        `bun:"start_period,notnull" json:"startPeriod"` // YYYY-MM
	EndPeriod     string        `bun:"end_period,notnull" json:"endPeriod"`     // YYYY-MM last month; "" = every month
	CreatedAt     time.Time     `bun:"created_at,nullzero,default:current_timestamp" json:"createdAt"`
}

// activeIn reports whether the transfer moves money in period.
func (t Transfer) activeIn(period string) bool {
	return period >= t.StartPeriod && (t.EndPeriod == "" || period <= t.EndPeriod)
}

// moved is what the transfer moves in a month whose salary is `salary`: a
// salary_rest transfer never moves less than nothing (a month without salary
// yet moves 0).
func (t Transfer) moved(salary types.Decimal) types.Decimal {
	if t.Mode != TransferSalaryRest {
		return t.Amount
	}
	rest := salary.Sub(t.Amount)
	if rest.IsNegative() {
		return types.Zero()
	}
	return rest
}

type TransferResult struct {
	Data  *Transfer        `json:"data,omitempty"`
	Error *shared.AppError `json:"error,omitempty"`
}

// validTransfer checks what a transfer needs besides account ownership. A
// fixed transfer moves a positive amount; a salary_rest one may keep nothing
// behind (it then passes the whole salary on).
func validTransfer(from, to int64, description, mode, amount string) (string, types.Decimal, *shared.AppError) {
	if from == to {
		return "", types.Zero(), shared.NewError(shared.ErrValidation, "la cuenta de origen y la de destino deben ser distintas")
	}
	if mode != TransferFixed && mode != TransferSalaryRest {
		return "", types.Zero(), shared.NewError(shared.ErrValidation, "tipo de transferencia inválido: "+mode)
	}
	amt, err := types.New(strings.TrimSpace(amount))
	if err != nil || amt.IsNegative() || (mode == TransferFixed && amt.IsZero()) {
		return "", types.Zero(), shared.NewError(shared.ErrValidation, "monto inválido: "+amount)
	}
	return strings.TrimSpace(description), amt, nil
}

// ownAccounts proves both ends of a transfer are uid's accounts and, for a
// salary_rest transfer, that it leaves from the account the salary lands in.
func ownAccounts(ctx context.Context, idb bun.IDB, uid, from, to int64, mode string) *shared.AppError {
	for _, id := range []int64{from, to} {
		if aerr := ownAccount(ctx, idb, uid, &id); aerr != nil {
			return aerr
		}
	}
	if mode != TransferSalaryRest {
		return nil
	}
	salary, err := idb.NewSelect().Model((*Account)(nil)).
		Where("id = ? AND user_id = ? AND receives_salary = 1", from, uid).Exists(ctx)
	if err != nil {
		return internalErr(err)
	}
	if !salary {
		return shared.NewError(shared.ErrValidation, "para pasar el resto del sueldo, la cuenta de origen debe ser la que recibe el sueldo")
	}
	return nil
}

// ListTransfers returns the profile's transfers, the newest start first.
func (s *FinanceService) ListTransfers(ctx context.Context) ([]Transfer, error) {
	out := []Transfer{}
	err := s.db.NewSelect().Model(&out).Where("user_id = ?", s.uid()).Order("start_period DESC", "id DESC").Scan(ctx)
	return out, err
}

// CreateTransfer records money moved between two own accounts in startPeriod,
// and in every month after it when monthly. `mode` says whether `amount` moves
// as is (fixed) or stays behind while the rest of the month's salary moves.
func (s *FinanceService) CreateTransfer(
	ctx context.Context, fromAccountID, toAccountID int64, description, mode, amount, startPeriod string, monthly bool,
) TransferResult {
	desc, amt, aerr := validTransfer(fromAccountID, toAccountID, description, mode, amount)
	if aerr != nil {
		return TransferResult{Error: aerr}
	}
	if !validPeriod(startPeriod) {
		return TransferResult{Error: invalidPeriod()}
	}
	uid := s.uid()
	if aerr := ownAccounts(ctx, s.db, uid, fromAccountID, toAccountID, mode); aerr != nil {
		return TransferResult{Error: aerr}
	}
	end := startPeriod
	if monthly {
		end = ""
	}
	tr := &Transfer{UserID: uid, FromAccountID: fromAccountID, ToAccountID: toAccountID, Description: desc,
		Mode: mode, Amount: amt, StartPeriod: startPeriod, EndPeriod: end}
	if _, err := s.db.NewInsert().Model(tr).Returning("*").Exec(ctx); err != nil {
		return TransferResult{Error: internalErr(err)}
	}
	return TransferResult{Data: tr}
}

// UpdateTransfer changes a transfer's accounts, description, mode and amount
// for every month it covers (to change it from a month on, end it and create a
// new one).
func (s *FinanceService) UpdateTransfer(
	ctx context.Context, id, fromAccountID, toAccountID int64, description, mode, amount string,
) TransferResult {
	desc, amt, aerr := validTransfer(fromAccountID, toAccountID, description, mode, amount)
	if aerr != nil {
		return TransferResult{Error: aerr}
	}
	uid := s.uid()
	tr := new(Transfer)
	err := s.db.RunInTx(ctx, nil, func(ctx context.Context, tx bun.Tx) error {
		if aerr := ownAccounts(ctx, tx, uid, fromAccountID, toAccountID, mode); aerr != nil {
			return aerr
		}
		res, err := tx.NewUpdate().Model((*Transfer)(nil)).
			Set("from_account_id = ?", fromAccountID).Set("to_account_id = ?", toAccountID).
			Set("description = ?", desc).Set("mode = ?", mode).Set("amount = ?", amt).
			Where("id = ? AND user_id = ?", id, uid).Exec(ctx)
		if aerr := requireOne(res, err, "transferencia no encontrada"); aerr != nil {
			return aerr
		}
		return tx.NewSelect().Model(tr).Where("id = ? AND user_id = ?", id, uid).Scan(ctx)
	})
	if err != nil {
		return TransferResult{Error: appErr(err)}
	}
	return TransferResult{Data: tr}
}

// EndTransfer stops a monthly transfer after lastPeriod (its months up to then
// stay as they were).
func (s *FinanceService) EndTransfer(ctx context.Context, id int64, lastPeriod string) OpResult {
	if !validPeriod(lastPeriod) {
		return OpResult{Error: invalidPeriod()}
	}
	res, err := s.db.NewUpdate().Model((*Transfer)(nil)).Set("end_period = ?", lastPeriod).
		Where("id = ? AND user_id = ? AND start_period <= ?", id, s.uid(), lastPeriod).Exec(ctx)
	return OpResult{Error: requireOne(res, err, "transferencia no encontrada (o el mes es anterior a su inicio)")}
}

// DeleteTransfer removes a transfer from every month it covered.
func (s *FinanceService) DeleteTransfer(ctx context.Context, id int64) OpResult {
	res, err := s.db.NewDelete().Model((*Transfer)(nil)).Where("id = ? AND user_id = ?", id, s.uid()).Exec(ctx)
	return OpResult{Error: requireOne(res, err, "transferencia no encontrada")}
}
