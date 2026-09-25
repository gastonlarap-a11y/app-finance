package finance

import (
	"time"

	"github.com/uptrace/bun"

	"github.com/gastonlarap-a11y/app-finance/backend/shared/types"
)

// Where an import item was detected.
const (
	ImportSourceEmail      = "email"       // correo de alerta de compra
	ImportSourcePDFAccount = "pdf_account" // cartola de cuenta corriente
	ImportSourcePDFCard    = "pdf_card"    // estado de cuenta de tarjeta de crédito
)

// Import item lifecycle: every detected movement starts pendiente; the user
// confirms it (creating or linking an expense) or discards it. conciliado marks
// the second sighting of a movement already in the inbox from the other source
// family (an alert email and its statement line), so it is never counted twice.
const (
	ImportPendiente  = "pendiente"
	ImportConfirmado = "confirmado"
	ImportDescartado = "descartado"
	ImportConciliado = "conciliado"
)

// Hints a parser attaches so the inbox can warn before a movement is counted
// twice (paying the card bill from the checking account repeats card purchases).
const (
	HintNone        = ""
	HintCardPayment = "card_payment"
	HintTransfer    = "transfer"
)

// ImportItem is one movement detected in a bank email or statement, waiting in
// the import inbox. Description keeps the bank's descriptor verbatim.
type ImportItem struct {
	bun.BaseModel `bun:"table:import_items,alias:ii"`

	ID                int64         `bun:"id,pk,autoincrement" json:"id"`
	UserID            int64         `bun:"user_id,notnull" json:"userId"`
	Source            string        `bun:"source,notnull" json:"source"`
	Issuer            string        `bun:"issuer,notnull" json:"issuer"`
	ExternalKey       string        `bun:"external_key,notnull" json:"-"`
	Date              string        `bun:"date,notnull" json:"date"` // YYYY-MM-DD
	Description       string        `bun:"description,notnull" json:"description"`
	Amount            types.Decimal `bun:"amount,notnull" json:"amount"`
	Currency          string        `bun:"currency,notnull" json:"currency"`
	CardLastDigits    string        `bun:"card_last_digits,notnull" json:"cardLastDigits"`
	InstallmentsTotal int           `bun:"installments_total,notnull" json:"installmentsTotal"`
	Hint              string        `bun:"hint,notnull" json:"hint"`
	Status            string        `bun:"status,notnull" json:"status"`
	ExpenseID         *int64        `bun:"expense_id" json:"expenseId"`
	MatchedItemID     *int64        `bun:"matched_item_id" json:"matchedItemId"`
	CreatedAt         time.Time     `bun:"created_at,notnull,default:current_timestamp" json:"createdAt"`

	// Card-statement items carry what the bank already knows about them.
	Kind              string `bun:"kind,notnull" json:"kind"` // gasto | abono (a credit, confirmed as income)
	StatementLineID   *int64 `bun:"statement_line_id" json:"statementLineId"`
	InstallmentNumber int    `bun:"installment_number,notnull" json:"installmentNumber"` // cuota n of InstallmentsTotal on the statement
	InstallmentAmount string `bun:"installment_amount,notnull" json:"installmentAmount"` // the bank's exact cuota; "" = unknown
	FirstPeriod       string `bun:"first_period,notnull" json:"firstPeriod"`             // YYYY-MM of cuota 1; "" = from the date
	IncomeID          *int64 `bun:"income_id" json:"incomeId"`
}

// Import item kinds.
const (
	ImportKindExpense = "gasto" // becomes an expense
	ImportKindCredit  = "abono" // a bank credit (cashback, points redemption): becomes an extra income
)

// MerchantRule maps bank descriptors starting with Pattern (normalized, see
// normalizeDescriptor) to the merchant and category the user chose for them.
type MerchantRule struct {
	bun.BaseModel `bun:"table:merchant_rules,alias:mr"`

	ID        int64     `bun:"id,pk,autoincrement" json:"id"`
	UserID    int64     `bun:"user_id,notnull" json:"userId"`
	Pattern   string    `bun:"pattern,notnull" json:"pattern"`
	Merchant  string    `bun:"merchant,notnull" json:"merchant"`
	Category  string    `bun:"category,notnull" json:"category"`
	CreatedAt time.Time `bun:"created_at,notnull,default:current_timestamp" json:"createdAt"`
}

// ImportCandidate is one movement as a parser extracted it, before staging.
// Account and Reference (operation number, email Message-ID…) only feed the
// deduplication key; Amount is a positive decimal string.
type ImportCandidate struct {
	Date              string `json:"date"` // YYYY-MM-DD
	Description       string `json:"description"`
	Amount            string `json:"amount"`
	Currency          string `json:"currency"` // "" = CLP
	CardLastDigits    string `json:"cardLastDigits"`
	Account           string `json:"account"`
	Reference         string `json:"reference"`
	InstallmentsTotal int    `json:"installmentsTotal"` // < 1 = 1
	Hint              string `json:"hint"`

	// Optional, set by card statements (zero values for alerts and cartolas).
	Kind              string `json:"kind,omitempty"`              // "" = gasto
	InstallmentNumber int    `json:"installmentNumber,omitempty"` // < 1 = 1
	InstallmentAmount string `json:"installmentAmount,omitempty"`
	FirstPeriod       string `json:"firstPeriod,omitempty"`
}

// ImportBatch is everything one parser run found in one email or file.
type ImportBatch struct {
	Source string            `json:"source"`
	Issuer string            `json:"issuer"`
	Items  []ImportCandidate `json:"items"`
}
