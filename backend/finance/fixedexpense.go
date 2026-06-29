package finance

import (
	"time"

	"github.com/uptrace/bun"

	"github.com/gastonlarap-a11y/app-finance/backend/shared/types"
)

// FixedExpense is a recurring monthly charge (subscriptions, plan bills, services)
// that the user does not want to re-enter every month. Its amount carries forward
// month to month and can be overridden "from a given month onward" via
// FixedExpenseAmount, while past months keep their previous value.
type FixedExpense struct {
	bun.BaseModel `bun:"table:fixed_expenses,alias:fe"`

	ID          int64     `bun:"id,pk,autoincrement" json:"id"`
	Description  string    `bun:"description,notnull" json:"description"`
	Category    string    `bun:"category,notnull" json:"category"`
	CardID      *int64    `bun:"card_id" json:"cardId"`
	StartPeriod string    `bun:"start_period,notnull" json:"startPeriod"` // YYYY-MM: primer mes cobrado
	EndPeriod   string    `bun:"end_period" json:"endPeriod"`             // YYYY-MM último mes cobrado; "" = activo
	CreatedAt   time.Time `bun:"created_at,nullzero,default:current_timestamp" json:"createdAt"`
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

// FixedExpensePayment marks one fixed expense as paid for a single month. Its mere
// presence means "pagado"; absence means "pendiente".
type FixedExpensePayment struct {
	bun.BaseModel `bun:"table:fixed_expense_payments,alias:fep"`

	FixedExpenseID int64      `bun:"fixed_expense_id,pk" json:"fixedExpenseId"`
	Period         string     `bun:"period,pk" json:"period"` // YYYY-MM
	PaidAt         *time.Time `bun:"paid_at" json:"paidAt"`
}

// activeIn reports whether the fixed expense should be billed in the given month.
func (fe FixedExpense) activeIn(period string) bool {
	if period < fe.StartPeriod {
		return false
	}
	if fe.EndPeriod != "" && period > fe.EndPeriod {
		return false
	}
	return true
}

// resolveFixedAmount returns the amount effective for `period`: the entry with the
// greatest EffectiveFrom that is <= period. `amounts` may be in any order. Returns
// zero when no entry applies yet.
func resolveFixedAmount(amounts []FixedExpenseAmount, period string) types.Decimal {
	best := ""
	out := types.Zero()
	for _, a := range amounts {
		if a.EffectiveFrom <= period && a.EffectiveFrom >= best {
			best = a.EffectiveFrom
			out = a.Amount
		}
	}
	return out
}
