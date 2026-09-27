package finance

import (
	"context"
	"fmt"

	"github.com/uptrace/bun"

	"github.com/gastonlarap-a11y/app-finance/backend/shared"
	"github.com/gastonlarap-a11y/app-finance/backend/shared/types"
)

// Cuotas that do not follow the plain plan: banks round a purchase's cuota and
// settle the difference in the last one, and a plan can be paid off early.
// Paid cuotas record money already paid and are never rewritten.

// pendingCuotaOf loads a pending cuota of a live expense of the profile.
func pendingCuotaOf(ctx context.Context, idb bun.IDB, uid, id int64) (*Installment, *shared.AppError) {
	inst := new(Installment)
	err := idb.NewSelect().Model(inst).
		Where("id = ? AND user_id = ?", id, uid).
		Where("expense_id IN (SELECT id FROM expenses WHERE user_id = ? AND deleted_at IS NULL)", uid).
		Scan(ctx)
	if err != nil {
		return nil, shared.NewError(shared.ErrNotFound, "cuota no encontrada")
	}
	if inst.Status == StatusPagado {
		return nil, shared.NewError(shared.ErrValidation, "la cuota ya está pagada: desmárcala para cambiarla")
	}
	return inst, nil
}

// SetInstallmentAmount changes the amount of one pending cuota (the bank's
// rounded last cuota, a renegotiated one). Editing the expense later applies
// its cuota amount to every pending cuota again.
func (s *FinanceService) SetInstallmentAmount(ctx context.Context, id int64, amount string) OpResult {
	amt, aerr := parseAmount(amount)
	if aerr != nil {
		return OpResult{Error: aerr}
	}
	if amt.IsZero() {
		return OpResult{Error: shared.NewError(shared.ErrValidation, "el monto debe ser mayor a 0")}
	}
	uid := s.uid()
	if _, aerr := pendingCuotaOf(ctx, s.db, uid, id); aerr != nil {
		return OpResult{Error: aerr}
	}
	res, err := s.db.NewUpdate().Model((*Installment)(nil)).Set("amount = ?", amt).
		Where("id = ? AND user_id = ?", id, uid).Exec(ctx)
	return OpResult{Error: requireOne(res, err, "cuota no encontrada")}
}

// PrepayExpense pays off a plan early: every pending cuota moves to `period`,
// the month the balance is paid, keeping its amount; paid cuotas stay where
// they are.
func (s *FinanceService) PrepayExpense(ctx context.Context, expenseID int64, period string) OpResult {
	if !validPeriod(period) {
		return OpResult{Error: invalidPeriod()}
	}
	uid := s.uid()
	err := s.db.RunInTx(ctx, nil, func(ctx context.Context, tx bun.Tx) error {
		live, err := tx.NewSelect().Model((*Expense)(nil)).Where("id = ? AND user_id = ?", expenseID, uid).Exists(ctx)
		if err != nil {
			return err
		}
		if !live {
			return shared.NewError(shared.ErrNotFound, "gasto no encontrado")
		}
		res, err := tx.NewUpdate().Model((*Installment)(nil)).Set("period = ?", period).
			Where("expense_id = ? AND user_id = ? AND status = ?", expenseID, uid, StatusPendiente).Exec(ctx)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return shared.NewError(shared.ErrValidation, "el gasto no tiene cuotas pendientes")
		}
		return nil
	})
	if err != nil {
		return OpResult{Error: appErr(err)}
	}
	return OpResult{}
}

// bankRounded reports whether an expense follows a CLP bank item's own plan
// (same cuota count and cuota), so the item's purchase total is the plan's.
func bankRounded(item *ImportItem, ex *Expense) bool {
	if item.Currency != "CLP" || item.InstallmentAmount == "" || ex.InstallmentsTotal < 2 ||
		ex.InstallmentsTotal != item.InstallmentsTotal {
		return false
	}
	cuota, aerr := parseAmount(item.InstallmentAmount)
	return aerr == nil && cuota.Cmp(ex.InstallmentAmount) == 0
}

// settleLastCuota makes a plan add up to the bank's purchase total: banks
// round the cuota and settle the difference in the last one (60.001 in 6 is
// five of 10.000 and one of 10.001). Only a pending last cuota changes, and
// only when the difference leaves it positive.
func settleLastCuota(ctx context.Context, tx bun.Tx, uid, expenseID int64, total types.Decimal) error {
	var insts []Installment
	if err := tx.NewSelect().Model(&insts).
		Where("expense_id = ? AND user_id = ?", expenseID, uid).Order("number ASC").Scan(ctx); err != nil {
		return fmt.Errorf("loading cuotas: %w", err)
	}
	if len(insts) < 2 {
		return nil
	}
	last := insts[len(insts)-1]
	others := types.Zero()
	for _, inst := range insts[:len(insts)-1] {
		others = others.Add(inst.Amount)
	}
	want := total.Sub(others)
	if last.Status == StatusPagado || !want.GT(types.Zero()) || want.Cmp(last.Amount) == 0 {
		return nil
	}
	if _, err := tx.NewUpdate().Model((*Installment)(nil)).Set("amount = ?", want).
		Where("id = ? AND user_id = ?", last.ID, uid).Exec(ctx); err != nil {
		return fmt.Errorf("settling the last cuota: %w", err)
	}
	return nil
}
