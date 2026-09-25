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
	Ahorro       types.Decimal   `json:"ahorro"`  // aportes a metas del mes (salen del disponible)
	Balance      types.Decimal   `json:"balance"` // disponible − gastos − ahorro
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
	Ahorro   types.Decimal `json:"ahorro"`  // aportes a metas del mes
	Balance  types.Decimal `json:"balance"` // neto del mes (ingresos − gastos − ahorro)
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
	TotalAhorro    types.Decimal     `json:"totalAhorro"`
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
	Ahorro          types.Decimal `json:"ahorro"`       // aportes a metas ya registrados para ese mes
	Ingresos        types.Decimal `json:"ingresos"`
	IngresoEstimado bool          `json:"ingresoEstimado"` // sin sueldo cargado: se usa el último conocido
	Libre           types.Decimal `json:"libre"`           // ingresos − comprometido − ahorro
	SaldoProyectado types.Decimal `json:"saldoProyectado"` // saldo acumulado al cierre si sólo ocurre lo comprometido
}

type ForecastResult struct {
	Data  []ForecastMonth  `json:"data,omitempty"`
	Error *shared.AppError `json:"error,omitempty"`
}

// --- Savings goals ---

type SavingsGoalResult struct {
	Data  *SavingsGoal     `json:"data,omitempty"`
	Error *shared.AppError `json:"error,omitempty"`
}

type SavingsContributionResult struct {
	Data  *SavingsContribution `json:"data,omitempty"`
	Error *shared.AppError     `json:"error,omitempty"`
}

// SavingsGoalView is a goal with its progress. MonthlyNeeded is what still has
// to be saved per month (current month included) to reach the target by
// TargetPeriod; zero without a target month, once reached, or when it passed.
type SavingsGoalView struct {
	SavingsGoal
	Saved         types.Decimal         `json:"saved"`
	Remaining     types.Decimal         `json:"remaining"`
	MonthsLeft    int                   `json:"monthsLeft"`
	MonthlyNeeded types.Decimal         `json:"monthlyNeeded"`
	Contributions []SavingsContribution `json:"contributions"` // newest first
}

// --- Spending trend ---

// TrendMonth is one month's totals in a trend window.
type TrendMonth struct {
	Period string        `json:"period"`
	Gastos types.Decimal `json:"gastos"`
}

// CategoryTrend compares a category's spend in the selected month with the
// previous month and with the average of the months before it in the window.
type CategoryTrend struct {
	Category string        `json:"category"`
	Current  types.Decimal `json:"current"`
	Previous types.Decimal `json:"previous"`
	Average  types.Decimal `json:"average"` // promedio de los meses anteriores de la ventana (redondeado)
}

type SpendingTrend struct {
	Months     []TrendMonth    `json:"months"` // oldest first, the selected month last
	Current    types.Decimal   `json:"current"`
	Previous   types.Decimal   `json:"previous"`
	Average    types.Decimal   `json:"average"`
	Categories []CategoryTrend `json:"categories"` // by current spend, descending
}

type SpendingTrendResult struct {
	Data  *SpendingTrend   `json:"data,omitempty"`
	Error *shared.AppError `json:"error,omitempty"`
}

// --- Recurring detection ---

// RecurringSuggestion is a one-off expense that keeps coming back every month
// with a similar amount — a candidate to become a fixed expense.
type RecurringSuggestion struct {
	Description string        `json:"description"`
	Merchant    string        `json:"merchant"`
	Category    string        `json:"category"`
	CardID      *int64        `json:"cardId"`
	Amount      types.Decimal `json:"amount"`  // monto más reciente
	Periods     []string      `json:"periods"` // meses en que apareció (ascendente)
	NextPeriod  string        `json:"nextPeriod"`
}

type RecurringResult struct {
	Data  []RecurringSuggestion `json:"data,omitempty"`
	Error *shared.AppError      `json:"error,omitempty"`
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

// --- Import inbox ---

// StageSummary reports what a StageImport did with each candidate: Added are
// new pending items, Duplicates were already in the inbox (same external key)
// and Reconciled matched an item from the other source family.
type StageSummary struct {
	Added      int `json:"added"`
	Duplicates int `json:"duplicates"`
	Reconciled int `json:"reconciled"`
}

type StageResult struct {
	Data  *StageSummary    `json:"data,omitempty"`
	Error *shared.AppError `json:"error,omitempty"`
}

// ImportItemView is an inbox item plus everything the review screen suggests:
// the card resolved from its last digits, the merchant/category of the rule it
// matches, the pattern a new rule would use, a live expense that looks like the
// same purchase (to link instead of duplicating it) and, for conciliado items,
// the sighting it was matched with.
type ImportItemView struct {
	ImportItem
	CardID               *int64 `json:"cardId"`
	CardName             string `json:"cardName"`
	RulePattern          string `json:"rulePattern"` // "" = ninguna regla aplica
	SuggestedMerchant    string `json:"suggestedMerchant"`
	SuggestedCategory    string `json:"suggestedCategory"`
	SuggestedPattern     string `json:"suggestedPattern"`
	DuplicateExpenseID   *int64 `json:"duplicateExpenseId"`
	DuplicateDescription string `json:"duplicateDescription"`
	MatchedSource        string `json:"matchedSource"`
	MatchedDate          string `json:"matchedDate"`
	// USD items: the amount in CLP at the rate implied by the last payment of
	// the USD card debt; "" when no such payment is known yet.
	SuggestedAmountClp string `json:"suggestedAmountClp"`
}

type ImportItemsResult struct {
	Data  []ImportItemView `json:"data,omitempty"`
	Error *shared.AppError `json:"error,omitempty"`
}

// --- Card statements ---

// CardStatementImport reports what ImportCardStatement did.
type CardStatementImport struct {
	StatementID        int64 `json:"statementId"`
	AlreadyImported    bool  `json:"alreadyImported"`    // the same statement was imported before: nothing changed
	Added              int   `json:"added"`              // new items in the inbox
	Duplicates         int   `json:"duplicates"`         // already in the inbox (e.g. from last month's statement)
	Reconciled         int   `json:"reconciled"`         // matched an alert email
	LinkedInstallments int   `json:"linkedInstallments"` // cuotas that continue expenses already in the app
	PaymentsMatched    int   `json:"paymentsMatched"`    // cartola card payments this statement accounts for
}

type CardStatementImportResult struct {
	Data  *CardStatementImport `json:"data,omitempty"`
	Error *shared.AppError     `json:"error,omitempty"`
}

// CardStatementView is a statement compared with the app: BankCharges are the
// period's purchases, products and charges (what the app's expenses on the
// card should add up to), BankCredits the credits (recorded as income), and
// AppCharges what the app has on that card for the period (nil when the card
// is not linked by its last digits, or for a USD statement).
type CardStatementView struct {
	CardStatement
	CardName     string         `json:"cardName"`
	BankCharges  types.Decimal  `json:"bankCharges"`
	BankCredits  types.Decimal  `json:"bankCredits"`
	AppCharges   *types.Decimal `json:"appCharges"`
	PendingItems int            `json:"pendingItems"` // lines still waiting in the inbox
}

type CardStatementsResult struct {
	Data  []CardStatementView `json:"data,omitempty"`
	Error *shared.AppError    `json:"error,omitempty"`
}

// CardStatementLineView is a line and what became of it in the app.
type CardStatementLineView struct {
	CardStatementLine
	ItemStatus         string `json:"itemStatus"` // status of its inbox item; "" = not staged
	ExpenseID          *int64 `json:"expenseId"`  // expense it became or whose cuota it bills
	ExpenseDescription string `json:"expenseDescription"`
	RedeemedPurchase   string `json:"redeemedPurchase"` // credits: the purchase a points redemption pays
}

type CardStatementDetail struct {
	Statement CardStatementView            `json:"statement"`
	Lines     []CardStatementLineView      `json:"lines"`
	Schedule  []CardStatementScheduleEntry `json:"schedule"`
}

type CardStatementDetailResult struct {
	Data  *CardStatementDetail `json:"data,omitempty"`
	Error *shared.AppError     `json:"error,omitempty"`
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
