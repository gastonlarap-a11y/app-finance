// Single wrapper around the auto-generated, git-ignored Wails bindings. Import
// the FinanceService + models from here everywhere — never from bindings/ directly.
//
// The generated models type Go's types.Decimal as `any`, which would erase money
// typing across the UI. So the service is exported typed as the hand-written
// contract (money = decimal string), and the assignment below makes tsc prove
// the generated bindings still satisfy it: a Go signature change that is not
// mirrored in contract.ts fails the desktop typecheck.
import { FinanceService as Bound } from '@/../bindings/github.com/gastonlarap-a11y/app-finance/backend/finance'
import type { FinanceServiceContract } from '@/services/contract'

export const FinanceService: FinanceServiceContract = Bound

export type {
  Account,
  AccountView,
  AccountsSummary,
  BudgetStatus,
  Card,
  CardDebt,
  CardOwed,
  CardResult,
  CardStatement,
  CardStatementDetail,
  CardStatementDetailResult,
  CardStatementImport,
  CardStatementImportResult,
  CardStatementInput,
  CardStatementLine,
  CardStatementLineInput,
  CardStatementLineView,
  CardStatementScheduleEntry,
  CardStatementView,
  CardStatementsResult,
  Category,
  CategoryBudgetView,
  CategoryBudgetsResult,
  CategoryResult,
  CategoryTotal,
  CategoryYearRow,
  Due,
  DuesResult,
  Expense,
  ExpenseFilter,
  ExpenseHit,
  ExpenseResult,
  ExpenseSearch,
  ExpenseSearchResult,
  FixedExpense,
  FixedExpenseResult,
  FixedExpenseView,
  ForecastMonth,
  ForecastResult,
  ImportBatch,
  ImportCandidate,
  ImportItem,
  ImportItemView,
  ImportItemsResult,
  Income,
  IncomeResult,
  Merchant,
  MerchantResult,
  MerchantRule,
  MonthlySummary,
  MonthlySummaryResult,
  Movimiento,
  OpResult,
  PeriodSalary,
  Reconciliation,
  ReconciliationResult,
  ReconciliationStatus,
  RecurringSuggestion,
  Refund,
  RefundResult,
  Tag,
  TagView,
  SalaryResult,
  SavingsContribution,
  SavingsGoal,
  SavingsGoalView,
  Settings,
  SettingsResult,
  SpendingTrend,
  StageResult,
  StageSummary,
  Transfer,
  TransferResult,
  CatalogSummary,
  CatalogResult,
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
export const SOURCE_REEMBOLSO = 'reembolso'
