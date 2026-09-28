package finance

import (
	"time"

	"github.com/uptrace/bun"
)

// Category is a user-managed expense category. Expenses store the category name
// as plain text (expenses.category), so renaming a category cascades to its
// expenses and deleting one leaves their text untouched.
type Category struct {
	bun.BaseModel `bun:"table:categories,alias:cat"`

	ID        int64      `bun:"id,pk,autoincrement" json:"id"`
	UserID    int64      `bun:"user_id,notnull" json:"userId"`
	Name      string     `bun:"name,notnull" json:"name"`
	Rollover  bool       `bun:"rollover,notnull" json:"rollover"` // unspent budget carries into the next month
	Icon      string     `bun:"icon,notnull" json:"icon"`         // looks.json icon key; "" = automatic
	Color     string     `bun:"color,notnull" json:"color"`       // looks.json color key; "" = automatic
	CreatedAt time.Time  `bun:"created_at,notnull,default:current_timestamp" json:"createdAt"`
	DeletedAt *time.Time `bun:",soft_delete" json:"deletedAt,omitempty"`
}
