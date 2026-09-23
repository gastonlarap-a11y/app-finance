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

type MerchantResult struct {
	Data  *Merchant        `json:"data,omitempty"`
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
	Merchant      string        `json:"merchant"`
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
	Presupuestos []BudgetStatus  `json:"presupuestos"` // sólo categorías con tope vigente
}

// BudgetStatus compares a category's monthly cap with what the month charges to it
// (installments + fixed expenses, paid or not — the same total as PorCategoria).
type BudgetStatus struct {
	CategoryID int64         `json:"categoryId"`
	Category   string        `json:"category"`
	Budget     types.Decimal `json:"budget"`
	Spent      types.Decimal `json:"spent"`
	Remaining  types.Decimal `json:"remaining"` // negativo cuando se excede
	Over       bool          `json:"over"`
}

// CategoryBudgetView is the cap in effect for one category at a given month.
type CategoryBudgetView struct {
	CategoryID    int64         `json:"categoryId"`
	Category      string        `json:"category"`
	Amount        types.Decimal `json:"amount"`
	EffectiveFrom string        `json:"effectiveFrom"` // YYYY-MM desde el que rige
}

type CategoryBudgetsResult struct {
	Data  []CategoryBudgetView `json:"data,omitempty"`
	Error *shared.AppError     `json:"error,omitempty"`
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
	Year           int               `json:"year"`
	Months         []YearMonth       `json:"months"`
	PorCategoria   []CategoryTotal   `json:"porCategoria"`
	CategoriaMeses []CategoryYearRow `json:"categoriaMeses"`
	TotalIngresos  types.Decimal     `json:"totalIngresos"`
	TotalGastos    types.Decimal     `json:"totalGastos"`
	TotalBalance   types.Decimal     `json:"totalBalance"`
}

// CategoryYearRow is one category's spending per month of a year: Months always
// has 12 entries (January first), Total is their sum.
type CategoryYearRow struct {
	Category string          `json:"category"`
	Months   []types.Decimal `json:"months"`
	Total    types.Decimal   `json:"total"`
}

type YearSummaryResult struct {
	Data  *YearSummary     `json:"data,omitempty"`
	Error *shared.AppError `json:"error,omitempty"`
}

// --- Commitments forecast (proyección) ---

// ForecastMonth is what a future month already has committed: remaining
// installments plus active fixed expenses, against the income expected for it.
type ForecastMonth struct {
	Period          string        `json:"period"`
	Cuotas          types.Decimal `json:"cuotas"`
	Fijos           types.Decimal `json:"fijos"`
	Comprometido    types.Decimal `json:"comprometido"` // cuotas + fijos
	Ingresos        types.Decimal `json:"ingresos"`
	IngresoEstimado bool          `json:"ingresoEstimado"` // sin sueldo cargado: se usa el último conocido
	Libre           types.Decimal `json:"libre"`           // ingresos − comprometido
	SaldoProyectado types.Decimal `json:"saldoProyectado"` // saldo acumulado al cierre si sólo ocurre lo comprometido
}

type ForecastResult struct {
	Data  []ForecastMonth  `json:"data,omitempty"`
	Error *shared.AppError `json:"error,omitempty"`
}

// --- Expense search ---

// ExpenseFilter narrows SearchExpenses. Empty strings / nil mean "any". The period
// range matches expenses with at least one installment inside it.
type ExpenseFilter struct {
	Text       string `json:"text"` // descripción o comercio (contiene)
	Category   string `json:"category"`
	CardID     *int64 `json:"cardId"`
	FromPeriod string `json:"fromPeriod"` // YYYY-MM
	ToPeriod   string `json:"toPeriod"`   // YYYY-MM
	Limit      int    `json:"limit"`      // default 50, máximo 200
	Offset     int    `json:"offset"`
}

// ExpenseHit is one search result: the expense with its card name and the span
// and progress of its installments.
type ExpenseHit struct {
	Expense     Expense       `json:"expense"`
	CardName    string        `json:"cardName"`
	FirstPeriod string        `json:"firstPeriod"`
	LastPeriod  string        `json:"lastPeriod"`
	Total       types.Decimal `json:"total"` // monto cuota × cuotas
	PaidCount   int           `json:"paidCount"`
}

type ExpenseSearch struct {
	Items []ExpenseHit `json:"items"`
	Count int          `json:"count"` // total de coincidencias (para paginar)
}

type ExpenseSearchResult struct {
	Data  *ExpenseSearch   `json:"data,omitempty"`
	Error *shared.AppError `json:"error,omitempty"`
}

// --- Trash (papelera) ---

// TrashItem is one soft-deleted record of any entity type, shown in the trash
// view with a Restore action.
type TrashItem struct {
	Type        string         `json:"type"` // card|category|merchant|income|expense|fixedexpense
	ID          int64          `json:"id"`
	Description string         `json:"description"`
	Amount      *types.Decimal `json:"amount,omitempty"`
	Period      string         `json:"period,omitempty"`
	DeletedAt   time.Time      `json:"deletedAt"`
}

type TrashResult struct {
	Data  []TrashItem      `json:"data,omitempty"`
	Error *shared.AppError `json:"error,omitempty"`
}
