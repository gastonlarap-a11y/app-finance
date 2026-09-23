// TypeScript port of backend/finance/service.go for the web build: identical
// method surface, validation messages, scoping and math — over a local SQLite
// (sqlite-wasm) instead of the Go backend. Every query filters by the active
// user id (session.active()), mirroring the desktop invariant.
import type {
  BudgetStatus,
  Card,
  CardDebt,
  CardResult,
  CategoryBudgetView,
  CategoryBudgetsResult,
  CategoryResult,
  CategoryTotal,
  CategoryTrend,
  CategoryYearRow,
  Expense,
  ExpenseFilter,
  ExpenseHit,
  ExpenseResult,
  ExpenseSearchResult,
  FinanceServiceContract,
  FixedExpense,
  FixedExpenseResult,
  FixedExpenseView,
  ForecastMonth,
  ForecastResult,
  Income,
  MerchantResult,
  MonthlySummary,
  MonthlySummaryResult,
  Movimiento,
  OpResult,
  PeriodSalary,
  RecurringResult,
  RecurringSuggestion,
  SalaryResult,
  SavingsContribution,
  SavingsContributionResult,
  SavingsGoalResult,
  SavingsGoalView,
  SettingsResult,
  SpendingTrend,
  SpendingTrendResult,
  TrashItem,
  TrashResult,
  TrendMonth,
  YearMonth,
  YearSummary,
  YearSummaryResult,
} from '@/services/contract'
import { ErrConflict, ErrNotFound, ErrValidation, isUniqueViolation, newError } from '@/engine/errors'
import { Money } from '@/engine/decimal'
import {
  addMonths,
  currentPeriod,
  monthOf,
  monthsBetween,
  periodOf,
  validPeriod,
  type DateParts,
} from '@/engine/finance/period'
import { activeIn, latestAsOf, resolveAsOf, sumAsOf, type EffectiveDated } from '@/engine/finance/fixedexpense'
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
  rowToSavingsContribution,
  rowToSavingsGoal,
  rowToSettings,
  type FixedExpenseAmountRow,
} from '@/engine/finance/models'
import { asNumber, asString, type SqlDb, type SqlValue } from '@/engine/db/types'

// compareStrings is Go's strings.Compare: byte-wise, locale-independent, so the
// engine orders ties exactly like the desktop backend.
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

// uncategorized is the bucket for expenses without a category.
const uncategorized = 'Sin categoría'

// escapeLike escapes LIKE's wildcards so user text matches literally (used with
// ESCAPE '\').
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => '\\' + c)
}

// CategoryMonths accumulates a year's spending per category and month (1..12).
class CategoryMonths {
  private readonly byCat = new Map<string, Money[]>()

  add(category: string, period: string, amount: Money): void {
    const cat = category !== '' ? category : uncategorized
    const month = monthOf(period)
    if (month < 1) return
    let row = this.byCat.get(cat)
    if (!row) {
      row = Array.from({ length: 12 }, () => Money.zero())
      this.byCat.set(cat, row)
    }
    row[month - 1] = (row[month - 1] ?? Money.zero()).add(amount)
  }

  // rows returns the per-category year totals and the per-month breakdown, both
  // ordered by total descending (ties by name, for a stable order).
  rows(): { totals: CategoryTotal[]; rows: CategoryYearRow[] } {
    const withTotals = [...this.byCat.entries()].map(([category, months]) => ({
      category,
      months,
      total: months.reduce((acc, v) => acc.add(v), Money.zero()),
    }))
    withTotals.sort((a, b) => b.total.cmp(a.total) || compareStrings(a.category, b.category))
    return {
      totals: withTotals.map((r) => ({ category: r.category, total: r.total.toString() })),
      rows: withTotals.map((r) => ({
        category: r.category,
        months: r.months.map((m) => m.toString()),
        total: r.total.toString(),
      })),
    }
  }
}

const minTrendMonths = 2
const maxTrendMonths = 24

// Recurring detection (mirror of backend/finance/recurring.go).
const recurringWindowMonths = 6
const recurringMinMonths = 3
const recurringTolerancePct = 15

// normalizeKey makes "  Netflix  CL" and "netflix cl" the same grouping key.
function normalizeKey(s: string): string {
  return s.trim().split(/\s+/).filter(Boolean).join(' ').toLowerCase()
}

interface RecurringHit {
  period: string
  amount: Money
  ex: Expense
}

// recurringFrom keeps hits within the tolerance of the group's median amount and
// suggests them when they span enough distinct months.
function recurringFrom(hits: RecurringHit[]): RecurringSuggestion | null {
  const sorted = hits.map((h) => h.amount).sort((a, b) => a.cmp(b))
  const median = sorted[Math.floor(sorted.length / 2)]
  if (!median || median.isZero()) return null
  const limit = median.mulInt(recurringTolerancePct)
  const months = new Set<string>()
  let latest: RecurringHit | undefined
  for (const h of hits) {
    // |amount − median| × 100 <= median × tolerance
    if (h.amount.sub(median).abs().mulInt(100).gt(limit)) continue
    months.add(h.period)
    if (!latest || h.period > latest.period || (h.period === latest.period && h.ex.id > latest.ex.id)) latest = h
  }
  if (!latest || months.size < recurringMinMonths) return null
  return {
    description: latest.ex.description,
    merchant: latest.ex.merchant,
    category: latest.ex.category,
    cardId: latest.ex.cardId,
    amount: latest.amount.toString(),
    periods: [...months].sort(compareStrings),
    nextPeriod: addMonths(latest.period, 1),
  }
}

const defaultSearchLimit = 50
const maxSearchLimit = 200
const maxForecastMonths = 36

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
      db
        .query(
          `SELECT fixed_expense_id FROM fixed_expense_payments WHERE period = ?
           AND fixed_expense_id IN (SELECT id FROM fixed_expenses WHERE user_id = ?)`,
          [period, uid()],
        )
        .map((r) => asNumber(r.fixed_expense_id)),
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
        amount: resolveAsOf(amountsByID.get(fe.id) ?? [], period).toString(),
        status: paid.has(fe.id) ? StatusPagado : StatusPendiente,
        date: null,
      })
    }
    return out
  }

  // sumFixedBefore totals fixed-expense charges for all months strictly before
  // `period` (carry-forward of the running balance). Each amount stretch is
  // multiplied out (sumAsOf), so the cost does not grow with the months elapsed.
  function sumFixedBefore(period: string): Money {
    const { fixed, amountsByID } = loadFixed(false)
    let total = Money.zero()
    const last = addMonths(period, -1)
    for (const fe of fixed) {
      if (!validPeriod(fe.startPeriod)) continue
      let end = last
      if (fe.endPeriod !== '' && fe.endPeriod < end) end = fe.endPeriod
      total = total.add(sumAsOf(amountsByID.get(fe.id) ?? [], fe.startPeriod, end))
    }
    return total
  }

  // fixedDisplayPeriod is the month whose amount represents a fixed expense
  // "now": today, or its start when it is future-dated.
  function fixedDisplayPeriod(fe: FixedExpense, now: string): string {
    return fe.startPeriod > now ? fe.startPeriod : now
  }

  // ownsFixedExpense: the amount/payment tables carry no user_id of their own,
  // so every write to them must first prove the parent belongs to the user.
  function ownsFixedExpense(id: number): boolean {
    return (
      db.query('SELECT 1 FROM fixed_expenses WHERE id = ? AND user_id = ? AND deleted_at IS NULL', [id, uid()])
        .length > 0
    )
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
    // Savings contributions left the account too.
    return total.sub(sumFixedBefore(period)).sub(sumContributions('period < ?', [period]))
  }

  // ---------- savings helpers ----------

  // Contributions of goals in the trash are excluded, like installments of a
  // deleted expense.
  const LIVE_GOAL = 'goal_id IN (SELECT id FROM savings_goals WHERE deleted_at IS NULL)'

  function contributionRows(where: string, params: SqlValue[]): SavingsContribution[] {
    return db
      .query(`SELECT * FROM savings_contributions WHERE user_id = ? AND ${LIVE_GOAL} AND ${where}`, [uid(), ...params])
      .map(rowToSavingsContribution)
  }

  function sumContributions(where: string, params: SqlValue[]): Money {
    return contributionRows(where, params).reduce((acc, c) => acc.add(Money.fromString(c.amount)), Money.zero())
  }

  function savingsByMonth(from: string, to: string): Map<string, Money> {
    const out = new Map<string, Money>()
    for (const c of contributionRows('period >= ? AND period <= ?', [from, to])) {
      out.set(c.period, (out.get(c.period) ?? Money.zero()).add(Money.fromString(c.amount)))
    }
    return out
  }

  // listSavingsGoals mirrors the Go helper; `now` is injected for testability.
  function listSavingsGoals(now: string): SavingsGoalView[] {
    const goals = db
      .query('SELECT * FROM savings_goals WHERE user_id = ? AND deleted_at IS NULL ORDER BY created_at ASC, id ASC', [
        uid(),
      ])
      .map(rowToSavingsGoal)
    const byGoal = new Map<number, SavingsContribution[]>()
    for (const c of db
      .query(`SELECT * FROM savings_contributions WHERE user_id = ? AND ${LIVE_GOAL} ORDER BY period DESC, id DESC`, [
        uid(),
      ])
      .map(rowToSavingsContribution)) {
      const list = byGoal.get(c.goalId) ?? []
      list.push(c)
      byGoal.set(c.goalId, list)
    }
    return goals.map((g) => {
      const contributions = byGoal.get(g.id) ?? []
      const saved = contributions.reduce((acc, c) => acc.add(Money.fromString(c.amount)), Money.zero())
      const target = Money.fromString(g.targetAmount)
      const remaining = target.gt(saved) ? target.sub(saved) : Money.zero()
      let monthsLeft = 0
      let monthlyNeeded = Money.zero()
      if (g.targetPeriod !== '' && g.targetPeriod >= now) {
        monthsLeft = monthsBetween(now, g.targetPeriod) + 1 // the current month counts
        monthlyNeeded = remaining.divCeil(monthsLeft)
      }
      return {
        ...g,
        saved: saved.toString(),
        remaining: remaining.toString(),
        monthsLeft,
        monthlyNeeded: monthlyNeeded.toString(),
        contributions,
      }
    })
  }

  function validateGoal(
    name: string,
    target: string,
    targetPeriod: string,
  ): { name?: string; amount?: Money; error?: ReturnType<typeof newError> } {
    const n = name.trim()
    if (n === '') return { error: newError(ErrValidation, 'el nombre es obligatorio') }
    const parsed = amountOrError(target)
    if (parsed.error || !parsed.amount) return { error: parsed.error ?? invalidAmountError(target) }
    if (parsed.amount.isZero()) return { error: newError(ErrValidation, 'el monto objetivo debe ser mayor a 0') }
    if (targetPeriod !== '' && !validPeriod(targetPeriod)) {
      return { error: newError(ErrValidation, 'fecha objetivo inválida (use YYYY-MM)') }
    }
    return { name: n, amount: parsed.amount }
  }

  // spendingByMonth mirrors the Go helper: per-month totals and per-category
  // totals of installments (live expenses) + active fixed expenses in [from, to].
  function spendingByMonth(from: string, to: string): {
    totals: Map<string, Money>
    byCat: Map<string, Map<string, Money>>
  } {
    const totals = new Map<string, Money>()
    const byCat = new Map<string, Map<string, Money>>()
    const add = (period: string, category: string, amount: Money) => {
      totals.set(period, (totals.get(period) ?? Money.zero()).add(amount))
      const cats = byCat.get(period) ?? new Map<string, Money>()
      const c = category !== '' ? category : uncategorized
      cats.set(c, (cats.get(c) ?? Money.zero()).add(amount))
      byCat.set(period, cats)
    }
    const insts = db
      .query(
        `SELECT * FROM installments WHERE user_id = ? AND period >= ? AND period <= ?
         AND expense_id IN (SELECT id FROM expenses WHERE deleted_at IS NULL)`,
        [uid(), from, to],
      )
      .map(rowToInstallment)
    const exById = expenseMapActive(insts.map((i) => i.expenseId))
    for (const inst of insts) add(inst.period, exById.get(inst.expenseId)?.category ?? '', Money.fromString(inst.amount))
    const { fixed, amountsByID } = loadFixed(false)
    for (let p = from; p <= to; p = addMonths(p, 1)) {
      for (const fe of fixed) {
        if (activeIn(fe, p)) add(p, fe.category, resolveAsOf(amountsByID.get(fe.id) ?? [], p))
      }
    }
    return { totals, byCat }
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
      .sort((a, b) => b[1].cmp(a[1]) || compareStrings(a[0], b[0]))
      .map(([category, total]) => ({ category, total: total.toString() }))
  }

  interface CategoryBudgetRow extends EffectiveDated {
    categoryId: number
  }

  // budgetsInEffect: the cap in effect at `period` for every active category
  // that has one (amount > 0), ordered by category name.
  function budgetsInEffect(period: string): CategoryBudgetView[] {
    const cats = db
      .query('SELECT * FROM categories WHERE user_id = ? AND deleted_at IS NULL', [uid()])
      .map(rowToCategory)
    const byCat = new Map<number, CategoryBudgetRow[]>()
    for (const r of db.query('SELECT * FROM category_budgets WHERE user_id = ? AND effective_from <= ?', [
      uid(),
      period,
    ])) {
      const row: CategoryBudgetRow = {
        categoryId: asNumber(r.category_id),
        effectiveFrom: asString(r.effective_from),
        amount: asString(r.amount),
      }
      const list = byCat.get(row.categoryId)
      if (list) list.push(row)
      else byCat.set(row.categoryId, [row])
    }
    const out: CategoryBudgetView[] = []
    for (const c of cats) {
      const b = latestAsOf(byCat.get(c.id) ?? [], period)
      if (!b || Money.fromString(b.amount).isZero()) continue
      out.push({ categoryId: c.id, category: c.name, amount: b.amount, effectiveFrom: b.effectiveFrom })
    }
    return out.sort((a, b) => compareStrings(a.category, b.category))
  }

  function budgetStatuses(period: string, catTotals: Map<string, Money>): BudgetStatus[] {
    return budgetsInEffect(period).map((v) => {
      const budget = Money.fromString(v.amount)
      const spent = catTotals.get(v.category) ?? Money.zero()
      return {
        categoryId: v.categoryId,
        category: v.category,
        budget: budget.toString(),
        spent: spent.toString(),
        remaining: budget.sub(spent).toString(),
        over: spent.gt(budget),
      }
    })
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

  // softDeleteRow: deleting a missing or already-deleted row is NotFound.
  function softDeleteRow(table: string, id: number, notFoundMsg: string): OpResult {
    db.exec(`UPDATE ${table} SET deleted_at = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL`, [
      nowIso(),
      id,
      uid(),
    ])
    if (db.changes() === 0) return { error: newError(ErrNotFound, notFoundMsg) }
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
      return softDeleteRow('cards', id, 'tarjeta no encontrada')
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
            // Like bun's soft-delete scoped UPDATE on desktop: only live rows.
            for (const table of ['expenses', 'fixed_expenses']) {
              db.exec(`UPDATE ${table} SET category = ? WHERE category = ? AND user_id = ? AND deleted_at IS NULL`, [
                n,
                old.name,
                uid(),
              ])
            }
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
      return softDeleteRow('categories', id, 'categoría no encontrada')
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
      return softDeleteRow('merchants', id, 'comercio no encontrado')
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
      return softDeleteRow('incomes', id, 'ingreso no encontrado')
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
      return softDeleteRow('expenses', id, 'gasto no encontrado')
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
      if (db.changes() === 0) return { error: newError(ErrNotFound, 'cuota no encontrada') }
      return {}
    },

    // ---------- fixed expenses (recurring) ----------

    async ListFixedExpenses(): Promise<FixedExpenseView[]> {
      const { fixed, amountsByID } = loadFixed(false)
      const cardByID = cardMapAll()
      const now = currentPeriod()
      const out: FixedExpenseView[] = fixed.map((fe) => {
        return {
          ...fe,
          currentAmount: resolveAsOf(amountsByID.get(fe.id) ?? [], fixedDisplayPeriod(fe, now)).toString(),
          cardName: fe.cardId != null ? (cardByID.get(fe.cardId)?.name ?? '') : '',
          active: activeIn(fe, now),
        }
      })
      out.sort((a, b) => compareStrings(a.description, b.description))
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
      const value = parsed.amount.toString()
      return db.transaction((): OpResult => {
        if (!ownsFixedExpense(id)) return { error: newError(ErrNotFound, 'gasto fijo no encontrado') }
        db.exec(
          `INSERT INTO fixed_expense_amounts (fixed_expense_id, effective_from, amount) VALUES (?, ?, ?)
           ON CONFLICT (fixed_expense_id, effective_from) DO UPDATE SET amount = EXCLUDED.amount`,
          [id, fromPeriod, value],
        )
        return {}
      })
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
      return softDeleteRow('fixed_expenses', id, 'gasto fijo no encontrado')
    },

    async RestoreFixedExpense(id: number): Promise<OpResult> {
      return restoreRow('fixed_expenses', id, 'gasto fijo no encontrado')
    },

    async SetFixedExpensePaid(id: number, period: string, paid: boolean): Promise<OpResult> {
      if (!validPeriod(period)) return { error: invalidPeriodError() }
      return db.transaction((): OpResult => {
        if (!ownsFixedExpense(id)) return { error: newError(ErrNotFound, 'gasto fijo no encontrado') }
        if (paid) {
          db.exec(
            `INSERT INTO fixed_expense_payments (fixed_expense_id, period, paid_at) VALUES (?, ?, ?)
             ON CONFLICT (fixed_expense_id, period) DO UPDATE SET paid_at = EXCLUDED.paid_at`,
            [id, period, nowIso()],
          )
        } else {
          db.exec('DELETE FROM fixed_expense_payments WHERE fixed_expense_id = ? AND period = ?', [id, period])
        }
        return {}
      })
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
        let cat = uncategorized
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
        const cat = mv.category !== '' ? mv.category : uncategorized
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

      const ahorro = sumContributions('period = ?', [period])
      const balance = disponible.sub(gastos).sub(ahorro)
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
        ahorro: ahorro.toString(),
        balance: balance.toString(),
        alcanza: disponible.gte(gastos.add(ahorro)),
        porCategoria: sortedCategoryTotals(catTotals),
        porTarjeta,
        movimientos,
        incomes,
        presupuestos: budgetStatuses(period, catTotals),
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
      const byCat = new CategoryMonths()
      for (const inst of insts) {
        const amount = Money.fromString(inst.amount)
        gastosByMonth.set(inst.period, (gastosByMonth.get(inst.period) ?? Money.zero()).add(amount))
        byCat.add(exById.get(inst.expenseId)?.category ?? '', inst.period, amount)
      }

      // Fold recurring fixed expenses into each month's gastos and categories.
      const { fixed, amountsByID } = loadFixed(false)
      for (let m = 1; m <= 12; m++) {
        const period = prefix + String(m).padStart(2, '0')
        for (const fe of fixed) {
          if (!activeIn(fe, period)) continue
          const amt = resolveAsOf(amountsByID.get(fe.id) ?? [], period)
          gastosByMonth.set(period, (gastosByMonth.get(period) ?? Money.zero()).add(amt))
          byCat.add(fe.category, period, amt)
        }
      }

      const ahorroByMonth = savingsByMonth(prefix + '01', prefix + '12')
      const months: YearMonth[] = []
      let totalIngresos = Money.zero()
      let totalGastos = Money.zero()
      let totalAhorro = Money.zero()
      for (let m = 1; m <= 12; m++) {
        const period = prefix + String(m).padStart(2, '0')
        const ingresos = (salaryByMonth.get(period) ?? Money.zero()).add(extrasByMonth.get(period) ?? Money.zero())
        const gastos = gastosByMonth.get(period) ?? Money.zero()
        const ahorro = ahorroByMonth.get(period) ?? Money.zero()
        const balance = ingresos.sub(gastos).sub(ahorro)
        saldo = saldo.add(balance) // running account balance at month close
        months.push({
          period,
          ingresos: ingresos.toString(),
          gastos: gastos.toString(),
          ahorro: ahorro.toString(),
          balance: balance.toString(),
          saldo: saldo.toString(),
          alcanza: saldo.gte(Money.zero()),
        })
        totalIngresos = totalIngresos.add(ingresos)
        totalGastos = totalGastos.add(gastos)
        totalAhorro = totalAhorro.add(ahorro)
      }

      const { totals, rows } = byCat.rows()
      const data: YearSummary = {
        year,
        months,
        porCategoria: totals,
        categoriaMeses: rows,
        totalIngresos: totalIngresos.toString(),
        totalGastos: totalGastos.toString(),
        totalAhorro: totalAhorro.toString(),
        totalBalance: totalIngresos.sub(totalGastos).sub(totalAhorro).toString(),
      }
      return { data }
    },

    // ---------- commitments forecast (proyección) ----------

    async CommitmentsForecast(fromPeriod: string, months: number): Promise<ForecastResult> {
      if (!validPeriod(fromPeriod)) return { error: invalidPeriodError() }
      if (!Number.isInteger(months) || months < 1 || months > maxForecastMonths) {
        return { error: newError(ErrValidation, 'la proyección debe ser de 1 a 36 meses') }
      }
      const to = addMonths(fromPeriod, months - 1)

      const cuotas = new Map<string, Money>()
      for (const r of db.query(
        `SELECT * FROM installments WHERE user_id = ? AND period >= ? AND period <= ?
         AND expense_id IN (SELECT id FROM expenses WHERE deleted_at IS NULL)`,
        [uid(), fromPeriod, to],
      )) {
        const inst = rowToInstallment(r)
        cuotas.set(inst.period, (cuotas.get(inst.period) ?? Money.zero()).add(Money.fromString(inst.amount)))
      }

      const { fixed, amountsByID } = loadFixed(false)

      // Every salary up to the horizon: the ones before `fromPeriod` only seed
      // the "last known salary" used to estimate months without one.
      const salaryByMonth = new Map<string, Money>()
      let lastKnown = Money.zero()
      for (const r of db.query('SELECT * FROM period_salaries WHERE user_id = ? AND period <= ? ORDER BY period ASC', [
        uid(),
        to,
      ])) {
        const ps = rowToPeriodSalary(r)
        if (ps.period < fromPeriod) lastKnown = Money.fromString(ps.amount)
        else salaryByMonth.set(ps.period, Money.fromString(ps.amount))
      }

      const extras = new Map<string, Money>()
      for (const r of db.query(
        'SELECT * FROM incomes WHERE user_id = ? AND period >= ? AND period <= ? AND deleted_at IS NULL',
        [uid(), fromPeriod, to],
      )) {
        const inc = rowToIncome(r)
        extras.set(inc.period, (extras.get(inc.period) ?? Money.zero()).add(Money.fromString(inc.amount)))
      }

      const ahorroByMonth = savingsByMonth(fromPeriod, to)
      let saldo = cumulativeBalanceBefore(fromPeriod)
      const data: ForecastMonth[] = []
      for (let i = 0; i < months; i++) {
        const period = addMonths(fromPeriod, i)
        let fijos = Money.zero()
        for (const fe of fixed) {
          if (activeIn(fe, period)) fijos = fijos.add(resolveAsOf(amountsByID.get(fe.id) ?? [], period))
        }
        const known = salaryByMonth.get(period)
        if (known) lastKnown = known
        const ingresos = lastKnown.add(extras.get(period) ?? Money.zero())
        const cuotasMes = cuotas.get(period) ?? Money.zero()
        const comprometido = cuotasMes.add(fijos)
        const ahorro = ahorroByMonth.get(period) ?? Money.zero()
        const libre = ingresos.sub(comprometido).sub(ahorro)
        saldo = saldo.add(libre)
        data.push({
          period,
          cuotas: cuotasMes.toString(),
          fijos: fijos.toString(),
          comprometido: comprometido.toString(),
          ahorro: ahorro.toString(),
          ingresos: ingresos.toString(),
          ingresoEstimado: known === undefined,
          libre: libre.toString(),
          saldoProyectado: saldo.toString(),
        })
      }
      return { data }
    },

    // ---------- category budgets (presupuestos) ----------

    async SetCategoryBudget(categoryID: number, fromPeriod: string, amount: string): Promise<OpResult> {
      if (!validPeriod(fromPeriod)) return { error: invalidPeriodError() }
      const parsed = amountOrError(amount)
      if (parsed.error || !parsed.amount) return { error: parsed.error ?? invalidAmountError(amount) }
      const value = parsed.amount.toString()
      return db.transaction((): OpResult => {
        const owned = db.query('SELECT 1 FROM categories WHERE id = ? AND user_id = ? AND deleted_at IS NULL', [
          categoryID,
          uid(),
        ])
        if (owned.length === 0) return { error: newError(ErrNotFound, 'categoría no encontrada') }
        db.exec(
          `INSERT INTO category_budgets (user_id, category_id, effective_from, amount) VALUES (?, ?, ?, ?)
           ON CONFLICT (category_id, effective_from) DO UPDATE SET amount = EXCLUDED.amount`,
          [uid(), categoryID, fromPeriod, value],
        )
        return {}
      })
    },

    async ListCategoryBudgets(period: string): Promise<CategoryBudgetsResult> {
      if (!validPeriod(period)) return { error: invalidPeriodError() }
      return { data: budgetsInEffect(period) }
    },

    // ---------- search ----------

    async SearchExpenses(f: ExpenseFilter): Promise<ExpenseSearchResult> {
      if ((f.fromPeriod !== '' && !validPeriod(f.fromPeriod)) || (f.toPeriod !== '' && !validPeriod(f.toPeriod))) {
        return { error: invalidPeriodError() }
      }
      if (f.fromPeriod !== '' && f.toPeriod !== '' && f.fromPeriod > f.toPeriod) {
        return { error: newError(ErrValidation, 'el período inicial es posterior al final') }
      }
      const limit = Math.min(f.limit > 0 ? f.limit : defaultSearchLimit, maxSearchLimit)
      const offset = Math.max(f.offset, 0)

      const where: string[] = ['user_id = ?', 'deleted_at IS NULL']
      const params: SqlValue[] = [uid()]
      const text = f.text.trim()
      if (text !== '') {
        const pattern = `%${escapeLike(text)}%`
        where.push(`(description LIKE ? ESCAPE '\\' OR merchant LIKE ? ESCAPE '\\')`)
        params.push(pattern, pattern)
      }
      const category = f.category.trim()
      if (category === uncategorized) {
        where.push("category = ''")
      } else if (category !== '') {
        where.push('category = ?')
        params.push(category)
      }
      if (f.cardId != null) {
        where.push('card_id = ?')
        params.push(f.cardId)
      }
      if (f.fromPeriod !== '' || f.toPeriod !== '') {
        where.push('id IN (SELECT expense_id FROM installments WHERE user_id = ? AND period >= ? AND period <= ?)')
        params.push(uid(), f.fromPeriod || '0000-01', f.toPeriod || '9999-12')
      }
      const clause = where.join(' AND ')
      const count = asNumber(db.query(`SELECT COUNT(*) AS n FROM expenses WHERE ${clause}`, params)[0]?.n)
      const expenses = db
        .query(`SELECT * FROM expenses WHERE ${clause} ORDER BY date DESC, id DESC LIMIT ? OFFSET ?`, [
          ...params,
          limit,
          offset,
        ])
        .map(rowToExpense)

      // Installment span/progress for the page, plus card names (incl. deleted cards).
      const spans = new Map<number, { first: string; last: string; paid: number }>()
      if (expenses.length > 0) {
        const ids = expenses.map((e) => e.id)
        for (const r of db.query(
          `SELECT * FROM installments WHERE user_id = ? AND expense_id IN (${ids.map(() => '?').join(', ')})`,
          [uid(), ...ids],
        )) {
          const inst = rowToInstallment(r)
          const sp = spans.get(inst.expenseId) ?? { first: inst.period, last: inst.period, paid: 0 }
          if (inst.period < sp.first) sp.first = inst.period
          if (inst.period > sp.last) sp.last = inst.period
          if (inst.status === StatusPagado) sp.paid++
          spans.set(inst.expenseId, sp)
        }
      }
      const cardByID = cardMapAll()
      const items: ExpenseHit[] = expenses.map((ex) => {
        const sp = spans.get(ex.id)
        return {
          expense: ex,
          cardName: ex.cardId != null ? (cardByID.get(ex.cardId)?.name ?? '') : '',
          firstPeriod: sp?.first ?? '',
          lastPeriod: sp?.last ?? '',
          total: Money.fromString(ex.installmentAmount).mulInt(Math.max(ex.installmentsTotal, 1)).toString(),
          paidCount: sp?.paid ?? 0,
        }
      })
      return { data: { items, count } }
    },

    // ---------- savings goals ----------

    async ListSavingsGoals(): Promise<SavingsGoalView[]> {
      return listSavingsGoals(currentPeriod())
    },

    async CreateSavingsGoal(name: string, targetAmount: string, targetPeriod: string): Promise<SavingsGoalResult> {
      const v = validateGoal(name, targetAmount, targetPeriod)
      if (v.error || !v.amount || v.name === undefined) return { error: v.error ?? newError(ErrValidation, 'meta inválida') }
      const row = db.query(
        `INSERT INTO savings_goals (user_id, name, target_amount, target_period, created_at)
         VALUES (?, ?, ?, ?, ?) RETURNING *`,
        [uid(), v.name, v.amount.toString(), targetPeriod, nowIso()],
      )[0]
      if (!row) return { error: newError(ErrNotFound, 'meta no encontrada') }
      return { data: rowToSavingsGoal(row) }
    },

    async UpdateSavingsGoal(
      id: number,
      name: string,
      targetAmount: string,
      targetPeriod: string,
    ): Promise<SavingsGoalResult> {
      const v = validateGoal(name, targetAmount, targetPeriod)
      if (v.error || !v.amount || v.name === undefined) return { error: v.error ?? newError(ErrValidation, 'meta inválida') }
      db.exec(
        `UPDATE savings_goals SET name = ?, target_amount = ?, target_period = ?
         WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
        [v.name, v.amount.toString(), targetPeriod, id, uid()],
      )
      if (db.changes() === 0) return { error: newError(ErrNotFound, 'meta no encontrada') }
      const row = db.query('SELECT * FROM savings_goals WHERE id = ? AND user_id = ?', [id, uid()])[0]
      if (!row) return { error: newError(ErrNotFound, 'meta no encontrada') }
      return { data: rowToSavingsGoal(row) }
    },

    async DeleteSavingsGoal(id: number): Promise<OpResult> {
      return softDeleteRow('savings_goals', id, 'meta no encontrada')
    },

    async RestoreSavingsGoal(id: number): Promise<OpResult> {
      return restoreRow('savings_goals', id, 'meta no encontrada')
    },

    async AddSavingsContribution(goalID: number, period: string, amount: string): Promise<SavingsContributionResult> {
      if (!validPeriod(period)) return { error: invalidPeriodError() }
      const parsed = amountOrError(amount)
      if (parsed.error || !parsed.amount) return { error: parsed.error ?? invalidAmountError(amount) }
      if (parsed.amount.isZero()) return { error: newError(ErrValidation, 'el aporte debe ser mayor a 0') }
      const value = parsed.amount.toString()
      return db.transaction((): SavingsContributionResult => {
        const owned = db.query('SELECT 1 FROM savings_goals WHERE id = ? AND user_id = ? AND deleted_at IS NULL', [
          goalID,
          uid(),
        ])
        if (owned.length === 0) return { error: newError(ErrNotFound, 'meta no encontrada') }
        const row = db.query(
          `INSERT INTO savings_contributions (user_id, goal_id, period, amount, created_at)
           VALUES (?, ?, ?, ?, ?) RETURNING *`,
          [uid(), goalID, period, value, nowIso()],
        )[0]
        if (!row) return { error: newError(ErrNotFound, 'aporte no encontrado') }
        return { data: rowToSavingsContribution(row) }
      })
    },

    async DeleteSavingsContribution(id: number): Promise<OpResult> {
      db.exec('DELETE FROM savings_contributions WHERE id = ? AND user_id = ?', [id, uid()])
      if (db.changes() === 0) return { error: newError(ErrNotFound, 'aporte no encontrado') }
      return {}
    },

    // ---------- spending trend ----------

    async SpendingTrend(period: string, months: number): Promise<SpendingTrendResult> {
      if (!validPeriod(period)) return { error: invalidPeriodError() }
      if (!Number.isInteger(months) || months < minTrendMonths || months > maxTrendMonths) {
        return { error: newError(ErrValidation, 'la tendencia debe ser de 2 a 24 meses') }
      }
      const from = addMonths(period, -(months - 1))
      const prev = addMonths(period, -1)
      const { totals, byCat } = spendingByMonth(from, period)
      const at = (m: Map<string, Money>, k: string) => m.get(k) ?? Money.zero()

      const trendMonths: TrendMonth[] = []
      let earlier = Money.zero()
      for (let i = 0; i < months; i++) {
        const p = addMonths(from, i)
        trendMonths.push({ period: p, gastos: at(totals, p).toString() })
        if (p !== period) earlier = earlier.add(at(totals, p))
      }

      const cats = new Set<string>()
      for (const m of byCat.values()) for (const c of m.keys()) cats.add(c)
      const empty = new Map<string, Money>()
      const categories = [...cats].map((category) => {
        let sumEarlier = Money.zero()
        for (let i = 0; i < months - 1; i++) sumEarlier = sumEarlier.add(at(byCat.get(addMonths(from, i)) ?? empty, category))
        return {
          category,
          current: at(byCat.get(period) ?? empty, category),
          previous: at(byCat.get(prev) ?? empty, category),
          average: sumEarlier.divRound(months - 1),
        }
      })
      categories.sort(
        (a, b) => b.current.cmp(a.current) || b.average.cmp(a.average) || compareStrings(a.category, b.category),
      )
      const data: SpendingTrend = {
        months: trendMonths,
        current: at(totals, period).toString(),
        previous: at(totals, prev).toString(),
        average: earlier.divRound(months - 1).toString(),
        categories: categories.map(
          (c): CategoryTrend => ({
            category: c.category,
            current: c.current.toString(),
            previous: c.previous.toString(),
            average: c.average.toString(),
          }),
        ),
      }
      return { data }
    },

    // ---------- recurring detection ----------

    async DetectRecurring(period: string): Promise<RecurringResult> {
      if (!validPeriod(period)) return { error: invalidPeriodError() }
      const from = addMonths(period, -(recurringWindowMonths - 1))
      const insts = db
        .query(
          `SELECT * FROM installments WHERE user_id = ? AND period >= ? AND period <= ?
           AND expense_id IN (SELECT id FROM expenses WHERE deleted_at IS NULL AND kind = ?)`,
          [uid(), from, period, KindUnico],
        )
        .map(rowToInstallment)
      const exById = expenseMapActive(insts.map((i) => i.expenseId))
      const groups = new Map<string, RecurringHit[]>()
      for (const inst of insts) {
        const ex = exById.get(inst.expenseId)
        if (!ex) continue
        const key = normalizeKey(ex.merchant) || normalizeKey(ex.description)
        const list = groups.get(key) ?? []
        list.push({ period: inst.period, amount: Money.fromString(inst.amount), ex })
        groups.set(key, list)
      }

      const alreadyFixed = new Set<string>()
      for (const fe of loadFixed(false).fixed) {
        if (fe.endPeriod === '' || fe.endPeriod >= period) alreadyFixed.add(normalizeKey(fe.description))
      }

      const out: RecurringSuggestion[] = []
      for (const hits of groups.values()) {
        const sug = recurringFrom(hits)
        if (!sug || alreadyFixed.has(normalizeKey(sug.description)) || alreadyFixed.has(normalizeKey(sug.merchant))) continue
        out.push(sug)
      }
      out.sort((a, b) => b.periods.length - a.periods.length || compareStrings(a.description, b.description))
      return { data: out }
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

      for (const r of db.query('SELECT * FROM savings_goals WHERE user_id = ? AND deleted_at IS NOT NULL', [uid()])) {
        const g = rowToSavingsGoal(r)
        out.push({ type: 'savingsgoal', id: g.id, description: g.name, amount: g.targetAmount, deletedAt: g.deletedAt ?? '' })
      }

      const { fixed, amountsByID } = loadFixed(true)
      const now = currentPeriod()
      for (const fe of fixed) {
        out.push({
          type: 'fixedexpense',
          id: fe.id,
          description: fe.description,
          amount: resolveAsOf(amountsByID.get(fe.id) ?? [], fixedDisplayPeriod(fe, now)).toString(),
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
