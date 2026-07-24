// Web-build stand-in for '@/services/finance' (aliased by vite --mode web):
// same call surface as the Wails bindings wrapper, backed by the local SQLite
// engine running in the worker instead of the Go backend.
import { remoteService } from '@/services/web/worker-client'
import type { FinanceServiceContract } from '@/services/contract'

export const FinanceService = remoteService<FinanceServiceContract>('finance')

export type {
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
  Merchant,
  MerchantResult,
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
} from '@/services/contract'

export const KIND_UNICO = 'unico'
export const KIND_CUOTAS = 'cuotas'
export const STATUS_PENDIENTE = 'pendiente'
export const STATUS_PAGADO = 'pagado'
export const SOURCE_CUOTA = 'cuota'
export const SOURCE_FIJO = 'fijo'
