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

	ID        int64     `bun:"id,pk,autoincrement" json:"id"`
	Name      string    `bun:"name,notnull" json:"name"`
	CreatedAt time.Time `bun:"created_at,notnull,default:current_timestamp" json:"createdAt"`
}
