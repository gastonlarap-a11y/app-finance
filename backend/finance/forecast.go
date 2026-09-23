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
// expenses) against its expected income. A month without a salary saved reuses
// the last known salary and is flagged IngresoEstimado.
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

	// Every salary up to the horizon: the ones before `from` only seed the
	// "last known salary" used to estimate months without one.
	var salaries []PeriodSalary
	if err := s.db.NewSelect().Model(&salaries).
		Where("user_id = ? AND period <= ?", uid, to).Order("period ASC").Scan(ctx); err != nil {
		return nil, err
	}
	salaryByMonth := map[string]types.Decimal{}
	lastKnown := types.Zero()
	for _, sal := range salaries {
		if sal.Period < from {
			lastKnown = sal.Amount
			continue
		}
		salaryByMonth[sal.Period] = sal.Amount
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

	saldo, err := s.cumulativeBalanceBefore(ctx, uid, from)
	if err != nil {
		return nil, err
	}

	out := make([]ForecastMonth, 0, months)
	for i := range months {
		period := addMonths(from, i)
		fijos := types.Zero()
		for _, fe := range fixed {
			if fe.activeIn(period) {
				fijos = fijos.Add(resolveAsOf(amountsByID[fe.ID], period))
			}
		}
		salary, known := salaryByMonth[period]
		if known {
			lastKnown = salary
		} else {
			salary = lastKnown
		}
		ingresos := salary.Add(extras[period])
		comprometido := cuotas[period].Add(fijos)
		libre := ingresos.Sub(comprometido)
		saldo = saldo.Add(libre)
		out = append(out, ForecastMonth{
			Period:          period,
			Cuotas:          cuotas[period],
			Fijos:           fijos,
			Comprometido:    comprometido,
			Ingresos:        ingresos,
			IngresoEstimado: !known,
			Libre:           libre,
			SaldoProyectado: saldo,
		})
	}
	return out, nil
}
