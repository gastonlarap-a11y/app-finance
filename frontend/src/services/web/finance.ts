// Web-build stand-in for '@/services/finance' (aliased by vite --mode web):
// same call surface as the Wails bindings wrapper, backed by the local SQLite
// engine running in the worker instead of the Go backend.
import { remoteService } from '@/services/web/worker-client'
import type { FinanceServiceContract } from '@/services/contract'

export const FinanceService = remoteService<FinanceServiceContract>('finance')

export type {
  BudgetStatus,
  Card,
  CardDebt,
  CardResult,
  Category,
  CategoryBudgetView,
  CategoryBudgetsResult,
  CategoryResult,
  CategoryTotal,
  CategoryYearRow,
  Expense,
  ExpenseFilter,
  ExpenseHit,
  ExpenseResult,
  ExpenseSearch,
  ExpenseSearchResult,
  ForecastMonth,
  ForecastResult,
  FixedExpense,
  FixedExpenseResult,
  FixedExpenseView,
  Income,
  IncomeResult,
  Merchant,
  MerchantResult,
  MonthlySummary,
  MonthlySummaryResult,
  Movimiento,
  OpResult,
  PeriodSalary,
  RecurringSuggestion,
  SalaryResult,
  SavingsContribution,
  SavingsGoal,
  SavingsGoalView,
  Settings,
  SettingsResult,
  SpendingTrend,
  TrashItem,
  TrashResult,
  TrendMonth,
  YearMonth,
  YearSummary,
  YearSummaryResult,
} from '@/services/contract'

export const KIND_UNICO = 'unico'
export const KIND_CUOTAS = 'cuotas'
export const STATUS_PENDIENTE = 'pendiente'
export const STATUS_PAGADO = 'pagado'
export const SOURCE_CUOTA = 'cuota'
export const SOURCE_FIJO = 'fijo'
