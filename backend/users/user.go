package users

import (
	"time"

	"github.com/uptrace/bun"
)

// User is a finance profile. Each user owns its own cards, categories, incomes,
// expenses, salaries and fixed expenses (rows are scoped by user_id). There is no
// login — the active user is chosen from the header switcher and persisted in prefs.
type User struct {
	bun.BaseModel `bun:"table:users,alias:u"`

	ID        int64      `bun:"id,pk,autoincrement" json:"id"`
	Name      string     `bun:"name,notnull" json:"name"`
	CreatedAt time.Time  `bun:"created_at,notnull,default:current_timestamp" json:"createdAt"`
	DeletedAt *time.Time `bun:",soft_delete" json:"deletedAt,omitempty"`
}
