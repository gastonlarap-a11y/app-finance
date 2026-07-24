// TypeScript port of backend/finance/service.go for the web build: identical
// method surface, validation messages, scoping and math — over a local SQLite
// (sqlite-wasm) instead of the Go backend. Every query filters by the active
// user id (session.active()), mirroring the desktop invariant.
import type {
  Card,
  CardDebt,
  CardResult,
  CategoryResult,
  CategoryTotal,
  Expense,
  ExpenseResult,
  FinanceServiceContract,
  FixedExpense,
  FixedExpenseResult,
  FixedExpenseView,
  Income,
  Installment,
  MerchantResult,
  MonthlySummary,
  MonthlySummaryResult,
  Movimiento,
  OpResult,
  PeriodSalary,
  SalaryResult,
  SettingsResult,
  TrashItem,
  TrashResult,
  YearMonth,
  YearSummary,
  YearSummaryResult,
} from '@/services/contract'
import { ErrConflict, ErrNotFound, ErrValidation, isUniqueViolation, newError } from '@/engine/errors'
import { Money, parseAmount } from '@/engine/decimal'
import { addMonths, currentPeriod, periodOf, validPeriod, type DateParts } from '@/engine/finance/period'
import { activeIn, resolveFixedAmount } from '@/engine/finance/fixedexpense'
import {
  KindCuotas,
  KindUnico,
  SourceCuota,
  SourceFijo,
  StatusPagado,
  StatusPendiente,
  rowToCard,
  rowToCategory,
  rowToExpense,
  rowToFixedExpense,
  rowToFixedExpenseAmount,
  rowToIncome,
  rowToInstallment,
  rowToMerchant,
  rowToPeriodSalary,
  rowToSettings,
  type FixedExpenseAmountRow,
} from '@/engine/finance/models'
import { asNumber, type SqlDb, type SqlValue } from '@/engine/db/types'

export interface ActiveSession {
  active(): number
}

// nowIso is the timestamp format the engine writes (RFC3339 UTC) — parseable by
// Safari's Date, by Intl, and by Go/bun when the file is imported on desktop.
function nowIso(): string {
  return new Date().toISOString()
}

interface ParsedDate {
  parts: DateParts
  // iso is what gets stored in expenses.date.
  iso: string
}

// parseDate mirrors the Go helper's accepted layouts: YYYY-MM-DD, RFC3339 and
// DD/MM/YYYY. Returns null for anything else (caller builds the AppError).
function parseDate(s: string): ParsedDate | null {
  const t = s.trim()
  let y = 0
  let m = 0
  let d = 0
  let iso = ''
  let match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t)
  if (match) {
    ;[y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])]
    iso = `${t}T00:00:00Z`
  } else if ((match = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(t))) {
    ;[y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])]
    iso = t
  } else if ((match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(t))) {
    ;[y, m, d] = [Number(match[3]), Number(match[2]), Number(match[1])]
    iso = `${match[3]}-${match[2]}-${match[1]}T00:00:00Z`
  } else {
    return null
  }
  // Reject impossible dates the same way time.Parse does (e.g. 2026-02-30).
  const check = new Date(Date.UTC(y, m - 1, d))
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) {
    return null
  }
  return { parts: { year: y, month: m, day: d }, iso }
}

const invalidPeriodError = () => newError(ErrValidation, 'período inválido (use YYYY-MM)')
const invalidAmountError = (s: string) => newError(ErrValidation, 'monto inválido: ' + s)

// amountOrError mirrors parseAmount in Go: invalid → "monto inválido", negative
// → dedicated message.
function amountOrError(s: string): { amount?: Money; error?: ReturnType<typeof newError> } {
  try {
    const m = Money.fromString(s.trim())
    if (m.isNegative()) {
      return { error: newError(ErrValidation, 'el monto no puede ser negativo') }
    }
    return { amount: m }
  } catch {
    return { error: invalidAmountError(s) }
  }
}

export function createFinanceService(db: SqlDb, session: ActiveSession): FinanceServiceContract {
  const uid = () => session.active()

  // ---------- internal helpers (ports of the Go private methods) ----------

  function salaryFor(period: string): Money {
    const rows = db.query('SELECT * FROM period_salaries WHERE user_id = ? AND period = ?', [uid(), period])
    const row = rows[0]
    return row ? Money.fromString(rowToPeriodSalary(row).amount) : Money.zero()
  }

  function listCardsActive(): Card[] {
    return db
      .query('SELECT * FROM cards WHERE user_id = ? AND deleted_at IS NULL ORDER BY name ASC', [uid()])
      .map(rowToCard)
  }

  // cardMapAll includes soft-deleted cards so historical movimientos keep their
  // card name after the card is deleted.
  function cardMapAll(): Map<number, Card> {
    const out = new Map<number, Card>()
    for (const r of db.query('SELECT * FROM cards WHERE user_id = ?', [uid()])) {
      const c = rowToCard(r)
      out.set(c.id, c)
    }
    return out
  }

  // billingDayFor: the card's cutoff day, or 0 (no roll) without a card.
  function billingDayFor(cardID: number | null): { day: number; error?: ReturnType<typeof newError> } {
    if (cardID == null) return { day: 0 }
    const rows = db.query('SELECT * FROM cards WHERE id = ? AND user_id = ? AND deleted_at IS NULL', [cardID, uid()])
    const row = rows[0]
    if (!row) return { day: 0, error: newError(ErrValidation, 'la tarjeta indicada no existe') }
    return { day: rowToCard(row).billingDay }
  }

  interface ValidatedExpense {
    date: ParsedDate
    description: string
    category: string
    merchant: string
    cardId: number | null
    kind: string
    installmentAmount: Money
    installmentsTotal: number
  }

  function validateExpense(
    dateStr: string,
    description: string,
    category: string,
    merchant: string,
    cardID: number | null,
    kind: string,
    installmentAmount: string,
    installmentsTotal: number,
  ): { expense?: ValidatedExpense; error?: ReturnType<typeof newError> } {
    if (description.trim() === '') {
      return { error: newError(ErrValidation, 'la descripción es obligatoria') }
    }
    const date = parseDate(dateStr)
    if (!date) {
      return { error: newError(ErrValidation, 'fecha inválida: ' + dateStr.trim()) }
    }
    const parsed = amountOrError(installmentAmount)
    if (parsed.error || !parsed.amount) return { error: parsed.error ?? invalidAmountError(installmentAmount) }
    if (parsed.amount.isZero()) {
      return { error: newError(ErrValidation, 'el monto debe ser mayor a 0') }
    }
    let total = installmentsTotal
    if (kind === KindUnico) {
      total = 1
    } else if (kind === KindCuotas) {
      if (total < 1) {
        return { error: newError(ErrValidation, 'las cuotas totales deben ser al menos 1') }
      }
    } else {
      return { error: newError(ErrValidation, "tipo inválido (use 'unico' o 'cuotas')") }
    }
    return {
      expense: {
        date,
        description: description.trim(),
        category: category.trim(),
        merchant: merchant.trim(),
        cardId: cardID,
        kind,
        installmentAmount: parsed.amount,
        installmentsTotal: total,
      },
    }
  }

  // generateInstallments creates one row per cuota; the first paidCount are
  // marked pagado (preserves progress across an edit).
  function generateInstallments(expenseId: number, ex: ValidatedExpense, billingDay: number, paidCount: number): void {
    const total = ex.kind === KindUnico ? 1 : ex.installmentsTotal
    const first = periodOf(ex.date.parts, billingDay)
    const now = nowIso()
    for (let i = 0; i < total; i++) {
      const paid = i < paidCount
      db.exec(
        `INSERT INTO installments (user_id, expense_id, number, total, period, amount, status, paid_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          uid(),
          expenseId,
          i + 1,
          total,
          addMonths(first, i),
          ex.installmentAmount.toString(),
          paid ? StatusPagado : StatusPendiente,
          paid ? now : null,
        ],
      )
    }
  }

  interface LoadedFixed {
    fixed: FixedExpense[]
    amountsByID: Map<number, FixedExpenseAmountRow[]>
  }

  function loadFixed(deletedOnly: boolean): LoadedFixed {
    const filter = deletedOnly ? 'deleted_at IS NOT NULL' : 'deleted_at IS NULL'
    const fixed = db
      .query(`SELECT * FROM fixed_expenses WHERE user_id = ? AND ${filter}`, [uid()])
      .map(rowToFixedExpense)
    const amountsByID = new Map<number, FixedExpenseAmountRow[]>()
    if (fixed.length > 0) {
      const placeholders = fixed.map(() => '?').join(', ')
      const ids: SqlValue[] = fixed.map((fe) => fe.id)
      const amounts = db
        .query(`SELECT * FROM fixed_expense_amounts WHERE fixed_expense_id IN (${placeholders})`, ids)
        .map(rowToFixedExpenseAmount)
      for (const a of amounts) {
        const list = amountsByID.get(a.fixedExpenseId)
        if (list) list.push(a)
        else amountsByID.set(a.fixedExpenseId, [a])
      }
    }
    return { fixed, amountsByID }
  }

  // fixedChargesFor builds the movimientos for fixed expenses billed in `period`.
  function fixedChargesFor(period: string): Movimiento[] {
    const { fixed, amountsByID } = loadFixed(false)
    const paid = new Set(
      db.query('SELECT fixed_expense_id FROM fixed_expense_payments WHERE period = ?', [period]).map((r) =>
        asNumber(r.fixed_expense_id),
      ),
    )
    const out: Movimiento[] = []
    for (const fe of fixed) {
      if (!activeIn(fe, period)) continue
      out.push({
        source: SourceFijo,
        installmentId: 0,
        expenseId: 0,
        fixedId: fe.id,
        description: fe.description,
        category: fe.category,
        merchant: '',
        cardId: fe.cardId,
        cardName: '',
        kind: SourceFijo,
        number: 1,
        total: 1,
        amount: resolveFixedAmount(amountsByID.get(fe.id) ?? [], period).toString(),
        status: paid.has(fe.id) ? StatusPagado : StatusPendiente,
        date: null,
      })
    }
    return out
  }

  // sumFixedBefore totals fixed-expense charges for all months strictly before
  // `period` (carry-forward of the running balance).
  function sumFixedBefore(period: string): Money {
    const { fixed, amountsByID } = loadFixed(false)
    let total = Money.zero()
    const last = addMonths(period, -1)
    for (const fe of fixed) {
      if (!validPeriod(fe.startPeriod)) continue
      let end = last
      if (fe.endPeriod !== '' && fe.endPeriod < end) end = fe.endPeriod
      for (let m = fe.startPeriod; m <= end; m = addMonths(m, 1)) {
        total = total.add(resolveFixedAmount(amountsByID.get(fe.id) ?? [], m))
      }
    }
    return total
  }

  // cumulativeBalanceBefore: Σ salaries + Σ extras − Σ gastos for every period
  // strictly before `period`, summed with Money (never SQL SUM over TEXT).
  function cumulativeBalanceBefore(period: string): Money {
    let total = Money.zero()
    for (const r of db.query('SELECT * FROM period_salaries WHERE user_id = ? AND period < ?', [uid(), period])) {
      total = total.add(Money.fromString(rowToPeriodSalary(r).amount))
    }
    for (const r of db.query(
      'SELECT * FROM incomes WHERE user_id = ? AND period < ? AND deleted_at IS NULL',
      [uid(), period],
    )) {
      total = total.add(Money.fromString(rowToIncome(r).amount))
    }
    for (const r of db.query(
      `SELECT * FROM installments WHERE user_id = ? AND period < ?
       AND expense_id IN (SELECT id FROM expenses WHERE deleted_at IS NULL)`,
      [uid(), period],
    )) {
      total = total.sub(Money.fromString(rowToInstallment(r).amount))
    }
    return total.sub(sumFixedBefore(period))
  }

  // expenseMapActive returns the (non-deleted) expenses for the given ids,
  // standing in for bun's Relation("Expense") join.
  function expenseMapActive(ids: number[]): Map<number, Expense> {
    const out = new Map<number, Expense>()
    if (ids.length === 0) return out
    const unique = [...new Set(ids)]
    const placeholders = unique.map(() => '?').join(', ')
    for (const r of db.query(
      `SELECT * FROM expenses WHERE id IN (${placeholders}) AND deleted_at IS NULL`,
      unique,
    )) {
      const ex = rowToExpense(r)
      out.set(ex.id, ex)
    }
    return out
  }

  // pendingByCard sums all pending installments grouped by their expense's card.
  function pendingByCard(): Map<number, Money> {
    const pend = db
      .query('SELECT * FROM installments WHERE user_id = ? AND status = ?', [uid(), StatusPendiente])
      .map(rowToInstallment)
    const exById = expenseMapActive(pend.map((i) => i.expenseId))
    const out = new Map<number, Money>()
    for (const inst of pend) {
      const ex = exById.get(inst.expenseId)
      if (ex && ex.cardId != null) {
        out.set(ex.cardId, (out.get(ex.cardId) ?? Money.zero()).add(Money.fromString(inst.amount)))
      }
    }
    return out
  }

  function sortedCategoryTotals(m: Map<string, Money>): CategoryTotal[] {
    return [...m.entries()]
      .sort((a, b) => b[1].cmp(a[1]))
      .map(([category, total]) => ({ category, total: total.toString() }))
  }

  // restoreRow is the shared soft-delete undo: UPDATE ... SET deleted_at = NULL.
  function restoreRow(table: string, id: number, notFoundMsg: string): OpResult {
    db.exec(
      `UPDATE ${table} SET deleted_at = NULL WHERE id = ? AND user_id = ? AND deleted_at IS NOT NULL`,
      [id, uid()],
    )
    if (db.changes() === 0) return { error: newError(ErrNotFound, notFoundMsg) }
    return {}
  }

  function softDeleteRow(table: string, id: number): OpResult {
    db.exec(`UPDATE ${table} SET deleted_at = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL`, [
      nowIso(),
      id,
      uid(),
    ])
    return {}
  }

  // ---------- bound surface ----------

  const service: FinanceServiceContract = {
    // ---------- settings ----------

    async GetSettings(): Promise<SettingsResult> {
      const row = db.query('SELECT * FROM settings WHERE id = 1')[0]
      if (!row) return { error: newError(ErrNotFound, 'configuración no encontrada') }
      return { data: rowToSettings(row) }
    },

    // ---------- salary (per month) ----------

    async GetSalary(period: string): Promise<SalaryResult> {
      if (!validPeriod(period)) return { error: invalidPeriodError() }
      const data: PeriodSalary = { userId: uid(), period, amount: salaryFor(period).toString() }
      return { data }
    },

    async SetSalary(period: string, amount: string): Promise<SalaryResult> {
      if (!validPeriod(period)) return { error: invalidPeriodError() }
      const parsed = amountOrError(amount)
      if (parsed.error || !parsed.amount) return { error: parsed.error ?? invalidAmountError(amount) }
      db.exec(
        `INSERT INTO period_salaries (user_id, period, amount) VALUES (?, ?, ?)
         ON CONFLICT (user_id, period) DO UPDATE SET amount = EXCLUDED.amount`,
        [uid(), period, parsed.amount.toString()],
      )
      return { data: { userId: uid(), period, amount: parsed.amount.toString() } }
    },

    // ---------- cards ----------

    async ListCards(): Promise<Card[]> {
      return listCardsActive()
    },

    async CreateCard(name: string, creditLimit: string, billingDay: number): Promise<CardResult> {
      if (name.trim() === '') return { error: newError(ErrValidation, 'el nombre es obligatorio') }
      const parsed = amountOrError(creditLimit)
      if (parsed.error || !parsed.amount) return { error: parsed.error ?? invalidAmountError(creditLimit) }
      const day = billingDay < 1 || billingDay > 28 ? 24 : billingDay
      const row = db.query(
        `INSERT INTO cards (user_id, name, credit_limit, billing_day, created_at)
         VALUES (?, ?, ?, ?, ?) RETURNING *`,
        [uid(), name.trim(), parsed.amount.toString(), day, nowIso()],
      )[0]
      if (!row) return { error: newError(ErrNotFound, 'tarjeta no encontrada') }
      return { data: rowToCard(row) }
    },

    async UpdateCard(id: number, name: string, creditLimit: string, billingDay: number): Promise<CardResult> {
      if (name.trim() === '') return { error: newError(ErrValidation, 'el nombre es obligatorio') }
      const parsed = amountOrError(creditLimit)
      if (parsed.error || !parsed.amount) return { error: parsed.error ?? invalidAmountError(creditLimit) }
      const day = billingDay < 1 || billingDay > 28 ? 24 : billingDay
      db.exec(
        `UPDATE cards SET name = ?, credit_limit = ?, billing_day = ?
         WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
        [name.trim(), parsed.amount.toString(), day, id, uid()],
      )
      if (db.changes() === 0) return { error: newError(ErrNotFound, 'tarjeta no encontrada') }
      const row = db.query('SELECT * FROM cards WHERE id = ? AND user_id = ? AND deleted_at IS NULL', [id, uid()])[0]
      if (!row) return { error: newError(ErrNotFound, 'tarjeta no encontrada') }
      return { data: rowToCard(row) }
    },

    async DeleteCard(id: number): Promise<OpResult> {
      return softDeleteRow('cards', id)
    },

    async RestoreCard(id: number): Promise<OpResult> {
      return restoreRow('cards', id, 'tarjeta no encontrada')
    },

    // ---------- categories ----------

    async ListCategories() {
      return db
        .query('SELECT * FROM categories WHERE user_id = ? AND deleted_at IS NULL ORDER BY name ASC', [uid()])
        .map(rowToCategory)
    },

    async CreateCategory(name: string): Promise<CategoryResult> {
      const n = name.trim()
      if (n === '') return { error: newError(ErrValidation, 'el nombre es obligatorio') }
      try {
        const row = db.query(
          'INSERT INTO categories (user_id, name, created_at) VALUES (?, ?, ?) RETURNING *',
          [uid(), n, nowIso()],
        )[0]
        if (!row) return { error: newError(ErrNotFound, 'categoría no encontrada') }
        return { data: rowToCategory(row) }
      } catch (err) {
        if (isUniqueViolation(err)) return { error: newError(ErrValidation, 'la categoría ya existe') }
        throw err
      }
    },

    async UpdateCategory(id: number, name: string): Promise<CategoryResult> {
      const n = name.trim()
      if (n === '') return { error: newError(ErrValidation, 'el nombre es obligatorio') }
      try {
        return db.transaction((): CategoryResult => {
          const oldRow = db.query('SELECT * FROM categories WHERE id = ? AND user_id = ? AND deleted_at IS NULL', [
            id,
            uid(),
          ])[0]
          if (!oldRow) return { error: newError(ErrNotFound, 'categoría no encontrada') }
          const old = rowToCategory(oldRow)
          db.exec('UPDATE categories SET name = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL', [n, id, uid()])
          if (old.name !== n) {
            db.exec('UPDATE expenses SET category = ? WHERE category = ? AND user_id = ? AND deleted_at IS NULL', [
              n,
              old.name,
              uid(),
            ])
          }
          const row = db.query('SELECT * FROM categories WHERE id = ? AND user_id = ? AND deleted_at IS NULL', [
            id,
            uid(),
          ])[0]
          if (!row) return { error: newError(ErrNotFound, 'categoría no encontrada') }
          return { data: rowToCategory(row) }
        })
      } catch (err) {
        if (isUniqueViolation(err)) return { error: newError(ErrValidation, 'la categoría ya existe') }
        throw err
      }
    },

    async DeleteCategory(id: number): Promise<OpResult> {
      return softDeleteRow('categories', id)
    },

    async RestoreCategory(id: number): Promise<OpResult> {
      try {
        return restoreRow('categories', id, 'categoría no encontrada')
      } catch (err) {
        if (isUniqueViolation(err)) {
          return { error: newError(ErrConflict, 'ya existe una categoría activa con ese nombre') }
        }
        throw err
      }
    },

    // ---------- merchants (comercios) ----------

    async ListMerchants() {
      return db
        .query('SELECT * FROM merchants WHERE user_id = ? AND deleted_at IS NULL ORDER BY name ASC', [uid()])
        .map(rowToMerchant)
    },

    async CreateMerchant(name: string): Promise<MerchantResult> {
      const n = name.trim()
      if (n === '') return { error: newError(ErrValidation, 'el nombre es obligatorio') }
      try {
        const row = db.query(
          'INSERT INTO merchants (user_id, name, created_at) VALUES (?, ?, ?) RETURNING *',
          [uid(), n, nowIso()],
        )[0]
        if (!row) return { error: newError(ErrNotFound, 'comercio no encontrado') }
        return { data: rowToMerchant(row) }
      } catch (err) {
        if (isUniqueViolation(err)) return { error: newError(ErrValidation, 'el comercio ya existe') }
        throw err
      }
    },

    async UpdateMerchant(id: number, name: string): Promise<MerchantResult> {
      const n = name.trim()
      if (n === '') return { error: newError(ErrValidation, 'el nombre es obligatorio') }
      try {
        return db.transaction((): MerchantResult => {
          const oldRow = db.query('SELECT * FROM merchants WHERE id = ? AND user_id = ? AND deleted_at IS NULL', [
            id,
            uid(),
          ])[0]
          if (!oldRow) return { error: newError(ErrNotFound, 'comercio no encontrado') }
          const old = rowToMerchant(oldRow)
          db.exec('UPDATE merchants SET name = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL', [n, id, uid()])
          if (old.name !== n) {
            db.exec('UPDATE expenses SET merchant = ? WHERE merchant = ? AND user_id = ? AND deleted_at IS NULL', [
              n,
              old.name,
              uid(),
            ])
          }
          const row = db.query('SELECT * FROM merchants WHERE id = ? AND user_id = ? AND deleted_at IS NULL', [
            id,
            uid(),
          ])[0]
          if (!row) return { error: newError(ErrNotFound, 'comercio no encontrado') }
          return { data: rowToMerchant(row) }
        })
      } catch (err) {
        if (isUniqueViolation(err)) return { error: newError(ErrValidation, 'el comercio ya existe') }
        throw err
      }
    },

    async DeleteMerchant(id: number): Promise<OpResult> {
      return softDeleteRow('merchants', id)
    },

    async RestoreMerchant(id: number): Promise<OpResult> {
      try {
        return restoreRow('merchants', id, 'comercio no encontrado')
      } catch (err) {
        if (isUniqueViolation(err)) {
          return { error: newError(ErrConflict, 'ya existe un comercio activo con ese nombre') }
        }
        throw err
      }
    },

    // ---------- incomes (extras / bonos) ----------

    async ListIncomes(period: string): Promise<Income[]> {
      return db
        .query(
          'SELECT * FROM incomes WHERE user_id = ? AND period = ? AND deleted_at IS NULL ORDER BY created_at ASC',
          [uid(), period],
        )
        .map(rowToIncome)
    },

    async CreateIncome(period: string, description: string, amount: string) {
      if (!validPeriod(period)) return { error: invalidPeriodError() }
      if (description.trim() === '') return { error: newError(ErrValidation, 'la descripción es obligatoria') }
      const parsed = amountOrError(amount)
      if (parsed.error || !parsed.amount) return { error: parsed.error ?? invalidAmountError(amount) }
      const row = db.query(
        `INSERT INTO incomes (user_id, period, description, amount, created_at)
         VALUES (?, ?, ?, ?, ?) RETURNING *`,
        [uid(), period, description.trim(), parsed.amount.toString(), nowIso()],
      )[0]
      if (!row) return { error: newError(ErrNotFound, 'ingreso no encontrado') }
      return { data: rowToIncome(row) }
    },

    async DeleteIncome(id: number): Promise<OpResult> {
      return softDeleteRow('incomes', id)
    },

    async RestoreIncome(id: number): Promise<OpResult> {
      return restoreRow('incomes', id, 'ingreso no encontrado')
    },

    // ---------- expenses + installments ----------

    async ListExpenses(period: string): Promise<Expense[]> {
      return db
        .query(
          `SELECT * FROM expenses WHERE user_id = ? AND deleted_at IS NULL
           AND id IN (SELECT expense_id FROM installments WHERE period = ? AND user_id = ?)
           ORDER BY date DESC`,
          [uid(), period, uid()],
        )
        .map(rowToExpense)
    },

    async CreateExpense(
      dateStr: string,
      description: string,
      category: string,
      merchant: string,
      cardID: number | null,
      kind: string,
      installmentAmount: string,
      installmentsTotal: number,
    ): Promise<ExpenseResult> {
      const v = validateExpense(dateStr, description, category, merchant, cardID, kind, installmentAmount, installmentsTotal)
      if (v.error || !v.expense) return { error: v.error ?? newError(ErrValidation, 'gasto inválido') }
      const ex = v.expense
      const billing = billingDayFor(cardID)
      if (billing.error) return { error: billing.error }
      return db.transaction((): ExpenseResult => {
        const row = db.query(
          `INSERT INTO expenses (user_id, date, description, category, merchant, card_id, kind, installment_amount, installments_total, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
          [
            uid(),
            ex.date.iso,
            ex.description,
            ex.category,
            ex.merchant,
            ex.cardId,
            ex.kind,
            ex.installmentAmount.toString(),
            ex.installmentsTotal,
            nowIso(),
          ],
        )[0]
        if (!row) return { error: newError(ErrNotFound, 'gasto no encontrado') }
        const created = rowToExpense(row)
        generateInstallments(created.id, ex, billing.day, 0)
        return { data: created }
      })
    },

    async UpdateExpense(
      id: number,
      dateStr: string,
      description: string,
      category: string,
      merchant: string,
      cardID: number | null,
      kind: string,
      installmentAmount: string,
      installmentsTotal: number,
    ): Promise<ExpenseResult> {
      const v = validateExpense(dateStr, description, category, merchant, cardID, kind, installmentAmount, installmentsTotal)
      if (v.error || !v.expense) return { error: v.error ?? newError(ErrValidation, 'gasto inválido') }
      const ex = v.expense
      const billing = billingDayFor(cardID)
      if (billing.error) return { error: billing.error }
      return db.transaction((): ExpenseResult => {
        // Preserve how many installments were already paid, then regenerate.
        const paidRow = db.query(
          'SELECT COUNT(*) AS n FROM installments WHERE expense_id = ? AND user_id = ? AND status = ?',
          [id, uid(), StatusPagado],
        )[0]
        const paidCount = asNumber(paidRow?.n)
        db.exec(
          `UPDATE expenses SET date = ?, description = ?, category = ?, merchant = ?, card_id = ?, kind = ?,
           installment_amount = ?, installments_total = ?
           WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
          [
            ex.date.iso,
            ex.description,
            ex.category,
            ex.merchant,
            ex.cardId,
            ex.kind,
            ex.installmentAmount.toString(),
            ex.installmentsTotal,
            id,
            uid(),
          ],
        )
        if (db.changes() === 0) return { error: newError(ErrNotFound, 'gasto no encontrado') }
        db.exec('DELETE FROM installments WHERE expense_id = ? AND user_id = ?', [id, uid()])
        generateInstallments(id, ex, billing.day, paidCount)
        const row = db.query('SELECT * FROM expenses WHERE id = ? AND user_id = ? AND deleted_at IS NULL', [id, uid()])[0]
        if (!row) return { error: newError(ErrNotFound, 'gasto no encontrado') }
        return { data: rowToExpense(row) }
      })
    },

    async DeleteExpense(id: number): Promise<OpResult> {
      return softDeleteRow('expenses', id)
    },

    async RestoreExpense(id: number): Promise<OpResult> {
      return restoreRow('expenses', id, 'gasto no encontrado')
    },

    async SetInstallmentPaid(id: number, paid: boolean): Promise<OpResult> {
      if (paid) {
        db.exec('UPDATE installments SET status = ?, paid_at = ? WHERE id = ? AND user_id = ?', [
          StatusPagado,
          nowIso(),
          id,
          uid(),
        ])
      } else {
        db.exec('UPDATE installments SET status = ?, paid_at = NULL WHERE id = ? AND user_id = ?', [
          StatusPendiente,
          id,
          uid(),
        ])
      }
      return {}
    },

    // ---------- fixed expenses (recurring) ----------

    async ListFixedExpenses(): Promise<FixedExpenseView[]> {
      const { fixed, amountsByID } = loadFixed(false)
      const cardByID = cardMapAll()
      const now = currentPeriod()
      const out: FixedExpenseView[] = fixed.map((fe) => {
        // Future-dated subscriptions resolve at their start so the configured
        // amount shows.
        const at = fe.startPeriod > now ? fe.startPeriod : now
        return {
          ...fe,
          currentAmount: resolveFixedAmount(amountsByID.get(fe.id) ?? [], at).toString(),
          cardName: fe.cardId != null ? (cardByID.get(fe.cardId)?.name ?? '') : '',
          active: activeIn(fe, now),
        }
      })
      out.sort((a, b) => (a.description < b.description ? -1 : a.description > b.description ? 1 : 0))
      return out
    },

    async CreateFixedExpense(
      description: string,
      category: string,
      cardID: number | null,
      startPeriod: string,
      amount: string,
    ): Promise<FixedExpenseResult> {
      const desc = description.trim()
      if (desc === '') return { error: newError(ErrValidation, 'la descripción es obligatoria') }
      if (!validPeriod(startPeriod)) return { error: newError(ErrValidation, 'período inicial inválido (use YYYY-MM)') }
      const parsed = amountOrError(amount)
      if (parsed.error || !parsed.amount) return { error: parsed.error ?? invalidAmountError(amount) }
      if (parsed.amount.isZero()) return { error: newError(ErrValidation, 'el monto debe ser mayor a 0') }
      if (cardID != null) {
        const billing = billingDayFor(cardID)
        if (billing.error) return { error: billing.error }
      }
      return db.transaction((): FixedExpenseResult => {
        const row = db.query(
          `INSERT INTO fixed_expenses (user_id, description, category, card_id, start_period, created_at)
           VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
          [uid(), desc, category.trim(), cardID, startPeriod, nowIso()],
        )[0]
        if (!row) return { error: newError(ErrNotFound, 'gasto fijo no encontrado') }
        const fe = rowToFixedExpense(row)
        db.exec('INSERT INTO fixed_expense_amounts (fixed_expense_id, effective_from, amount) VALUES (?, ?, ?)', [
          fe.id,
          startPeriod,
          parsed.amount ? parsed.amount.toString() : '0',
        ])
        return { data: fe }
      })
    },

    async UpdateFixedExpense(
      id: number,
      description: string,
      category: string,
      cardID: number | null,
    ): Promise<FixedExpenseResult> {
      const desc = description.trim()
      if (desc === '') return { error: newError(ErrValidation, 'la descripción es obligatoria') }
      if (cardID != null) {
        const billing = billingDayFor(cardID)
        if (billing.error) return { error: billing.error }
      }
      db.exec(
        'UPDATE fixed_expenses SET description = ?, category = ?, card_id = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL',
        [desc, category.trim(), cardID, id, uid()],
      )
      if (db.changes() === 0) return { error: newError(ErrNotFound, 'gasto fijo no encontrado') }
      const row = db.query('SELECT * FROM fixed_expenses WHERE id = ? AND user_id = ? AND deleted_at IS NULL', [
        id,
        uid(),
      ])[0]
      if (!row) return { error: newError(ErrNotFound, 'gasto fijo no encontrado') }
      return { data: rowToFixedExpense(row) }
    },

    async SetFixedExpenseAmount(id: number, fromPeriod: string, amount: string): Promise<OpResult> {
      if (!validPeriod(fromPeriod)) return { error: invalidPeriodError() }
      const parsed = amountOrError(amount)
      if (parsed.error || !parsed.amount) return { error: parsed.error ?? invalidAmountError(amount) }
      if (parsed.amount.isZero()) return { error: newError(ErrValidation, 'el monto debe ser mayor a 0') }
      db.exec(
        `INSERT INTO fixed_expense_amounts (fixed_expense_id, effective_from, amount) VALUES (?, ?, ?)
         ON CONFLICT (fixed_expense_id, effective_from) DO UPDATE SET amount = EXCLUDED.amount`,
        [id, fromPeriod, parsed.amount.toString()],
      )
      return {}
    },

    async EndFixedExpense(id: number, fromPeriod: string): Promise<OpResult> {
      if (!validPeriod(fromPeriod)) return { error: invalidPeriodError() }
      const end = addMonths(fromPeriod, -1)
      db.exec('UPDATE fixed_expenses SET end_period = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL', [
        end,
        id,
        uid(),
      ])
      if (db.changes() === 0) return { error: newError(ErrNotFound, 'gasto fijo no encontrado') }
      return {}
    },

    async DeleteFixedExpense(id: number): Promise<OpResult> {
      return softDeleteRow('fixed_expenses', id)
    },

    async RestoreFixedExpense(id: number): Promise<OpResult> {
      return restoreRow('fixed_expenses', id, 'gasto fijo no encontrado')
    },

    async SetFixedExpensePaid(id: number, period: string, paid: boolean): Promise<OpResult> {
      if (!validPeriod(period)) return { error: invalidPeriodError() }
      if (paid) {
        db.exec(
          `INSERT INTO fixed_expense_payments (fixed_expense_id, period, paid_at) VALUES (?, ?, ?)
           ON CONFLICT (fixed_expense_id, period) DO UPDATE SET paid_at = EXCLUDED.paid_at`,
          [id, period, nowIso()],
        )
        return {}
      }
      db.exec('DELETE FROM fixed_expense_payments WHERE fixed_expense_id = ? AND period = ?', [id, period])
      return {}
    },

    // ---------- summaries ----------

    async MonthlySummary(period: string): Promise<MonthlySummaryResult> {
      if (!validPeriod(period)) return { error: invalidPeriodError() }

      const salary = salaryFor(period)
      const acumulado = cumulativeBalanceBefore(period)
      const incomes = await service.ListIncomes(period)
      const cards = listCardsActive()
      const cardByID = cardMapAll()

      // Installments billed this period; a soft-deleted expense's installments
      // are excluded explicitly so they never leak into the totals.
      const insts = db
        .query(
          `SELECT * FROM installments WHERE user_id = ? AND period = ?
           AND expense_id IN (SELECT id FROM expenses WHERE deleted_at IS NULL)
           ORDER BY id ASC`,
          [uid(), period],
        )
        .map(rowToInstallment)
      const exById = expenseMapActive(insts.map((i) => i.expenseId))

      let extras = Money.zero()
      for (const inc of incomes) extras = extras.add(Money.fromString(inc.amount))
      const ingresos = salary.add(extras)
      const disponible = acumulado.add(ingresos)

      let gastos = Money.zero()
      let pendiente = Money.zero()
      let pagado = Money.zero()
      const movimientos: Movimiento[] = []
      const catTotals = new Map<string, Money>()
      const gastoMesByCard = new Map<number, Money>()

      for (const inst of insts) {
        const ex = exById.get(inst.expenseId)
        const amount = Money.fromString(inst.amount)
        const mv: Movimiento = {
          source: SourceCuota,
          installmentId: inst.id,
          expenseId: 0,
          fixedId: null,
          description: '',
          category: '',
          merchant: '',
          cardId: null,
          cardName: '',
          kind: '',
          number: inst.number,
          total: inst.total,
          amount: inst.amount,
          status: inst.status,
          date: null,
        }
        let cat = 'Sin categoría'
        if (ex) {
          mv.expenseId = ex.id
          mv.description = ex.description
          mv.merchant = ex.merchant
          mv.cardId = ex.cardId
          mv.kind = ex.kind
          mv.date = ex.date
          if (ex.category !== '') cat = ex.category
          if (ex.cardId != null) {
            mv.cardName = cardByID.get(ex.cardId)?.name ?? ''
            gastoMesByCard.set(ex.cardId, (gastoMesByCard.get(ex.cardId) ?? Money.zero()).add(amount))
          }
        }
        mv.category = cat
        movimientos.push(mv)
        gastos = gastos.add(amount)
        if (inst.status === StatusPagado) pagado = pagado.add(amount)
        else pendiente = pendiente.add(amount)
        catTotals.set(cat, (catTotals.get(cat) ?? Money.zero()).add(amount))
      }

      // Recurring fixed expenses billed this month fold into the same totals.
      for (const mv of fixedChargesFor(period)) {
        const cat = mv.category !== '' ? mv.category : 'Sin categoría'
        mv.category = cat
        const amount = Money.fromString(mv.amount)
        if (mv.cardId != null) {
          mv.cardName = cardByID.get(mv.cardId)?.name ?? ''
          gastoMesByCard.set(mv.cardId, (gastoMesByCard.get(mv.cardId) ?? Money.zero()).add(amount))
        }
        movimientos.push(mv)
        gastos = gastos.add(amount)
        if (mv.status === StatusPagado) pagado = pagado.add(amount)
        else pendiente = pendiente.add(amount)
        catTotals.set(cat, (catTotals.get(cat) ?? Money.zero()).add(amount))
      }

      const balance = disponible.sub(gastos)
      // Cupo usado per card = all PENDING installments across every period.
      const cupoUsado = pendingByCard()
      const porTarjeta: CardDebt[] = cards.map((c) => {
        const used = cupoUsado.get(c.id) ?? Money.zero()
        return {
          card: c,
          gastoMes: (gastoMesByCard.get(c.id) ?? Money.zero()).toString(),
          cupoUsado: used.toString(),
          cupoDisponible: Money.fromString(c.creditLimit).sub(used).toString(),
        }
      })

      const data: MonthlySummary = {
        period,
        salary: salary.toString(),
        extras: extras.toString(),
        ingresos: ingresos.toString(),
        acumulado: acumulado.toString(),
        disponible: disponible.toString(),
        gastos: gastos.toString(),
        pendiente: pendiente.toString(),
        pagado: pagado.toString(),
        balance: balance.toString(),
        alcanza: disponible.gte(gastos),
        porCategoria: sortedCategoryTotals(catTotals),
        porTarjeta,
        movimientos,
        incomes,
      }
      return { data }
    },

    async YearSummary(year: number): Promise<YearSummaryResult> {
      if (year < 2000 || year > 3000) return { error: newError(ErrValidation, 'año inválido') }
      const prefix = `${String(year).padStart(4, '0')}-`

      // Carry-in from every period before this year.
      let saldo = cumulativeBalanceBefore(prefix + '01')

      const salaryByMonth = new Map<string, Money>()
      for (const r of db.query('SELECT * FROM period_salaries WHERE user_id = ? AND period LIKE ?', [
        uid(),
        prefix + '%',
      ])) {
        const ps = rowToPeriodSalary(r)
        salaryByMonth.set(ps.period, Money.fromString(ps.amount))
      }

      const extrasByMonth = new Map<string, Money>()
      for (const r of db.query(
        'SELECT * FROM incomes WHERE user_id = ? AND period LIKE ? AND deleted_at IS NULL',
        [uid(), prefix + '%'],
      )) {
        const inc = rowToIncome(r)
        extrasByMonth.set(inc.period, (extrasByMonth.get(inc.period) ?? Money.zero()).add(Money.fromString(inc.amount)))
      }

      const insts = db
        .query(
          `SELECT * FROM installments WHERE user_id = ? AND period LIKE ?
           AND expense_id IN (SELECT id FROM expenses WHERE deleted_at IS NULL)`,
          [uid(), prefix + '%'],
        )
        .map(rowToInstallment)
      const exById = expenseMapActive(insts.map((i) => i.expenseId))

      const gastosByMonth = new Map<string, Money>()
      const catTotals = new Map<string, Money>()
      for (const inst of insts) {
        const amount = Money.fromString(inst.amount)
        gastosByMonth.set(inst.period, (gastosByMonth.get(inst.period) ?? Money.zero()).add(amount))
        const ex = exById.get(inst.expenseId)
        const cat = ex && ex.category !== '' ? ex.category : 'Sin categoría'
        catTotals.set(cat, (catTotals.get(cat) ?? Money.zero()).add(amount))
      }

      // Fold recurring fixed expenses into each month's gastos and categories.
      const { fixed, amountsByID } = loadFixed(false)
      for (let m = 1; m <= 12; m++) {
        const period = prefix + String(m).padStart(2, '0')
        for (const fe of fixed) {
          if (!activeIn(fe, period)) continue
          const amt = resolveFixedAmount(amountsByID.get(fe.id) ?? [], period)
          gastosByMonth.set(period, (gastosByMonth.get(period) ?? Money.zero()).add(amt))
          const cat = fe.category !== '' ? fe.category : 'Sin categoría'
          catTotals.set(cat, (catTotals.get(cat) ?? Money.zero()).add(amt))
        }
      }

      const months: YearMonth[] = []
      let totalIngresos = Money.zero()
      let totalGastos = Money.zero()
      for (let m = 1; m <= 12; m++) {
        const period = prefix + String(m).padStart(2, '0')
        const ingresos = (salaryByMonth.get(period) ?? Money.zero()).add(extrasByMonth.get(period) ?? Money.zero())
        const gastos = gastosByMonth.get(period) ?? Money.zero()
        const balance = ingresos.sub(gastos)
        saldo = saldo.add(balance) // running account balance at month close
        months.push({
          period,
          ingresos: ingresos.toString(),
          gastos: gastos.toString(),
          balance: balance.toString(),
          saldo: saldo.toString(),
          alcanza: saldo.gte(Money.zero()),
        })
        totalIngresos = totalIngresos.add(ingresos)
        totalGastos = totalGastos.add(gastos)
      }

      const data: YearSummary = {
        year,
        months,
        porCategoria: sortedCategoryTotals(catTotals),
        totalIngresos: totalIngresos.toString(),
        totalGastos: totalGastos.toString(),
        totalBalance: totalIngresos.sub(totalGastos).toString(),
      }
      return { data }
    },

    // ---------- trash (papelera) ----------

    async ListTrash(): Promise<TrashResult> {
      const out: TrashItem[] = []

      for (const r of db.query('SELECT * FROM cards WHERE user_id = ? AND deleted_at IS NOT NULL', [uid()])) {
        const c = rowToCard(r)
        out.push({ type: 'card', id: c.id, description: c.name, deletedAt: c.deletedAt ?? '' })
      }
      for (const r of db.query('SELECT * FROM categories WHERE user_id = ? AND deleted_at IS NOT NULL', [uid()])) {
        const c = rowToCategory(r)
        out.push({ type: 'category', id: c.id, description: c.name, deletedAt: c.deletedAt ?? '' })
      }
      for (const r of db.query('SELECT * FROM merchants WHERE user_id = ? AND deleted_at IS NOT NULL', [uid()])) {
        const m = rowToMerchant(r)
        out.push({ type: 'merchant', id: m.id, description: m.name, deletedAt: m.deletedAt ?? '' })
      }
      for (const r of db.query('SELECT * FROM incomes WHERE user_id = ? AND deleted_at IS NOT NULL', [uid()])) {
        const inc = rowToIncome(r)
        out.push({
          type: 'income',
          id: inc.id,
          description: inc.description,
          amount: inc.amount,
          period: inc.period,
          deletedAt: inc.deletedAt ?? '',
        })
      }
      for (const r of db.query('SELECT * FROM expenses WHERE user_id = ? AND deleted_at IS NOT NULL', [uid()])) {
        const ex = rowToExpense(r)
        out.push({
          type: 'expense',
          id: ex.id,
          description: ex.description,
          amount: ex.installmentAmount,
          deletedAt: ex.deletedAt ?? '',
        })
      }

      const { fixed, amountsByID } = loadFixed(true)
      const now = currentPeriod()
      for (const fe of fixed) {
        const at = fe.startPeriod > now ? fe.startPeriod : now
        out.push({
          type: 'fixedexpense',
          id: fe.id,
          description: fe.description,
          amount: resolveFixedAmount(amountsByID.get(fe.id) ?? [], at).toString(),
          deletedAt: fe.deletedAt ?? '',
        })
      }

      // Newest deletion first. Both timestamp formats in play (engine RFC3339,
      // desktop bun) start with YYYY-MM-DD, so lexical order is chronological.
      out.sort((a, b) => (a.deletedAt < b.deletedAt ? 1 : a.deletedAt > b.deletedAt ? -1 : 0))
      return { data: out }
    },
  }

  return service
}
