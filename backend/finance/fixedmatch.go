package finance

import (
	"context"
	"fmt"
	"strings"
	"time"
	"unicode"

	"github.com/shopspring/decimal"
	"github.com/uptrace/bun"

	"github.com/gastonlarap-a11y/app-finance/backend/shared"
	"github.com/gastonlarap-a11y/app-finance/backend/shared/types"
)

// A bank charge is offered as a fixed expense's monthly bill when both the
// merchant and the amount agree, the way Actual Budget matches imports to its
// schedules: the name must match, and the amount only approximately, because a
// fixed expense's amount is an estimate (a phone bill of $16.990 against the
// $17.000 planned). The suggestion never applies itself: the user links it.
var fixedMatchTolerance = decimal.RequireFromString("0.075")

// minMatchTokenLen keeps short words ("sub", "com", "pcs") from matching.
const minMatchTokenLen = 4

// fixedMonth identifies one billed month of a fixed expense.
type fixedMonth struct {
	id     int64
	period string
}

// fixedIndex is what suggestFixed needs about the user's live fixed expenses.
type fixedIndex struct {
	fixed   []FixedExpense
	amounts map[int64][]FixedExpenseAmount
	paid    map[fixedMonth]bool
}

func (s *FinanceService) loadFixedIndex(ctx context.Context, uid int64) (fixedIndex, error) {
	fixed, amounts, err := s.loadFixed(ctx, uid, false)
	if err != nil {
		return fixedIndex{}, fmt.Errorf("loading fixed expenses: %w", err)
	}
	ix := fixedIndex{fixed: fixed, amounts: amounts, paid: map[fixedMonth]bool{}}
	if len(fixed) == 0 {
		return ix, nil
	}
	ids := make([]int64, len(fixed))
	for i, fe := range fixed {
		ids[i] = fe.ID
	}
	var payments []FixedExpensePayment
	if err := s.db.NewSelect().Model(&payments).Where("fixed_expense_id IN (?)", bun.List(ids)).Scan(ctx); err != nil {
		return fixedIndex{}, fmt.Errorf("loading fixed payments: %w", err)
	}
	for _, p := range payments {
		ix.paid[fixedMonth{p.FixedExpenseID, p.Period}] = true
	}
	return ix, nil
}

// billingPeriodOf is the month an item is billed in: the one its card
// statement states, else its date rolled by its card's cutoff (0 = no card).
func billingPeriodOf(it ImportItem, billingDay int) string {
	if it.FirstPeriod != "" {
		return it.FirstPeriod
	}
	date, err := time.Parse(dateLayout, it.Date)
	if err != nil {
		return ""
	}
	return periodOf(date, billingDay)
}

// suggest returns the fixed expense whose still-unpaid month `period` the item
// most likely bills: same merchant, amount within the tolerance (the closest
// wins), and the same card when both name one. clp is the item's amount in
// pesos; a zero clp (a USD item without a known rate) never matches.
func (ix fixedIndex) suggest(it ImportItem, period string, cardID *int64, clp types.Decimal) (*FixedExpense, bool) {
	if period == "" || clp.IsZero() {
		return nil, false
	}
	var best *FixedExpense
	bestGap := decimal.Zero
	for i := range ix.fixed {
		fe := &ix.fixed[i]
		if !fe.activeIn(period) || ix.paid[fixedMonth{fe.ID, period}] {
			continue
		}
		if fe.CardID != nil && cardID != nil && *fe.CardID != *cardID {
			continue
		}
		if !namesMatch(fe.Description, it.Description) {
			continue
		}
		planned := resolveAsOf(ix.amounts[fe.ID], period)
		if planned.IsZero() {
			continue
		}
		gap := clp.Decimal.Sub(planned.Decimal).Abs().Div(planned.Decimal)
		if gap.GreaterThan(fixedMatchTolerance) {
			continue
		}
		if best == nil || gap.LessThan(bestGap) {
			best, bestGap = fe, gap
		}
	}
	return best, best != nil
}

// namesMatch reports whether a fixed expense's name and a bank descriptor share
// a significant word, allowing one to prefix the other ("Proseguro" and
// "PROSEGUR ACTIVA", "Claude" and "ANTHROPIC* CLAUDE SUB").
func namesMatch(fixedName, descriptor string) bool {
	for _, a := range matchTokens(fixedName) {
		for _, b := range matchTokens(descriptor) {
			if strings.HasPrefix(a, b) || strings.HasPrefix(b, a) {
				return true
			}
		}
	}
	return false
}

// matchTokens splits text into its lowercase letter runs of at least
// minMatchTokenLen letters ("APPLE.COM/BILL" → apple, bill).
func matchTokens(s string) []string {
	var out []string
	for w := range strings.FieldsFuncSeq(strings.ToLower(s), func(r rune) bool { return !unicode.IsLetter(r) }) {
		if len([]rune(w)) >= minMatchTokenLen {
			out = append(out, w)
		}
	}
	return out
}

// LinkImportItemToFixed records a pending bank charge as the bill of a fixed
// expense for `period`: that month is marked paid instead of adding an
// expense. As with a schedule matched in YNAB or Actual Budget, the bank's real
// amount replaces the estimate — for that month only: when a CLP charge differs
// from the planned amount, the month gets the real one and the next month
// keeps the previous plan.
func (s *FinanceService) LinkImportItemToFixed(ctx context.Context, id, fixedID int64, period string) OpResult {
	if !validPeriod(period) {
		return OpResult{Error: invalidPeriod()}
	}
	uid := s.uid()
	err := s.db.RunInTx(ctx, nil, func(ctx context.Context, tx bun.Tx) error {
		item, err := loadPendingItem(ctx, tx, uid, id)
		if err != nil {
			return err
		}
		if err := requireKind(item, ImportKindExpense); err != nil {
			return err
		}
		fe, err := ownFixedExpense(ctx, tx, uid, fixedID)
		if err != nil {
			return err
		}
		if err := requireActiveIn(fe, period, "enlazarlo"); err != nil {
			return err
		}
		taken, err := tx.NewSelect().Model((*ImportItem)(nil)).
			Where("user_id = ? AND fixed_expense_id = ? AND fixed_period = ?", uid, fixedID, period).Exists(ctx)
		if err != nil {
			return fmt.Errorf("checking fixed links: %w", err)
		}
		if taken {
			return shared.NewError(shared.ErrConflict, "ese mes del gasto fijo ya está enlazado a otro movimiento del banco")
		}
		if item.Currency == "CLP" {
			if err := applyMonthAmount(ctx, tx, fe, period, item.Amount); err != nil {
				return err
			}
		}
		now := time.Now()
		payment := &FixedExpensePayment{FixedExpenseID: fixedID, Period: period, PaidAt: &now}
		if _, err := tx.NewInsert().Model(payment).
			On("CONFLICT (fixed_expense_id, period) DO UPDATE").Set("paid_at = EXCLUDED.paid_at").Exec(ctx); err != nil {
			return fmt.Errorf("marking fixed month paid: %w", err)
		}
		_, err = tx.NewUpdate().Model((*ImportItem)(nil)).
			Set("status = ?", ImportConfirmado).Set("fixed_expense_id = ?", fixedID).Set("fixed_period = ?", period).
			Where("id = ? AND user_id = ?", id, uid).Exec(ctx)
		return err
	})
	if err != nil {
		return OpResult{Error: appErr(err)}
	}
	return OpResult{}
}

// applyMonthAmount makes `amount` the fixed expense's amount for `period` alone:
// it writes an override at period and, unless one already exists, restores the
// previous plan from the next month on (while the fixed expense still bills).
func applyMonthAmount(ctx context.Context, tx bun.Tx, fe *FixedExpense, period string, amount types.Decimal) error {
	var rows []FixedExpenseAmount
	if err := tx.NewSelect().Model(&rows).Where("fixed_expense_id = ?", fe.ID).Scan(ctx); err != nil {
		return fmt.Errorf("loading fixed amounts: %w", err)
	}
	planned := resolveAsOf(rows, period)
	if planned.Cmp(amount) == 0 {
		return nil
	}
	next := addMonths(period, 1)
	hasNext := false
	for _, r := range rows {
		if r.EffectiveFrom == next {
			hasNext = true
		}
	}
	upsert := func(from string, v types.Decimal) error {
		row := &FixedExpenseAmount{FixedExpenseID: fe.ID, EffectiveFrom: from, Amount: v}
		_, err := tx.NewInsert().Model(row).
			On("CONFLICT (fixed_expense_id, effective_from) DO UPDATE").Set("amount = EXCLUDED.amount").Exec(ctx)
		return err
	}
	if !hasNext && (fe.EndPeriod == "" || next <= fe.EndPeriod) {
		if err := upsert(next, resolveAsOf(rows, next)); err != nil {
			return fmt.Errorf("keeping next month's amount: %w", err)
		}
	}
	if err := upsert(period, amount); err != nil {
		return fmt.Errorf("setting the month's amount: %w", err)
	}
	return nil
}
