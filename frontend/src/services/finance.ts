// Single wrapper around the auto-generated, git-ignored Wails bindings. Import
// the FinanceService + models from here everywhere — never from bindings/ directly.
export {
  FinanceService,
  Card,
  CardDebt,
  CardResult,
  Category,
  CategoryResult,
  CategoryTotal,
  Expense,
  ExpenseResult,
  FixedExpense,
  FixedExpenseResult,
  FixedExpenseView,
  Income,
  IncomeResult,
  MonthlySummary,
  MonthlySummaryResult,
  Movimiento,
  OpResult,
  PeriodSalary,
  SalaryResult,
  Settings,
  SettingsResult,
  TrashItem,
  TrashResult,
  YearMonth,
  YearSummary,
  YearSummaryResult,
} from '@/../bindings/github.com/gastonlarap-a11y/app-finance/backend/finance'

export const KIND_UNICO = 'unico'
export const KIND_CUOTAS = 'cuotas'
export const STATUS_PENDIENTE = 'pendiente'
export const STATUS_PAGADO = 'pagado'
export const SOURCE_CUOTA = 'cuota'
export const SOURCE_FIJO = 'fijo'
