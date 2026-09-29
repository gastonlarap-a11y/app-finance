package finance

import (
	"context"

	"github.com/gastonlarap-a11y/app-finance/backend/shared"
	"github.com/gastonlarap-a11y/app-finance/backend/shared/types"
)

// maxForecastMonths bounds CommitmentsForecast (three years ahead).
const maxForecastMonths = 36

// CommitmentsForecast projects `months` months starting at `fromPeriod`: what each
// one already has committed (installments of existing purchases + active fixed
// expenses) against its expected income. A month without a confirmed salary
// takes the base salary (or, without one, the last confirmed salary) and is
// flagged IngresoEstimado.
func (s *FinanceService) CommitmentsForecast(ctx context.Context, fromPeriod string, months int) ForecastResult {
	if !validPeriod(fromPeriod) {
		return ForecastResult{Error: invalidPeriod()}
	}
	if months < 1 || months > maxForecastMonths {
		return ForecastResult{Error: shared.NewError(shared.ErrValidation, "la proyección debe ser de 1 a 36 meses")}
	}
	out, err := s.commitmentsForecast(ctx, s.uid(), fromPeriod, months)
	if err != nil {
		return ForecastResult{Error: internalErr(err)}
	}
	return ForecastResult{Data: out}
}

func (s *FinanceService) commitmentsForecast(ctx context.Context, uid int64, from string, months int) ([]ForecastMonth, error) {
	to := addMonths(from, months-1)

	var insts []Installment
	if err := s.db.NewSelect().Model(&insts).
		Where("user_id = ? AND period >= ? AND period <= ?", uid, from, to).
		Where("expense_id IN (SELECT id FROM expenses WHERE deleted_at IS NULL)").
		Scan(ctx); err != nil {
		return nil, err
	}
	cuotas := map[string]types.Decimal{}
	for _, inst := range insts {
		cuotas[inst.Period] = cuotas[inst.Period].Add(inst.Amount)
	}

	fixed, amountsByID, err := s.loadFixed(ctx, uid, false)
	if err != nil {
		return nil, err
	}
	// Future months have no UF value yet: fixedCharge uses the latest known one.
	uf, err := s.loadUF(ctx)
	if err != nil {
		return nil, err
	}

	// Each month's salary: the confirmed one, else the base salary (expected).
	salaryByMonth, err := s.salaryByMonth(ctx, uid, from, to)
	if err != nil {
		return nil, err
	}
	// Without a base salary, a month with none reuses the last confirmed one
	// (the ones before `from` seed it); with a base salary, the base decides —
	// ended means no salary.
	plans, err := s.salaryPlans(ctx, uid)
	if err != nil {
		return nil, err
	}
	lastKnown := types.Zero()
	if len(plans) == 0 {
		var before []PeriodSalary
		if err := s.db.NewSelect().Model(&before).
			Where("user_id = ? AND period < ?", uid, from).Order("period DESC").Limit(1).Scan(ctx); err != nil {
			return nil, err
		}
		if len(before) > 0 {
			lastKnown = before[0].Amount
		}
	}

	var incomes []Income
	if err := s.db.NewSelect().Model(&incomes).
		Where("user_id = ? AND period >= ? AND period <= ?", uid, from, to).Scan(ctx); err != nil {
		return nil, err
	}
	extras := map[string]types.Decimal{}
	for _, inc := range incomes {
		extras[inc.Period] = extras[inc.Period].Add(inc.Amount)
	}

	ahorro, err := s.savingsByMonth(ctx, uid, from, to)
	if err != nil {
		return nil, err
	}

	saldo, _, err := s.cumulativeBalanceBefore(ctx, uid, from)
	if err != nil {
		return nil, err
	}
	// Refunds already recorded in the horizon come back into the account
	// (added to Libre, as in the month and year views).
	refunds, err := s.refundsIn(ctx, uid, from, to)
	if err != nil {
		return nil, err
	}
	refundedIn := map[string]types.Decimal{}
	for _, r := range refunds {
		refundedIn[r.Period] = refundedIn[r.Period].Add(r.Amount)
	}
	// A past month of the horizon may already be reconciled: from its close on,
	// the projection starts from the real balance.
	realByMonth, err := s.reconciliationsIn(ctx, uid, from, to)
	if err != nil {
		return nil, err
	}

	out := make([]ForecastMonth, 0, months)
	for i := range months {
		period := addMonths(from, i)
		fijos := types.Zero()
		for _, fe := range fixed {
			if fe.billsIn(period) {
				clp, _, _ := fixedCharge(fe, amountsByID[fe.ID], uf, period)
				fijos = fijos.Add(clp)
			}
		}
		ms, ok := salaryByMonth[period]
		known := ok && !ms.expected // confirmed for the month
		salary := lastKnown
		if ok {
			salary = ms.amount
		}
		if known {
			lastKnown = salary
		}
		ingresos := salary.Add(extras[period])
		comprometido := cuotas[period].Add(fijos)
		libre := ingresos.Sub(comprometido).Sub(ahorro[period]).Add(refundedIn[period])
		saldo = saldo.Add(libre)
		if closing, ok := realByMonth[period]; ok {
			saldo = closing
		}
		out = append(out, ForecastMonth{
			Period:          period,
			Cuotas:          cuotas[period],
			Fijos:           fijos,
			Comprometido:    comprometido,
			Ahorro:          ahorro[period],
			Ingresos:        ingresos,
			IngresoEstimado: !known,
			Libre:           libre,
			SaldoProyectado: saldo,
		})
	}
	return out, nil
}
