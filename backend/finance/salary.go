package finance

import (
	"context"
	"fmt"

	"github.com/uptrace/bun"

	"github.com/gastonlarap-a11y/app-finance/backend/shared"
	"github.com/gastonlarap-a11y/app-finance/backend/shared/types"
)

// PeriodSalary is the salary confirmed for a single month (YYYY-MM). A month
// without one takes the base salary in effect (SalaryPlan) as expected — the
// way Actual Budget's schedules add a paycheck each month until the real one
// replaces it — so the month, the carried balance and the accounts never read
// a missing salary as zero.
type PeriodSalary struct {
	bun.BaseModel `bun:"table:period_salaries,alias:ps"`

	UserID   int64         `bun:"user_id,pk" json:"userId"`
	Period   string        `bun:"period,pk" json:"period"` // YYYY-MM
	Amount   types.Decimal `bun:"amount,notnull" json:"amount"`
	Expected bool          `bun:"-" json:"expected"` // the base salary, not confirmed for the month
}

// SalaryPlan is the base salary from EffectiveFrom onward, until a later row
// takes over — the effective-dated scheme of fixed-expense amounts. A row with
// Active false ends the base salary from its month on.
type SalaryPlan struct {
	bun.BaseModel `bun:"table:salary_plans,alias:sp"`

	UserID        int64         `bun:"user_id,pk" json:"userId"`
	EffectiveFrom string        `bun:"effective_from,pk" json:"effectiveFrom"` // YYYY-MM
	Amount        types.Decimal `bun:"amount,notnull" json:"amount"`
	Active        bool          `bun:"active,notnull" json:"active"`
}

func (p SalaryPlan) effective() (string, types.Decimal) { return p.EffectiveFrom, p.Amount }

// BaseSalary is the base salary in effect at a month.
type BaseSalary struct {
	EffectiveFrom string        `json:"effectiveFrom"` // YYYY-MM it applies from
	Amount        types.Decimal `json:"amount"`
}

type BaseSalaryResult struct {
	Data  *BaseSalary      `json:"data,omitempty"` // nil = no base salary that month
	Error *shared.AppError `json:"error,omitempty"`
}

// monthSalary is one month's salary and whether it is the expected base one.
type monthSalary struct {
	amount   types.Decimal
	expected bool
}

func (s *FinanceService) salaryPlans(ctx context.Context, uid int64) ([]SalaryPlan, error) {
	var plans []SalaryPlan
	if err := s.db.NewSelect().Model(&plans).Where("user_id = ?", uid).Scan(ctx); err != nil {
		return nil, fmt.Errorf("loading base salary: %w", err)
	}
	return plans, nil
}

// baseSalaryAt is the base salary in effect at period, if any.
func baseSalaryAt(plans []SalaryPlan, period string) (SalaryPlan, bool) {
	p, ok := latestAsOf(plans, period)
	return p, ok && p.Active
}

// salaryByMonth is each month's salary in [from, to] ("" from = the first
// month there is one): the one confirmed for the month or, without it, the
// base salary in effect (expected). A month with neither is absent.
func (s *FinanceService) salaryByMonth(ctx context.Context, uid int64, from, to string) (map[string]monthSalary, error) {
	var rows []PeriodSalary
	if err := s.db.NewSelect().Model(&rows).
		Where("user_id = ? AND period >= ? AND period <= ?", uid, from, to).Scan(ctx); err != nil {
		return nil, fmt.Errorf("salaries: %w", err)
	}
	out := make(map[string]monthSalary, len(rows))
	for _, r := range rows {
		out[r.Period] = monthSalary{amount: r.Amount}
	}
	plans, err := s.salaryPlans(ctx, uid)
	if err != nil || len(plans) == 0 {
		return out, err
	}
	start := plans[0].EffectiveFrom // no base before the first plan row
	for _, p := range plans {
		start = min(start, p.EffectiveFrom)
	}
	for m := max(start, from); m <= to; m = addMonths(m, 1) {
		if _, confirmed := out[m]; confirmed {
			continue
		}
		if p, ok := baseSalaryAt(plans, m); ok {
			out[m] = monthSalary{amount: p.Amount, expected: true}
		}
	}
	return out, nil
}

// salaryFor returns the salary of a period: confirmed, expected (the base
// salary) or zero when there is neither.
func (s *FinanceService) salaryFor(ctx context.Context, uid int64, period string) (monthSalary, error) {
	byMonth, err := s.salaryByMonth(ctx, uid, period, period)
	if err != nil {
		return monthSalary{}, err
	}
	ms := byMonth[period]
	ms.amount = types.Zero().Add(ms.amount)
	return ms, nil
}

// GetBaseSalary returns the base salary in effect at period (nil when none).
func (s *FinanceService) GetBaseSalary(ctx context.Context, period string) BaseSalaryResult {
	if !validPeriod(period) {
		return BaseSalaryResult{Error: invalidPeriod()}
	}
	plans, err := s.salaryPlans(ctx, s.uid())
	if err != nil {
		return BaseSalaryResult{Error: internalErr(err)}
	}
	p, ok := baseSalaryAt(plans, period)
	if !ok {
		return BaseSalaryResult{}
	}
	return BaseSalaryResult{Data: &BaseSalary{EffectiveFrom: p.EffectiveFrom, Amount: p.Amount}}
}

// SetBaseSalary makes `amount` the salary expected every month from fromPeriod
// on (earlier months keep theirs; a month's confirmed salary always wins).
func (s *FinanceService) SetBaseSalary(ctx context.Context, fromPeriod, amount string) OpResult {
	if !validPeriod(fromPeriod) {
		return OpResult{Error: invalidPeriod()}
	}
	amt, aerr := parseAmount(amount)
	if aerr != nil {
		return OpResult{Error: aerr}
	}
	if amt.IsZero() {
		return OpResult{Error: shared.NewError(shared.ErrValidation, "el sueldo base debe ser mayor a 0")}
	}
	return s.putSalaryPlan(ctx, &SalaryPlan{UserID: s.uid(), EffectiveFrom: fromPeriod, Amount: amt, Active: true})
}

// EndBaseSalary stops expecting a base salary from fromPeriod on (earlier
// months keep theirs). There must be one in effect that month.
func (s *FinanceService) EndBaseSalary(ctx context.Context, fromPeriod string) OpResult {
	if !validPeriod(fromPeriod) {
		return OpResult{Error: invalidPeriod()}
	}
	uid := s.uid()
	plans, err := s.salaryPlans(ctx, uid)
	if err != nil {
		return OpResult{Error: internalErr(err)}
	}
	if _, ok := baseSalaryAt(plans, fromPeriod); !ok {
		return OpResult{Error: shared.NewError(shared.ErrValidation, "no hay sueldo base en "+fromPeriod)}
	}
	return s.putSalaryPlan(ctx, &SalaryPlan{UserID: uid, EffectiveFrom: fromPeriod, Amount: types.Zero(), Active: false})
}

func (s *FinanceService) putSalaryPlan(ctx context.Context, plan *SalaryPlan) OpResult {
	if _, err := s.db.NewInsert().Model(plan).
		On("CONFLICT (user_id, effective_from) DO UPDATE").
		Set("amount = EXCLUDED.amount").Set("active = EXCLUDED.active").Exec(ctx); err != nil {
		return OpResult{Error: internalErr(err)}
	}
	return OpResult{}
}

// DeleteSalary forgets the salary confirmed for a month: it goes back to the
// base salary (expected), or to none.
func (s *FinanceService) DeleteSalary(ctx context.Context, period string) OpResult {
	if !validPeriod(period) {
		return OpResult{Error: invalidPeriod()}
	}
	res, err := s.db.NewDelete().Model((*PeriodSalary)(nil)).
		Where("user_id = ? AND period = ?", s.uid(), period).Exec(ctx)
	return OpResult{Error: requireOne(res, err, "ese mes no tiene sueldo anotado")}
}
