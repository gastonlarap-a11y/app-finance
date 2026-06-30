package finance

import (
	"time"

	"github.com/gastonlarap-a11y/app-finance/backend/shared"
	"github.com/gastonlarap-a11y/app-finance/backend/shared/types"
)

// Concrete Result types (no generics — safest for the Wails AST binding generator).
// Business errors resolve the JS promise with Error set; system errors are returned
// as native Go errors instead (which reject the promise).

type OpResult struct {
	Error *shared.AppError `json:"error,omitempty"`
}

type CardResult struct {
	Data  *Card            `json:"data,omitempty"`
	Error *shared.AppError `json:"error,omitempty"`
}

type ExpenseResult struct {
	Data  *Expense         `json:"data,omitempty"`
	Error *shared.AppError `json:"error,omitempty"`
}

type IncomeResult struct {
	Data  *Income          `json:"data,omitempty"`
	Error *shared.AppError `json:"error,omitempty"`
}

type SettingsResult struct {
	Data  *Settings        `json:"data,omitempty"`
	Error *shared.AppError `json:"error,omitempty"`
}

type SalaryResult struct {
	Data  *PeriodSalary    `json:"data,omitempty"`
	Error *shared.AppError `json:"error,omitempty"`
}

type CategoryResult struct {
	Data  *Category        `json:"data,omitempty"`
	Error *shared.AppError `json:"error,omitempty"`
}

type FixedExpenseResult struct {
	Data  *FixedExpense    `json:"data,omitempty"`
	Error *shared.AppError `json:"error,omitempty"`
}

// FixedExpenseView is a fixed expense enriched for the "Fijos" tab: the amount
// currently in effect plus its display flags. Active is false once the expense has
// been ended (cancelled).
type FixedExpenseView struct {
	FixedExpense
	CurrentAmount types.Decimal `json:"currentAmount"` // monto vigente hoy
	CardName      string        `json:"cardName"`
	Active        bool          `json:"active"`
}

// --- Summary view models ---

// Movimiento sources.
const (
	SourceCuota = "cuota"
	SourceFijo  = "fijo"
)

// Movimiento is one row of a month's view: either an installment joined with its
// expense/card (Source="cuota") or a recurring fixed expense (Source="fijo").
type Movimiento struct {
	Source        string        `json:"source"`        // "cuota" | "fijo"
	InstallmentID int64         `json:"installmentId"` // 0 para fijos
	ExpenseID     int64         `json:"expenseId"`     // 0 para fijos
	FixedID       *int64        `json:"fixedId"`       // set sólo para fijos
	Description   string        `json:"description"`
	Category      string        `json:"category"`
	CardID        *int64        `json:"cardId"`
	CardName      string        `json:"cardName"`
	Kind          string        `json:"kind"`
	Number        int           `json:"number"`
	Total         int           `json:"total"`
	Amount        types.Decimal `json:"amount"`
	Status        string        `json:"status"`
	Date          *time.Time    `json:"date"` // nil para gastos fijos
}

type CategoryTotal struct {
	Category string        `json:"category"`
	Total    types.Decimal `json:"total"`
}

// CardDebt summarises one card's situation. CupoUsado = sum of all pending
// installments across every period; CupoDisponible = limit − CupoUsado.
type CardDebt struct {
	Card           Card          `json:"card"`
	GastoMes       types.Decimal `json:"gastoMes"`  // facturado este período
	CupoUsado      types.Decimal `json:"cupoUsado"` // deuda total pendiente
	CupoDisponible types.Decimal `json:"cupoDisponible"`
}

type MonthlySummary struct {
	Period       string          `json:"period"`
	Salary       types.Decimal   `json:"salary"`     // sueldo de este mes
	Extras       types.Decimal   `json:"extras"`     // bonos / ingresos extra del mes
	Ingresos     types.Decimal   `json:"ingresos"`   // salary + extras
	Acumulado    types.Decimal   `json:"acumulado"`  // arrastre de meses previos (puede ser negativo)
	Disponible   types.Decimal   `json:"disponible"` // acumulado + ingresos
	Gastos       types.Decimal   `json:"gastos"`
	Pendiente    types.Decimal   `json:"pendiente"`
	Pagado       types.Decimal   `json:"pagado"`
	Balance      types.Decimal   `json:"balance"`
	Alcanza      bool            `json:"alcanza"`
	PorCategoria []CategoryTotal `json:"porCategoria"`
	PorTarjeta   []CardDebt      `json:"porTarjeta"`
	Movimientos  []Movimiento    `json:"movimientos"`
	Incomes      []Income        `json:"incomes"`
}

type MonthlySummaryResult struct {
	Data  *MonthlySummary  `json:"data,omitempty"`
	Error *shared.AppError `json:"error,omitempty"`
}

type YearMonth struct {
	Period   string        `json:"period"`
	Ingresos types.Decimal `json:"ingresos"`
	Gastos   types.Decimal `json:"gastos"`
	Balance  types.Decimal `json:"balance"` // neto del mes (ingresos − gastos)
	Saldo    types.Decimal `json:"saldo"`   // saldo acumulado al cierre del mes
	Alcanza  bool          `json:"alcanza"`
}

type YearSummary struct {
	Year          int             `json:"year"`
	Months        []YearMonth     `json:"months"`
	PorCategoria  []CategoryTotal `json:"porCategoria"`
	TotalIngresos types.Decimal   `json:"totalIngresos"`
	TotalGastos   types.Decimal   `json:"totalGastos"`
	TotalBalance  types.Decimal   `json:"totalBalance"`
}

type YearSummaryResult struct {
	Data  *YearSummary     `json:"data,omitempty"`
	Error *shared.AppError `json:"error,omitempty"`
}
