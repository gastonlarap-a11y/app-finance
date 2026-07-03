package finance

import (
	"time"

	"github.com/uptrace/bun"
)

// Merchant is a user-managed "comercio" (where a purchase was made). Expenses
// store the merchant name as plain text (expenses.merchant), so renaming a
// merchant cascades to its expenses and deleting one leaves their text untouched.
type Merchant struct {
	bun.BaseModel `bun:"table:merchants,alias:mer"`

	ID        int64      `bun:"id,pk,autoincrement" json:"id"`
	UserID    int64      `bun:"user_id,notnull" json:"userId"`
	Name      string     `bun:"name,notnull" json:"name"`
	CreatedAt time.Time  `bun:"created_at,notnull,default:current_timestamp" json:"createdAt"`
	DeletedAt *time.Time `bun:",soft_delete" json:"deletedAt,omitempty"`
}
