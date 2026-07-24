// Hand-written mirror of the Go domain types and bound service surfaces
// (backend/finance, backend/users), field-by-field from their `json:` tags.
// The web build (--mode web) aliases '@/services/{finance,users,settings}' to
// '@/services/web/*', whose implementations must satisfy these contracts; the
// desktop build keeps using the Wails-generated bindings, which serialize to
// exactly these shapes. Dates are RFC3339/SQLite TIMESTAMP strings; money is
// always a decimal string (never a JS number).

export interface AppError {
  code: string
  message: string
}

export interface OpResult {
  error?: AppError | null
}

export interface Result<T> {
  data?: T | null
  error?: AppError | null
}

// ---------- finance models ----------

export interface Card {
  id: number
  userId: number
  name: string
  creditLimit: string
  billingDay: number
  createdAt: string
  deletedAt?: string | null
}

export interface Category {
  id: number
  userId: number
  name: string
  createdAt: string
  deletedAt?: string | null
}

export interface Merchant {
  id: number
  userId: number
  name: string
  createdAt: string
  deletedAt?: string | null
}

export interface Income {
  id: number
  userId: number
  period: string
  description: string
  amount: string
  createdAt: string
  deletedAt?: string | null
}

export interface Expense {
  id: number
  userId: number
  date: string
  description: string
  category: string
  merchant: string
  cardId: number | null
  kind: string
  installmentAmount: string
  installmentsTotal: number
  createdAt: string
  deletedAt?: string | null
}

export interface Installment {
  id: number
  userId: number
  expenseId: number
  number: number
  total: number
  period: string
  amount: string
  status: string
  paidAt: string | null
  expense?: Expense | null
}

export interface PeriodSalary {
  userId: number
  period: string
  amount: string
}

export interface Settings {
  id: number
  defaultBillingDay: number
}

export interface FixedExpense {
  id: number
  userId: number
  description: string
  category: string
  cardId: number | null
  startPeriod: string
  endPeriod: string
  createdAt: string
  deletedAt?: string | null
}

export interface FixedExpenseView extends FixedExpense {
  currentAmount: string
  cardName: string
  active: boolean
}

export interface Movimiento {
  source: string
  installmentId: number
  expenseId: number
  fixedId: number | null
  description: string
  category: string
  merchant: string
  cardId: number | null
  cardName: string
  kind: string
  number: number
  total: number
  amount: string
  status: string
  date: string | null
}

export interface CategoryTotal {
  category: string
  total: string
}

export interface CardDebt {
  card: Card
  gastoMes: string
  cupoUsado: string
  cupoDisponible: string
}

export interface MonthlySummary {
  period: string
  salary: string
  extras: string
  ingresos: string
  acumulado: string
  disponible: string
  gastos: string
  pendiente: string
  pagado: string
  balance: string
  alcanza: boolean
  porCategoria: CategoryTotal[]
  porTarjeta: CardDebt[]
  movimientos: Movimiento[]
  incomes: Income[]
}

export interface YearMonth {
  period: string
  ingresos: string
  gastos: string
  balance: string
  saldo: string
  alcanza: boolean
}

export interface YearSummary {
  year: number
  months: YearMonth[]
  porCategoria: CategoryTotal[]
  totalIngresos: string
  totalGastos: string
  totalBalance: string
}

export interface TrashItem {
  type: string
  id: number
  description: string
  amount?: string | null
  period?: string
  deletedAt: string
}

// ---------- result aliases (named like the Go structs / generated bindings) ----------

export type CardResult = Result<Card>
export type CategoryResult = Result<Category>
export type MerchantResult = Result<Merchant>
export type IncomeResult = Result<Income>
export type ExpenseResult = Result<Expense>
export type SettingsResult = Result<Settings>
export type SalaryResult = Result<PeriodSalary>
export type FixedExpenseResult = Result<FixedExpense>
export type MonthlySummaryResult = Result<MonthlySummary>
export type YearSummaryResult = Result<YearSummary>
export type TrashResult = Result<TrashItem[]>

// ---------- users ----------

export interface User {
  id: number
  name: string
  createdAt: string
  deletedAt?: string | null
}

export type UserResult = Result<User>

// ---------- bound service surfaces ----------

export interface FinanceServiceContract {
  GetSettings(): Promise<SettingsResult>
  GetSalary(period: string): Promise<SalaryResult>
  SetSalary(period: string, amount: string): Promise<SalaryResult>

  ListCards(): Promise<Card[]>
  CreateCard(name: string, creditLimit: string, billingDay: number): Promise<CardResult>
  UpdateCard(id: number, name: string, creditLimit: string, billingDay: number): Promise<CardResult>
  DeleteCard(id: number): Promise<OpResult>
  RestoreCard(id: number): Promise<OpResult>

  ListCategories(): Promise<Category[]>
  CreateCategory(name: string): Promise<CategoryResult>
  UpdateCategory(id: number, name: string): Promise<CategoryResult>
  DeleteCategory(id: number): Promise<OpResult>
  RestoreCategory(id: number): Promise<OpResult>

  ListMerchants(): Promise<Merchant[]>
  CreateMerchant(name: string): Promise<MerchantResult>
  UpdateMerchant(id: number, name: string): Promise<MerchantResult>
  DeleteMerchant(id: number): Promise<OpResult>
  RestoreMerchant(id: number): Promise<OpResult>

  ListIncomes(period: string): Promise<Income[]>
  CreateIncome(period: string, description: string, amount: string): Promise<IncomeResult>
  DeleteIncome(id: number): Promise<OpResult>
  RestoreIncome(id: number): Promise<OpResult>

  ListExpenses(period: string): Promise<Expense[]>
  CreateExpense(
    dateStr: string, description: string, category: string, merchant: string,
    cardID: number | null, kind: string, installmentAmount: string, installmentsTotal: number,
  ): Promise<ExpenseResult>
  UpdateExpense(
    id: number, dateStr: string, description: string, category: string, merchant: string,
    cardID: number | null, kind: string, installmentAmount: string, installmentsTotal: number,
  ): Promise<ExpenseResult>
  DeleteExpense(id: number): Promise<OpResult>
  RestoreExpense(id: number): Promise<OpResult>
  SetInstallmentPaid(id: number, paid: boolean): Promise<OpResult>

  ListFixedExpenses(): Promise<FixedExpenseView[]>
  CreateFixedExpense(
    description: string, category: string, cardID: number | null, startPeriod: string, amount: string,
  ): Promise<FixedExpenseResult>
  UpdateFixedExpense(
    id: number, description: string, category: string, cardID: number | null,
  ): Promise<FixedExpenseResult>
  SetFixedExpenseAmount(id: number, fromPeriod: string, amount: string): Promise<OpResult>
  EndFixedExpense(id: number, fromPeriod: string): Promise<OpResult>
  DeleteFixedExpense(id: number): Promise<OpResult>
  RestoreFixedExpense(id: number): Promise<OpResult>
  SetFixedExpensePaid(id: number, period: string, paid: boolean): Promise<OpResult>

  MonthlySummary(period: string): Promise<MonthlySummaryResult>
  YearSummary(year: number): Promise<YearSummaryResult>

  ListTrash(): Promise<TrashResult>
}

export interface UsersServiceContract {
  ListUsers(): Promise<User[]>
  ActiveUser(): Promise<UserResult>
  CreateUser(name: string): Promise<UserResult>
  SwitchUser(id: number): Promise<UserResult>
  RenameUser(id: number, name: string): Promise<UserResult>
  DeleteUser(id: number): Promise<UserResult>
  RestoreUser(id: number): Promise<OpResult>
  ListDeletedUsers(): Promise<User[]>
}
