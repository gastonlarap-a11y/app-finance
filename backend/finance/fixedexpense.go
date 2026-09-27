package finance

import (
	"slices"
	"strings"
	"time"

	"github.com/uptrace/bun"

	"github.com/gastonlarap-a11y/app-finance/backend/shared/types"
)

// Currencies a fixed expense's amounts may be in. UF (Unidad de Fomento) is
// converted to CLP with the UF value of each billed month (uf.go).
const (
	CurrencyCLP = "CLP"
	CurrencyUF  = "UF"
)

// validIntervals are the billing frequencies offered: monthly, bimonthly,
// quarterly, every four months, half-yearly and yearly.
var validIntervals = []int{1, 2, 3, 4, 6, 12}

// FixedExpense is a recurring charge (subscriptions, plan bills, services,
// insurance, rent in UF) that the user does not want to re-enter. It bills
// every IntervalMonths months from StartPeriod; its amount carries forward and
// can be overridden "from a given month onward" via FixedExpenseAmount, while
// past months keep their previous value. Interval and currency are fixed at
// creation: changing them would move or re-price charges already recorded.
type FixedExpense struct {
	bun.BaseModel `bun:"table:fixed_expenses,alias:fe"`

	ID             int64      `bun:"id,pk,autoincrement" json:"id"`
	UserID         int64      `bun:"user_id,notnull" json:"userId"`
	Description    string     `bun:"description,notnull" json:"description"`
	Category       string     `bun:"category,notnull" json:"category"`
	CardID         *int64     `bun:"card_id" json:"cardId"`
	StartPeriod    string     `bun:"start_period,notnull" json:"startPeriod"` // YYYY-MM: primer mes cobrado
	EndPeriod      string     `bun:"end_period" json:"endPeriod"`             // YYYY-MM último mes cobrado; "" = activo
	IntervalMonths int        `bun:"interval_months,notnull,default:1" json:"intervalMonths"`
	Currency       string     `bun:"currency,notnull,default:'CLP'" json:"currency"` // CLP | UF
	DueDay         *int       `bun:"due_day" json:"dueDay"`                          // día del mes en que vence; nil = sin recordatorio
	CreatedAt      time.Time  `bun:"created_at,nullzero,default:current_timestamp" json:"createdAt"`
	DeletedAt      *time.Time `bun:",soft_delete" json:"deletedAt,omitempty"`
}

// interval is IntervalMonths, never below 1 (rows written before the column existed read 1).
func (fe FixedExpense) interval() int { return max(fe.IntervalMonths, 1) }

// billsIn reports whether the fixed expense charges in `period`: inside its
// [start, end] and on its schedule (every interval months from the start).
func (fe FixedExpense) billsIn(period string) bool {
	return fe.activeIn(period) && monthsBetween(fe.StartPeriod, period)%fe.interval() == 0
}

// nextBilling is the first month at or after `from` the fixed expense bills
// in, or "" when it has ended before then.
func (fe FixedExpense) nextBilling(from string) string {
	p := fe.StartPeriod
	if from > p {
		n := fe.interval()
		p = addMonths(fe.StartPeriod, (monthsBetween(fe.StartPeriod, from)+n-1)/n*n)
	}
	if fe.EndPeriod != "" && p > fe.EndPeriod {
		return ""
	}
	return p
}

// FixedExpenseAmount is the amount that becomes effective for a fixed expense from
// EffectiveFrom (YYYY-MM) onward. The amount for a month M is the row with the
// greatest EffectiveFrom that is <= M.
type FixedExpenseAmount struct {
	bun.BaseModel `bun:"table:fixed_expense_amounts,alias:fea"`

	FixedExpenseID int64         `bun:"fixed_expense_id,pk" json:"fixedExpenseId"`
	EffectiveFrom  string        `bun:"effective_from,pk" json:"effectiveFrom"` // YYYY-MM
	Amount         types.Decimal `bun:"amount,notnull" json:"amount"`
}

func (a FixedExpenseAmount) effective() (string, types.Decimal) { return a.EffectiveFrom, a.Amount }

// FixedExpensePayment marks one fixed expense as paid for a single month. Its mere
// presence means "pagado"; absence means "pendiente".
type FixedExpensePayment struct {
	bun.BaseModel `bun:"table:fixed_expense_payments,alias:fep"`

	FixedExpenseID int64      `bun:"fixed_expense_id,pk" json:"fixedExpenseId"`
	Period         string     `bun:"period,pk" json:"period"` // YYYY-MM
	PaidAt         *time.Time `bun:"paid_at" json:"paidAt"`
}

// activeIn reports whether `period` falls within the fixed expense's life
// [start, end]; whether it charges that month is billsIn.
func (fe FixedExpense) activeIn(period string) bool {
	if period < fe.StartPeriod {
		return false
	}
	if fe.EndPeriod != "" && period > fe.EndPeriod {
		return false
	}
	return true
}

// effectiveDated is a row whose amount applies from a YYYY-MM period onward until
// the next row takes over (fixed-expense amounts, category budgets).
type effectiveDated interface {
	effective() (from string, amount types.Decimal)
}

// latestAsOf returns the row in effect for `period`: the one with the greatest
// effective-from that is <= period. `rows` may be in any order; ok is false when
// no row applies yet.
func latestAsOf[T effectiveDated](rows []T, period string) (row T, ok bool) {
	best := ""
	for _, r := range rows {
		from, _ := r.effective()
		if from <= period && (!ok || from >= best) {
			best, row, ok = from, r, true
		}
	}
	return row, ok
}

// resolveAsOf returns the amount effective for `period` (see latestAsOf), or zero
// when no row applies yet.
func resolveAsOf[T effectiveDated](rows []T, period string) types.Decimal {
	row, ok := latestAsOf(rows, period)
	if !ok {
		return types.Zero()
	}
	_, amount := row.effective()
	return amount
}

// sumAsOf totals resolveAsOf(rows, m) for every month m in [from, to] without
// walking month by month: each row covers a contiguous stretch (until the next
// row takes over), so its share is amount × months-in-overlap.
func sumAsOf[T effectiveDated](rows []T, from, to string) types.Decimal {
	total := types.Zero()
	if from > to {
		return total
	}
	sorted := slices.SortedFunc(slices.Values(rows), func(a, b T) int {
		fa, _ := a.effective()
		fb, _ := b.effective()
		return strings.Compare(fa, fb)
	})
	for i, r := range sorted {
		start, amount := r.effective()
		end := to
		if i+1 < len(sorted) {
			next, _ := sorted[i+1].effective()
			end = min(end, addMonths(next, -1))
		}
		start = max(start, from)
		if start > end {
			continue
		}
		total = total.Add(amount.MulInt(int64(monthsBetween(start, end) + 1)))
	}
	return total
}
