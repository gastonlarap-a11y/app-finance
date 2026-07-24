// Row→model mappers: snake_case SQLite columns to the camelCase shapes the UI
// receives (identical to what Wails serializes from the Go structs).
import type {
  Card,
  Category,
  Expense,
  FixedExpense,
  Income,
  Installment,
  Merchant,
  PeriodSalary,
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

export function rowToCard(r: SqlRow): Card {
  return {
    id: asNumber(r.id),
    userId: asNumber(r.user_id),
    name: asString(r.name),
    creditLimit: asString(r.credit_limit),
    billingDay: asNumber(r.billing_day),
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
