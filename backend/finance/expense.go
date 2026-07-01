package finance

import (
	"time"

	"github.com/uptrace/bun"

	"github.com/gastonlarap-a11y/app-finance/backend/shared/types"
)

// Expense kinds.
const (
	KindUnico  = "unico"  // pago único (un solo mes)
	KindCuotas = "cuotas" // compra en cuotas mensuales
)

// Expense is a purchase / commitment. For KindCuotas it spawns N Installments;
// for KindUnico it spawns exactly one. InstallmentAmount is the per-month value
// (for KindUnico it is the full amount).
type Expense struct {
	bun.BaseModel `bun:"table:expenses,alias:ex"`

	ID                int64         `bun:"id,pk,autoincrement" json:"id"`
	UserID            int64         `bun:"user_id,notnull" json:"userId"`
	Date              time.Time     `bun:"date,notnull" json:"date"`
	Description       string        `bun:"description,notnull" json:"description"`
	Category          string        `bun:"category,notnull" json:"category"`
	CardID            *int64        `bun:"card_id" json:"cardId"`
	Kind              string        `bun:"kind,notnull" json:"kind"`
	InstallmentAmount types.Decimal `bun:"installment_amount,notnull" json:"installmentAmount"`
	InstallmentsTotal int           `bun:"installments_total,notnull,default:1" json:"installmentsTotal"`
	CreatedAt         time.Time     `bun:"created_at,notnull,default:current_timestamp" json:"createdAt"`
	DeletedAt         *time.Time    `bun:",soft_delete" json:"deletedAt,omitempty"`
}
