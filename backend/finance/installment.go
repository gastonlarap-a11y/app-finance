package finance

import (
	"time"

	"github.com/uptrace/bun"

	"github.com/gastonlarap-a11y/app-finance/backend/shared/types"
)

// Installment statuses.
const (
	StatusPendiente = "pendiente"
	StatusPagado    = "pagado"
)

// Installment is one monthly charge generated from an Expense. "Cuota Number/Total"
// is the progress shown in the UI; it advances as installments are marked pagado.
type Installment struct {
	bun.BaseModel `bun:"table:installments,alias:inst"`

	ID        int64         `bun:"id,pk,autoincrement" json:"id"`
	ExpenseID int64         `bun:"expense_id,notnull" json:"expenseId"`
	Number    int           `bun:"number,notnull" json:"number"` // 1..Total
	Total     int           `bun:"total,notnull" json:"total"`
	Period    string        `bun:"period,notnull" json:"period"` // YYYY-MM en que se factura
	Amount    types.Decimal `bun:"amount,notnull" json:"amount"`
	Status    string        `bun:"status,notnull,default:'pendiente'" json:"status"`
	PaidAt    *time.Time    `bun:"paid_at" json:"paidAt"`

	Expense *Expense `bun:"rel:belongs-to,join:expense_id=id" json:"expense,omitempty"`
}
