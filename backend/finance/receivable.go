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

// Receivable is the part of an expense someone else owes the user (a split
// bill, something paid for another). Settling it records a refund of the
// expense in the month the money arrives, so the user's net spending is their
// share — Splitwise's "you are owed" on top of the refund model. Deleting that
// refund makes the receivable pending again (ON DELETE SET NULL).
type Receivable struct {
	bun.BaseModel `bun:"table:receivables,alias:rcv"`

	ID        int64         `bun:"id,pk,autoincrement" json:"id"`
	UserID    int64         `bun:"user_id,notnull" json:"userId"`
	ExpenseID int64         `bun:"expense_id,notnull" json:"expenseId"`
	Person    string        `bun:"person,notnull" json:"person"`
	Amount    types.Decimal `bun:"amount,notnull" json:"amount"`
	RefundID  *int64        `bun:"refund_id" json:"refundId"` // nil = still owed
	CreatedAt time.Time     `bun:"created_at,nullzero,default:current_timestamp" json:"createdAt"`
}

// ReceivableView is a receivable with its expense and, once settled, the
// month it was collected in.
type ReceivableView struct {
	Receivable
	ExpenseDescription string `json:"expenseDescription"`
	ExpenseDate        string `json:"expenseDate"`   // YYYY-MM-DD
	SettledPeriod      string `json:"settledPeriod"` // YYYY-MM; "" = still owed
}

type ReceivableResult struct {
	Data  *Receivable      `json:"data,omitempty"`
	Error *shared.AppError `json:"error,omitempty"`
}

type ReceivablesResult struct {
	Data  []ReceivableView `json:"data,omitempty"`
	Error *shared.AppError `json:"error,omitempty"`
}

// CreateReceivable records that `person` owes `amount` of a live expense of
// the profile; what is owed for one expense never exceeds what it cost.
func (s *FinanceService) CreateReceivable(ctx context.Context, expenseID int64, person, amount string) ReceivableResult {
	person = strings.TrimSpace(person)
	if person == "" {
		return ReceivableResult{Error: shared.NewError(shared.ErrValidation, "indica quién te debe")}
	}
	amt, aerr := parseAmount(amount)
	if aerr != nil {
		return ReceivableResult{Error: aerr}
	}
	if amt.IsZero() {
		return ReceivableResult{Error: shared.NewError(shared.ErrValidation, "el monto debe ser mayor a 0")}
	}
	uid := s.uid()
	rcv := &Receivable{UserID: uid, ExpenseID: expenseID, Person: person, Amount: amt}
	err := s.db.RunInTx(ctx, nil, func(ctx context.Context, tx bun.Tx) error {
		ex := new(Expense)
		err := tx.NewSelect().Model(ex).Where("id = ? AND user_id = ?", expenseID, uid).Scan(ctx)
		if errors.Is(err, sql.ErrNoRows) {
			return shared.NewError(shared.ErrNotFound, "gasto no encontrado")
		}
		if err != nil {
			return fmt.Errorf("loading expense: %w", err)
		}
		owed, err := sumAmounts(ctx, tx.NewSelect().Model((*Receivable)(nil)).Where("expense_id = ? AND user_id = ?", expenseID, uid))
		if err != nil {
			return fmt.Errorf("summing receivables: %w", err)
		}
		total, err := expenseCost(ctx, tx, uid, expenseID)
		if err != nil {
			return err
		}
		if owed.Add(amt).GT(total) {
			return shared.NewError(shared.ErrValidation,
				fmt.Sprintf("lo que te deben supera lo que costó el gasto (quedan %s)", total.Sub(owed)))
		}
		_, err = tx.NewInsert().Model(rcv).Returning("*").Exec(ctx)
		return err
	})
	if err != nil {
		return ReceivableResult{Error: appErr(err)}
	}
	return ReceivableResult{Data: rcv}
}

// SettleReceivable records that a pending receivable was paid back in
// `period`: a refund of its expense, linked to it.
func (s *FinanceService) SettleReceivable(ctx context.Context, id int64, period string) ReceivableResult {
	uid := s.uid()
	rcv := new(Receivable)
	err := s.db.RunInTx(ctx, nil, func(ctx context.Context, tx bun.Tx) error {
		err := tx.NewSelect().Model(rcv).Where("id = ? AND user_id = ?", id, uid).
			Where("expense_id IN (SELECT id FROM expenses WHERE deleted_at IS NULL)").Scan(ctx)
		if errors.Is(err, sql.ErrNoRows) {
			return shared.NewError(shared.ErrNotFound, "cuenta por cobrar no encontrada")
		}
		if err != nil {
			return fmt.Errorf("loading receivable: %w", err)
		}
		if rcv.RefundID != nil {
			return shared.NewError(shared.ErrConflict, "ya está cobrada")
		}
		rf, err := insertRefund(ctx, tx, uid, rcv.ExpenseID, period, rcv.Amount.String(), "Cobrado a "+rcv.Person)
		if err != nil {
			return err
		}
		rcv.RefundID = &rf.ID
		_, err = tx.NewUpdate().Model(rcv).Column("refund_id").WherePK().Exec(ctx)
		return err
	})
	if err != nil {
		return ReceivableResult{Error: appErr(err)}
	}
	return ReceivableResult{Data: rcv}
}

// DeleteReceivable forgets a receivable; a refund it was settled with stays
// (the money did arrive).
func (s *FinanceService) DeleteReceivable(ctx context.Context, id int64) OpResult {
	res, err := s.db.NewDelete().Model((*Receivable)(nil)).Where("id = ? AND user_id = ?", id, s.uid()).Exec(ctx)
	return OpResult{Error: requireOne(res, err, "cuenta por cobrar no encontrada")}
}

// ListReceivables returns the profile's receivables of live expenses: the ones
// still owed first (oldest first), then the settled ones (newest first).
func (s *FinanceService) ListReceivables(ctx context.Context) ReceivablesResult {
	uid := s.uid()
	var rows []struct {
		Receivable
		ExpenseDescription string    `bun:"expense_description"`
		ExpenseDate        time.Time `bun:"expense_date"`
		SettledPeriod      string    `bun:"settled_period"`
	}
	if err := s.db.NewSelect().Model((*Receivable)(nil)).
		ColumnExpr("rcv.*, ex.description AS expense_description, ex.date AS expense_date, COALESCE(rf.period, '') AS settled_period").
		Join("JOIN expenses AS ex ON ex.id = rcv.expense_id AND ex.deleted_at IS NULL").
		Join("LEFT JOIN refunds AS rf ON rf.id = rcv.refund_id").
		Where("rcv.user_id = ?", uid).
		OrderExpr("rcv.refund_id IS NOT NULL, CASE WHEN rcv.refund_id IS NULL THEN rcv.id ELSE -rcv.id END").
		Scan(ctx, &rows); err != nil {
		return ReceivablesResult{Error: internalErr(err)}
	}
	out := make([]ReceivableView, 0, len(rows))
	for _, r := range rows {
		out = append(out, ReceivableView{
			Receivable:         r.Receivable,
			ExpenseDescription: r.ExpenseDescription,
			ExpenseDate:        r.ExpenseDate.UTC().Format(dateLayout),
			SettledPeriod:      r.SettledPeriod,
		})
	}
	return ReceivablesResult{Data: out}
}
