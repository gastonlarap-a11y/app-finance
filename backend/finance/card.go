package finance

import (
	"time"

	"github.com/uptrace/bun"

	"github.com/gastonlarap-a11y/app-finance/backend/shared/types"
)

// Card is a credit card with a spending limit (cupo) and a billing cutoff day.
type Card struct {
	bun.BaseModel `bun:"table:cards,alias:c"`

	ID          int64         `bun:"id,pk,autoincrement" json:"id"`
	Name        string        `bun:"name,notnull" json:"name"`
	CreditLimit types.Decimal `bun:"credit_limit,notnull" json:"creditLimit"` // cupo total
	BillingDay  int           `bun:"billing_day,notnull" json:"billingDay"`   // día de corte (ej. 24)
	CreatedAt   time.Time     `bun:"created_at,notnull,default:current_timestamp" json:"createdAt"`
}
