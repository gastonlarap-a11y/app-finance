package finance

import (
	"time"

	"github.com/uptrace/bun"

	"github.com/gastonlarap-a11y/app-finance/backend/shared/types"
)

// Income is an extra income / bono for a given month. The recurring base salary
// lives in Settings, not here.
type Income struct {
	bun.BaseModel `bun:"table:incomes,alias:i"`

	ID          int64         `bun:"id,pk,autoincrement" json:"id"`
	Period      string        `bun:"period,notnull" json:"period"` // YYYY-MM
	Description string        `bun:"description,notnull" json:"description"`
	Amount      types.Decimal `bun:"amount,notnull" json:"amount"`
	CreatedAt   time.Time     `bun:"created_at,notnull,default:current_timestamp" json:"createdAt"`
}
