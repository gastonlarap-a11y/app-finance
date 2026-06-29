package finance

import "github.com/uptrace/bun"

// Settings is the single-row (id=1) app-wide finance configuration.
type Settings struct {
	bun.BaseModel `bun:"table:settings,alias:st"`

	ID                int64 `bun:"id,pk" json:"id"`
	DefaultBillingDay int   `bun:"default_billing_day,notnull" json:"defaultBillingDay"`
}
