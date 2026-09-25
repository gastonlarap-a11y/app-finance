// Row→model mappers: snake_case SQLite columns to the camelCase shapes the UI
// receives (identical to what Wails serializes from the Go structs).
import type {
  Card,
  CardStatement,
  CardStatementLine,
  CardStatementScheduleEntry,
  Category,
  Expense,
  FixedExpense,
  ImportItem,
  Income,
  Installment,
  Merchant,
  MerchantRule,
  PeriodSalary,
  SavingsContribution,
  SavingsGoal,
  Settings,
} from '@/services/contract'
import {
  asNullableNumber,
  asNullableString,
  asNumber,
  asString,
  type SqlRow,
} from '@/engine/db/types'

// Expense kinds / installment statuses (mirror backend/finance constants).
export const KindUnico = 'unico'
export const KindCuotas = 'cuotas'
export const StatusPendiente = 'pendiente'
export const StatusPagado = 'pagado'
export const SourceCuota = 'cuota'
export const SourceFijo = 'fijo'

// Import inbox (mirror backend/finance/importitem.go constants).
export const ImportSourceEmail = 'email'
export const ImportSourcePDFAccount = 'pdf_account'
export const ImportSourcePDFCard = 'pdf_card'
export const ImportPendiente = 'pendiente'
export const ImportConfirmado = 'confirmado'
export const ImportDescartado = 'descartado'
export const ImportConciliado = 'conciliado'
export const HintNone = ''
export const HintCardPayment = 'card_payment'
export const HintTransfer = 'transfer'
export const ImportKindExpense = 'gasto'
export const ImportKindCredit = 'abono'

// Card statements (mirror backend/finance/cardstatement.go constants).
export const StatementNational = 'nacional'
export const StatementInternational = 'internacional'
export const LinePayment = 'pago'
export const LinePurchase = 'compra'
export const LineVoluntary = 'voluntario'
export const LineCharge = 'cargo'
export const LineCredit = 'abono'

export function rowToImportItem(r: SqlRow): ImportItem {
  return {
    id: asNumber(r.id),
    userId: asNumber(r.user_id),
    source: asString(r.source),
    issuer: asString(r.issuer),
    date: asString(r.date),
    description: asString(r.description),
    amount: asString(r.amount),
    currency: asString(r.currency),
    cardLastDigits: asString(r.card_last_digits),
    installmentsTotal: asNumber(r.installments_total),
    hint: asString(r.hint),
    status: asString(r.status),
    expenseId: asNullableNumber(r.expense_id),
    matchedItemId: asNullableNumber(r.matched_item_id),
    createdAt: asString(r.created_at),
    kind: asString(r.kind),
    statementLineId: asNullableNumber(r.statement_line_id),
    installmentNumber: asNumber(r.installment_number),
    installmentAmount: asString(r.installment_amount),
    firstPeriod: asString(r.first_period),
    incomeId: asNullableNumber(r.income_id),
    fixedExpenseId: asNullableNumber(r.fixed_expense_id),
    fixedPeriod: asString(r.fixed_period),
  }
}

export function rowToCardStatement(r: SqlRow): CardStatement {
  return {
    id: asNumber(r.id),
    userId: asNumber(r.user_id),
    cardId: asNullableNumber(r.card_id),
    issuer: asString(r.issuer),
    kind: asString(r.kind),
    currency: asString(r.currency),
    cardLastDigits: asString(r.card_last_digits),
    statementDate: asString(r.statement_date),
    period: asString(r.period),
    periodFrom: asString(r.period_from),
    periodTo: asString(r.period_to),
    dueDate: asString(r.due_date),
    previousPeriodFrom: asString(r.previous_period_from),
    previousPeriodTo: asString(r.previous_period_to),
    nextPeriodFrom: asString(r.next_period_from),
    nextPeriodTo: asString(r.next_period_to),
    creditLimit: asString(r.credit_limit),
    creditUsed: asString(r.credit_used),
    creditAvailable: asString(r.credit_available),
    cashLimit: asString(r.cash_limit),
    cashUsed: asString(r.cash_used),
    cashAvailable: asString(r.cash_available),
    previousBalanceStart: asString(r.previous_balance_start),
    previousBilled: asString(r.previous_billed),
    previousPaid: asString(r.previous_paid),
    previousBalanceEnd: asString(r.previous_balance_end),
    transferFromNational: asString(r.transfer_from_national),
    totalOperations: asString(r.total_operations),
    voluntaryProducts: asString(r.voluntary_products),
    chargesNet: asString(r.charges_net),
    totalBilled: asString(r.total_billed),
    minimumPayment: asString(r.minimum_payment),
    prepaymentCost: asString(r.prepayment_cost),
    automaticCharge: asString(r.automatic_charge),
    unbilledBalance: asString(r.unbilled_balance),
    rateRevolving: asString(r.rate_revolving),
    rateInstallments: asString(r.rate_installments),
    rateCashAdvance: asString(r.rate_cash_advance),
    caeRevolving: asString(r.cae_revolving),
    caeInstallments: asString(r.cae_installments),
    caeCashAdvance: asString(r.cae_cash_advance),
    caePrepayment: asString(r.cae_prepayment),
    lateInterestRate: asString(r.late_interest_rate),
    fxRate: asString(r.fx_rate),
    fileHash: asString(r.file_hash),
    importedAt: asString(r.imported_at),
  }
}

export function rowToCardStatementLine(r: SqlRow): CardStatementLine {
  return {
    id: asNumber(r.id),
    userId: asNumber(r.user_id),
    statementId: asNumber(r.statement_id),
    position: asNumber(r.position),
    section: asString(r.section),
    place: asString(r.place),
    city: asString(r.city),
    country: asString(r.country),
    operationDate: asString(r.operation_date),
    reference: asString(r.reference),
    description: asString(r.description),
    interestRate: asString(r.interest_rate),
    operationAmount: asString(r.operation_amount),
    totalAmount: asString(r.total_amount),
    installmentNumber: asNumber(r.installment_number),
    installmentsTotal: asNumber(r.installments_total),
    installmentAmount: asString(r.installment_amount),
    originAmount: asString(r.origin_amount),
    importItemId: asNullableNumber(r.import_item_id),
    installmentId: asNullableNumber(r.installment_id),
  }
}

export function rowToScheduleEntry(r: SqlRow): CardStatementScheduleEntry {
  return {
    id: asNumber(r.id),
    statementId: asNumber(r.statement_id),
    period: asString(r.period),
    amount: asString(r.amount),
  }
}

export function rowToMerchantRule(r: SqlRow): MerchantRule {
  return {
    id: asNumber(r.id),
    userId: asNumber(r.user_id),
    pattern: asString(r.pattern),
    merchant: asString(r.merchant),
    category: asString(r.category),
    createdAt: asString(r.created_at),
  }
}

export function rowToCard(r: SqlRow): Card {
  return {
    id: asNumber(r.id),
    userId: asNumber(r.user_id),
    name: asString(r.name),
    creditLimit: asString(r.credit_limit),
    billingDay: asNumber(r.billing_day),
    lastDigits: asString(r.last_digits),
    createdAt: asString(r.created_at),
    deletedAt: asNullableString(r.deleted_at),
  }
}

export function rowToCategory(r: SqlRow): Category {
  return {
    id: asNumber(r.id),
    userId: asNumber(r.user_id),
    name: asString(r.name),
    createdAt: asString(r.created_at),
    deletedAt: asNullableString(r.deleted_at),
  }
}

export function rowToMerchant(r: SqlRow): Merchant {
  return {
    id: asNumber(r.id),
    userId: asNumber(r.user_id),
    name: asString(r.name),
    createdAt: asString(r.created_at),
    deletedAt: asNullableString(r.deleted_at),
  }
}

export function rowToSavingsGoal(r: SqlRow): SavingsGoal {
  return {
    id: asNumber(r.id),
    userId: asNumber(r.user_id),
    name: asString(r.name),
    targetAmount: asString(r.target_amount),
    targetPeriod: asString(r.target_period),
    createdAt: asString(r.created_at),
    deletedAt: asNullableString(r.deleted_at),
  }
}

export function rowToSavingsContribution(r: SqlRow): SavingsContribution {
  return {
    id: asNumber(r.id),
    userId: asNumber(r.user_id),
    goalId: asNumber(r.goal_id),
    period: asString(r.period),
    amount: asString(r.amount),
    createdAt: asString(r.created_at),
  }
}

export function rowToIncome(r: SqlRow): Income {
  return {
    id: asNumber(r.id),
    userId: asNumber(r.user_id),
    period: asString(r.period),
    description: asString(r.description),
    amount: asString(r.amount),
    createdAt: asString(r.created_at),
    deletedAt: asNullableString(r.deleted_at),
  }
}

export function rowToExpense(r: SqlRow): Expense {
  return {
    id: asNumber(r.id),
    userId: asNumber(r.user_id),
    date: asString(r.date),
    description: asString(r.description),
    category: asString(r.category),
    merchant: asString(r.merchant),
    cardId: asNullableNumber(r.card_id),
    kind: asString(r.kind),
    installmentAmount: asString(r.installment_amount),
    installmentsTotal: asNumber(r.installments_total),
    createdAt: asString(r.created_at),
    deletedAt: asNullableString(r.deleted_at),
  }
}

export function rowToInstallment(r: SqlRow): Installment {
  return {
    id: asNumber(r.id),
    userId: asNumber(r.user_id),
    expenseId: asNumber(r.expense_id),
    number: asNumber(r.number),
    total: asNumber(r.total),
    period: asString(r.period),
    amount: asString(r.amount),
    status: asString(r.status),
    paidAt: asNullableString(r.paid_at),
  }
}

export function rowToPeriodSalary(r: SqlRow): PeriodSalary {
  return {
    userId: asNumber(r.user_id),
    period: asString(r.period),
    amount: asString(r.amount),
  }
}

export function rowToSettings(r: SqlRow): Settings {
  return {
    id: asNumber(r.id),
    defaultBillingDay: asNumber(r.default_billing_day),
  }
}

export function rowToFixedExpense(r: SqlRow): FixedExpense {
  return {
    id: asNumber(r.id),
    userId: asNumber(r.user_id),
    description: asString(r.description),
    category: asString(r.category),
    cardId: asNullableNumber(r.card_id),
    startPeriod: asString(r.start_period),
    // end_period is NULL in SQL for "active forever"; Go models it as "".
    endPeriod: asString(r.end_period),
    createdAt: asString(r.created_at),
    deletedAt: asNullableString(r.deleted_at),
  }
}

export interface FixedExpenseAmountRow {
  fixedExpenseId: number
  effectiveFrom: string
  amount: string
}

export function rowToFixedExpenseAmount(r: SqlRow): FixedExpenseAmountRow {
  return {
    fixedExpenseId: asNumber(r.fixed_expense_id),
    effectiveFrom: asString(r.effective_from),
    amount: asString(r.amount),
  }
}
