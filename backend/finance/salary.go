package finance

import (
	"github.com/uptrace/bun"

	"github.com/gastonlarap-a11y/app-finance/backend/shared/types"
)

// PeriodSalary is the salary saved for a single month (YYYY-MM). There is no
// global base salary: every month has its own value (zero if not set).
type PeriodSalary struct {
	bun.BaseModel `bun:"table:period_salaries,alias:ps"`

	UserID int64         `bun:"user_id,pk" json:"userId"`
	Period string        `bun:"period,pk" json:"period"` // YYYY-MM
	Amount types.Decimal `bun:"amount,notnull" json:"amount"`
}
