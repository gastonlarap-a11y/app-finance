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

// SourceReembolso marks a refund in the month's movimientos (negative amount).
const SourceReembolso = "reembolso"

// Refund is money returned for a specific expense — a store return, a bank
// reversal — in part or in full. It lowers the gastos of the month it arrives
// in, in the expense's category and card, so budgets and the carried balance
// stay net (the way YNAB and Monarch treat refunds). It rides along with its
// expense: a trashed expense's refunds count nowhere, like its cuotas.
type Refund struct {
	bun.BaseModel `bun:"table:refunds,alias:rf"`

	ID          int64         `bun:"id,pk,autoincrement" json:"id"`
	UserID      int64         `bun:"user_id,notnull" json:"userId"`
	ExpenseID   int64         `bun:"expense_id,notnull" json:"expenseId"`
	Period      string        `bun:"period,notnull" json:"period"` // YYYY-MM it arrived in
	Amount      types.Decimal `bun:"amount,notnull" json:"amount"` // positive
	Description string        `bun:"description,notnull" json:"description"`
	CreatedAt   time.Time     `bun:"created_at,nullzero,default:current_timestamp" json:"createdAt"`
}

// liveExpenseRefunds restricts a refunds query to expenses not in the trash.
const liveExpenseRefunds = "expense_id IN (SELECT id FROM expenses WHERE deleted_at IS NULL)"

// CreateRefund records `amount` returned for expense `expenseID` in `period`.
func (s *FinanceService) CreateRefund(ctx context.Context, expenseID int64, period, amount, description string) RefundResult {
	uid := s.uid()
	var rf *Refund
	err := s.db.RunInTx(ctx, nil, func(ctx context.Context, tx bun.Tx) error {
		var err error
		rf, err = insertRefund(ctx, tx, uid, expenseID, period, amount, description)
		return err
	})
	if err != nil {
		return RefundResult{Error: appErr(err)}
	}
	return RefundResult{Data: rf}
}

// insertRefund validates and stores a refund inside tx: the expense must be
// the profile's and live, and its refunds may never add up to more than it cost.
func insertRefund(ctx context.Context, tx bun.Tx, uid, expenseID int64, period, amount, description string) (*Refund, error) {
	if !validPeriod(period) {
		return nil, invalidPeriod()
	}
	amt, aerr := parseAmount(amount)
	if aerr != nil {
		return nil, aerr
	}
	if amt.IsZero() {
		return nil, shared.NewError(shared.ErrValidation, "el reembolso debe ser mayor a 0")
	}
	ex := new(Expense)
	err := tx.NewSelect().Model(ex).Where("id = ? AND user_id = ?", expenseID, uid).Scan(ctx)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, shared.NewError(shared.ErrNotFound, "gasto no encontrado")
	}
	if err != nil {
		return nil, fmt.Errorf("loading expense: %w", err)
	}
	refunded, err := sumAmounts(ctx, tx.NewSelect().Model((*Refund)(nil)).Where("expense_id = ?", expenseID))
	if err != nil {
		return nil, fmt.Errorf("summing refunds: %w", err)
	}
	total, err := expenseCost(ctx, tx, uid, expenseID)
	if err != nil {
		return nil, err
	}
	if refunded.Add(amt).GT(total) {
		return nil, shared.NewError(shared.ErrValidation,
			fmt.Sprintf("el reembolso supera lo que queda por devolver de ese gasto (%s)", total.Sub(refunded)))
	}
	desc := strings.TrimSpace(description)
	if desc == "" {
		desc = "Reembolso: " + ex.Description
	}
	rf := &Refund{UserID: uid, ExpenseID: expenseID, Period: period, Amount: amt, Description: desc}
	if _, err := tx.NewInsert().Model(rf).Returning("*").Exec(ctx); err != nil {
		return nil, fmt.Errorf("inserting refund: %w", err)
	}
	return rf, nil
}

// DeleteRefund forgets a refund (a bank credit confirmed as it goes back to review).
func (s *FinanceService) DeleteRefund(ctx context.Context, id int64) OpResult {
	res, err := s.db.NewDelete().Model((*Refund)(nil)).Where("id = ? AND user_id = ?", id, s.uid()).Exec(ctx)
	return OpResult{Error: requireOne(res, err, "reembolso no encontrado")}
}

// ConfirmImportItemAsRefund records a pending bank credit as a refund of an
// expense (a reversal on the card statement, a store return) instead of an
// extra income.
func (s *FinanceService) ConfirmImportItemAsRefund(ctx context.Context, id, expenseID int64, period, amount string) RefundResult {
	uid := s.uid()
	var rf *Refund
	err := s.db.RunInTx(ctx, nil, func(ctx context.Context, tx bun.Tx) error {
		item, err := loadPendingItem(ctx, tx, uid, id)
		if err != nil {
			return err
		}
		if err := requireKind(item, ImportKindCredit); err != nil {
			return err
		}
		amt, aerr := parseAmount(amount)
		if aerr != nil {
			return aerr
		}
		if err := requirePesos(item, amt); err != nil {
			return err
		}
		if rf, err = insertRefund(ctx, tx, uid, expenseID, period, amount, item.Description); err != nil {
			return err
		}
		_, err = tx.NewUpdate().Model((*ImportItem)(nil)).
			Set("status = ?", ImportConfirmado).Set("refund_id = ?", rf.ID).
			Where("id = ? AND user_id = ?", id, uid).Exec(ctx)
		return err
	})
	if err != nil {
		return RefundResult{Error: appErr(err)}
	}
	return RefundResult{Data: rf}
}

// refundWindowDays bounds how far back a bank credit is matched to the
// purchase it refunds (returns and disputes settle within weeks; 120 days
// covers a slow chargeback).
const refundWindowDays = 120

// refundReviewable reports whether an item gets a "refund of …?" suggestion:
// a pending CLP bank credit.
func refundReviewable(it ImportItem) bool {
	return it.Status == ImportPendiente && it.Kind == ImportKindCredit && it.Currency == "CLP"
}

// refundCandidates loads, in one query for the whole inbox, the live expenses
// dated up to refundWindowDays before any reviewable credit.
func (s *FinanceService) refundCandidates(ctx context.Context, uid int64, items []ImportItem) (expenseCandidates, error) {
	var from, to time.Time
	for _, it := range items {
		if !refundReviewable(it) {
			continue
		}
		d, err := time.Parse(dateLayout, it.Date)
		if err != nil {
			continue
		}
		if from.IsZero() || d.Before(from) {
			from = d
		}
		if to.IsZero() || d.After(to) {
			to = d
		}
	}
	if from.IsZero() {
		return nil, nil
	}
	var cands []Expense
	if err := s.db.NewSelect().Model(&cands).
		Where("user_id = ?", uid).
		Where("date >= ? AND date < ?",
			from.AddDate(0, 0, -refundWindowDays).Format(dateLayout), to.AddDate(0, 0, 1).Format(dateLayout)).
		Order("date DESC", "id DESC").Scan(ctx); err != nil {
		return nil, fmt.Errorf("finding refund candidates: %w", err)
	}
	return cands, nil
}

// refundOf returns the purchase a bank credit most likely refunds: named like
// it (merchant or description), costing at least the credit, dated before it
// within the window, on its card when both know one. The most recent wins.
func (c expenseCandidates) refundOf(it ImportItem, cardID *int64) *Expense {
	day, err := time.Parse(dateLayout, it.Date)
	if err != nil {
		return nil
	}
	for i := range c { // newest first
		ex := &c[i]
		purchased := dateOnly(ex.Date)
		if purchased.After(day) || day.Sub(purchased).Hours()/24 > refundWindowDays {
			continue
		}
		if cardID != nil && ex.CardID != nil && *ex.CardID != *cardID {
			continue
		}
		if ex.InstallmentAmount.MulInt(int64(ex.InstallmentsTotal)).Cmp(it.Amount) < 0 {
			continue
		}
		if namesMatch(ex.Merchant, it.Description) || namesMatch(ex.Description, it.Description) {
			return ex
		}
	}
	return nil
}

// refundRow is a live refund with what the month view needs of its expense.
type refundRow struct {
	Refund
	Category    string `bun:"category"`
	Merchant    string `bun:"merchant"`
	CardID      *int64 `bun:"card_id"`
	ExpenseDesc string `bun:"expense_description"`
}

// refundsIn lists the live refunds that arrived in [from, to].
func (s *FinanceService) refundsIn(ctx context.Context, uid int64, from, to string) ([]refundRow, error) {
	var rows []refundRow
	if err := s.db.NewRaw(`
		SELECT rf.*, e.category, e.merchant, e.card_id, e.description AS expense_description
		FROM refunds AS rf JOIN expenses AS e ON e.id = rf.expense_id
		WHERE rf.user_id = ? AND rf.period >= ? AND rf.period <= ? AND e.deleted_at IS NULL
		ORDER BY rf.id`, uid, from, to).Scan(ctx, &rows); err != nil {
		return nil, fmt.Errorf("refunds %s..%s: %w", from, to, err)
	}
	return rows, nil
}

// refundsBetween sums the live refunds of the months strictly between `after`
// ("" = from the start) and `before`: money that came back into the account.
func (s *FinanceService) refundsBetween(ctx context.Context, uid int64, after, before string) (types.Decimal, error) {
	return sumAmounts(ctx, s.db.NewSelect().Model((*Refund)(nil)).
		Where("user_id = ? AND period > ? AND period < ?", uid, after, before).Where(liveExpenseRefunds))
}

// refundMovimiento is how a refund shows among the month's movimientos: a
// negative, already-received charge in its expense's category and card.
func refundMovimiento(r refundRow) Movimiento {
	id := r.ID
	return Movimiento{
		Source:      SourceReembolso,
		ExpenseID:   r.ExpenseID,
		RefundID:    &id,
		Description: r.Description,
		Category:    r.Category,
		Merchant:    r.Merchant,
		CardID:      r.CardID,
		Kind:        SourceReembolso,
		Number:      1,
		Total:       1,
		Amount:      types.Zero().Sub(r.Amount),
		Status:      StatusPagado,
	}
}
