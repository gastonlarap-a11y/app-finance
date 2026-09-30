package finance

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/uptrace/bun"

	"github.com/gastonlarap-a11y/app-finance/backend/shared"
	"github.com/gastonlarap-a11y/app-finance/backend/shared/types"
)

// Cuotas that do not follow the plain plan: banks round a purchase's cuota and
// settle the difference in the last one, and a plan can be paid off early.
// Paid cuotas record money already paid and are never rewritten.

// expenseCost is what an expense really costs: the sum of its cuotas, which
// differs from cuota × N once the bank rounded the last one or one was set by
// hand. The caller has proved the expense is uid's.
func expenseCost(ctx context.Context, idb bun.IDB, uid, expenseID int64) (types.Decimal, error) {
	cost, err := sumAmounts(ctx, idb.NewSelect().Model((*Installment)(nil)).
		Where("expense_id = ? AND user_id = ?", expenseID, uid))
	if err != nil {
		return types.Zero(), fmt.Errorf("expense %d cost: %w", expenseID, err)
	}
	return cost, nil
}

// cuotaProgress is where a plan stands at a month: what its cuotas billed up to
// that month add up to, what the later ones will, and how many those are.
type cuotaProgress struct {
	soFar, remaining types.Decimal
	remainingCount   int
}

// cuotaProgressAt is the progress at `period` of every plan (more than one
// cuota) among the month's cuotas, by expense. It goes by each cuota's month,
// not its number: a plan prepaid into this month is all "so far".
func (s *FinanceService) cuotaProgressAt(ctx context.Context, uid int64, period string, insts []Installment) (map[int64]cuotaProgress, error) {
	out := map[int64]cuotaProgress{}
	var ids []int64
	for _, inst := range insts {
		if inst.Total > 1 {
			ids = append(ids, inst.ExpenseID)
		}
	}
	if len(ids) == 0 {
		return out, nil
	}
	var rows []struct {
		ExpenseID int64         `bun:"expense_id"`
		Period    string        `bun:"period"`
		Amount    types.Decimal `bun:"amount"`
	}
	if err := s.db.NewSelect().Model((*Installment)(nil)).Column("expense_id", "period", "amount").
		Where("user_id = ? AND expense_id IN (?)", uid, bun.List(ids)).Scan(ctx, &rows); err != nil {
		return nil, fmt.Errorf("loading plans: %w", err)
	}
	for _, r := range rows {
		p := out[r.ExpenseID]
		if r.Period <= period {
			p.soFar = p.soFar.Add(r.Amount)
		} else {
			p.remaining = p.remaining.Add(r.Amount)
			p.remainingCount++
		}
		out[r.ExpenseID] = p
	}
	for id, p := range out { // zero values print as 0, not as an empty decimal
		p.soFar, p.remaining = types.Zero().Add(p.soFar), types.Zero().Add(p.remaining)
		out[id] = p
	}
	return out, nil
}

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
// rounded last cuota, a renegotiated one). Editing the expense keeps it unless
// the edit changes the expense's cuota amount, which then reaches every
// pending cuota.
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
		// A plan cannot be paid off before it started.
		var first string
		if err := tx.NewSelect().Model((*Installment)(nil)).ColumnExpr("MIN(period)").
			Where("expense_id = ? AND user_id = ?", expenseID, uid).Scan(ctx, &first); err != nil {
			return fmt.Errorf("finding the plan's first month: %w", err)
		}
		if period < first {
			return shared.NewError(shared.ErrValidation, "no puedes pagar por adelantado antes de la primera cuota ("+first+")")
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

// DeferExpense moves a plan so its first cuota falls in `period`: the bank
// postponed it ("compra hoy, primera cuota en 3 meses"). Every cuota keeps its
// distance to the first, so a plan's own shape (a prepayment) survives. The plan
// cannot start before the purchase's billing month, and a paid cuota pins it:
// money already paid does not move. Editing the expense keeps the months while
// its date and card lead to the same billing month (replanInstallments).
func (s *FinanceService) DeferExpense(ctx context.Context, expenseID int64, period string) OpResult {
	if !validPeriod(period) {
		return OpResult{Error: invalidPeriod()}
	}
	uid := s.uid()
	ex := new(Expense)
	err := s.db.NewSelect().Model(ex).Where("id = ? AND user_id = ?", expenseID, uid).Scan(ctx)
	if errors.Is(err, sql.ErrNoRows) {
		return OpResult{Error: shared.NewError(shared.ErrNotFound, "gasto no encontrado")}
	}
	if err != nil {
		return OpResult{Error: internalErr(err)}
	}
	// Before the transaction: the single connection cannot serve a second query.
	cutoff, aerr := s.cutoffFor(ctx, uid, ex.CardID, true)
	if aerr != nil {
		cutoff = cardCutoff{} // the card row is gone: the purchase bills in its own month
	}
	if billed := cutoff.periodOf(ex.Date.UTC()); period < billed {
		return OpResult{Error: shared.NewError(shared.ErrValidation,
			"la primera cuota no puede ser antes del mes en que se factura la compra ("+billed+")")}
	}
	err = s.db.RunInTx(ctx, nil, func(ctx context.Context, tx bun.Tx) error {
		var insts []Installment
		if err := tx.NewSelect().Model(&insts).
			Where("expense_id = ? AND user_id = ?", expenseID, uid).Order("number ASC").Scan(ctx); err != nil {
			return fmt.Errorf("loading cuotas: %w", err)
		}
		if len(insts) == 0 {
			return shared.NewError(shared.ErrValidation, "el gasto no tiene cuotas")
		}
		for _, inst := range insts {
			if inst.Status == StatusPagado {
				return shared.NewError(shared.ErrValidation, "el plan tiene cuotas pagadas: desmárcalas antes de moverlo")
			}
		}
		shift := monthsBetween(insts[0].Period, period)
		for _, inst := range insts {
			if _, err := tx.NewUpdate().Model((*Installment)(nil)).Set("period = ?", addMonths(inst.Period, shift)).
				Where("id = ? AND user_id = ?", inst.ID, uid).Exec(ctx); err != nil {
				return fmt.Errorf("moving cuota %d: %w", inst.Number, err)
			}
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
