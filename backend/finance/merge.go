package finance

import (
	"context"
	"fmt"
	"time"

	"github.com/uptrace/bun"
)

// Merging a bank movement into an expense the user entered by hand — the
// "matching" of YNAB and Actual Budget. The bank is the source of truth for
// when and how much: date, amount, cuotas and billing month (Actual always
// favors the imported side). The user's own words stay: description,
// category, merchant and tags (YNAB keeps what you entered). The bank's
// descriptor is kept apart (bank_description) and its reference code comes
// with the link, so nothing either side knew is lost.

// mergeWindowDays is how far the user's date may be from the bank's for a
// match (YNAB's window: ten days).
const mergeWindowDays = 10

// bankLinked reports whether an expense already carries a bank movement: an
// inbox item confirmed into it, or a statement line billing one of its cuotas.
// Only expenses without one are the user's manual entries a movement may
// complete.
func bankLinked(ctx context.Context, idb bun.IDB, uid, expenseID int64) (bool, error) {
	linked, err := idb.NewSelect().Model((*ImportItem)(nil)).
		Where("user_id = ? AND expense_id = ?", uid, expenseID).Exists(ctx)
	if err != nil || linked {
		return linked, err
	}
	return idb.NewSelect().TableExpr("card_statement_lines AS l").
		Join("JOIN installments AS i ON i.id = l.installment_id").
		Where("l.user_id = ? AND i.expense_id = ?", uid, expenseID).Exists(ctx)
}

// manualMatch finds the one expense the user entered by hand for this
// statement purchase: on the statement's card, not linked to any bank
// movement, dated within mergeWindowDays of the bank's date, with the
// purchase's total or the bank's cuota as its amount. More than one
// candidate (or an unknown card) is left to the inbox, where the user picks.
func manualMatch(ctx context.Context, tx bun.Tx, uid int64, card *Card, c ImportCandidate, skip map[int64]bool) (*Expense, error) {
	if card == nil {
		return nil, nil
	}
	day, err := time.Parse(dateLayout, c.Date)
	if err != nil {
		return nil, fmt.Errorf("candidate date: %w", err)
	}
	var cands []Expense
	if err := tx.NewSelect().Model(&cands).
		Where("user_id = ? AND card_id = ?", uid, card.ID).
		Where("date >= ? AND date < ?",
			day.AddDate(0, 0, -mergeWindowDays).Format(dateLayout),
			day.AddDate(0, 0, mergeWindowDays+1).Format(dateLayout)).
		Where("id NOT IN (SELECT expense_id FROM import_items WHERE user_id = ? AND expense_id IS NOT NULL)", uid).
		Where(`id NOT IN (SELECT i.expense_id FROM card_statement_lines AS l
			JOIN installments AS i ON i.id = l.installment_id WHERE l.user_id = ?)`, uid).
		Order("id ASC").Scan(ctx); err != nil {
		return nil, fmt.Errorf("finding manual expenses: %w", err)
	}
	var found *Expense
	for i := range cands {
		ex := &cands[i]
		if skip[ex.ID] || !sameAmount(ex, c.Amount, c.InstallmentAmount) {
			continue
		}
		if found != nil {
			return nil, nil // ambiguous: the user decides in the inbox
		}
		found = ex
	}
	return found, nil
}

// sameAmount: the expense's total equals the purchase total, or its cuota
// equals the bank's cuota.
func sameAmount(ex *Expense, total, cuota string) bool {
	exTotal := ex.InstallmentAmount.MulInt(int64(max(ex.InstallmentsTotal, 1)))
	if t, aerr := parseAmount(total); aerr == nil && (exTotal.Cmp(t) == 0 || ex.InstallmentAmount.Cmp(t) == 0) {
		return true
	}
	q, aerr := parseAmount(cuota)
	return cuota != "" && aerr == nil && ex.InstallmentAmount.Cmp(q) == 0
}

// mergeIntoExpense completes the user's expense with a pending item's bank
// facts and confirms the item into it. A paid cuota records money already
// paid and is never rewritten: when the bank's plan would move or drop one,
// the plan stays as the user has it and only the date and words are taken.
func mergeIntoExpense(ctx context.Context, tx bun.Tx, uid int64, item *ImportItem, ex *Expense, cutoff cardCutoff) error {
	date, err := time.Parse(dateLayout, item.Date)
	if err != nil {
		return fmt.Errorf("item date: %w", err)
	}
	merged := *ex
	merged.Date = date
	merged.BankDescription = item.Description
	bankPlan := item.Currency == "CLP" // a USD item's amount is not the expense's pesos
	if bankPlan {
		applyBankAmount(&merged, item)
	}

	var insts []Installment
	if err := tx.NewSelect().Model(&insts).
		Where("expense_id = ? AND user_id = ?", ex.ID, uid).Order("number ASC").Scan(ctx); err != nil {
		return fmt.Errorf("loading installments: %w", err)
	}
	first := item.FirstPeriod
	if first == "" || merged.InstallmentsTotal != item.InstallmentsTotal {
		first = cutoff.periodOf(date)
	}
	if !replannable(insts, merged.InstallmentsTotal, first) {
		merged.Kind, merged.InstallmentAmount, merged.InstallmentsTotal = ex.Kind, ex.InstallmentAmount, ex.InstallmentsTotal
		bankPlan = false
		if len(insts) > 0 {
			first = insts[0].Period
		}
	}

	if _, err := tx.NewUpdate().Model(&merged).
		Column("date", "bank_description", "kind", "installment_amount", "installments_total").
		WherePK().Where("user_id = ?", uid).Exec(ctx); err != nil {
		return fmt.Errorf("merging expense: %w", err)
	}
	if err := replanInstallments(ctx, tx, &merged, placementChange{after: first}); err != nil {
		return err
	}
	// The statement's cuota n means cuotas 1..n-1 were already billed.
	if bankPlan && item.FirstPeriod != "" && item.InstallmentNumber > 1 {
		if _, err := tx.NewUpdate().Model((*Installment)(nil)).
			Set("status = ?", StatusPagado).Set("paid_at = ?", time.Now()).
			Where("expense_id = ? AND user_id = ? AND number < ? AND status = ?", ex.ID, uid, item.InstallmentNumber, StatusPendiente).
			Exec(ctx); err != nil {
			return fmt.Errorf("marking billed cuotas: %w", err)
		}
	}
	if _, err := tx.NewUpdate().Model((*ImportItem)(nil)).
		Set("status = ?", ImportConfirmado).Set("expense_id = ?", ex.ID).
		Where("id = ? AND user_id = ?", item.ID, uid).Exec(ctx); err != nil {
		return fmt.Errorf("confirming merged item: %w", err)
	}
	return nil
}

// applyBankAmount takes the bank's cuota plan when it knows it: the exact
// cuota of a statement, or the amount of a one-payment movement. An alert
// with N cuotas but no cuota amount keeps the user's plan.
func applyBankAmount(ex *Expense, item *ImportItem) {
	total := max(item.InstallmentsTotal, 1)
	switch {
	case item.InstallmentAmount != "":
		if q, aerr := parseAmount(item.InstallmentAmount); aerr == nil {
			ex.InstallmentAmount, ex.InstallmentsTotal = q, total
		}
	case total == 1:
		ex.InstallmentAmount, ex.InstallmentsTotal = item.Amount, 1
	default:
		return
	}
	ex.Kind = KindUnico
	if ex.InstallmentsTotal > 1 {
		ex.Kind = KindCuotas
	}
}

// replannable mirrors replanInstallments' refusals: no paid cuota past the new
// total, and none moved to another month.
func replannable(insts []Installment, total int, first string) bool {
	lastPaid := 0
	for _, inst := range insts {
		if inst.Status == StatusPagado {
			lastPaid = max(lastPaid, inst.Number)
		}
	}
	return lastPaid == 0 || (lastPaid <= total && len(insts) > 0 && insts[0].Period == first)
}
