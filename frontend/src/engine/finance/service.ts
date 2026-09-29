// TypeScript port of backend/finance/service.go for the web build: identical
// method surface, validation messages, scoping and math — over a local SQLite
// (sqlite-wasm) instead of the Go backend. Every query filters by the active
// user id (session.active()), mirroring the desktop invariant.
import type {
  AppError,
  BudgetStatus,
  Card,
  CardDebt,
  CardResult,
  CardStatement,
  CardStatementDetailResult,
  CardStatementImport,
  CardStatementImportResult,
  CardStatementInput,
  CardStatementLine,
  CardStatementLineView,
  CardStatementView,
  CardStatementsResult,
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
  Due,
  DuesResult,
  FixedExpense,
  FixedExpenseResult,
  FixedExpenseView,
  ForecastMonth,
  ForecastResult,
  ImportBatch,
  ImportCandidate,
  ImportItem,
  ImportItemView,
  Installment,
  ImportItemsResult,
  Income,
  IncomeResult,
  MerchantResult,
  MerchantRule,
  MonthlySummary,
  MonthlySummaryResult,
  Movimiento,
  OpResult,
  PeriodSalary,
  ReconciliationResult,
  FxRateResult,
  Account,
  AccountResult,
  AccountsResult,
  AccountView,
  ReceivableResult,
  ReceivablesResult,
  RefundResult,
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
  StageResult,
  StageSummary,
  CatalogResult,
  Transfer,
  TransferResult,
  TrashItem,
  TrashResult,
  TagView,
  TrendMonth,
  UFValueInput,
  YearMonth,
  YearSummary,
  YearSummaryResult,
} from '@/services/contract'
import { ErrConflict, ErrNotFound, ErrValidation, isUniqueViolation, newError } from '@/engine/errors'
import { Money } from '@/engine/decimal'
import { validColor, validIcon } from '@/engine/finance/looks'
import { CATALOG } from '@/engine/finance/catalog'
import {
  addMonths,
  currentPeriod,
  inYearRange,
  MAX_YEAR,
  MIN_YEAR,
  monthOf,
  monthsBetween,
  validPeriod,
  type DateParts,
} from '@/engine/finance/period'
import {
  activeIn,
  billsIn,
  CurrencyCLP,
  CurrencyUF,
  fixedCharge,
  fixedTotal,
  interval,
  latestAsOf,
  nextBilling,
  resolveAsOf,
  UFRates,
  validIntervals,
  type EffectiveDated,
} from '@/engine/finance/fixedexpense'
import { normalizeDescriptor, ruleFor, suggestPattern } from '@/engine/finance/descriptor'
import { amountGap, namesMatch } from '@/engine/finance/fixedmatch'
import {
  dayOfMonth,
  DUE_LOOKBACK_DAYS,
  DueCard,
  DueFixed,
  MAX_DUE_DAYS,
  monthsSpanned,
  shiftDays,
} from '@/engine/finance/dues'
import { cleanTagName, normalizeTags, tagKey } from '@/engine/finance/tags'
import {
  buildCutoffs,
  cutoffPeriodOf,
  NO_CUTOFF,
  operationNumber,
  type CardCutoff,
  type StatementWindowRow,
} from '@/engine/finance/cutoff'
import {
  HintCardPayment,
  HintNone,
  HintTransfer,
  ImportConciliado,
  ImportConfirmado,
  ImportDescartado,
  ImportKindCredit,
  ImportKindExpense,
  ImportPendiente,
  ImportSourceCSV,
  ImportSourceEmail,
  ImportSourcePDFAccount,
  ImportSourcePDFCard,
  KindCuotas,
  KindUnico,
  LineCharge,
  LineCredit,
  LineDeferred,
  LinePayment,
  LinePurchase,
  LineVoluntary,
  SourceCuota,
  SourceFijo,
  SourceReembolso,
  StatementInternational,
  StatementNational,
  StatusPagado,
  StatusPendiente,
  TransferFixed,
  TransferSalaryRest,
  rowToAccount,
  rowToCard,
  rowToCardStatement,
  rowToCardStatementLine,
  rowToScheduleEntry,
  rowToCategory,
  rowToExpense,
  rowToFixedExpense,
  rowToFixedExpenseAmount,
  rowToImportItem,
  rowToIncome,
  rowToInstallment,
  rowToMerchant,
  rowToMerchantRule,
  rowToPeriodSalary,
  rowToReconciliation,
  rowToReceivable,
  rowToRefund,
  rowToTag,
  rowToTransfer,
  rowToSavingsContribution,
  rowToSavingsGoal,
  rowToSettings,
  type FixedExpenseAmountRow,
} from '@/engine/finance/models'
import { asNumber, asString, type SqlDb, type SqlRow, type SqlValue } from '@/engine/db/types'

// compareStrings is Go's strings.Compare: byte-wise, locale-independent, so the
// engine orders ties exactly like the desktop backend.
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

// uncategorized is the bucket for expenses without a category.
const uncategorized = 'Sin categoría'

// ACCOUNT_KINDS mirrors Go's accountKinds; 'digital' is a prepaid wallet
// (Mercado Pago, Tenpo, MACH): money is loaded into it before it is spent.
const ACCOUNT_KINDS: readonly string[] = ['corriente', 'vista', 'digital', 'efectivo', 'ahorro', 'otra']

// AccountFlow mirrors Go's accountFlow: what an account received and spent in
// a month, and what it got from (tin) or passed to (tout) another own account.
type AccountFlow = { in: Money; out: Money; tin: Money; tout: Money }

// transferActiveIn mirrors Transfer.activeIn: '' end = every month from the start.
function transferActiveIn(t: Transfer, period: string): boolean {
  return period >= t.startPeriod && (t.endPeriod === '' || period <= t.endPeriod)
}

// transferMoved mirrors Transfer.moved: a salary_rest transfer moves the
// month's salary minus its amount, never less than nothing.
function transferMoved(t: Transfer, salary: Money): Money {
  const amount = Money.fromString(t.amount)
  if (t.mode !== TransferSalaryRest) return amount
  const rest = salary.sub(amount)
  return rest.isNegative() ? Money.zero() : rest
}

// validTransfer mirrors Go: distinct accounts, a known mode, and a positive
// amount (salary_rest may keep nothing behind).
function validTransfer(
  from: number,
  to: number,
  description: string,
  mode: string,
  amount: string,
): { description: string; amount: string; error?: ReturnType<typeof newError> } {
  if (from === to) {
    return { description: '', amount: '', error: newError(ErrValidation, 'la cuenta de origen y la de destino deben ser distintas') }
  }
  if (mode !== TransferFixed && mode !== TransferSalaryRest) {
    return { description: '', amount: '', error: newError(ErrValidation, 'tipo de transferencia inválido: ' + mode) }
  }
  let amt: Money
  try {
    amt = Money.fromString(amount.trim())
  } catch {
    return { description: '', amount: '', error: newError(ErrValidation, 'monto inválido: ' + amount) }
  }
  if (amt.isNegative() || (mode === TransferFixed && amt.isZero())) {
    return { description: '', amount: '', error: newError(ErrValidation, 'monto inválido: ' + amount) }
  }
  return { description: description.trim(), amount: amt.toString() }
}

// trashTables mirrors Go's trashModels: a TrashItem type → its table. Deleting
// for good takes children along by ON DELETE CASCADE and unlinks the rest by
// ON DELETE SET NULL.
const trashTables: Readonly<Record<string, string>> = {
  card: 'cards',
  category: 'categories',
  merchant: 'merchants',
  income: 'incomes',
  expense: 'expenses',
  savingsgoal: 'savings_goals',
  fixedexpense: 'fixed_expenses',
}

// invalidLookError mirrors look.go's invalidLook: a key outside looks.json.
function invalidLookError(what: string): ReturnType<typeof newError> {
  return newError(ErrValidation, `${what} no válido`)
}

// validCategoryName mirrors Go: trimmed, not empty, and not the name of the
// bucket that groups expenses without a category.
function validCategoryName(name: string): { name: string; error?: ReturnType<typeof newError> } {
  const n = name.trim()
  if (n === '') return { name: '', error: newError(ErrValidation, 'el nombre es obligatorio') }
  if (n.toLowerCase() === uncategorized.toLowerCase()) {
    return { name: '', error: newError(ErrValidation, `«${uncategorized}» está reservado para los gastos sin categoría`) }
  }
  return { name: n }
}

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

// MAX_INSTALLMENTS mirrors maxInstallments in Go: a sanity ceiling against typos,
// not a bank rule (issuers cap purchases at about 48 cuotas commercially).
const MAX_INSTALLMENTS = 120

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

// storedDateParts reads the calendar date of an expenses.date value, in either
// format that reaches the table: the engine's ISO ('2026-07-10T00:00:00Z') or
// bun's ('2026-07-10 00:00:00+00:00') from a desktop file. Both are UTC, like
// the old.Date.UTC() Go uses for the same comparison.
function storedDateParts(stored: string): DateParts {
  return {
    year: Number(stored.slice(0, 4)),
    month: Number(stored.slice(5, 7)),
    day: Number(stored.slice(8, 10)),
  }
}

// PlacementChange is the cuota-1 month derived from an expense's date and card
// cutoff before and after an edit (mirrors placementChange in Go).
interface PlacementChange {
  before: string
  after: string
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

// validateLastDigits mirrors the Go helper: '' (not informed) or exactly four digits.
function validateLastDigits(s: string): { digits: string; error?: ReturnType<typeof newError> } {
  const t = s.trim()
  if (t === '' || /^[0-9]{4}$/.test(t)) return { digits: t }
  return { digits: '', error: newError(ErrValidation, 'los últimos dígitos deben ser 4 números') }
}

// ---------- import inbox (mirror of backend/finance/imports.go) ----------

// reconcileWindowDays: an alert email and its statement line may be dated a
// day apart (purchase date vs posting date).
const reconcileWindowDays = 1
// mergeWindowDays mirrors Go: how far the user's date may be from the bank's
// for a match (YNAB's window: ten days).
const mergeWindowDays = 10
// duplicateWindowDays: how far a manually entered expense may be from the
// detected movement and still be offered as "probably the same purchase"
// (the merge window: a date typed wrong by days is still found).
const duplicateWindowDays = mergeWindowDays

// dayNumber / shiftDay do calendar arithmetic on YYYY-MM-DD strings (UTC days).
function dayNumber(ymd: string): number {
  return Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(5, 7)) - 1, Number(ymd.slice(8, 10))) / 86_400_000
}

function shiftDay(ymd: string, n: number): string {
  return new Date((dayNumber(ymd) + n) * 86_400_000).toISOString().slice(0, 10)
}

function validImportStatus(status: string): boolean {
  return [ImportPendiente, ImportConfirmado, ImportDescartado, ImportConciliado].includes(status)
}

// validImportDate mirrors time.Parse("2006-01-02"): strict YYYY-MM-DD of a real day.
function validImportDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) return false
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const t = new Date(Date.UTC(y, mo - 1, d))
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d
}

interface StagedItem {
  source: string
  issuer: string
  externalKey: string
  date: string
  description: string
  amount: Money
  currency: string
  cardLastDigits: string
  installmentsTotal: number
  hint: string
  reference: string
  kind: string
  installmentNumber: number
  installmentAmount: string
  firstPeriod: string
  statementLineId: number | null
}

// validateCandidate mirrors the Go helper of the same name.
function validateCandidate(
  c: ImportCandidate,
): { item?: Omit<StagedItem, 'source' | 'issuer' | 'externalKey' | 'statementLineId'>; error?: ReturnType<typeof newError> } {
  const description = c.description.trim()
  if (description === '') return { error: newError(ErrValidation, 'la descripción es obligatoria') }
  const date = c.date.trim()
  if (!validImportDate(date)) return { error: newError(ErrValidation, 'fecha inválida (use YYYY-MM-DD): ' + c.date) }
  const parsed = amountOrError(c.amount)
  if (parsed.error || !parsed.amount) return { error: parsed.error ?? invalidAmountError(c.amount) }
  if (parsed.amount.isZero()) return { error: newError(ErrValidation, 'el monto debe ser mayor a 0') }
  const digits = validateLastDigits(c.cardLastDigits)
  if (digits.error) return { error: digits.error }
  if (![HintNone, HintCardPayment, HintTransfer].includes(c.hint)) {
    return { error: newError(ErrValidation, 'pista inválida: ' + c.hint) }
  }
  const currency = c.currency.trim().toUpperCase()
  const kind = c.kind ?? ''
  if (![ImportKindExpense, ImportKindCredit, ''].includes(kind)) {
    return { error: newError(ErrValidation, 'tipo de movimiento inválido: ' + kind) }
  }
  const total = Math.max(c.installmentsTotal, 1)
  const number = Math.max(c.installmentNumber ?? 0, 1)
  if (number > total) return { error: newError(ErrValidation, `cuota ${number} de ${total} inválida`) }
  let cuota = ''
  if ((c.installmentAmount ?? '').trim() !== '') {
    const v = amountOrError(c.installmentAmount ?? '')
    if (v.error || !v.amount) return { error: v.error ?? invalidAmountError(c.installmentAmount ?? '') }
    cuota = v.amount.toString()
  }
  const firstPeriod = c.firstPeriod ?? ''
  if (firstPeriod !== '' && !validPeriod(firstPeriod)) {
    return { error: newError(ErrValidation, 'período de la primera cuota inválido: ' + firstPeriod) }
  }
  return {
    item: {
      date,
      description,
      amount: parsed.amount,
      currency: currency === '' ? 'CLP' : currency,
      cardLastDigits: digits.digits,
      installmentsTotal: total,
      hint: c.hint,
      reference: c.reference.trim(),
      kind: kind === '' ? ImportKindExpense : kind,
      installmentNumber: number,
      installmentAmount: cuota,
      firstPeriod,
    },
  }
}

// validateBatch mirrors the Go helper: rejects the whole batch when any
// candidate is invalid, and keys each item by its stable fields plus its
// ordinal among identical candidates of the batch.
function validateBatch(batch: ImportBatch): { items?: StagedItem[]; error?: ReturnType<typeof newError> } {
  if (![ImportSourceEmail, ImportSourcePDFAccount, ImportSourcePDFCard, ImportSourceCSV].includes(batch.source)) {
    return { error: newError(ErrValidation, 'origen de importación inválido: ' + batch.source) }
  }
  const issuer = batch.issuer.trim().toLowerCase()
  if (issuer === '') return { error: newError(ErrValidation, 'el emisor es obligatorio') }
  const ordinals = new Map<string, number>()
  const items: StagedItem[] = []
  for (const [i, c] of batch.items.entries()) {
    const v = validateCandidate(c)
    if (v.error || !v.item) {
      const err = v.error ?? newError(ErrValidation, 'movimiento inválido')
      return { error: newError(err.code, `movimiento ${i + 1}: ${err.message}`) }
    }
    const base = [
      issuer,
      batch.source,
      c.account.trim(),
      v.item.date,
      v.item.amount.toString(),
      v.item.currency,
      v.item.cardLastDigits,
      normalizeKey(v.item.description),
      c.reference.trim(),
    ].join('|')
    const ordinal = ordinals.get(base) ?? 0
    ordinals.set(base, ordinal + 1)
    items.push({ ...v.item, source: batch.source, issuer, externalKey: `${base}|${ordinal}`, statementLineId: null })
  }
  return { items }
}

// cardsByLastDigits maps last digits to the one live card that has them;
// digits shared by several cards are ambiguous and resolve to none.
function cardsByLastDigits(cards: Card[]): Map<string, Card> {
  const out = new Map<string, Card>()
  const seen = new Map<string, number>()
  for (const c of cards) {
    if (c.lastDigits === '') continue
    seen.set(c.lastDigits, (seen.get(c.lastDigits) ?? 0) + 1)
    out.set(c.lastDigits, c)
  }
  for (const [digits, n] of seen) if (n > 1) out.delete(digits)
  return out
}

// validateRulePattern normalizes a rule pattern like descriptors; '' = no rule.
function validateRulePattern(pattern: string): { pattern: string; error?: ReturnType<typeof newError> } {
  if (pattern.trim() === '') return { pattern: '' }
  const norm = normalizeDescriptor(pattern)
  if (norm === '') {
    return { pattern: '', error: newError(ErrValidation, 'el patrón de la regla no tiene palabras válidas') }
  }
  return { pattern: norm }
}

// TxAbort carries a business error out of db.transaction so the transaction
// rolls back — the engine's equivalent of returning an *AppError from RunInTx.
class TxAbort extends Error {
  constructor(readonly appError: AppError) {
    super(appError.message)
  }
}

// ---------- card statements (mirror of backend/finance/cardstatement.go) ----------

// paymentWindowDays: a card payment may be posted a few days apart in the
// cartola and in the statement.
const paymentWindowDays = 5

type StatementRow = Omit<CardStatement, 'id' | 'cardId' | 'fxRate' | 'importedAt'>
type StatementLineRow = Omit<CardStatementLine, 'id' | 'statementId' | 'importItemId' | 'installmentId'>

// StatementFields collects field errors so the first one is reported with its
// name (a parser bug must be easy to locate). JSON.stringify stands in for Go's %q.
class StatementFields {
  error: AppError | null = null

  money(name: string, s: string): string {
    const t = s.trim()
    if (t === '' || this.error) return '0'
    try {
      return Money.fromString(t).toString()
    } catch {
      this.error = newError(ErrValidation, `${name}: monto inválido ${JSON.stringify(t)}`)
      return '0'
    }
  }

  rate(name: string, s: string): string {
    const t = s.trim()
    if (t === '' || this.error) return ''
    try {
      return Money.fromString(t).toString()
    } catch {
      this.error = newError(ErrValidation, `${name}: tasa inválida ${JSON.stringify(t)}`)
      return ''
    }
  }

  date(name: string, s: string, required: boolean): string {
    const t = s.trim()
    if (this.error || (t === '' && !required)) return t
    if (!validImportDate(t)) {
      this.error = newError(ErrValidation, `${name}: fecha inválida (use YYYY-MM-DD) ${JSON.stringify(t)}`)
    }
    return t
  }
}

function validSection(s: string): boolean {
  return [LinePayment, LinePurchase, LineVoluntary, LineCharge, LineCredit, LineDeferred].includes(s)
}

// purchaseSections mirrors Go: lines that are purchases (a plan of cuotas may
// show up in several statements).
const purchaseSections = [LinePurchase, LineVoluntary, LineDeferred]

interface ValidatedStatement {
  statement: StatementRow
  lines: StatementLineRow[]
  schedule: { period: string; amount: string }[]
}

// validateStatement mirrors the Go helper: turns the parser's input into rows
// ready to insert, reporting the first invalid field by name.
function validateStatement(
  userId: number,
  input: CardStatementInput,
): { value?: ValidatedStatement; error?: AppError } {
  const f = new StatementFields()
  if (input.kind !== StatementNational && input.kind !== StatementInternational) {
    return { error: newError(ErrValidation, 'tipo de estado de cuenta inválido: ' + input.kind) }
  }
  const digits = validateLastDigits(input.cardLastDigits)
  if (digits.error) return { error: digits.error }
  if (digits.digits === '') return { error: newError(ErrValidation, 'faltan los últimos 4 dígitos de la tarjeta') }
  const issuer = input.issuer.trim().toLowerCase()
  const currency = input.currency.trim().toUpperCase()
  if (issuer === '' || currency === '') {
    return { error: newError(ErrValidation, 'faltan el emisor o la moneda del estado de cuenta') }
  }
  // Field order matches the Go struct literal, so both report the same first error.
  const statement: StatementRow = {
    userId,
    issuer,
    kind: input.kind,
    currency,
    cardLastDigits: digits.digits,
    period: '',
    statementDate: f.date('fecha del estado', input.statementDate, true),
    periodFrom: f.date('período desde', input.periodFrom, false),
    periodTo: f.date('período hasta', input.periodTo, false),
    dueDate: f.date('pagar hasta', input.dueDate, false),
    previousPeriodFrom: f.date('período anterior desde', input.previousPeriodFrom, false),
    previousPeriodTo: f.date('período anterior hasta', input.previousPeriodTo, false),
    nextPeriodFrom: f.date('próximo período desde', input.nextPeriodFrom, false),
    nextPeriodTo: f.date('próximo período hasta', input.nextPeriodTo, false),
    creditLimit: f.money('cupo total', input.creditLimit),
    creditUsed: f.money('cupo utilizado', input.creditUsed),
    creditAvailable: f.money('cupo disponible', input.creditAvailable),
    cashLimit: f.money('cupo avance', input.cashLimit),
    cashUsed: f.money('avance utilizado', input.cashUsed),
    cashAvailable: f.money('avance disponible', input.cashAvailable),
    previousBalanceStart: f.money('saldo inicio período anterior', input.previousBalanceStart),
    previousBilled: f.money('facturado período anterior', input.previousBilled),
    previousPaid: f.money('pagado período anterior', input.previousPaid),
    previousBalanceEnd: f.money('saldo final período anterior', input.previousBalanceEnd),
    transferFromNational: f.money('traspaso deuda nacional', input.transferFromNational),
    totalOperations: f.money('total operaciones', input.totalOperations),
    voluntaryProducts: f.money('productos voluntarios', input.voluntaryProducts),
    chargesNet: f.money('cargos y abonos', input.chargesNet),
    totalBilled: f.money('total facturado', input.totalBilled),
    minimumPayment: f.money('monto mínimo', input.minimumPayment),
    prepaymentCost: f.money('costo prepago', input.prepaymentCost),
    automaticCharge: f.money('cargo automático', input.automaticCharge),
    unbilledBalance: f.money('deuda no facturada', input.unbilledBalance),
    rateRevolving: f.rate('tasa rotativo', input.rateRevolving),
    rateInstallments: f.rate('tasa compra en cuotas', input.rateInstallments),
    rateCashAdvance: f.rate('tasa avance', input.rateCashAdvance),
    caeRevolving: f.rate('CAE rotativo', input.caeRevolving),
    caeInstallments: f.rate('CAE compra en cuotas', input.caeInstallments),
    caeCashAdvance: f.rate('CAE avance', input.caeCashAdvance),
    caePrepayment: f.rate('CAE prepago', input.caePrepayment),
    lateInterestRate: f.rate('interés moratorio', input.lateInterestRate),
    fileHash: input.fileHash.trim(),
  }
  // The billed period is the month the statement closes, the same month
  // periodOf assigns to purchases made before the card's cutoff.
  const closing = statement.periodTo !== '' ? statement.periodTo : statement.statementDate
  if (!f.error) statement.period = closing.slice(0, 7)

  const lines: StatementLineRow[] = []
  for (const [i, l] of input.lines.entries()) {
    const name = `movimiento ${i + 1}`
    if (!validSection(l.section)) {
      return { error: newError(ErrValidation, `${name}: sección inválida ${JSON.stringify(l.section)}`) }
    }
    const description = l.description.trim()
    if (description === '') return { error: newError(ErrValidation, name + ': falta la descripción') }
    const total = Math.max(l.installmentsTotal, 1)
    const number = l.section === LineDeferred ? 0 : Math.max(l.installmentNumber, 1) // deferred: no cuota billed yet
    if (number > total) return { error: newError(ErrValidation, `${name}: cuota ${number} de ${total} inválida`) }
    const origin = l.originAmount.trim() !== '' ? f.money(name + ' monto origen', l.originAmount) : ''
    lines.push({
      userId,
      position: i + 1,
      section: l.section,
      place: l.place.trim(),
      city: l.city.trim(),
      country: l.country.trim(),
      operationDate: f.date(name + ' fecha', l.operationDate, true),
      reference: l.reference.trim(),
      description,
      interestRate: f.rate(name + ' tasa', l.interestRate),
      operationAmount: f.money(name + ' monto operación', l.operationAmount),
      totalAmount: f.money(name + ' monto total', l.totalAmount),
      installmentNumber: number,
      installmentsTotal: total,
      installmentAmount: f.money(name + ' cargo del mes', l.installmentAmount),
      originAmount: origin,
    })
  }
  const schedule: { period: string; amount: string }[] = []
  for (const e of input.schedule) {
    if (!validPeriod(e.period)) return { error: newError(ErrValidation, 'calendario: período inválido ' + e.period) }
    schedule.push({ period: e.period, amount: f.money('calendario ' + e.period, e.amount) })
  }
  if (f.error) return { error: f.error }
  return { value: { statement, lines, schedule } }
}

// lineCandidate is the inbox candidate for a staged line. Purchases keep the
// purchase total as amount and the bank's cuota apart; the key uses the
// reference and total (not the cuota number), so the same purchase seen in
// next month's statement is recognized as already in the inbox.
function lineCandidate(st: CardStatement, l: CardStatementLine): ImportCandidate {
  const c: ImportCandidate = {
    date: l.operationDate,
    description: l.description,
    amount: '',
    currency: st.currency,
    cardLastDigits: st.cardLastDigits,
    account: st.kind,
    reference: l.reference,
    installmentsTotal: l.installmentsTotal,
    installmentNumber: l.installmentNumber,
    hint: HintNone,
  }
  // Mirrors Go: the kind is decided here, not by the sign downstream — a
  // negative line in a charge section (a reversal, a refunded fee) is money
  // back — and the statement fixes every purchase's billing month.
  const charged = Money.fromString(l.installmentAmount).abs()
  const operation = Money.fromString(l.operationAmount)
  const reversal =
    l.section !== LineCredit && (Money.fromString(l.installmentAmount).isNegative() || operation.isNegative())
  if (l.section === LineCredit || reversal) {
    c.kind = ImportKindCredit
    c.amount = (charged.isZero() ? operation.abs() : charged).toString()
  } else if (l.section === LineDeferred) {
    // Bought this period, billed from the next one: nothing is paid yet.
    c.amount = (operation.isZero() ? charged : operation.abs()).toString()
    if (l.installmentsTotal > 1) c.installmentAmount = charged.toString()
    c.installmentNumber = 1
    c.firstPeriod = addMonths(st.period, 1)
  } else if (l.section === LinePurchase || l.section === LineVoluntary) {
    let total = operation.abs()
    // USD lines carry only the charged amount.
    if (st.kind === StatementInternational || total.isZero()) total = charged
    c.amount = total.toString()
    if (l.installmentsTotal > 1) c.installmentAmount = charged.toString()
    c.firstPeriod = addMonths(st.period, -(l.installmentNumber - 1))
  } else {
    // cargo: a fee or tax billed in the statement's month
    c.amount = charged.toString()
    c.firstPeriod = st.period
  }
  return c
}

// isInternationalPayment tells a cartola's payment of the USD card debt
// ("PAGO DEUDA INTER. TC CTA CLP") from the national one.
function isInternationalPayment(description: string): boolean {
  return description.toUpperCase().includes('INTER')
}

// suggestClp converts a USD item at the given CLP-per-USD rate, rounded to
// whole pesos; '' for CLP items or without a known rate.
function suggestClp(it: ImportItem, fx: string): string {
  if (it.currency !== 'USD' || fx === '') return ''
  try {
    return Money.fromString(it.amount).times(Money.fromString(fx)).round(0).toString()
  } catch {
    return ''
  }
}

// duplicateReviewable mirrors the Go helper: a pending CLP charge gets a "did
// you already enter it?" suggestion.
function duplicateReviewable(it: ImportItem): boolean {
  return it.status === ImportPendiente && it.kind !== ImportKindCredit && it.currency === 'CLP'
}

// budgetAlertPercent mirrors Go: the share of a cap that raises the early warning.
const budgetAlertPercent = 80

// refundWindowDays / refundReviewable mirror the Go refund suggestion: a pending
// CLP bank credit is matched to purchases up to 120 days before it.
const refundWindowDays = 120

function refundReviewable(it: ImportItem): boolean {
  return it.status === ImportPendiente && it.kind === ImportKindCredit && it.currency === 'CLP'
}

// clpAmountOf mirrors the Go helper: the item's amount in pesos (its own for a
// CLP item, the suggested conversion for a USD one), or null when unknown.
function clpAmountOf(it: ImportItem, suggestedClp: string): Money | null {
  if (it.currency === 'CLP') return Money.fromString(it.amount)
  return suggestedClp === '' ? null : Money.fromString(suggestedClp)
}

// billingPeriodOf mirrors the Go helper: the month the statement states, else
// the date placed by the card's cutoff (NO_CUTOFF = no card).
function billingPeriodOf(it: ImportItem, cutoff: CardCutoff): string {
  return it.firstPeriod !== '' ? it.firstPeriod : cutoffPeriodOf(cutoff, storedDateParts(it.date))
}

// requireKind mirrors the Go helper: a bank credit is income, never an expense
// (and a charge is never income).
function requireKind(item: ImportItem, kind: string): ReturnType<typeof newError> | null {
  if (item.kind === kind) return null
  return item.kind === ImportKindCredit
    ? newError(ErrValidation, 'es un abono del banco: regístralo como ingreso')
    : newError(ErrValidation, 'es un cargo del banco: regístralo como gasto')
}

// requirePesos mirrors the Go helper: an item billed in another currency needs
// a whole-peso amount (CLP has no minor unit) that is not the foreign figure.
function requirePesos(item: ImportItem, amount: Money): ReturnType<typeof newError> | null {
  if (item.currency === 'CLP') return null
  if (!amount.isInteger()) {
    return newError(ErrValidation, 'ingresa el monto en pesos, sin decimales')
  }
  if (amount.cmp(Money.fromString(item.amount)) === 0) {
    return newError(ErrValidation, `el monto es el mismo que en ${item.currency}: ingrésalo convertido a pesos`)
  }
  return null
}

// snakeCase maps a model field to its column (creditLimit → credit_limit).
function snakeCase(field: string): string {
  return field.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase())
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

  // cutoffsFor mirrors the Go helper: the cutoff of the user's cards (all of
  // them when no id is given; trashed ones included), keyed by card id.
  function cutoffsFor(...cardIDs: number[]): Map<number, CardCutoff> {
    const only = cardIDs.length > 0 ? ` AND id IN (${cardIDs.map(() => '?').join(', ')})` : ''
    const cards = db.query(`SELECT * FROM cards WHERE user_id = ?${only}`, [uid(), ...cardIDs]).map(rowToCard)
    if (cards.length === 0) return new Map()
    const ids = cards.map((c) => c.id)
    const statements: StatementWindowRow[] = db
      .query(
        `SELECT card_id, period, period_from, period_to, next_period_from, next_period_to FROM card_statements
         WHERE user_id = ? AND card_id IN (${ids.map(() => '?').join(', ')}) ORDER BY statement_date DESC`,
        [uid(), ...ids],
      )
      .map((r) => ({
        cardId: asNumber(r.card_id),
        period: asString(r.period),
        periodFrom: asString(r.period_from),
        periodTo: asString(r.period_to),
        nextPeriodFrom: asString(r.next_period_from),
        nextPeriodTo: asString(r.next_period_to),
      }))
    return buildCutoffs(cards, statements)
  }

  // cutoffFor: the card's cutoff (statement windows, then billing day), or none
  // (no roll) without a card. A card in the trash is accepted only with
  // allowTrashed: an edit may keep the card a row already had, but nothing new
  // may be charged to it.
  function cutoffFor(
    cardID: number | null,
    allowTrashed = false,
  ): { cutoff: CardCutoff; error?: ReturnType<typeof newError> } {
    if (cardID == null) return { cutoff: NO_CUTOFF }
    const live = allowTrashed ? '' : ' AND deleted_at IS NULL'
    const rows = db.query(`SELECT id FROM cards WHERE id = ? AND user_id = ?${live}`, [cardID, uid()])
    if (!rows[0]) return { cutoff: NO_CUTOFF, error: newError(ErrValidation, 'la tarjeta indicada no existe') }
    return { cutoff: cutoffsFor(cardID).get(cardID) ?? NO_CUTOFF }
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
    if (!inYearRange(date.parts.year)) {
      return {
        error: newError(
          ErrValidation,
          `fecha fuera de rango: ${dateStr.trim()} (use un año entre ${MIN_YEAR} y ${MAX_YEAR})`,
        ),
      }
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
      if (total > MAX_INSTALLMENTS) {
        return { error: newError(ErrValidation, `las cuotas totales no pueden ser más de ${MAX_INSTALLMENTS}`) }
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

  // replanInstallments mirrors the Go helper: an edited expense's cuotas are
  // adapted in place, matched by number, instead of regenerated. Ids stay stable
  // (card statement lines link to them) and a paid cuota is never rewritten; an
  // edit that would drop a paid cuota or move the plan to other months is
  // refused. A pending cuota takes the new amount only when amountChanged and is
  // re-placed only when the plan moved (a prepayment, the bank's rounded last
  // cuota stay); cuotas added to a plan that did not move follow its last one.
  // It checks before writing anything, so a refusal leaves the plan untouched.
  function replanInstallments(
    expenseId: number,
    ex: ValidatedExpense,
    placement: PlacementChange,
    amountChanged: boolean,
  ): ReturnType<typeof newError> | null {
    const insts = db
      .query('SELECT * FROM installments WHERE expense_id = ? AND user_id = ? ORDER BY number ASC', [expenseId, uid()])
      .map(rowToInstallment)
    const byNumber = new Map(insts.map((i) => [i.number, i]))
    const lastPaid = Math.max(0, ...insts.filter((i) => i.status === StatusPagado).map((i) => i.number))

    const total = ex.installmentsTotal
    if (lastPaid > total) {
      return newError(
        ErrValidation,
        `la cuota ${lastPaid} ya está pagada: desmárcala antes de dejar el gasto en ${total} cuota(s)`,
      )
    }
    const moved = placement.before !== placement.after
    const current = byNumber.get(1)
    const first = current && !moved ? current.period : placement.after
    if (lastPaid > 0 && current && first !== current.period) {
      return newError(
        ErrValidation,
        'el cambio mueve las cuotas a otros meses y hay cuotas pagadas: desmárcalas para moverlo',
      )
    }

    const amount = ex.installmentAmount.toString()
    let previous = '' // the month of cuota n-1 once placed
    for (let n = 1; n <= total; n++) {
      const inst = byNumber.get(n)
      let period = addMonths(first, n - 1)
      if (inst && !moved) period = inst.period
      else if (!inst && !moved && previous !== '') period = addMonths(previous, 1)
      previous = period
      if (!inst) {
        db.exec(
          `INSERT INTO installments (user_id, expense_id, number, total, period, amount, status, paid_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
          [uid(), expenseId, n, total, period, amount, StatusPendiente],
        )
      } else if (inst.status === StatusPagado) {
        db.exec('UPDATE installments SET total = ? WHERE id = ?', [total, inst.id])
      } else {
        db.exec('UPDATE installments SET total = ?, period = ?, amount = ? WHERE id = ?', [
          total,
          period,
          amountChanged ? amount : inst.amount,
          inst.id,
        ])
      }
    }
    // Only pending cuotas can be past the new total (checked above).
    db.exec('DELETE FROM installments WHERE expense_id = ? AND user_id = ? AND number > ?', [expenseId, uid(), total])
    return null
  }

  // generateInstallments creates one row per cuota starting at firstPeriod ('' =
  // derived from the date and the card's cutoff); the first paidCount are
  // marked pagado (a statement's cuota n means cuotas 1..n-1 were already billed).
  function generateInstallments(
    expenseId: number,
    ex: ValidatedExpense,
    cutoff: CardCutoff,
    paidCount: number,
    firstPeriod = '',
  ): void {
    const total = ex.kind === KindUnico ? 1 : ex.installmentsTotal
    const first = firstPeriod !== '' ? firstPeriod : cutoffPeriodOf(cutoff, ex.date.parts)
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

  // insertExpense writes a validated expense and its installments; callers wrap
  // it in their transaction (CreateExpense, ConfirmImportItem).
  function insertExpense(ex: ValidatedExpense, cutoff: CardCutoff, firstPeriod = '', paidCount = 0): Expense {
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
    if (!row) throw new Error('INSERT expenses RETURNING produced no row')
    const created = rowToExpense(row)
    generateInstallments(created.id, ex, cutoff, paidCount, firstPeriod)
    return created
  }

  // ---------- import inbox helpers ----------

  // findReconcileMatch mirrors the Go helper: the other-family sighting of the
  // item nothing has been matched with yet; closest date wins, then oldest row.
  function findReconcileMatch(item: StagedItem): ImportItem | null {
    const familyFilter = item.source === ImportSourceEmail ? 'source <> ?' : 'source = ?'
    const row = db.query(
      `SELECT * FROM import_items
       WHERE user_id = ? AND status <> ? AND amount = ? AND currency = ?
       AND ABS(julianday(date) - julianday(?)) <= ?
       AND (card_last_digits = ? OR card_last_digits = '' OR ? = '')
       AND id NOT IN (SELECT matched_item_id FROM import_items WHERE user_id = ? AND matched_item_id IS NOT NULL)
       AND ${familyFilter}
       ORDER BY ABS(julianday(date) - julianday(?)) ASC, id ASC LIMIT 1`,
      [
        uid(),
        ImportConciliado,
        item.amount.toString(),
        item.currency,
        item.date,
        reconcileWindowDays,
        item.cardLastDigits,
        item.cardLastDigits,
        uid(),
        ImportSourceEmail,
        item.date,
      ],
    )[0]
    return row ? rowToImportItem(row) : null
  }

  function listMerchantRules(): MerchantRule[] {
    return db
      .query('SELECT * FROM merchant_rules WHERE user_id = ? ORDER BY pattern ASC, id ASC', [uid()])
      .map(rowToMerchantRule)
  }

  // merchantCategories mirrors Go: each live merchant (lowercased) → its usual category.
  function merchantCategories(): Map<string, string> {
    const out = new Map<string, string>()
    for (const r of db.query(
      "SELECT name, category FROM merchants WHERE user_id = ? AND deleted_at IS NULL AND category <> ''",
      [uid()],
    )) {
      out.set(asString(r.name).toLowerCase(), asString(r.category))
    }
    return out
  }

  // matchedItemsOf loads, in one query, the items the listed ones were
  // reconciled with (mirrors Go's matchedItems).
  function matchedItemsOf(items: ImportItem[]): Map<number, ImportItem> {
    const ids: SqlValue[] = items.flatMap((it) => (it.matchedItemId != null ? [it.matchedItemId] : []))
    if (ids.length === 0) return new Map()
    const rows = db.query(
      `SELECT * FROM import_items WHERE user_id = ? AND id IN (${ids.map(() => '?').join(', ')})`,
      [uid(), ...ids],
    )
    return new Map(rows.map(rowToImportItem).map((m) => [m.id, m]))
  }

  // duplicateFinder mirrors Go's duplicateCandidates + find: the live, unlinked
  // expenses dated near any listed item are loaded in one query (a string range
  // on the YYYY-MM-DD prefix both date formats share), then each item picks the
  // one that looks like the same purchase — within duplicateWindowDays, cuota
  // or total equal to its amount, on its card when known; closest date wins,
  // then the oldest expense.
  function duplicateFinder(items: ImportItem[]): (item: ImportItem, cardId: number | null) => Expense | null {
    const days = dayNumber
    const reviewable = items.filter(duplicateReviewable).map((it) => it.date)
    if (reviewable.length === 0) return () => null
    const shift = shiftDay
    const from = shift(reviewable.reduce((a, b) => (b < a ? b : a)), -duplicateWindowDays)
    const to = shift(reviewable.reduce((a, b) => (b > a ? b : a)), duplicateWindowDays + 1)
    const cands = db
      .query(
        `SELECT * FROM expenses WHERE user_id = ? AND deleted_at IS NULL AND date >= ? AND date < ?
         AND id NOT IN (SELECT expense_id FROM import_items WHERE user_id = ? AND expense_id IS NOT NULL)
         ORDER BY id ASC`,
        [uid(), from, to, uid()],
      )
      .map(rowToExpense)
    return (item, cardId) => {
      const amount = Money.fromString(item.amount)
      const day = days(item.date)
      let best: Expense | null = null
      let bestGap = 0
      for (const ex of cands) {
        if (cardId != null && ex.cardId !== cardId) continue
        const gap = Math.abs(days(ex.date.slice(0, 10)) - day)
        if (gap > duplicateWindowDays) continue
        const cuota = Money.fromString(ex.installmentAmount)
        if (cuota.cmp(amount) !== 0 && cuota.mulInt(ex.installmentsTotal).cmp(amount) !== 0) continue
        if (best === null || gap < bestGap) {
          best = ex
          bestGap = gap
        }
      }
      return best
    }
  }

  // refundFinder mirrors Go's refundCandidates + refundOf: live expenses dated up
  // to refundWindowDays before any reviewable credit, loaded once (newest
  // first); a credit takes the most recent purchase named like it, costing at
  // least the credit, on its card when both know one.
  function refundFinder(items: ImportItem[]): (item: ImportItem, cardId: number | null) => Expense | null {
    const days = (ymd: string) => Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(5, 7)) - 1, Number(ymd.slice(8, 10))) / 86_400_000
    const reviewable = items.filter(refundReviewable).map((it) => it.date)
    if (reviewable.length === 0) return () => null
    const shift = (ymd: string, n: number) => new Date((days(ymd) + n) * 86_400_000).toISOString().slice(0, 10)
    const from = shift(reviewable.reduce((a, b) => (b < a ? b : a)), -refundWindowDays)
    const to = shift(reviewable.reduce((a, b) => (b > a ? b : a)), 1)
    const cands = db
      .query('SELECT * FROM expenses WHERE user_id = ? AND deleted_at IS NULL AND date >= ? AND date < ? ORDER BY date DESC, id DESC', [
        uid(),
        from,
        to,
      ])
      .map(rowToExpense)
    return (item, cardId) => {
      const amount = Money.fromString(item.amount)
      const day = days(item.date)
      for (const ex of cands) {
        const purchased = days(ex.date.slice(0, 10))
        if (purchased > day || day - purchased > refundWindowDays) continue
        if (cardId != null && ex.cardId != null && ex.cardId !== cardId) continue
        if (Money.fromString(ex.installmentAmount).mulInt(ex.installmentsTotal).cmp(amount) < 0) continue
        if (namesMatch(ex.merchant, item.description) || namesMatch(ex.description, item.description)) return ex
      }
      return null
    }
  }

  // loadPendingItem: NotFound when the item does not exist for the user,
  // Conflict when it was already processed.
  function loadPendingItem(id: number): { item?: ImportItem; error?: ReturnType<typeof newError> } {
    const row = db.query('SELECT * FROM import_items WHERE id = ? AND user_id = ?', [id, uid()])[0]
    if (!row) return { error: newError(ErrNotFound, 'movimiento no encontrado') }
    const item = rowToImportItem(row)
    if (item.status !== ImportPendiente) return { error: newError(ErrConflict, 'el movimiento ya fue procesado') }
    return { item }
  }

  function moveImportItem(id: number, from: string, to: string): OpResult {
    return db.transaction((): OpResult => {
      const row = db.query('SELECT * FROM import_items WHERE id = ? AND user_id = ?', [id, uid()])[0]
      if (!row) return { error: newError(ErrNotFound, 'movimiento no encontrado') }
      if (rowToImportItem(row).status !== from) {
        return { error: newError(ErrConflict, 'el movimiento no está ' + from) }
      }
      db.exec('UPDATE import_items SET status = ? WHERE id = ? AND user_id = ?', [to, id, uid()])
      return {}
    })
  }

  // stageItems mirrors the Go helper: inserts validated items inside the
  // caller's transaction and returns, per item, the id of the inbox row that
  // now represents it (the new row, or the existing one for a duplicate).
  function stageItems(items: StagedItem[]): { ids: number[]; sum: StageSummary } {
    const sum: StageSummary = { added: 0, duplicates: 0, reconciled: 0 }
    const ids: number[] = []
    for (const item of items) {
      const existing = db.query('SELECT id FROM import_items WHERE user_id = ? AND external_key = ?', [
        uid(),
        item.externalKey,
      ])[0]
      if (existing) {
        ids.push(asNumber(existing.id))
        sum.duplicates++
        continue
      }
      const rec = reconcile(item)
      const row = db.query(
        `INSERT INTO import_items (user_id, source, issuer, external_key, date, description, amount, currency,
         card_last_digits, installments_total, hint, status, matched_item_id, created_at,
         kind, statement_line_id, installment_number, installment_amount, first_period, reference)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        [
          uid(),
          item.source,
          item.issuer,
          item.externalKey,
          item.date,
          item.description,
          item.amount.toString(),
          item.currency,
          item.cardLastDigits,
          item.installmentsTotal,
          item.hint,
          rec ? ImportConciliado : ImportPendiente,
          rec?.matchedItemId ?? null,
          nowIso(),
          item.kind,
          rec ? rec.statementLineId : item.statementLineId,
          item.installmentNumber,
          item.installmentAmount,
          item.firstPeriod,
          item.reference,
        ],
      )[0]
      if (!row) throw new Error('INSERT import_items RETURNING produced no row')
      ids.push(asNumber(row.id))
      if (rec) sum.reconciled++
      else sum.added++
    }
    return { ids, sum }
  }

  // reconcile mirrors the Go helper: what already accounts for the item — the
  // statement payment line of a cartola card payment, or the other-family
  // sighting of the same purchase. null = nothing (the item stays pendiente).
  function reconcile(item: StagedItem): { matchedItemId: number | null; statementLineId: number | null } | null {
    if (item.hint === HintCardPayment) {
      const line = matchPaymentLine(item)
      return line ? { matchedItemId: null, statementLineId: line.id } : null
    }
    const match = findReconcileMatch(item)
    if (!match) return null
    // A statement knows the installment count an alert may not carry.
    if (item.installmentsTotal > 1 && match.installmentsTotal === 1) {
      db.exec('UPDATE import_items SET installments_total = ? WHERE id = ? AND user_id = ?', [
        item.installmentsTotal,
        match.id,
        uid(),
      ])
    }
    return { matchedItemId: match.id, statementLineId: item.statementLineId }
  }

  // ---------- card statement helpers ----------

  // insertReturning inserts a model-shaped record (camelCase fields → snake_case
  // columns) and returns the stored row.
  function insertReturning(table: string, values: Record<string, SqlValue>): SqlRow {
    const cols = Object.keys(values)
    const row = db.query(
      `INSERT INTO ${table} (${cols.map(snakeCase).join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) RETURNING *`,
      cols.map((c) => values[c] ?? null),
    )[0]
    if (!row) throw new Error(`INSERT ${table} RETURNING produced no row`)
    return row
  }

  // cardByDigits returns the user's one live card with those last digits, or null.
  function cardByDigits(digits: string): Card | null {
    const rows = db.query('SELECT * FROM cards WHERE user_id = ? AND last_digits = ? AND deleted_at IS NULL', [
      uid(),
      digits,
    ])
    const only = rows[0]
    return rows.length === 1 && only ? rowToCard(only) : null
  }

  // relinkStatements mirrors the Go helper: every statement points at the one
  // live card holding its last digits; with none, it keeps a trashed card it
  // already had and loses a live one whose digits changed.
  function relinkStatements(): void {
    const byDigits = cardsByLastDigits(listCardsActive())
    const live = new Set(listCardsActive().map((c) => c.id))
    for (const r of db.query('SELECT id, card_id, card_last_digits FROM card_statements WHERE user_id = ?', [uid()])) {
      const current = r.card_id == null ? null : asNumber(r.card_id)
      const match = byDigits.get(asString(r.card_last_digits))
      if (!match && current != null && !live.has(current)) continue
      const want = match?.id ?? null
      if (want === current) continue
      db.exec('UPDATE card_statements SET card_id = ? WHERE id = ? AND user_id = ?', [want, asNumber(r.id), uid()])
    }
  }

  // continuedInstallment finds the app installment a statement cuota bills: the
  // cuota number n of a live expense on the same card (when known) with the same
  // cuota count and amount, bought within reconcileWindowDays of the line.
  function continuedInstallment(card: Card | null, l: CardStatementLine): number | null {
    const params: SqlValue[] = [
      uid(),
      l.installmentsTotal,
      Money.fromString(l.installmentAmount).abs().toString(),
      l.operationDate,
      reconcileWindowDays,
    ]
    let cardFilter = ''
    if (card) {
      cardFilter = 'AND card_id = ?'
      params.push(card.id)
    }
    params.push(l.operationDate)
    const expenses = db.query(
      `SELECT id FROM expenses WHERE user_id = ? AND deleted_at IS NULL AND installments_total = ? AND installment_amount = ?
       AND ABS(julianday(substr(date, 1, 10)) - julianday(?)) <= ? ${cardFilter}
       ORDER BY ABS(julianday(substr(date, 1, 10)) - julianday(?)) ASC, id ASC`,
      params,
    )
    for (const ex of expenses) {
      const inst = db.query(
        `SELECT id FROM installments WHERE expense_id = ? AND user_id = ? AND number = ?
         AND id NOT IN (SELECT installment_id FROM card_statement_lines WHERE user_id = ? AND installment_id IS NOT NULL)`,
        [asNumber(ex.id), uid(), l.installmentNumber, uid()],
      )[0]
      if (inst) return asNumber(inst.id)
    }
    return null
  }

  // learnFxRate stores the CLP-per-USD rate implied by paying `usd` with `clp`.
  function learnFxRate(statementId: number, clp: Money, usd: Money): void {
    if (usd.isZero()) return
    db.exec('UPDATE card_statements SET fx_rate = ? WHERE id = ?', [clp.div(usd).round(4).toString(), statementId])
  }

  // latestFxRate is the most recent CLP-per-USD rate learned for the user, or ''.
  function latestFxRate(): string {
    const row = db.query(
      `SELECT fx_rate FROM card_statements WHERE user_id = ? AND fx_rate <> ''
       ORDER BY statement_date DESC, id DESC LIMIT 1`,
      [uid()],
    )[0]
    return row ? asString(row.fx_rate) : ''
  }

  // reconcilePaymentLine marks as conciliado the cartola card-payment item that
  // a statement payment line accounts for, and learns the USD rate from an
  // international one. Returns how many items it matched. A payment already
  // discarded (it is not an expense) still counts, as in Go.
  function reconcilePaymentLine(st: CardStatement, l: CardStatementLine): number {
    const paid = Money.fromString(l.installmentAmount).abs()
    const international = st.kind === StatementInternational
    const rows = db.query(
      `SELECT * FROM import_items WHERE user_id = ? AND status IN (?, ?) AND hint = ? AND statement_line_id IS NULL
       AND ABS(julianday(date) - julianday(?)) <= ?
       AND ${international ? 'description LIKE ?' : 'amount = ?'}
       ORDER BY ABS(julianday(date) - julianday(?)) ASC, id ASC`,
      [
        uid(),
        ImportPendiente,
        ImportDescartado,
        HintCardPayment,
        l.operationDate,
        paymentWindowDays,
        international ? '%INTER%' : paid.toString(),
        l.operationDate,
      ],
    )
    for (const r of rows) {
      const it = rowToImportItem(r)
      if (st.kind === StatementNational && isInternationalPayment(it.description)) continue
      db.exec('UPDATE import_items SET status = ?, statement_line_id = ? WHERE id = ? AND user_id = ?', [
        ImportConciliado,
        l.id,
        it.id,
        uid(),
      ])
      if (international) learnFxRate(st.id, Money.fromString(it.amount), paid)
      return 1
    }
    return 0
  }

  // matchPaymentLine is the other direction: a cartola card payment staged
  // after the statement that lists it.
  function matchPaymentLine(item: StagedItem): CardStatementLine | null {
    const international = isInternationalPayment(item.description)
    const params: SqlValue[] = [uid(), LinePayment, item.date, paymentWindowDays, uid()]
    let kindFilter = 'AND cs.kind = ?'
    if (international) {
      params.push(StatementInternational)
    } else {
      kindFilter += ' AND csl.installment_amount = ?'
      params.push(StatementNational, item.amount.neg().toString())
    }
    params.push(item.date)
    const row = db.query(
      `SELECT csl.* FROM card_statement_lines AS csl JOIN card_statements AS cs ON cs.id = csl.statement_id
       WHERE csl.user_id = ? AND csl.section = ?
       AND ABS(julianday(csl.operation_date) - julianday(?)) <= ?
       AND csl.id NOT IN (SELECT statement_line_id FROM import_items WHERE user_id = ? AND statement_line_id IS NOT NULL)
       ${kindFilter}
       ORDER BY ABS(julianday(csl.operation_date) - julianday(?)) ASC, csl.id ASC LIMIT 1`,
      params,
    )[0]
    if (!row) return null
    const line = rowToCardStatementLine(row)
    if (international) learnFxRate(line.statementId, item.amount, Money.fromString(line.installmentAmount).abs())
    return line
  }

  // feedInbox links, reconciles and stages the statement's lines (see
  // ImportCardStatement). Throws TxAbort on an invalid candidate.
  // earlierSighting mirrors the Go helper: the inbox item an earlier statement
  // of the same card and currency staged for this purchase (same operation
  // date, cuota count and operation number), or null.
  function earlierSighting(st: CardStatement, l: CardStatementLine): number | null {
    const op = operationNumber(l.reference)
    if (op === '') return null
    const prior = db
      .query(
        `SELECT * FROM card_statement_lines
         WHERE user_id = ? AND operation_date = ? AND installments_total = ?
         AND import_item_id IS NOT NULL AND section IN (${purchaseSections.map(() => '?').join(', ')})
         AND statement_id IN (SELECT id FROM card_statements WHERE user_id = ? AND card_last_digits = ? AND kind = ? AND id <> ?)
         ORDER BY id DESC`,
        [uid(), l.operationDate, l.installmentsTotal, ...purchaseSections, uid(), st.cardLastDigits, st.kind, st.id],
      )
      .map(rowToCardStatementLine)
    return prior.find((p) => operationNumber(p.reference) === op)?.importItemId ?? null
  }

  // ---------- merging a bank movement into a manual expense (mirror of merge.go) ----------

  // bankLinked: the expense already carries a bank movement (an item confirmed
  // into it, or a statement line billing one of its cuotas).
  function bankLinked(expenseId: number): boolean {
    if (db.query('SELECT 1 FROM import_items WHERE user_id = ? AND expense_id = ?', [uid(), expenseId]).length > 0) return true
    return (
      db.query(
        `SELECT 1 FROM card_statement_lines AS l JOIN installments AS i ON i.id = l.installment_id
         WHERE l.user_id = ? AND i.expense_id = ?`,
        [uid(), expenseId],
      ).length > 0
    )
  }

  // sameAmount: the expense's total equals the purchase total, or its cuota the bank's cuota.
  function sameAmount(ex: Expense, total: string, cuota: string): boolean {
    const q = Money.fromString(ex.installmentAmount)
    const t = amountOrError(total).amount
    if (t && (q.mulInt(Math.max(ex.installmentsTotal, 1)).cmp(t) === 0 || q.cmp(t) === 0)) return true
    const c = cuota !== '' ? amountOrError(cuota).amount : undefined
    return c !== undefined && q.cmp(c) === 0
  }

  // manualMatch: the one expense entered by hand for this purchase, on the
  // statement's card, within mergeWindowDays, same amount; null when there is
  // none, more than one, or the card is unknown.
  function manualMatch(card: Card | null, c: ImportCandidate, skip: ReadonlySet<number>): Expense | null {
    if (!card) return null
    const cands = db
      .query(
        `SELECT * FROM expenses WHERE user_id = ? AND deleted_at IS NULL AND card_id = ? AND date >= ? AND date < ?
         AND id NOT IN (SELECT expense_id FROM import_items WHERE user_id = ? AND expense_id IS NOT NULL)
         AND id NOT IN (SELECT i.expense_id FROM card_statement_lines AS l
           JOIN installments AS i ON i.id = l.installment_id WHERE l.user_id = ?)
         ORDER BY id ASC`,
        [uid(), card.id, shiftDay(c.date, -mergeWindowDays), shiftDay(c.date, mergeWindowDays + 1), uid(), uid()],
      )
      .map(rowToExpense)
      .filter((ex) => !skip.has(ex.id) && sameAmount(ex, c.amount, c.installmentAmount ?? ''))
    return cands.length === 1 ? (cands[0] ?? null) : null
  }

  // replannable mirrors Go: no paid cuota past the new total, and none moved.
  function replannable(insts: Installment[], total: number, first: string): boolean {
    const lastPaid = Math.max(0, ...insts.filter((i) => i.status === StatusPagado).map((i) => i.number))
    return lastPaid === 0 || (lastPaid <= total && insts[0]?.period === first)
  }

  // mergeIntoExpense mirrors Go: the bank's date, amount and billing month, the
  // user's words; paid cuotas never move. Confirms the item into the expense.
  function mergeIntoExpense(item: ImportItem, ex: Expense, cutoff: CardCutoff): void {
    const date = parseDate(item.date)
    if (!date) throw new Error('item date: ' + item.date)
    let kind = ex.kind
    let amount = Money.fromString(ex.installmentAmount)
    let total = ex.installmentsTotal
    let bankPlan = item.currency === 'CLP' // a USD item's amount is not the expense's pesos
    if (bankPlan) {
      const n = Math.max(item.installmentsTotal, 1)
      const cuota = item.installmentAmount !== '' ? amountOrError(item.installmentAmount).amount : undefined
      if (cuota) [amount, total] = [cuota, n]
      else if (n === 1) [amount, total] = [Money.fromString(item.amount), 1]
      if (cuota || n === 1) kind = total > 1 ? KindCuotas : KindUnico
    }
    const insts = db
      .query('SELECT * FROM installments WHERE expense_id = ? AND user_id = ? ORDER BY number ASC', [ex.id, uid()])
      .map(rowToInstallment)
    let first = item.firstPeriod
    if (first === '' || total !== item.installmentsTotal) first = cutoffPeriodOf(cutoff, date.parts)
    let placement: PlacementChange = { before: '', after: first } // the bank's month wins
    if (!replannable(insts, total, first)) {
      kind = ex.kind
      amount = Money.fromString(ex.installmentAmount)
      total = ex.installmentsTotal
      bankPlan = false
      first = insts[0]?.period ?? first
      placement = { before: first, after: first } // the plan stays exactly as the user has it
    }
    db.exec(
      `UPDATE expenses SET date = ?, bank_description = ?, kind = ?, installment_amount = ?, installments_total = ?
       WHERE id = ? AND user_id = ?`,
      [date.iso, item.description, kind, amount.toString(), total, ex.id, uid()],
    )
    const merged: ValidatedExpense = {
      date, description: ex.description, category: ex.category, merchant: ex.merchant, cardId: ex.cardId,
      kind, installmentAmount: amount, installmentsTotal: total,
    }
    const refused = replanInstallments(ex.id, merged, placement, bankPlan)
    if (refused) throw new TxAbort(refused)
    if (bankPlan && bankRounded(item, total, amount)) settleLastCuota(ex.id, Money.fromString(item.amount))
    // The statement's cuota n means cuotas 1..n-1 were already billed.
    if (bankPlan && item.firstPeriod !== '' && item.installmentNumber > 1) {
      db.exec(
        'UPDATE installments SET status = ?, paid_at = ? WHERE expense_id = ? AND user_id = ? AND number < ? AND status = ?',
        [StatusPagado, nowIso(), ex.id, uid(), item.installmentNumber, StatusPendiente],
      )
    }
    db.exec('UPDATE import_items SET status = ?, expense_id = ? WHERE id = ? AND user_id = ?', [
      ImportConfirmado,
      ex.id,
      item.id,
      uid(),
    ])
  }

  // bankRounded mirrors Go: the expense follows a CLP bank item's own plan
  // (same cuota count and cuota), so the item's amount is the plan's total.
  function bankRounded(item: ImportItem, total: number, cuota: Money): boolean {
    if (item.currency !== 'CLP' || item.installmentAmount === '' || total < 2 || total !== item.installmentsTotal) {
      return false
    }
    const bank = amountOrError(item.installmentAmount).amount
    return bank !== undefined && bank.cmp(cuota) === 0
  }

  // expenseCost mirrors Go: what an expense really costs, the sum of its cuotas
  // (not cuota × N once the bank rounded the last one or one was set by hand).
  function expenseCost(expenseId: number): Money {
    return sumAmounts('SELECT amount FROM installments WHERE expense_id = ? AND user_id = ?', [expenseId, uid()])
  }

  // settleLastCuota mirrors Go: the pending last cuota takes the bank's
  // rounding so the plan adds up to its purchase total.
  function settleLastCuota(expenseId: number, total: Money): void {
    const insts = db
      .query('SELECT * FROM installments WHERE expense_id = ? AND user_id = ? ORDER BY number ASC', [expenseId, uid()])
      .map(rowToInstallment)
    const last = insts.at(-1)
    if (insts.length < 2 || !last) return
    const others = insts.slice(0, -1).reduce((acc, i) => acc.add(Money.fromString(i.amount)), Money.zero())
    const want = total.sub(others)
    if (last.status === StatusPagado || !want.gt(Money.zero()) || want.cmp(Money.fromString(last.amount)) === 0) return
    db.exec('UPDATE installments SET amount = ? WHERE id = ? AND user_id = ?', [want.toString(), last.id, uid()])
  }

  // validAccount mirrors Go: a named account of a known kind with a valid
  // opening balance (may be negative) and month.
  function validAccount(
    name: string,
    kind: string,
    opening: string,
    openingPeriod: string,
  ): { name: string; balance: string; error?: ReturnType<typeof newError> } {
    const n = name.trim()
    if (n === '') return { name: '', balance: '', error: newError(ErrValidation, 'el nombre es obligatorio') }
    if (!ACCOUNT_KINDS.includes(kind)) {
      return { name: '', balance: '', error: newError(ErrValidation, 'tipo de cuenta inválido: ' + kind) }
    }
    if (!validPeriod(openingPeriod)) return { name: '', balance: '', error: invalidPeriodError() }
    try {
      return { name: n, balance: Money.fromString(opening.trim()).toString() }
    } catch {
      return { name: '', balance: '', error: newError(ErrValidation, 'saldo inicial inválido: ' + opening) }
    }
  }

  // keepOneSalaryAccount mirrors Go: the salary lands in one account only.
  function keepOneSalaryAccount(acc: Account): void {
    if (acc.receivesSalary) db.exec('UPDATE accounts SET receives_salary = 0 WHERE user_id = ? AND id <> ?', [uid(), acc.id])
  }

  // keepSalaryRestSource mirrors Go: saving account `id` (0 = a new one) is
  // refused when a live salary_rest transfer (open-ended, or ending this month
  // or later) would leave from an account the salary no longer lands in.
  function keepSalaryRestSource(id: number, receivesSalary: boolean): ReturnType<typeof newError> | undefined {
    let salaryAcc = id
    if (!receivesSalary) {
      const other = db.query('SELECT id FROM accounts WHERE user_id = ? AND receives_salary = 1 AND id <> ?', [uid(), id])[0]
      salaryAcc = other ? asNumber(other.id) : 0
    }
    const stranded = db.query(
      `SELECT description FROM transfers WHERE user_id = ? AND mode = ? AND from_account_id <> ?
       AND (end_period = '' OR end_period >= ?) LIMIT 1`,
      [uid(), TransferSalaryRest, salaryAcc, currentPeriod()],
    )[0]
    if (!stranded) return undefined
    const label = asString(stranded.description) || 'resto del sueldo'
    return newError(
      ErrConflict,
      `la transferencia «${label}» pasa el resto del sueldo desde otra cuenta: termínala antes de cambiar dónde cae el sueldo`,
    )
  }

  // ownAccounts mirrors Go: both ends of a transfer are the profile's accounts.
  function ownAccounts(from: number, to: number, mode: string): ReturnType<typeof newError> | undefined {
    for (const id of [from, to]) {
      if (db.query('SELECT 1 FROM accounts WHERE id = ? AND user_id = ?', [id, uid()]).length === 0) {
        return newError(ErrNotFound, 'cuenta no encontrada')
      }
    }
    if (mode !== TransferSalaryRest) return undefined
    if (db.query('SELECT 1 FROM accounts WHERE id = ? AND user_id = ? AND receives_salary = 1', [from, uid()]).length === 0) {
      return newError(ErrValidation, 'para pasar el resto del sueldo, la cuenta de origen debe ser la que recibe el sueldo')
    }
    return undefined
  }

  // accountStart mirrors Go: an account's balance at `period` starts from its
  // latest reconciliation before it (from the month after) or its opening; a
  // reconciliation before the opening is ignored. `here` is `period`'s own.
  function accountStart(
    a: Account,
    recs: readonly { period: string; balance: string }[],
    period: string,
  ): { from: string; balance: Money; here: Money | null } {
    let from = a.openingPeriod
    let balance = Money.fromString(a.openingBalance)
    let here: Money | null = null
    for (const r of recs) {
      if (r.period < a.openingPeriod) continue
      if (r.period < period) {
        from = addMonths(r.period, 1)
        balance = Money.fromString(r.balance)
      } else if (r.period === period) {
        here = Money.fromString(r.balance)
      }
    }
    return { from, balance, here }
  }

  // setAccountOf mirrors Go: names the account (null = none) of one row.
  function setAccountOf(table: string, id: number, accountID: number | null, notFound: string): OpResult {
    if (accountID !== null && db.query('SELECT 1 FROM accounts WHERE id = ? AND user_id = ?', [accountID, uid()]).length === 0) {
      return { error: newError(ErrNotFound, 'cuenta no encontrada') }
    }
    db.exec(`UPDATE ${table} SET account_id = ? WHERE id = ? AND user_id = ?`, [accountID, id, uid()])
    if (db.changes() === 0) return { error: newError(ErrNotFound, notFound) }
    return {}
  }

  // accountFlows mirrors Go: per account (0 = none) and month in [from, to],
  // what came in and went out, and what moved to or from another own account.
  function accountFlows(accs: Account[], from: string, to: string): Map<number, Map<string, AccountFlow>> {
    const out = new Map<number, Map<string, AccountFlow>>()
    const flow = (acc: number, period: string): AccountFlow => {
      const byPeriod = out.get(acc) ?? new Map<string, AccountFlow>()
      out.set(acc, byPeriod)
      return byPeriod.get(period) ?? { in: Money.zero(), out: Money.zero(), tin: Money.zero(), tout: Money.zero() }
    }
    const add = (acc: number, period: string, inAmt: Money, outAmt: Money) => {
      const f = flow(acc, period)
      out.get(acc)!.set(period, { ...f, in: f.in.add(inAmt), out: f.out.add(outAmt) })
    }
    const move = (fromAcc: number, toAcc: number, period: string, amt: Money) => {
      const f = flow(fromAcc, period)
      out.get(fromAcc)!.set(period, { ...f, tout: f.tout.add(amt) })
      const g = flow(toAcc, period)
      out.get(toAcc)!.set(period, { ...g, tin: g.tin.add(amt) })
    }
    const salaryAcc = accs.find((a) => a.receivesSalary)?.id ?? 0
    const accOf = (r: SqlRow) => (r.account == null ? 0 : asNumber(r.account))
    const money = (r: SqlRow) => Money.fromString(asString(r.amount))
    const salaryOf = new Map<string, Money>() // a salary_rest transfer follows it
    for (const r of db.query('SELECT period, amount FROM period_salaries WHERE user_id = ? AND period >= ? AND period <= ?', [
      uid(),
      from,
      to,
    ])) {
      add(salaryAcc, asString(r.period), money(r), Money.zero())
      salaryOf.set(asString(r.period), money(r))
    }
    for (const r of db.query(
      `SELECT period, amount, account_id AS account FROM incomes
       WHERE user_id = ? AND deleted_at IS NULL AND period >= ? AND period <= ?`,
      [uid(), from, to],
    )) {
      add(accOf(r), asString(r.period), money(r), Money.zero())
    }
    for (const r of db.query(
      `SELECT inst.period AS period, inst.amount AS amount, COALESCE(ex.account_id, c.account_id) AS account
       FROM installments AS inst JOIN expenses AS ex ON ex.id = inst.expense_id AND ex.deleted_at IS NULL
       LEFT JOIN cards AS c ON c.id = ex.card_id
       WHERE inst.user_id = ? AND inst.period >= ? AND inst.period <= ?`,
      [uid(), from, to],
    )) {
      add(accOf(r), asString(r.period), Money.zero(), money(r))
    }
    for (const r of db.query(
      `SELECT rf.period AS period, rf.amount AS amount, COALESCE(ex.account_id, c.account_id) AS account
       FROM refunds AS rf JOIN expenses AS ex ON ex.id = rf.expense_id AND ex.deleted_at IS NULL
       LEFT JOIN cards AS c ON c.id = ex.card_id
       WHERE rf.user_id = ? AND rf.period >= ? AND rf.period <= ?`,
      [uid(), from, to],
    )) {
      add(accOf(r), asString(r.period), Money.zero(), Money.zero().sub(money(r)))
    }
    const cardAcc = new Map<number, number>()
    for (const c of db.query('SELECT id, account_id FROM cards WHERE user_id = ?', [uid()])) {
      if (c.account_id != null) cardAcc.set(asNumber(c.id), asNumber(c.account_id))
    }
    const { fixed, amountsByID, uf } = loadFixed(false)
    const transfers = db.query('SELECT * FROM transfers WHERE user_id = ?', [uid()]).map(rowToTransfer)
    for (let m = from; m <= to; m = addMonths(m, 1)) {
      for (const fe of fixed) {
        if (!billsIn(fe, m)) continue
        // Its own account wins over its card's (mirrors Go).
        const acc = fe.accountId ?? (fe.cardId != null ? (cardAcc.get(fe.cardId) ?? 0) : 0)
        add(acc, m, Money.zero(), fixedCharge(fe, amountsByID.get(fe.id) ?? [], uf, m).clp)
      }
      for (const t of transfers) {
        if (transferActiveIn(t, m)) move(t.fromAccountId, t.toAccountId, m, transferMoved(t, salaryOf.get(m) ?? Money.zero()))
      }
    }
    return out
  }

  // recordItemCurrency mirrors Go: a confirmed foreign item keeps its original
  // total and the rate the user's pesos imply (4 decimals) on its expense.
  function recordItemCurrency(item: ImportItem, expenseId: number, pesos: Money): void {
    if (item.currency === '' || item.currency === 'CLP') return
    const original = Money.fromString(item.amount)
    if (!original.gt(Money.zero())) return
    db.exec('UPDATE expenses SET currency = ?, original_amount = ?, fx_rate = ? WHERE id = ? AND user_id = ?', [
      item.currency,
      original.toString(),
      pesos.div(original).round(4).toString(),
      expenseId,
      uid(),
    ])
  }

  // pendingCuotaOf mirrors Go: a pending cuota of a live expense of the profile.
  function pendingCuotaOf(id: number): { error?: ReturnType<typeof newError> } {
    const row = db.query(
      `SELECT * FROM installments WHERE id = ? AND user_id = ?
       AND expense_id IN (SELECT id FROM expenses WHERE user_id = ? AND deleted_at IS NULL)`,
      [id, uid(), uid()],
    )[0]
    if (!row) return { error: newError(ErrNotFound, 'cuota no encontrada') }
    if (rowToInstallment(row).status === StatusPagado) {
      return { error: newError(ErrValidation, 'la cuota ya está pagada: desmárcala para cambiarla') }
    }
    return {}
  }

  // cutoffOfExpense: the cutoff of the expense's card (trashed included), or none.
  function cutoffOfExpense(ex: Expense): CardCutoff {
    return ex.cardId == null ? NO_CUTOFF : (cutoffsFor(ex.cardId).get(ex.cardId) ?? NO_CUTOFF)
  }

  // placePurchase mirrors Go: done when the line continues a plan the app has
  // from the bank or an earlier statement staged it; otherwise the manual
  // expense its item will complete (null = none).
  function placePurchase(
    st: CardStatement,
    card: Card | null,
    l: CardStatementLine,
    claimed: ReadonlySet<number>,
    out: CardStatementImport,
  ): { done: boolean; target: number | null } {
    let instId = l.section === LineDeferred ? null : continuedInstallment(card, l)
    let expenseId: number | null = null
    let linked = false
    if (instId != null) {
      expenseId = asNumber(db.query('SELECT expense_id FROM installments WHERE id = ?', [instId])[0]?.expense_id)
      // Asked before linking this line, which would make it look linked.
      linked = bankLinked(expenseId)
      // An expense entered by hand is completed only on its own card.
      if (!linked && card == null) instId = null
    }
    if (instId != null && expenseId != null) {
      db.exec('UPDATE card_statement_lines SET installment_id = ? WHERE id = ?', [instId, l.id])
      if (linked || claimed.has(expenseId)) {
        out.linkedInstallments++
        return { done: true, target: null }
      }
      return { done: false, target: expenseId } // a cuota of an expense entered by hand
    }
    const itemId = earlierSighting(st, l)
    if (itemId != null) {
      db.exec('UPDATE card_statement_lines SET import_item_id = ? WHERE id = ?', [itemId, l.id])
      out.duplicates++
      return { done: true, target: null }
    }
    return { done: false, target: manualMatch(card, lineCandidate(st, l), claimed)?.id ?? null }
  }

  // mergeStaged mirrors Go: completes the manual expense with the item just
  // staged for it, unless staging reconciled the item with another sighting.
  function mergeStaged(itemId: number, expenseId: number): boolean {
    const row = db.query('SELECT * FROM import_items WHERE id = ? AND user_id = ?', [itemId, uid()])[0]
    if (!row) throw new Error('staged item not found')
    const item = rowToImportItem(row)
    if (item.status !== ImportPendiente) return false
    const exRow = db.query('SELECT * FROM expenses WHERE id = ? AND user_id = ?', [expenseId, uid()])[0]
    if (!exRow) throw new Error('manual expense not found')
    const ex = rowToExpense(exRow)
    mergeIntoExpense(item, ex, cutoffOfExpense(ex))
    return true
  }

  function feedInbox(st: CardStatement, card: Card | null, lines: CardStatementLine[], out: CardStatementImport): void {
    const candidates: ImportCandidate[] = []
    const staged: CardStatementLine[] = []
    const mergeInto = new Map<number, number>() // candidate index → the manual expense it completes
    const claimed = new Set<number>() // manual expenses already taken by a line of this statement
    for (const l of lines) {
      if (l.section === LinePayment) {
        out.paymentsMatched += reconcilePaymentLine(st, l)
        continue
      }
      if (purchaseSections.includes(l.section)) {
        const { done, target } = placePurchase(st, card, l, claimed, out)
        if (done) continue
        if (target != null) {
          claimed.add(target)
          mergeInto.set(candidates.length, target)
        }
      }
      candidates.push(lineCandidate(st, l))
      staged.push(l)
    }
    if (candidates.length === 0) return
    const v = validateBatch({ source: ImportSourcePDFCard, issuer: st.issuer, items: candidates })
    if (v.error || !v.items) throw new TxAbort(v.error ?? newError(ErrValidation, 'lote inválido'))
    const items = v.items.map((it, k) => ({ ...it, statementLineId: staged[k]?.id ?? null }))
    const { ids, sum } = stageItems(items)
    // += keeps the purchases already recognized from earlier statements.
    out.added += sum.added
    out.duplicates += sum.duplicates
    out.reconciled += sum.reconciled
    ids.forEach((id, k) => {
      db.exec('UPDATE card_statement_lines SET import_item_id = ? WHERE id = ?', [id, staged[k]?.id ?? null])
    })
    for (const [k, expenseId] of mergeInto) {
      const id = ids[k]
      if (id != null && mergeStaged(id, expenseId)) {
        out.added--
        out.merged++
      }
    }
  }

  // statementView adds the bank-vs-app comparison. bankCharges is what the app
  // should have as expenses on the card for the period (purchases, products and
  // charges billed this month); credits are income, payments move money.
  // StatementsContext mirrors Go's statementsContext: what statementView needs
  // beyond the statement, loaded once for a whole list.
  interface StatementsContext {
    cardByID: Map<number, Card>
    lines: Map<number, CardStatementLine[]> // statement id → lines
    pending: Map<number, number> // statement id → pending inbox items
    appByPeriod: Map<string, Map<number, Money>> // period → card → app charges (lazy)
  }

  // statementsContext loads every listed statement's lines and pending counts in
  // two queries, instead of two per statement.
  function statementsContext(sts: CardStatement[]): StatementsContext {
    const ctx: StatementsContext = { cardByID: cardMapAll(), lines: new Map(), pending: new Map(), appByPeriod: new Map() }
    if (sts.length === 0) return ctx
    const ids: SqlValue[] = sts.map((st) => st.id)
    const placeholders = ids.map(() => '?').join(', ')
    for (const r of db.query(
      `SELECT * FROM card_statement_lines WHERE user_id = ? AND statement_id IN (${placeholders})`,
      [uid(), ...ids],
    )) {
      const l = rowToCardStatementLine(r)
      const list = ctx.lines.get(l.statementId)
      if (list) list.push(l)
      else ctx.lines.set(l.statementId, [l])
    }
    for (const r of db.query(
      `SELECT csl.statement_id, COUNT(*) AS n FROM import_items AS ii
       JOIN card_statement_lines AS csl ON csl.id = ii.statement_line_id
       WHERE ii.user_id = ? AND ii.status = ? AND csl.statement_id IN (${placeholders})
       GROUP BY csl.statement_id`,
      [uid(), ImportPendiente, ...ids],
    )) {
      ctx.pending.set(asNumber(r.statement_id), asNumber(r.n))
    }
    return ctx
  }

  function statementView(st: CardStatement, sc: StatementsContext): CardStatementView {
    let bankCharges = Money.zero()
    let bankCredits = Money.zero()
    for (const l of sc.lines.get(st.id) ?? []) {
      const amount = Money.fromString(l.installmentAmount)
      if (l.section === LinePurchase || l.section === LineVoluntary || l.section === LineCharge) {
        bankCharges = bankCharges.add(amount)
      } else if (l.section === LineCredit) {
        bankCredits = bankCredits.add(amount.abs())
      }
    }
    const v: CardStatementView = {
      ...st,
      cardName: '',
      bankCharges: bankCharges.toString(),
      bankCredits: bankCredits.toString(),
      appCharges: null,
      pendingItems: sc.pending.get(st.id) ?? 0,
    }
    if (st.cardId == null) return v
    const card = sc.cardByID.get(st.cardId)
    v.cardName = card?.name ?? ''
    if (st.currency !== 'CLP') return v // the app keeps CLP only: USD lines are compared in the inbox
    let byCard = sc.appByPeriod.get(st.period)
    if (!byCard) {
      byCard = cardChargesIn(st.period)
      sc.appByPeriod.set(st.period, byCard)
    }
    // MonthlySummary's per-card totals cover live cards only, as in Go.
    v.appCharges = (card && card.deletedAt == null ? (byCard.get(st.cardId) ?? Money.zero()) : Money.zero()).toString()
    return v
  }

  // cardChargesIn mirrors the Go helper: what the app bills to each card in
  // `period` (live cuotas + fixed expenses), without a whole MonthlySummary.
  function cardChargesIn(period: string): Map<number, Money> {
    const out = new Map<number, Money>()
    const add = (cardId: number, amount: Money) => out.set(cardId, (out.get(cardId) ?? Money.zero()).add(amount))
    for (const r of db.query(
      `SELECT e.card_id, i.amount FROM installments AS i JOIN expenses AS e ON e.id = i.expense_id
       WHERE i.user_id = ? AND i.period = ? AND e.deleted_at IS NULL AND e.card_id IS NOT NULL`,
      [uid(), period],
    )) {
      add(asNumber(r.card_id), Money.fromString(asString(r.amount)))
    }
    for (const mv of fixedChargesFor(period)) {
      if (mv.cardId != null) add(mv.cardId, Money.fromString(mv.amount))
    }
    // A refund to a card is a credit on its statement.
    for (const r of refundsIn(period, period)) {
      if (r.cardId != null) add(r.cardId, Money.zero().sub(r.amount))
    }
    return out
  }

  // lineView says what became of a line: the app expense its cuota continues,
  // its inbox item's status, and for a points redemption the purchase it pays.
  function lineView(l: CardStatementLine, all: CardStatementLine[]): CardStatementLineView {
    const v: CardStatementLineView = { ...l, itemStatus: '', expenseId: null, expenseDescription: '', redeemedPurchase: '' }
    let expenseId: number | null = null
    if (l.installmentId != null) {
      const inst = db.query('SELECT expense_id FROM installments WHERE id = ? AND user_id = ?', [l.installmentId, uid()])[0]
      if (inst) expenseId = asNumber(inst.expense_id)
    }
    if (l.importItemId != null) {
      const row = db.query('SELECT * FROM import_items WHERE id = ? AND user_id = ?', [l.importItemId, uid()])[0]
      if (row) {
        const it = rowToImportItem(row)
        v.itemStatus = it.status
        if (it.expenseId != null) expenseId = it.expenseId
      }
    }
    if (expenseId != null) {
      const row = db.query('SELECT * FROM expenses WHERE id = ? AND user_id = ? AND deleted_at IS NULL', [expenseId, uid()])[0]
      if (row) {
        const ex = rowToExpense(row)
        v.expenseId = ex.id
        v.expenseDescription = ex.description
      }
    }
    if (l.section === LineCredit) {
      const credit = Money.fromString(l.installmentAmount).abs()
      const redeemed = all.find((p) => p.section === LinePurchase && Money.fromString(p.installmentAmount).cmp(credit) === 0)
      if (redeemed) v.redeemedPurchase = redeemed.description
    }
    return v
  }

  interface LoadedFixed {
    fixed: FixedExpense[]
    amountsByID: Map<number, FixedExpenseAmountRow[]>
    uf: UFRates
  }

  // loadUF reads the stored UF values (public data: no user_id).
  function loadUF(): UFRates {
    const values = new Map<string, Money>()
    for (const r of db.query('SELECT period, value FROM uf_values', [])) {
      values.set(asString(r.period), Money.fromString(asString(r.value)))
    }
    return new UFRates(values)
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
    return { fixed, amountsByID, uf: loadUF() }
  }

  // fixedSuggester mirrors Go's fixedIndex.suggest: the live fixed expense whose
  // still-unpaid month the item most likely bills — same name, amount within
  // the tolerance (closest wins), same card when both name one.
  function fixedSuggester(): (it: ImportItem, period: string, cardId: number | null, clp: Money | null) => FixedExpense | null {
    const { fixed, amountsByID, uf } = loadFixed(false)
    const paid = new Set<string>()
    if (fixed.length > 0) {
      const placeholders = fixed.map(() => '?').join(', ')
      const ids: SqlValue[] = fixed.map((fe) => fe.id)
      for (const r of db.query(
        `SELECT fixed_expense_id, period FROM fixed_expense_payments WHERE fixed_expense_id IN (${placeholders})`,
        ids,
      )) {
        paid.add(`${asNumber(r.fixed_expense_id)}|${asString(r.period)}`)
      }
    }
    return (it, period, cardId, clp) => {
      if (period === '' || clp === null || clp.isZero()) return null
      let best: FixedExpense | null = null
      let bestGap: Money | null = null
      for (const fe of fixed) {
        if (!billsIn(fe, period) || paid.has(`${fe.id}|${period}`)) continue
        if (fe.cardId != null && cardId != null && fe.cardId !== cardId) continue
        if (!namesMatch(fe.description, it.description)) continue
        const gap = amountGap(clp, fixedCharge(fe, amountsByID.get(fe.id) ?? [], uf, period).clp)
        if (gap === null) continue
        if (bestGap === null || gap.cmp(bestGap) < 0) {
          best = fe
          bestGap = gap
        }
      }
      return best
    }
  }

  // paidFixedMonths is `${fixedId}|${period}` for every paid month of the
  // given fixed expenses.
  function paidFixedMonths(fixed: readonly FixedExpense[]): Set<string> {
    const paid = new Set<string>()
    if (fixed.length === 0) return paid
    const placeholders = fixed.map(() => '?').join(', ')
    for (const r of db.query(
      `SELECT fixed_expense_id, period FROM fixed_expense_payments WHERE fixed_expense_id IN (${placeholders})`,
      fixed.map((fe) => fe.id),
    )) {
      paid.add(`${asNumber(r.fixed_expense_id)}|${asString(r.period)}`)
    }
    return paid
  }

  // upcomingDues mirrors Go: unpaid card statements and fixed expenses with a
  // due day whose due date falls in [from, to], soonest first.
  function upcomingDues(today: string, from: string, to: string): Due[] {
    const cardDue = new Map<string, { card: number; period: string; date: string }>()
    for (const r of db.query(
      `SELECT card_id, period, due_date FROM card_statements
        WHERE user_id = ? AND card_id IS NOT NULL AND due_date BETWEEN ? AND ?`,
      [uid(), from, to],
    )) {
      const card = asNumber(r.card_id)
      const period = asString(r.period)
      const date = asString(r.due_date)
      const key = `${card}|${period}`
      const seen = cardDue.get(key)
      // A card's national and international statements are paid together.
      if (!seen || date < seen.date) cardDue.set(key, { card, period, date })
    }

    const periods = monthsSpanned(from, to)
    for (const { period } of cardDue.values()) if (!periods.includes(period)) periods.push(period)
    const { fixed, amountsByID, uf } = loadFixed(false)
    const paid = paidFixedMonths(fixed)

    const pendingByCard = new Map<string, Money>()
    const addPending = (key: string, amount: Money) =>
      pendingByCard.set(key, (pendingByCard.get(key) ?? Money.zero()).add(amount))
    if (cardDue.size > 0) {
      const placeholders = periods.map(() => '?').join(', ')
      for (const r of db.query(
        `SELECT e.card_id AS card_id, i.period AS period, i.amount AS amount
           FROM installments i JOIN expenses e ON e.id = i.expense_id
          WHERE i.user_id = ? AND i.status = ? AND e.deleted_at IS NULL AND e.card_id IS NOT NULL
            AND i.period IN (${placeholders})`,
        [uid(), StatusPendiente, ...periods],
      )) {
        addPending(`${asNumber(r.card_id)}|${asString(r.period)}`, Money.fromString(asString(r.amount)))
      }
    }

    const dues: Due[] = []
    for (const fe of fixed) {
      for (const p of periods) {
        if (!billsIn(fe, p) || paid.has(`${fe.id}|${p}`)) continue
        const clp = fixedCharge(fe, amountsByID.get(fe.id) ?? [], uf, p).clp
        if (fe.cardId != null) {
          const key = `${fe.cardId}|${p}`
          if (cardDue.has(key)) addPending(key, clp)
          continue
        }
        if (fe.dueDay == null) continue
        const date = dayOfMonth(p, fe.dueDay)
        if (date < from || date > to) continue
        dues.push({
          kind: DueFixed,
          refId: fe.id,
          label: fe.description,
          period: p,
          dueDate: date,
          amount: clp.toString(),
          overdue: date < today,
        })
      }
    }

    if (cardDue.size > 0) {
      const cards = cardMapAll()
      for (const [key, { card, period, date }] of cardDue) {
        const owed = pendingByCard.get(key)
        const c = cards.get(card)
        if (!c || !owed || !owed.gt(Money.zero())) continue // paid (or nothing recorded)
        dues.push({
          kind: DueCard,
          refId: card,
          label: c.name,
          period,
          dueDate: date,
          amount: owed.toString(),
          overdue: date < today,
        })
      }
    }

    return dues.sort(
      (a, b) =>
        (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0) ||
        (a.label < b.label ? -1 : a.label > b.label ? 1 : 0) ||
        a.refId - b.refId,
    )
  }

  // reopenableIds mirrors Go's reopenableItems: confirmed items whose every
  // target (expense, income, fixed expense) is in the trash or gone.
  function reopenableIds(): Set<number> {
    const rows = db.query(
      `SELECT ii.id FROM import_items AS ii
       LEFT JOIN expenses AS e ON e.id = ii.expense_id
       LEFT JOIN incomes AS inc ON inc.id = ii.income_id
       LEFT JOIN fixed_expenses AS f ON f.id = ii.fixed_expense_id
       LEFT JOIN refunds AS rf ON rf.id = ii.refund_id
       LEFT JOIN expenses AS rfe ON rfe.id = rf.expense_id
       WHERE ii.user_id = ? AND ii.status = ?
         AND (e.id IS NULL OR e.deleted_at IS NOT NULL)
         AND (inc.id IS NULL OR inc.deleted_at IS NOT NULL)
         AND (f.id IS NULL OR f.deleted_at IS NOT NULL)
         AND (rf.id IS NULL OR rfe.deleted_at IS NOT NULL)`,
      [uid(), ImportConfirmado],
    )
    return new Set(rows.map((r) => asNumber(r.id)))
  }

  // insertRefund mirrors the Go helper (call inside a transaction): the expense
  // must be the profile's and live, and its refunds never exceed what it cost.
  function insertRefund(expenseID: number, period: string, amount: string, description: string): RefundResult {
    if (!validPeriod(period)) return { error: invalidPeriodError() }
    const parsed = amountOrError(amount)
    if (parsed.error || !parsed.amount) return { error: parsed.error ?? invalidAmountError(amount) }
    if (parsed.amount.isZero()) return { error: newError(ErrValidation, 'el reembolso debe ser mayor a 0') }
    const row = db.query('SELECT * FROM expenses WHERE id = ? AND user_id = ? AND deleted_at IS NULL', [expenseID, uid()])[0]
    if (!row) return { error: newError(ErrNotFound, 'gasto no encontrado') }
    const ex = rowToExpense(row)
    const refunded = sumAmounts('SELECT amount FROM refunds WHERE expense_id = ?', [expenseID])
    const total = expenseCost(expenseID)
    if (refunded.add(parsed.amount).gt(total)) {
      return {
        error: newError(ErrValidation, `el reembolso supera lo que queda por devolver de ese gasto (${total.sub(refunded).toString()})`),
      }
    }
    const desc = description.trim() !== '' ? description.trim() : 'Reembolso: ' + ex.description
    const inserted = db.query(
      `INSERT INTO refunds (user_id, expense_id, period, amount, description, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
      [uid(), expenseID, period, parsed.amount.toString(), desc, nowIso()],
    )[0]
    if (!inserted) throw new Error('INSERT refunds RETURNING produced no row')
    return { data: rowToRefund(inserted) }
  }

  // applyMonthAmount mirrors the Go helper: `amount` becomes the fixed
  // expense's amount for `period` alone (the next month keeps the plan).
  function applyMonthAmount(fe: FixedExpense, period: string, amount: Money): void {
    const rows = db
      .query('SELECT * FROM fixed_expense_amounts WHERE fixed_expense_id = ?', [fe.id])
      .map(rowToFixedExpenseAmount)
    const planned = resolveAsOf(rows, period)
    if (planned.cmp(amount) === 0) return
    const next = addMonths(period, 1)
    const upsert = (from: string, v: Money) =>
      db.exec(
        `INSERT INTO fixed_expense_amounts (fixed_expense_id, effective_from, amount) VALUES (?, ?, ?)
         ON CONFLICT (fixed_expense_id, effective_from) DO UPDATE SET amount = EXCLUDED.amount`,
        [fe.id, from, v.toString()],
      )
    if (!rows.some((r) => r.effectiveFrom === next) && (fe.endPeriod === '' || next <= fe.endPeriod)) {
      upsert(next, resolveAsOf(rows, next))
    }
    upsert(period, amount)
  }

  // fixedChargesFor builds the movimientos for fixed expenses billed in `period`.
  function fixedChargesFor(period: string): Movimiento[] {
    const { fixed, amountsByID, uf } = loadFixed(false)
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
      if (!billsIn(fe, period)) continue
      const charge = fixedCharge(fe, amountsByID.get(fe.id) ?? [], uf, period)
      out.push({
        source: SourceFijo,
        installmentId: 0,
        expenseId: 0,
        fixedId: fe.id,
        refundId: null,
        description: fe.description,
        bankDescription: '',
      currency: '',
      originalAmount: '',
        category: fe.category,
        merchant: '',
        cardId: fe.cardId,
        cardName: '',
        kind: SourceFijo,
        number: 1,
        total: 1,
        amount: charge.clp.toString(),
        status: paid.has(fe.id) ? StatusPagado : StatusPendiente,
        date: null,
        ufAmount: fe.currency === CurrencyUF ? charge.original.toString() : null,
        estimado: charge.estimated,
        tags: [],
        references: [],
      })
    }
    return out
  }

  // sumFixedBetween totals fixed-expense charges of the months strictly between
  // `after` ('' = from the start) and `before` (carry-forward of the running
  // balance); fixedTotal keeps monthly CLP independent of the months elapsed.
  function sumFixedBetween(after: string, before: string): Money {
    const { fixed, amountsByID, uf } = loadFixed(false)
    let total = Money.zero()
    const last = addMonths(before, -1)
    const first = after === '' ? '' : addMonths(after, 1)
    for (const fe of fixed) {
      if (!validPeriod(fe.startPeriod)) continue
      total = total.add(fixedTotal(fe, amountsByID.get(fe.id) ?? [], uf, first, last))
    }
    return total
  }

  // fixedDisplayPeriod is the month whose amount represents a fixed expense
  // "now": today, or its start when it is future-dated.
  function fixedDisplayPeriod(fe: FixedExpense, now: string): string {
    return fe.startPeriod > now ? fe.startPeriod : now
  }

  // ownFixedExpense returns the (non-deleted) fixed expense if it belongs to the
  // active user. The amount/payment tables carry no user_id of their own, so
  // every write to them must pass through this check first.
  function ownFixedExpense(id: number): FixedExpense | null {
    const row = db.query('SELECT * FROM fixed_expenses WHERE id = ? AND user_id = ? AND deleted_at IS NULL', [
      id,
      uid(),
    ])[0]
    return row ? rowToFixedExpense(row) : null
  }

  // requireActiveIn mirrors the Go helper: a payment or an amount change outside
  // [start, end] would never show up anywhere.
  function requireActiveIn(fe: FixedExpense, period: string, action: string): ReturnType<typeof newError> | null {
    if (period < fe.startPeriod) {
      return newError(ErrValidation, `no se puede ${action} en ${period}: el gasto fijo empieza en ${fe.startPeriod}`)
    }
    if (fe.endPeriod !== '' && period > fe.endPeriod) {
      return newError(ErrValidation, `no se puede ${action} en ${period}: el gasto fijo terminó en ${fe.endPeriod}`)
    }
    return null
  }

  // requireBillsIn mirrors the Go helper: a payment (or a linked bank charge)
  // in a month off the fixed expense's schedule would never show up.
  function requireBillsIn(fe: FixedExpense, period: string, action: string): ReturnType<typeof newError> | null {
    const outside = requireActiveIn(fe, period, action)
    if (outside) return outside
    if (!billsIn(fe, period)) {
      return newError(
        ErrValidation,
        `no se puede ${action} en ${period}: el gasto fijo cobra cada ${interval(fe)} meses (próximo: ${nextBilling(fe, period)})`,
      )
    }
    return null
  }

  // sumAmounts mirrors the Go helper: adds up the amount column of a query,
  // as decimals (never SQLite's float SUM over TEXT).
  function sumAmounts(sql: string, params: SqlValue[]): Money {
    let total = Money.zero()
    for (const r of db.query(sql, params)) total = total.add(Money.fromString(asString(r.amount)))
    return total
  }

  // ---------- tags (mirror backend/finance/tag.go) ----------

  // ensureTag returns the id of the profile's tag named `name` (any case),
  // creating it with that spelling when it does not exist.
  function ensureTag(name: string): number {
    const found = db.query('SELECT id FROM tags WHERE user_id = ? AND name_key = ?', [uid(), tagKey(name)])[0]
    if (found) return asNumber(found.id)
    const row = db.query('INSERT INTO tags (user_id, name, name_key, created_at) VALUES (?, ?, ?, ?) RETURNING id', [
      uid(),
      name,
      tagKey(name),
      nowIso(),
    ])[0]
    if (!row) throw new Error('INSERT tags RETURNING produced no row')
    return asNumber(row.id)
  }

  // tagsByExpense maps each of the given expenses to its tag names, sorted by key.
  function tagsByExpense(ids: readonly number[]): Map<number, string[]> {
    const out = new Map<number, string[]>()
    const unique = [...new Set(ids)]
    if (unique.length === 0) return out
    for (const r of db.query(
      `SELECT et.expense_id, tg.name FROM expense_tags AS et JOIN tags AS tg ON tg.id = et.tag_id
       WHERE tg.user_id = ? AND et.expense_id IN (${unique.map(() => '?').join(', ')})`,
      [uid(), ...unique],
    )) {
      const id = asNumber(r.expense_id)
      out.set(id, [...(out.get(id) ?? []), asString(r.name)])
    }
    for (const list of out.values()) list.sort((a, b) => compareStrings(tagKey(a), tagKey(b)))
    return out
  }

  // expenseReferencesSQL mirrors the Go query (reference.go): (expense_id,
  // reference) from the inbox item an expense was confirmed from, the statement
  // lines that billed its cuotas and the later lines that reported it again.
  // `cond` is a condition on the expense id column (ii.expense_id /
  // i.expense_id); every "?" is uid followed by that condition's arguments.
  function expenseReferencesSQL(condItem: string, condInst: string): string {
    return `
      SELECT ii.expense_id AS expense_id, ii.reference AS reference
        FROM import_items AS ii
        WHERE ii.user_id = ? AND ii.expense_id IS NOT NULL AND ii.reference <> '' AND ${condItem}
      UNION
      SELECT i.expense_id, l.reference
        FROM card_statement_lines AS l JOIN installments AS i ON i.id = l.installment_id
        WHERE l.user_id = ? AND i.user_id = l.user_id AND l.reference <> '' AND ${condInst}
      UNION
      SELECT ii.expense_id, l.reference
        FROM card_statement_lines AS l JOIN import_items AS ii ON ii.id = l.import_item_id
        WHERE l.user_id = ? AND ii.user_id = l.user_id AND ii.expense_id IS NOT NULL AND l.reference <> '' AND ${condItem}`
  }

  // referencesByExpense maps each of the given expenses to its reference codes, sorted.
  function referencesByExpense(ids: readonly number[]): Map<number, string[]> {
    const out = new Map<number, string[]>()
    const unique = [...new Set(ids)]
    if (unique.length === 0) return out
    const list = unique.map(() => '?').join(', ')
    const sql =
      expenseReferencesSQL(`ii.expense_id IN (${list})`, `i.expense_id IN (${list})`) +
      ' ORDER BY expense_id, reference'
    for (const r of db.query(sql, [uid(), ...unique, uid(), ...unique, uid(), ...unique])) {
      const id = asNumber(r.expense_id)
      out.set(id, [...(out.get(id) ?? []), asString(r.reference)])
    }
    return out
  }

  // ---------- refunds (mirror backend/finance/refund.go) ----------

  interface RefundRow {
    id: number
    expenseId: number
    period: string
    amount: Money
    description: string
    category: string
    merchant: string
    cardId: number | null
  }

  // refundsIn lists the live refunds (expense not in the trash) arrived in [from, to].
  function refundsIn(from: string, to: string): RefundRow[] {
    return db
      .query(
        `SELECT rf.id, rf.expense_id, rf.period, rf.amount, rf.description, e.category, e.merchant, e.card_id
         FROM refunds AS rf JOIN expenses AS e ON e.id = rf.expense_id
         WHERE rf.user_id = ? AND rf.period >= ? AND rf.period <= ? AND e.deleted_at IS NULL
         ORDER BY rf.id`,
        [uid(), from, to],
      )
      .map((r) => ({
        id: asNumber(r.id),
        expenseId: asNumber(r.expense_id),
        period: asString(r.period),
        amount: Money.fromString(asString(r.amount)),
        description: asString(r.description),
        category: asString(r.category),
        merchant: asString(r.merchant),
        cardId: r.card_id == null ? null : asNumber(r.card_id),
      }))
  }

  // refundsBetween sums the live refunds of the months strictly between `after` and `before`.
  function refundsBetween(after: string, before: string): Money {
    return sumAmounts(
      `SELECT amount FROM refunds WHERE user_id = ? AND period > ? AND period < ?
       AND expense_id IN (SELECT id FROM expenses WHERE deleted_at IS NULL)`,
      [uid(), after, before],
    )
  }

  // refundMovimiento: a negative, already-received charge in its expense's category and card.
  function refundMovimiento(r: RefundRow): Movimiento {
    return {
      source: SourceReembolso,
      installmentId: 0,
      expenseId: r.expenseId,
      fixedId: null,
      refundId: r.id,
      description: r.description,
      bankDescription: '',
      currency: '',
      originalAmount: '',
      category: r.category,
      merchant: r.merchant,
      cardId: r.cardId,
      cardName: '',
      kind: SourceReembolso,
      number: 1,
      total: 1,
      amount: Money.zero().sub(r.amount).toString(),
      status: StatusPagado,
      date: null,
      ufAmount: null,
      estimado: false,
      tags: [],
      references: [],
    }
  }

  // ---------- reconciliations (mirror backend/finance/reconciliation.go) ----------

  // reconciliationBefore is the latest reconciliation strictly before `period`.
  function reconciliationBefore(period: string): { period: string; amount: Money } | null {
    const row = db.query(
      'SELECT period, amount FROM reconciliations WHERE user_id = ? AND period < ? ORDER BY period DESC LIMIT 1',
      [uid(), period],
    )[0]
    return row ? { period: asString(row.period), amount: Money.fromString(asString(row.amount)) } : null
  }

  // reconciliationsIn maps each reconciled month in [from, to] to its real balance.
  function reconciliationsIn(from: string, to: string): Map<string, Money> {
    const out = new Map<string, Money>()
    for (const r of db.query('SELECT period, amount FROM reconciliations WHERE user_id = ? AND period >= ? AND period <= ?', [
      uid(),
      from,
      to,
    ])) {
      out.set(asString(r.period), Money.fromString(asString(r.amount)))
    }
    return out
  }

  // cumulativeBalanceBefore: the running balance carried into `period` and the
  // reconciled month it starts from ('' when none). Without a reconciliation it
  // is Σ salaries + Σ extras − Σ gastos − Σ ahorro of every earlier period; with
  // one, that month's real closing balance plus the same flows after it.
  function cumulativeBalanceBefore(period: string): { amount: Money; from: string } {
    const anchor = reconciliationBefore(period)
    // Every YYYY-MM sorts after '': with no anchor the bound reads the whole history.
    const after = anchor?.period ?? ''
    const base = anchor?.amount ?? Money.zero()
    return { amount: base.add(flowsBetween(after, period)), from: after }
  }

  // flowsBetween is the net of every month strictly between `after` and
  // `before`; it reads only amounts (it walks the whole history on every summary).
  function flowsBetween(after: string, before: string): Money {
    const user = uid()
    let total = sumAmounts('SELECT amount FROM period_salaries WHERE user_id = ? AND period > ? AND period < ?', [
      user,
      after,
      before,
    ])
    total = total.add(
      sumAmounts('SELECT amount FROM incomes WHERE user_id = ? AND period > ? AND period < ? AND deleted_at IS NULL', [
        user,
        after,
        before,
      ]),
    )
    total = total.sub(
      sumAmounts(
        `SELECT amount FROM installments WHERE user_id = ? AND period > ? AND period < ?
         AND expense_id IN (SELECT id FROM expenses WHERE user_id = ? AND deleted_at IS NULL)`,
        [user, after, before, user],
      ),
    )
    // Savings contributions left the account too; refunds came back into it.
    return total
      .sub(sumFixedBetween(after, before))
      .sub(sumContributions('period > ? AND period < ?', [after, before]))
      .add(refundsBetween(after, before))
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
        // Past its target month and still short: the UI flags it.
        overdue: g.targetPeriod !== '' && g.targetPeriod < now && !remaining.isZero(),
        contributions,
      }
    })
  }

  // goalBalance is what a goal holds: its contributions minus its withdrawals.
  function goalBalance(goalID: number): Money {
    return sumAmounts('SELECT amount FROM savings_contributions WHERE goal_id = ?', [goalID])
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
    for (const r of refundsIn(from, to)) add(r.period, r.category, Money.zero().sub(r.amount))
    const { fixed, amountsByID, uf } = loadFixed(false)
    for (let p = from; p <= to; p = addMonths(p, 1)) {
      for (const fe of fixed) {
        if (billsIn(fe, p)) add(p, fe.category, fixedCharge(fe, amountsByID.get(fe.id) ?? [], uf, p).clp)
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
  // pendingByCard mirrors Go: card and amount only, over every pending cuota.
  function pendingByCard(): Map<number, Money> {
    const out = new Map<number, Money>()
    for (const r of db.query(
      `SELECT e.card_id, i.amount FROM installments AS i JOIN expenses AS e ON e.id = i.expense_id
       WHERE i.user_id = ? AND i.status = ? AND e.deleted_at IS NULL AND e.card_id IS NOT NULL`,
      [uid(), StatusPendiente],
    )) {
      const cardId = asNumber(r.card_id)
      out.set(cardId, (out.get(cardId) ?? Money.zero()).add(Money.fromString(asString(r.amount))))
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
    capped: boolean // false = no cap from this month on; a capped $0 is a real cap
  }

  function budgetRows(where: string, params: SqlValue[]): Map<number, CategoryBudgetRow[]> {
    const byCat = new Map<number, CategoryBudgetRow[]>()
    for (const r of db.query(`SELECT * FROM category_budgets WHERE user_id = ? AND ${where}`, [uid(), ...params])) {
      const row: CategoryBudgetRow = {
        categoryId: asNumber(r.category_id),
        effectiveFrom: asString(r.effective_from),
        amount: asString(r.amount),
        capped: asNumber(r.capped) === 1,
      }
      byCat.set(row.categoryId, [...(byCat.get(row.categoryId) ?? []), row])
    }
    return byCat
  }

  // budgetsInEffect: the cap in effect at `period` for every active category
  // that has one ($0 included), ordered by category name.
  function budgetsInEffect(period: string): CategoryBudgetView[] {
    const cats = db
      .query('SELECT * FROM categories WHERE user_id = ? AND deleted_at IS NULL', [uid()])
      .map(rowToCategory)
    const byCat = budgetRows('effective_from <= ?', [period])
    const out: CategoryBudgetView[] = []
    for (const c of cats) {
      const b = latestAsOf(byCat.get(c.id) ?? [], period)
      if (!b || !b.capped) continue
      out.push({ categoryId: c.id, category: c.name, amount: b.amount, effectiveFrom: b.effectiveFrom, rollover: c.rollover })
    }
    return out.sort((a, b) => compareStrings(a.category, b.category))
  }

  // categorySpentByMonth mirrors Go: what each category was charged each month
  // from `from` to `to` (inclusive) — cuotas, fixed charges and refunds.
  function categorySpentByMonth(from: string, to: string): Map<string, Map<string, Money>> {
    const out = new Map<string, Map<string, Money>>()
    const add = (cat: string, period: string, amt: Money) => {
      const byPeriod = out.get(cat) ?? new Map<string, Money>()
      byPeriod.set(period, (byPeriod.get(period) ?? Money.zero()).add(amt))
      out.set(cat, byPeriod)
    }
    if (from > to) return out
    const insts = db
      .query(
        `SELECT * FROM installments WHERE user_id = ? AND period >= ? AND period <= ?
         AND expense_id IN (SELECT id FROM expenses WHERE deleted_at IS NULL)`,
        [uid(), from, to],
      )
      .map(rowToInstallment)
    const exById = expenseMapActive(insts.map((i) => i.expenseId))
    for (const inst of insts) {
      const ex = exById.get(inst.expenseId)
      if (ex) add(ex.category, inst.period, Money.fromString(inst.amount))
    }
    const { fixed, amountsByID, uf } = loadFixed(false)
    for (let m = from; m <= to; m = addMonths(m, 1)) {
      for (const fe of fixed) {
        if (billsIn(fe, m)) add(fe.category, m, fixedCharge(fe, amountsByID.get(fe.id) ?? [], uf, m).clp)
      }
    }
    for (const r of refundsIn(from, to)) add(r.category, r.period, Money.zero().sub(r.amount))
    return out
  }

  // rolloverCarries mirrors Go: what each rollover category brings into
  // `period` — unspent budget only (never a debt); a month without a cap
  // starts over.
  function rolloverCarries(period: string, views: CategoryBudgetView[]): Map<number, Money> {
    const out = new Map<number, Money>()
    const ids = views.filter((v) => v.rollover).map((v) => v.categoryId)
    if (ids.length === 0) return out
    const byCat = budgetRows(`category_id IN (${ids.map(() => '?').join(', ')}) AND effective_from < ?`, [...ids, period])
    const starts = [...byCat.values()].flat().map((r) => r.effectiveFrom)
    if (starts.length === 0) return out
    const start = starts.reduce((a, b) => (b < a ? b : a))
    const spent = categorySpentByMonth(start, addMonths(period, -1))
    for (const v of views) {
      if (!v.rollover) continue
      let carry = Money.zero()
      for (let m = start; m < period; m = addMonths(m, 1)) {
        const b = latestAsOf(byCat.get(v.categoryId) ?? [], m)
        if (!b || !b.capped) {
          carry = Money.zero()
          continue
        }
        carry = Money.fromString(b.amount).add(carry).sub(spent.get(v.category)?.get(m) ?? Money.zero())
        if (carry.isNegative()) carry = Money.zero()
      }
      out.set(v.categoryId, carry)
    }
    return out
  }

  // putCategoryBudget mirrors Go: a cap (or its absence) from `fromPeriod` on.
  function putCategoryBudget(categoryID: number, fromPeriod: string, amount: string, capped: boolean): OpResult {
    if (!validPeriod(fromPeriod)) return { error: invalidPeriodError() }
    return db.transaction((): OpResult => {
      const owned = db.query('SELECT 1 FROM categories WHERE id = ? AND user_id = ? AND deleted_at IS NULL', [
        categoryID,
        uid(),
      ])
      if (owned.length === 0) return { error: newError(ErrNotFound, 'categoría no encontrada') }
      db.exec(
        `INSERT INTO category_budgets (user_id, category_id, effective_from, amount, capped) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (category_id, effective_from) DO UPDATE SET amount = EXCLUDED.amount, capped = EXCLUDED.capped`,
        [uid(), categoryID, fromPeriod, amount, capped ? 1 : 0],
      )
      return {}
    })
  }

  function budgetStatuses(period: string, catTotals: Map<string, Money>): BudgetStatus[] {
    const views = budgetsInEffect(period)
    const carried = rolloverCarries(period, views)
    return views.map((v) => {
      const budget = Money.fromString(v.amount)
      const carry = carried.get(v.categoryId) ?? Money.zero()
      const available = budget.add(carry)
      const spent = catTotals.get(v.category) ?? Money.zero()
      const over = spent.gt(available)
      return {
        categoryId: v.categoryId,
        category: v.category,
        budget: budget.toString(),
        carried: carry.toString(),
        spent: spent.toString(),
        remaining: available.sub(spent).toString(),
        over,
        // Mirrors Go's nearCap: 80 % of a positive cap, the usual early warning.
        near: !over && available.gt(Money.zero()) && spent.mulInt(100).gte(available.mulInt(budgetAlertPercent)),
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

    async CreateCard(name: string, creditLimit: string, billingDay: number, lastDigits: string): Promise<CardResult> {
      if (name.trim() === '') return { error: newError(ErrValidation, 'el nombre es obligatorio') }
      const parsed = amountOrError(creditLimit)
      if (parsed.error || !parsed.amount) return { error: parsed.error ?? invalidAmountError(creditLimit) }
      const digits = validateLastDigits(lastDigits)
      if (digits.error) return { error: digits.error }
      const day = billingDay < 1 || billingDay > 28 ? 24 : billingDay
      const limit = parsed.amount.toString()
      return db.transaction((): CardResult => {
        const row = db.query(
          `INSERT INTO cards (user_id, name, credit_limit, billing_day, last_digits, created_at)
           VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
          [uid(), name.trim(), limit, day, digits.digits, nowIso()],
        )[0]
        if (!row) return { error: newError(ErrNotFound, 'tarjeta no encontrada') }
        relinkStatements()
        return { data: rowToCard(row) }
      })
    },

    async UpdateCard(
      id: number,
      name: string,
      creditLimit: string,
      billingDay: number,
      lastDigits: string,
    ): Promise<CardResult> {
      if (name.trim() === '') return { error: newError(ErrValidation, 'el nombre es obligatorio') }
      const parsed = amountOrError(creditLimit)
      if (parsed.error || !parsed.amount) return { error: parsed.error ?? invalidAmountError(creditLimit) }
      const digits = validateLastDigits(lastDigits)
      if (digits.error) return { error: digits.error }
      const day = billingDay < 1 || billingDay > 28 ? 24 : billingDay
      const limit = parsed.amount.toString()
      return db.transaction((): CardResult => {
        db.exec(
          `UPDATE cards SET name = ?, credit_limit = ?, billing_day = ?, last_digits = ?
           WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
          [name.trim(), limit, day, digits.digits, id, uid()],
        )
        if (db.changes() === 0) return { error: newError(ErrNotFound, 'tarjeta no encontrada') }
        relinkStatements()
        const row = db.query('SELECT * FROM cards WHERE id = ? AND user_id = ? AND deleted_at IS NULL', [id, uid()])[0]
        if (!row) return { error: newError(ErrNotFound, 'tarjeta no encontrada') }
        return { data: rowToCard(row) }
      })
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
      const { name: n, error } = validCategoryName(name)
      if (error) return { error }
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
      const { name: n, error } = validCategoryName(name)
      if (error) return { error }
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
            for (const table of ['expenses', 'fixed_expenses', 'merchants']) {
              db.exec(`UPDATE ${table} SET category = ? WHERE category = ? AND user_id = ? AND deleted_at IS NULL`, [
                n,
                old.name,
                uid(),
              ])
            }
            // Import rules have no trash: every one that names it.
            db.exec('UPDATE merchant_rules SET category = ? WHERE category = ? AND user_id = ?', [n, old.name, uid()])
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
            db.exec('UPDATE merchant_rules SET merchant = ? WHERE merchant = ? AND user_id = ?', [n, old.name, uid()])
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

    async SetMerchantCategory(merchantID: number, category: string): Promise<OpResult> {
      let name = category.trim()
      if (name !== '') {
        // Compared in JS like Go's EqualFold: SQLite's lower() folds only ASCII.
        const match = db
          .query('SELECT name FROM categories WHERE user_id = ? AND deleted_at IS NULL', [uid()])
          .map((r) => asString(r.name))
          .find((n) => n.toLowerCase() === name.toLowerCase())
        if (match === undefined) return { error: newError(ErrValidation, `la categoría «${name}» no existe`) }
        name = match
      }
      db.exec('UPDATE merchants SET category = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL', [name, merchantID, uid()])
      if (db.changes() === 0) return { error: newError(ErrNotFound, 'comercio no encontrado') }
      return {}
    },

    // ApplyCatalog mirrors catalog.go: adds what the profile lacks, never changes
    // a choice already made (names in any case; a name in the trash is taken).
    async ApplyCatalog(): Promise<CatalogResult> {
      return db.transaction((): CatalogResult => {
        const now = nowIso()
        const categoryRows = db.query('SELECT name, deleted_at FROM categories WHERE user_id = ?', [uid()])
        const taken = new Set(categoryRows.map((r) => asString(r.name).toLowerCase()))
        const liveCategory = new Map(
          categoryRows.filter((r) => r.deleted_at == null).map((r) => [asString(r.name).toLowerCase(), asString(r.name)] as const),
        )
        let categories = 0
        for (const c of CATALOG.categories) {
          const key = c.name.toLowerCase()
          if (taken.has(key)) continue
          taken.add(key)
          liveCategory.set(key, c.name)
          db.exec('INSERT INTO categories (user_id, name, icon, color, created_at) VALUES (?, ?, ?, ?, ?)', [
            uid(),
            c.name,
            c.icon,
            c.color,
            now,
          ])
          categories++
        }

        const merchantRows = db.query('SELECT id, name, category, deleted_at FROM merchants WHERE user_id = ?', [uid()])
        const trashed = new Set(merchantRows.filter((r) => r.deleted_at != null).map((r) => asString(r.name).toLowerCase()))
        const live = new Map<string, { id: number; name: string; category: string }>()
        for (const r of merchantRows) {
          if (r.deleted_at == null) {
            live.set(asString(r.name).toLowerCase(), { id: asNumber(r.id), name: asString(r.name), category: asString(r.category) })
          }
        }
        const patternTaken = new Set(listMerchantRules().map((r) => r.pattern))
        let merchants = 0
        let rules = 0
        for (const m of CATALOG.merchants) {
          const key = m.name.toLowerCase()
          if (trashed.has(key) && !live.has(key)) continue // removed on purpose: neither it nor its rules come back
          let category = liveCategory.get(m.category.toLowerCase()) ?? ''
          let name = m.name
          const cur = live.get(key)
          if (cur) {
            name = cur.name
            if (cur.category === '' && category !== '') {
              db.exec('UPDATE merchants SET category = ? WHERE id = ? AND user_id = ?', [category, cur.id, uid()])
              cur.category = category
            }
            category = cur.category
          } else {
            db.exec('INSERT INTO merchants (user_id, name, category, created_at) VALUES (?, ?, ?, ?)', [uid(), m.name, category, now])
            merchants++
          }
          for (const p of m.patterns) {
            if (patternTaken.has(p)) continue
            patternTaken.add(p)
            db.exec('INSERT INTO merchant_rules (user_id, pattern, merchant, category, created_at) VALUES (?, ?, ?, ?, ?)', [
              uid(),
              p,
              name,
              category,
              now,
            ])
            rules++
          }
        }
        return { data: { categories, merchants, rules } }
      })
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
      const billing = cutoffFor(cardID)
      if (billing.error) return { error: billing.error }
      return db.transaction((): ExpenseResult => ({ data: insertExpense(ex, billing.cutoff) }))
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
      const oldRow = db.query('SELECT * FROM expenses WHERE id = ? AND user_id = ? AND deleted_at IS NULL', [id, uid()])[0]
      if (!oldRow) return { error: newError(ErrNotFound, 'gasto no encontrado') }
      const old = rowToExpense(oldRow)
      const billing = cutoffFor(cardID, old.cardId === cardID)
      if (billing.error) return { error: billing.error }
      // The old card row is gone: its expense was never on a known cutoff (NO_CUTOFF).
      const oldCutoff = cutoffFor(old.cardId, true).cutoff
      // The cuota-1 month the old and new inputs lead to (see replanInstallments).
      const placement: PlacementChange = {
        before: cutoffPeriodOf(oldCutoff, storedDateParts(old.date)),
        after: cutoffPeriodOf(billing.cutoff, ex.date.parts),
      }
      return db.transaction((): ExpenseResult => {
        // A returned error still commits here (only a throw rolls back), so the
        // replan refuses before writing anything and runs before the UPDATE.
        const amountChanged = Money.fromString(old.installmentAmount).cmp(ex.installmentAmount) !== 0
        const refused = replanInstallments(id, ex, placement, amountChanged)
        if (refused) return { error: refused }
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
        if (db.changes() === 0) throw new Error(`expense ${id} vanished inside its own transaction`)
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

    // Cuotas of an expense in the trash are frozen with it (mirrors Go).
    // ---------- accounts (mirror of account.go) ----------

    async ListAccounts(period: string): Promise<AccountsResult> {
      if (!validPeriod(period)) return { error: invalidPeriodError() }
      const accs = db.query('SELECT * FROM accounts WHERE user_id = ? ORDER BY name ASC', [uid()]).map(rowToAccount)
      const from = accs.reduce((m, a) => (a.openingPeriod < m ? a.openingPeriod : m), period)
      const flows = accountFlows(accs, from, period)
      const flowOf = (id: number, m: string): AccountFlow =>
        flows.get(id)?.get(m) ?? { in: Money.zero(), out: Money.zero(), tin: Money.zero(), tout: Money.zero() }
      const recs = new Map<number, { period: string; balance: string }[]>()
      for (const r of db.query(
        'SELECT account_id, period, balance FROM account_reconciliations WHERE user_id = ? AND period <= ? ORDER BY period ASC',
        [uid(), period],
      )) {
        const id = asNumber(r.account_id)
        recs.set(id, [...(recs.get(id) ?? []), { period: asString(r.period), balance: asString(r.balance) }])
      }
      const views: AccountView[] = accs.map((a) => {
        let balance = Money.zero()
        let conciliacion: AccountView['conciliacion'] = null
        if (a.openingPeriod <= period) {
          const start = accountStart(a, recs.get(a.id) ?? [], period)
          balance = start.balance
          for (let m = start.from; m <= period; m = addMonths(m, 1)) {
            const f = flowOf(a.id, m)
            balance = balance.add(f.in).sub(f.out).add(f.tin).sub(f.tout)
          }
          if (start.here) {
            conciliacion = {
              saldoReal: start.here.toString(),
              calculado: balance.toString(),
              diferencia: start.here.sub(balance).toString(),
            }
          }
        }
        const f = flowOf(a.id, period)
        return {
          ...a,
          balance: balance.toString(),
          ingresos: f.in.toString(),
          gastos: f.out.toString(),
          transferIn: f.tin.toString(),
          transferOut: f.tout.toString(),
          conciliacion,
        }
      })
      const none = flowOf(0, period)
      return { data: { accounts: views, unassignedIngresos: none.in.toString(), unassignedGastos: none.out.toString() } }
    },

    async CreateAccount(
      name: string,
      kind: string,
      openingBalance: string,
      openingPeriod: string,
      receivesSalary: boolean,
    ): Promise<AccountResult> {
      const v = validAccount(name, kind, openingBalance, openingPeriod)
      if (v.error) return { error: v.error }
      return db.transaction((): AccountResult => {
        const stranded = keepSalaryRestSource(0, receivesSalary)
        if (stranded) return { error: stranded }
        const row = db.query(
          `INSERT INTO accounts (user_id, name, kind, opening_balance, opening_period, receives_salary, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`,
          [uid(), v.name, kind, v.balance, openingPeriod, receivesSalary ? 1 : 0, nowIso()],
        )[0]
        if (!row) throw new Error('INSERT accounts RETURNING produced no row')
        const acc = rowToAccount(row)
        keepOneSalaryAccount(acc)
        return { data: acc }
      })
    },

    async UpdateAccount(
      id: number,
      name: string,
      kind: string,
      openingBalance: string,
      openingPeriod: string,
      receivesSalary: boolean,
    ): Promise<AccountResult> {
      const v = validAccount(name, kind, openingBalance, openingPeriod)
      if (v.error) return { error: v.error }
      return db.transaction((): AccountResult => {
        // Checked before writing: a returned error still commits here.
        const stranded = keepSalaryRestSource(id, receivesSalary)
        if (stranded) return { error: stranded }
        db.exec(
          `UPDATE accounts SET name = ?, kind = ?, opening_balance = ?, opening_period = ?, receives_salary = ?
           WHERE id = ? AND user_id = ?`,
          [v.name, kind, v.balance, openingPeriod, receivesSalary ? 1 : 0, id, uid()],
        )
        if (db.changes() === 0) return { error: newError(ErrNotFound, 'cuenta no encontrada') }
        const acc = rowToAccount(db.query('SELECT * FROM accounts WHERE id = ?', [id])[0]!)
        keepOneSalaryAccount(acc)
        return { data: acc }
      })
    },

    async DeleteAccount(id: number): Promise<OpResult> {
      db.exec('DELETE FROM accounts WHERE id = ? AND user_id = ?', [id, uid()])
      if (db.changes() === 0) return { error: newError(ErrNotFound, 'cuenta no encontrada') }
      return {}
    },

    async SetExpenseAccount(expenseID: number, accountID: number | null): Promise<OpResult> {
      return setAccountOf('expenses', expenseID, accountID, 'gasto no encontrado')
    },

    async SetIncomeAccount(incomeID: number, accountID: number | null): Promise<OpResult> {
      return setAccountOf('incomes', incomeID, accountID, 'ingreso no encontrado')
    },

    async SetCardAccount(cardID: number, accountID: number | null): Promise<OpResult> {
      return setAccountOf('cards', cardID, accountID, 'tarjeta no encontrada')
    },

    async SetFixedExpenseAccount(fixedExpenseID: number, accountID: number | null): Promise<OpResult> {
      return setAccountOf('fixed_expenses', fixedExpenseID, accountID, 'gasto fijo no encontrado')
    },

    // ---------- transfers (mirror of transfer.go) ----------

    async ListTransfers(): Promise<Transfer[]> {
      return db
        .query('SELECT * FROM transfers WHERE user_id = ? ORDER BY start_period DESC, id DESC', [uid()])
        .map(rowToTransfer)
    },

    async CreateTransfer(
      fromAccountID: number,
      toAccountID: number,
      description: string,
      mode: string,
      amount: string,
      startPeriod: string,
      monthly: boolean,
    ): Promise<TransferResult> {
      const v = validTransfer(fromAccountID, toAccountID, description, mode, amount)
      if (v.error) return { error: v.error }
      if (!validPeriod(startPeriod)) return { error: invalidPeriodError() }
      const owned = ownAccounts(fromAccountID, toAccountID, mode)
      if (owned) return { error: owned }
      const row = db.query(
        `INSERT INTO transfers (user_id, from_account_id, to_account_id, description, mode, amount, start_period, end_period, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
        [uid(), fromAccountID, toAccountID, v.description, mode, v.amount, startPeriod, monthly ? '' : startPeriod, nowIso()],
      )[0]
      if (!row) throw new Error('INSERT transfers RETURNING produced no row')
      return { data: rowToTransfer(row) }
    },

    async UpdateTransfer(
      id: number,
      fromAccountID: number,
      toAccountID: number,
      description: string,
      mode: string,
      amount: string,
    ): Promise<TransferResult> {
      const v = validTransfer(fromAccountID, toAccountID, description, mode, amount)
      if (v.error) return { error: v.error }
      const owned = ownAccounts(fromAccountID, toAccountID, mode)
      if (owned) return { error: owned }
      db.exec(
        `UPDATE transfers SET from_account_id = ?, to_account_id = ?, description = ?, mode = ?, amount = ?
         WHERE id = ? AND user_id = ?`,
        [fromAccountID, toAccountID, v.description, mode, v.amount, id, uid()],
      )
      if (db.changes() === 0) return { error: newError(ErrNotFound, 'transferencia no encontrada') }
      return { data: rowToTransfer(db.query('SELECT * FROM transfers WHERE id = ?', [id])[0]!) }
    },

    async EndTransfer(id: number, lastPeriod: string): Promise<OpResult> {
      if (!validPeriod(lastPeriod)) return { error: invalidPeriodError() }
      db.exec('UPDATE transfers SET end_period = ? WHERE id = ? AND user_id = ? AND start_period <= ?', [
        lastPeriod,
        id,
        uid(),
        lastPeriod,
      ])
      if (db.changes() === 0) {
        return { error: newError(ErrNotFound, 'transferencia no encontrada (o el mes es anterior a su inicio)') }
      }
      return {}
    },

    async DeleteTransfer(id: number): Promise<OpResult> {
      db.exec('DELETE FROM transfers WHERE id = ? AND user_id = ?', [id, uid()])
      if (db.changes() === 0) return { error: newError(ErrNotFound, 'transferencia no encontrada') }
      return {}
    },

    async LatestFxRate(): Promise<FxRateResult> {
      return { data: latestFxRate() }
    },

    async SetExpenseCurrency(expenseID: number, currency: string, originalAmount: string, fxRate: string): Promise<OpResult> {
      const code = currency.trim().toUpperCase()
      if (!/^[A-Z]{3}$/.test(code)) {
        return { error: newError(ErrValidation, 'moneda inválida (use un código de 3 letras, ej. USD)') }
      }
      let original = ''
      let rate = ''
      if (code !== 'CLP') {
        for (const [value, what] of [
          [originalAmount, 'el monto original'],
          [fxRate, 'la tasa'],
        ] as const) {
          const parsed = amountOrError(value)
          if (parsed.error || !parsed.amount) return { error: parsed.error ?? invalidAmountError(value) }
          if (!parsed.amount.gt(Money.zero())) return { error: newError(ErrValidation, what + ' debe ser mayor a 0') }
        }
        original = Money.fromString(originalAmount.trim()).toString()
        rate = Money.fromString(fxRate.trim()).toString()
      }
      db.exec('UPDATE expenses SET currency = ?, original_amount = ?, fx_rate = ? WHERE id = ? AND user_id = ?', [
        code,
        original,
        rate,
        expenseID,
        uid(),
      ])
      if (db.changes() === 0) return { error: newError(ErrNotFound, 'gasto no encontrado') }
      return {}
    },

    async SetInstallmentAmount(id: number, amount: string): Promise<OpResult> {
      const parsed = amountOrError(amount)
      if (parsed.error || !parsed.amount) return { error: parsed.error ?? invalidAmountError(amount) }
      if (parsed.amount.isZero()) return { error: newError(ErrValidation, 'el monto debe ser mayor a 0') }
      const pending = pendingCuotaOf(id)
      if (pending.error) return { error: pending.error }
      db.exec('UPDATE installments SET amount = ? WHERE id = ? AND user_id = ?', [parsed.amount.toString(), id, uid()])
      return {}
    },

    async PrepayExpense(expenseID: number, period: string): Promise<OpResult> {
      if (!validPeriod(period)) return { error: invalidPeriodError() }
      const live = db.query('SELECT 1 FROM expenses WHERE id = ? AND user_id = ? AND deleted_at IS NULL', [expenseID, uid()])
      if (live.length === 0) return { error: newError(ErrNotFound, 'gasto no encontrado') }
      db.exec('UPDATE installments SET period = ? WHERE expense_id = ? AND user_id = ? AND status = ?', [
        period,
        expenseID,
        uid(),
        StatusPendiente,
      ])
      if (db.changes() === 0) return { error: newError(ErrValidation, 'el gasto no tiene cuotas pendientes') }
      return {}
    },

    async SetInstallmentPaid(id: number, paid: boolean): Promise<OpResult> {
      const user = uid()
      const liveParent = 'expense_id IN (SELECT id FROM expenses WHERE user_id = ? AND deleted_at IS NULL)'
      if (paid) {
        db.exec(`UPDATE installments SET status = ?, paid_at = ? WHERE id = ? AND user_id = ? AND ${liveParent}`, [
          StatusPagado,
          nowIso(),
          id,
          user,
          user,
        ])
      } else {
        db.exec(`UPDATE installments SET status = ?, paid_at = NULL WHERE id = ? AND user_id = ? AND ${liveParent}`, [
          StatusPendiente,
          id,
          user,
          user,
        ])
      }
      if (db.changes() === 0) return { error: newError(ErrNotFound, 'cuota no encontrada') }
      return {}
    },

    // ---------- fixed expenses (recurring) ----------

    async ListFixedExpenses(): Promise<FixedExpenseView[]> {
      const { fixed, amountsByID, uf } = loadFixed(false)
      const cardByID = cardMapAll()
      const now = currentPeriod()
      const out: FixedExpenseView[] = fixed.map((fe) => {
        const charge = fixedCharge(fe, amountsByID.get(fe.id) ?? [], uf, fixedDisplayPeriod(fe, now))
        return {
          ...fe,
          currentAmount: charge.original.toString(),
          currentAmountClp: charge.clp.toString(),
          nextPeriod: nextBilling(fe, now),
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
      intervalMonths: number,
      currency: string,
    ): Promise<FixedExpenseResult> {
      const desc = description.trim()
      if (desc === '') return { error: newError(ErrValidation, 'la descripción es obligatoria') }
      if (!validPeriod(startPeriod)) return { error: newError(ErrValidation, 'período inicial inválido (use YYYY-MM)') }
      if (!validIntervals.includes(intervalMonths)) {
        return { error: newError(ErrValidation, 'frecuencia inválida (cada 1, 2, 3, 4, 6 o 12 meses)') }
      }
      if (currency !== CurrencyCLP && currency !== CurrencyUF) {
        return { error: newError(ErrValidation, 'moneda inválida (CLP o UF)') }
      }
      const parsed = amountOrError(amount)
      if (parsed.error || !parsed.amount) return { error: parsed.error ?? invalidAmountError(amount) }
      if (parsed.amount.isZero()) return { error: newError(ErrValidation, 'el monto debe ser mayor a 0') }
      if (cardID != null) {
        const billing = cutoffFor(cardID)
        if (billing.error) return { error: billing.error }
      }
      return db.transaction((): FixedExpenseResult => {
        const row = db.query(
          `INSERT INTO fixed_expenses (user_id, description, category, card_id, start_period, interval_months, currency, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
          [uid(), desc, category.trim(), cardID, startPeriod, intervalMonths, currency, nowIso()],
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

    // UFMonthsNeeded mirrors the Go method: billing months of the profile's UF
    // fixed expenses, up to next month, without a stored UF value.
    async UFMonthsNeeded(): Promise<string[]> {
      const { fixed, uf } = loadFixed(false)
      const horizon = addMonths(currentPeriod(), 1)
      const need = new Set<string>()
      for (const fe of fixed) {
        if (fe.currency !== CurrencyUF || !validPeriod(fe.startPeriod)) continue
        const last = fe.endPeriod !== '' && fe.endPeriod < horizon ? fe.endPeriod : horizon
        for (let p = fe.startPeriod; p <= last; p = addMonths(p, interval(fe))) {
          if (!uf.has(p)) need.add(p)
        }
      }
      return [...need].sort(compareStrings)
    },

    async SetUFValues(values: UFValueInput[]): Promise<OpResult> {
      const rows: Array<{ period: string; value: string }> = []
      for (const v of values) {
        if (!validPeriod(v.period)) return { error: invalidPeriodError() }
        let value: Money
        try {
          value = Money.fromString(v.value.trim())
        } catch {
          return { error: newError(ErrValidation, 'valor UF inválido: ' + v.value) }
        }
        if (value.isZero() || value.isNegative()) return { error: newError(ErrValidation, 'valor UF inválido: ' + v.value) }
        rows.push({ period: v.period, value: value.toString() })
      }
      const now = nowIso()
      db.transaction(() => {
        for (const r of rows) {
          db.exec(
            `INSERT INTO uf_values (period, value, updated_at) VALUES (?, ?, ?)
             ON CONFLICT (period) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
            [r.period, r.value, now],
          )
        }
      })
      return {}
    },

    async UpdateFixedExpense(
      id: number,
      description: string,
      category: string,
      cardID: number | null,
    ): Promise<FixedExpenseResult> {
      const desc = description.trim()
      if (desc === '') return { error: newError(ErrValidation, 'la descripción es obligatoria') }
      const old = ownFixedExpense(id)
      if (!old) return { error: newError(ErrNotFound, 'gasto fijo no encontrado') }
      const billing = cutoffFor(cardID, old.cardId === cardID)
      if (billing.error) return { error: billing.error }
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
        const fe = ownFixedExpense(id)
        if (!fe) return { error: newError(ErrNotFound, 'gasto fijo no encontrado') }
        const outside = requireActiveIn(fe, fromPeriod, 'cambiar el monto')
        if (outside) return { error: outside }
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
      const fe = ownFixedExpense(id)
      if (!fe) return { error: newError(ErrNotFound, 'gasto fijo no encontrado') }
      if (fromPeriod <= fe.startPeriod) {
        return {
          error: newError(
            ErrValidation,
            `el gasto fijo empieza en ${fe.startPeriod}: cancélalo desde un mes posterior, o elimínalo`,
          ),
        }
      }
      db.exec('UPDATE fixed_expenses SET end_period = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL', [
        addMonths(fromPeriod, -1),
        id,
        uid(),
      ])
      return {}
    },

    async SetFixedExpenseDueDay(id: number, day: number | null): Promise<OpResult> {
      if (day !== null && (!Number.isInteger(day) || day < 1 || day > 31)) {
        return { error: newError(ErrValidation, 'el día de vencimiento debe estar entre 1 y 31') }
      }
      db.exec('UPDATE fixed_expenses SET due_day = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL', [day, id, uid()])
      if (db.changes() === 0) return { error: newError(ErrNotFound, 'gasto fijo no encontrado') }
      return {}
    },

    async UpcomingDues(today: string, days: number): Promise<DuesResult> {
      const parsed = /^\d{4}-\d{2}-\d{2}$/.test(today) ? parseDate(today) : null
      if (!parsed || !inYearRange(parsed.parts.year)) {
        return { error: newError(ErrValidation, 'fecha inválida (AAAA-MM-DD)') }
      }
      if (!Number.isInteger(days) || days < 0 || days > MAX_DUE_DAYS) {
        return { error: newError(ErrValidation, `los días deben estar entre 0 y ${MAX_DUE_DAYS}`) }
      }
      return { data: upcomingDues(today, shiftDays(today, -DUE_LOOKBACK_DAYS), shiftDays(today, days)) }
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
        const fe = ownFixedExpense(id)
        if (!fe) return { error: newError(ErrNotFound, 'gasto fijo no encontrado') }
        if (paid) {
          // Marking needs a month it bills in; unmarking is always allowed.
          const outside = requireBillsIn(fe, period, 'marcarlo pagado')
          if (outside) return { error: outside }
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
      const carried = cumulativeBalanceBefore(period)
      const acumulado = carried.amount
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
      const tagsOf = tagsByExpense(insts.map((i) => i.expenseId))
      const refsOf = referencesByExpense(insts.map((i) => i.expenseId))

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
          refundId: null,
          description: '',
          bankDescription: '',
      currency: '',
      originalAmount: '',
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
          ufAmount: null,
          estimado: false,
          tags: tagsOf.get(inst.expenseId) ?? [],
          references: refsOf.get(inst.expenseId) ?? [],
        }
        let cat = uncategorized
        if (ex) {
          mv.expenseId = ex.id
          mv.description = ex.description
          mv.bankDescription = ex.bankDescription
          if (ex.currency !== '' && ex.currency !== 'CLP') {
            mv.currency = ex.currency
            mv.originalAmount = ex.originalAmount
          }
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

      // Recurring fixed expenses billed this month fold into the same totals, and
      // so do the refunds that arrived (negative, net of their category and card).
      for (const mv of [...fixedChargesFor(period), ...refundsIn(period, period).map(refundMovimiento)]) {
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
        acumuladoDesde: carried.from,
        conciliacion: null,
      }
      const closing = reconciliationsIn(period, period).get(period)
      if (closing) {
        data.conciliacion = {
          saldoReal: closing.toString(),
          calculado: balance.toString(),
          diferencia: closing.sub(balance).toString(),
        }
      }
      return { data }
    },

    async YearSummary(year: number): Promise<YearSummaryResult> {
      if (year < 2000 || year > 3000) return { error: newError(ErrValidation, 'año inválido') }
      const prefix = `${String(year).padStart(4, '0')}-`

      // Carry-in from every period before this year.
      let saldo = cumulativeBalanceBefore(prefix + '01').amount
      // A month reconciled inside the year resets the running balance to the real one.
      const realByMonth = reconciliationsIn(prefix + '01', prefix + '12')

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
      const { fixed, amountsByID, uf } = loadFixed(false)
      for (let m = 1; m <= 12; m++) {
        const period = prefix + String(m).padStart(2, '0')
        for (const fe of fixed) {
          if (!billsIn(fe, period)) continue
          const amt = fixedCharge(fe, amountsByID.get(fe.id) ?? [], uf, period).clp
          gastosByMonth.set(period, (gastosByMonth.get(period) ?? Money.zero()).add(amt))
          byCat.add(fe.category, period, amt)
        }
      }
      // Refunds lower their month's gastos and their expense's category.
      for (const r of refundsIn(prefix + '01', prefix + '12')) {
        const neg = Money.zero().sub(r.amount)
        gastosByMonth.set(r.period, (gastosByMonth.get(r.period) ?? Money.zero()).add(neg))
        byCat.add(r.category, r.period, neg)
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
        const closing = realByMonth.get(period)
        if (closing) saldo = closing
        months.push({
          period,
          ingresos: ingresos.toString(),
          gastos: gastos.toString(),
          ahorro: ahorro.toString(),
          balance: balance.toString(),
          saldo: saldo.toString(),
          alcanza: saldo.gte(Money.zero()),
          conciliado: closing !== undefined,
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

      const { fixed, amountsByID, uf } = loadFixed(false)

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
      let saldo = cumulativeBalanceBefore(fromPeriod).amount
      // A past month of the horizon may already be reconciled.
      const realByMonth = reconciliationsIn(fromPeriod, to)
      const refundedIn = new Map<string, Money>()
      for (const r of refundsIn(fromPeriod, to)) refundedIn.set(r.period, (refundedIn.get(r.period) ?? Money.zero()).add(r.amount))
      const data: ForecastMonth[] = []
      for (let i = 0; i < months; i++) {
        const period = addMonths(fromPeriod, i)
        let fijos = Money.zero()
        for (const fe of fixed) {
          // Future months have no UF value yet: fixedCharge uses the latest known one.
          if (billsIn(fe, period)) fijos = fijos.add(fixedCharge(fe, amountsByID.get(fe.id) ?? [], uf, period).clp)
        }
        const known = salaryByMonth.get(period)
        if (known) lastKnown = known
        const ingresos = lastKnown.add(extras.get(period) ?? Money.zero())
        const cuotasMes = cuotas.get(period) ?? Money.zero()
        const comprometido = cuotasMes.add(fijos)
        const ahorro = ahorroByMonth.get(period) ?? Money.zero()
        // Refunds already recorded come back into the account, as in the month view.
        const libre = ingresos.sub(comprometido).sub(ahorro).add(refundedIn.get(period) ?? Money.zero())
        saldo = realByMonth.get(period) ?? saldo.add(libre)
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

    // ---------- refunds (reembolsos) ----------

    async CreateRefund(expenseID: number, period: string, amount: string, description: string): Promise<RefundResult> {
      return db.transaction((): RefundResult => insertRefund(expenseID, period, amount, description))
    },

    async DeleteRefund(id: number): Promise<OpResult> {
      db.exec('DELETE FROM refunds WHERE id = ? AND user_id = ?', [id, uid()])
      if (db.changes() === 0) return { error: newError(ErrNotFound, 'reembolso no encontrado') }
      return {}
    },

    // ---------- receivables (por cobrar; mirror of receivable.go) ----------

    async CreateReceivable(expenseID: number, person: string, amount: string): Promise<ReceivableResult> {
      const who = person.trim()
      if (who === '') return { error: newError(ErrValidation, 'indica quién te debe') }
      const parsed = amountOrError(amount)
      if (parsed.error || !parsed.amount) return { error: parsed.error ?? invalidAmountError(amount) }
      if (parsed.amount.isZero()) return { error: newError(ErrValidation, 'el monto debe ser mayor a 0') }
      const amt = parsed.amount
      return db.transaction((): ReceivableResult => {
        const row = db.query('SELECT * FROM expenses WHERE id = ? AND user_id = ? AND deleted_at IS NULL', [expenseID, uid()])[0]
        if (!row) return { error: newError(ErrNotFound, 'gasto no encontrado') }
        const owed = sumAmounts('SELECT amount FROM receivables WHERE expense_id = ? AND user_id = ?', [expenseID, uid()])
        const total = expenseCost(expenseID)
        if (owed.add(amt).gt(total)) {
          return {
            error: newError(ErrValidation, `lo que te deben supera lo que costó el gasto (quedan ${total.sub(owed).toString()})`),
          }
        }
        const inserted = db.query(
          'INSERT INTO receivables (user_id, expense_id, person, amount, created_at) VALUES (?, ?, ?, ?, ?) RETURNING *',
          [uid(), expenseID, who, amt.toString(), nowIso()],
        )[0]
        if (!inserted) throw new Error('INSERT receivables RETURNING produced no row')
        return { data: rowToReceivable(inserted) }
      })
    },

    async SettleReceivable(id: number, period: string): Promise<ReceivableResult> {
      try {
        return db.transaction((): ReceivableResult => {
          const row = db.query(
            `SELECT * FROM receivables WHERE id = ? AND user_id = ?
             AND expense_id IN (SELECT id FROM expenses WHERE deleted_at IS NULL)`,
            [id, uid()],
          )[0]
          if (!row) return { error: newError(ErrNotFound, 'cuenta por cobrar no encontrada') }
          const rcv = rowToReceivable(row)
          if (rcv.refundId !== null) return { error: newError(ErrConflict, 'ya está cobrada') }
          const refund = insertRefund(rcv.expenseId, period, rcv.amount, 'Cobrado a ' + rcv.person)
          if (refund.error || !refund.data) throw new TxAbort(refund.error ?? newError(ErrValidation, 'reembolso inválido'))
          db.exec('UPDATE receivables SET refund_id = ? WHERE id = ?', [refund.data.id, id])
          return { data: { ...rcv, refundId: refund.data.id } }
        })
      } catch (err) {
        if (err instanceof TxAbort) return { error: err.appError }
        throw err
      }
    },

    async DeleteReceivable(id: number): Promise<OpResult> {
      db.exec('DELETE FROM receivables WHERE id = ? AND user_id = ?', [id, uid()])
      if (db.changes() === 0) return { error: newError(ErrNotFound, 'cuenta por cobrar no encontrada') }
      return {}
    },

    async ListReceivables(): Promise<ReceivablesResult> {
      const rows = db.query(
        `SELECT rcv.*, ex.description AS expense_description, ex.date AS expense_date,
                COALESCE(rf.period, '') AS settled_period
         FROM receivables AS rcv
         JOIN expenses AS ex ON ex.id = rcv.expense_id AND ex.deleted_at IS NULL
         LEFT JOIN refunds AS rf ON rf.id = rcv.refund_id
         WHERE rcv.user_id = ?
         ORDER BY rcv.refund_id IS NOT NULL, CASE WHEN rcv.refund_id IS NULL THEN rcv.id ELSE -rcv.id END`,
        [uid()],
      )
      return {
        data: rows.map((r) => ({
          ...rowToReceivable(r),
          expenseDescription: asString(r.expense_description),
          expenseDate: asString(r.expense_date).slice(0, 10),
          settledPeriod: asString(r.settled_period),
        })),
      }
    },

    // ---------- reconciliations (conciliación) ----------

    async SetReconciliation(period: string, amount: string): Promise<ReconciliationResult> {
      if (!validPeriod(period)) return { error: invalidPeriodError() }
      if (period > currentPeriod()) {
        return { error: newError(ErrValidation, 'no se puede conciliar un mes que aún no empieza') }
      }
      // Unlike every other amount, a real balance may be negative (an overdraft).
      let balance: Money
      try {
        balance = Money.fromString(amount.trim())
      } catch {
        return { error: newError(ErrValidation, 'saldo inválido: ' + amount) }
      }
      const now = nowIso()
      const row = db.query(
        `INSERT INTO reconciliations (user_id, period, amount, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (user_id, period) DO UPDATE SET amount = EXCLUDED.amount, updated_at = EXCLUDED.updated_at
         RETURNING *`,
        [uid(), period, balance.toString(), now, now],
      )[0]
      if (!row) return { error: newError(ErrNotFound, 'conciliación no encontrada') }
      return { data: rowToReconciliation(row) }
    },

    async DeleteReconciliation(period: string): Promise<OpResult> {
      if (!validPeriod(period)) return { error: invalidPeriodError() }
      db.exec('DELETE FROM reconciliations WHERE user_id = ? AND period = ?', [uid(), period])
      if (db.changes() === 0) return { error: newError(ErrNotFound, 'no hay conciliación para ese mes') }
      return {}
    },

    // Mirrors accountreconciliation.go: one account's real close of a month.
    async SetAccountReconciliation(accountID: number, period: string, balance: string): Promise<OpResult> {
      if (!validPeriod(period)) return { error: invalidPeriodError() }
      if (period > currentPeriod()) {
        return { error: newError(ErrValidation, 'no se puede conciliar un mes que aún no empieza') }
      }
      let real: Money
      try {
        real = Money.fromString(balance.trim())
      } catch {
        return { error: newError(ErrValidation, 'saldo inválido: ' + balance) }
      }
      const acc = db.query('SELECT opening_period FROM accounts WHERE id = ? AND user_id = ?', [accountID, uid()])[0]
      if (!acc) return { error: newError(ErrNotFound, 'cuenta no encontrada') }
      const opening = asString(acc.opening_period)
      if (period < opening) {
        return { error: newError(ErrValidation, 'la cuenta empieza en ' + opening + ': concilia desde ese mes') }
      }
      const now = nowIso()
      db.exec(
        `INSERT INTO account_reconciliations (user_id, account_id, period, balance, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (account_id, period) DO UPDATE SET balance = EXCLUDED.balance, updated_at = EXCLUDED.updated_at`,
        [uid(), accountID, period, real.toString(), now, now],
      )
      return {}
    },

    async DeleteAccountReconciliation(accountID: number, period: string): Promise<OpResult> {
      if (!validPeriod(period)) return { error: invalidPeriodError() }
      db.exec('DELETE FROM account_reconciliations WHERE user_id = ? AND account_id = ? AND period = ?', [uid(), accountID, period])
      if (db.changes() === 0) return { error: newError(ErrNotFound, 'esa cuenta no tiene conciliación en ese mes') }
      return {}
    },

    // ---------- category budgets (presupuestos) ----------

    async SetCategoryBudget(categoryID: number, fromPeriod: string, amount: string): Promise<OpResult> {
      const parsed = amountOrError(amount)
      if (parsed.error || !parsed.amount) return { error: parsed.error ?? invalidAmountError(amount) }
      return putCategoryBudget(categoryID, fromPeriod, parsed.amount.toString(), true)
    },

    async RemoveCategoryBudget(categoryID: number, fromPeriod: string): Promise<OpResult> {
      return putCategoryBudget(categoryID, fromPeriod, '0', false)
    },

    async SetCategoryRollover(categoryID: number, on: boolean): Promise<OpResult> {
      db.exec('UPDATE categories SET rollover = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL', [
        on ? 1 : 0,
        categoryID,
        uid(),
      ])
      if (db.changes() === 0) return { error: newError(ErrNotFound, 'categoría no encontrada') }
      return {}
    },

    async ListCategoryBudgets(period: string): Promise<CategoryBudgetsResult> {
      if (!validPeriod(period)) return { error: invalidPeriodError() }
      return { data: budgetsInEffect(period) }
    },

    // ---------- personalization (mirror of look.go) ----------

    async SetCategoryLook(categoryID: number, icon: string, color: string): Promise<OpResult> {
      if (!validIcon(icon)) return { error: invalidLookError('ícono') }
      if (!validColor(color)) return { error: invalidLookError('color') }
      db.exec('UPDATE categories SET icon = ?, color = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL', [
        icon,
        color,
        categoryID,
        uid(),
      ])
      if (db.changes() === 0) return { error: newError(ErrNotFound, 'categoría no encontrada') }
      return {}
    },

    async SetCardColor(cardID: number, color: string): Promise<OpResult> {
      if (!validColor(color)) return { error: invalidLookError('color') }
      db.exec('UPDATE cards SET color = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL', [color, cardID, uid()])
      if (db.changes() === 0) return { error: newError(ErrNotFound, 'tarjeta no encontrada') }
      return {}
    },

    async SetSavingsGoalIcon(goalID: number, icon: string): Promise<OpResult> {
      if (!validIcon(icon)) return { error: invalidLookError('ícono') }
      db.exec('UPDATE savings_goals SET icon = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL', [icon, goalID, uid()])
      if (db.changes() === 0) return { error: newError(ErrNotFound, 'meta no encontrada') }
      return {}
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
        const refs = expenseReferencesSQL('1 = 1', '1 = 1')
        where.push(
          `(description LIKE ? ESCAPE '\\' OR merchant LIKE ? ESCAPE '\\' OR bank_description LIKE ? ESCAPE '\\'` +
            ` OR id IN (SELECT expense_id FROM (${refs}) WHERE reference LIKE ? ESCAPE '\\'))`,
        )
        params.push(pattern, pattern, pattern, uid(), uid(), uid(), pattern)
      }
      const category = f.category.trim()
      if (category === uncategorized) {
        where.push("category = ''")
      } else if (category !== '') {
        where.push('category = ?')
        params.push(category)
      }
      const tag = f.tag.trim().split(/\s+/).join(' ')
      if (tag !== '') {
        where.push(`id IN (SELECT et.expense_id FROM expense_tags AS et JOIN tags AS tg ON tg.id = et.tag_id
          WHERE tg.user_id = ? AND tg.name_key = ?)`)
        params.push(uid(), tagKey(tag))
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
      // The sum covers every match, not just this page.
      let sum = Money.zero()
      for (const r of db.query(`SELECT installment_amount, installments_total FROM expenses WHERE ${clause}`, params)) {
        sum = sum.add(Money.fromString(asString(r.installment_amount)).mulInt(Math.max(asNumber(r.installments_total), 1)))
      }
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
      const tagsOf = tagsByExpense(expenses.map((e) => e.id))
      const refsOf = referencesByExpense(expenses.map((e) => e.id))
      const items: ExpenseHit[] = expenses.map((ex) => {
        const sp = spans.get(ex.id)
        return {
          expense: ex,
          cardName: ex.cardId != null ? (cardByID.get(ex.cardId)?.name ?? '') : '',
          firstPeriod: sp?.first ?? '',
          lastPeriod: sp?.last ?? '',
          total: Money.fromString(ex.installmentAmount).mulInt(Math.max(ex.installmentsTotal, 1)).toString(),
          paidCount: sp?.paid ?? 0,
          tags: tagsOf.get(ex.id) ?? [],
          references: refsOf.get(ex.id) ?? [],
        }
      })
      return { data: { items, count, sum: sum.toString() } }
    },

    // ---------- tags (mirror backend/finance/tag.go) ----------

    async SetExpenseTags(expenseID: number, names: string[]): Promise<OpResult> {
      const clean = normalizeTags(names)
      if (clean.error || !clean.names) return { error: clean.error ?? newError(ErrValidation, 'etiquetas inválidas') }
      const cleanNames = clean.names
      return db.transaction((): OpResult => {
        const owned = db.query('SELECT 1 FROM expenses WHERE id = ? AND user_id = ? AND deleted_at IS NULL', [expenseID, uid()])
        if (owned.length === 0) return { error: newError(ErrNotFound, 'gasto no encontrado') }
        const tagIDs = cleanNames.map(ensureTag)
        db.exec('DELETE FROM expense_tags WHERE expense_id = ?', [expenseID])
        for (const id of tagIDs) db.exec('INSERT INTO expense_tags (expense_id, tag_id) VALUES (?, ?)', [expenseID, id])
        return {}
      })
    },

    async ListTags(): Promise<TagView[]> {
      return db
        .query(
          `SELECT tg.*, (
             SELECT COUNT(*) FROM expense_tags AS et JOIN expenses AS e ON e.id = et.expense_id
             WHERE et.tag_id = tg.id AND e.deleted_at IS NULL
           ) AS count
           FROM tags AS tg WHERE tg.user_id = ? ORDER BY tg.name_key`,
          [uid()],
        )
        .map((r) => ({ ...rowToTag(r), count: asNumber(r.count) }))
    },

    async RenameTag(id: number, name: string): Promise<OpResult> {
      const clean = cleanTagName(name)
      if (clean.error || clean.name === undefined) return { error: clean.error ?? newError(ErrValidation, 'etiqueta inválida') }
      const taken = db.query('SELECT 1 FROM tags WHERE user_id = ? AND name_key = ? AND id <> ?', [uid(), tagKey(clean.name), id])
      if (taken.length > 0) return { error: newError(ErrConflict, 'ya existe una etiqueta con ese nombre') }
      db.exec('UPDATE tags SET name = ?, name_key = ? WHERE id = ? AND user_id = ?', [clean.name, tagKey(clean.name), id, uid()])
      if (db.changes() === 0) return { error: newError(ErrNotFound, 'etiqueta no encontrada') }
      return {}
    },

    async DeleteTag(id: number): Promise<OpResult> {
      db.exec('DELETE FROM tags WHERE id = ? AND user_id = ?', [id, uid()])
      if (db.changes() === 0) return { error: newError(ErrNotFound, 'etiqueta no encontrada') }
      return {}
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

    // WithdrawSavings mirrors the Go method: a negative contribution, never
    // more than the goal holds.
    async WithdrawSavings(goalID: number, period: string, amount: string): Promise<SavingsContributionResult> {
      if (!validPeriod(period)) return { error: invalidPeriodError() }
      const parsed = amountOrError(amount)
      if (parsed.error || !parsed.amount) return { error: parsed.error ?? invalidAmountError(amount) }
      if (parsed.amount.isZero()) return { error: newError(ErrValidation, 'el retiro debe ser mayor a 0') }
      const amt = parsed.amount
      return db.transaction((): SavingsContributionResult => {
        const owned = db.query('SELECT 1 FROM savings_goals WHERE id = ? AND user_id = ? AND deleted_at IS NULL', [
          goalID,
          uid(),
        ])
        if (owned.length === 0) return { error: newError(ErrNotFound, 'meta no encontrada') }
        const saved = goalBalance(goalID)
        if (amt.gt(saved)) {
          return { error: newError(ErrValidation, `no puedes retirar más de lo ahorrado en la meta (${saved.toString()})`) }
        }
        const row = db.query(
          `INSERT INTO savings_contributions (user_id, goal_id, period, amount, created_at)
           VALUES (?, ?, ?, ?, ?) RETURNING *`,
          [uid(), goalID, period, Money.zero().sub(amt).toString(), nowIso()],
        )[0]
        if (!row) throw new Error('INSERT savings_contributions RETURNING produced no row')
        return { data: rowToSavingsContribution(row) }
      })
    },

    // Contributions of a goal in the trash stay untouched until it is restored;
    // deleting one may never leave its goal below zero.
    async DeleteSavingsContribution(id: number): Promise<OpResult> {
      const user = uid()
      return db.transaction((): OpResult => {
        const row = db.query(
          `SELECT * FROM savings_contributions WHERE id = ? AND user_id = ?
           AND goal_id IN (SELECT id FROM savings_goals WHERE user_id = ? AND deleted_at IS NULL)`,
          [id, user, user],
        )[0]
        if (!row) return { error: newError(ErrNotFound, 'aporte no encontrado') }
        const c = rowToSavingsContribution(row)
        if (goalBalance(c.goalId).sub(Money.fromString(c.amount)).isNegative()) {
          return { error: newError(ErrConflict, 'la meta quedaría negativa: elimina primero el retiro') }
        }
        db.exec('DELETE FROM savings_contributions WHERE id = ?', [id])
        return {}
      })
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

    // ---------- import inbox ----------

    async StageImport(batch: ImportBatch): Promise<StageResult> {
      const v = validateBatch(batch)
      if (v.error || !v.items) return { error: v.error ?? newError(ErrValidation, 'lote inválido') }
      const items = v.items
      return db.transaction((): StageResult => ({ data: stageItems(items).sum }))
    },

    async ListImportItems(status: string): Promise<ImportItemsResult> {
      if (!validImportStatus(status)) return { error: newError(ErrValidation, 'estado inválido: ' + status) }
      const items = db
        .query('SELECT * FROM import_items WHERE user_id = ? AND status = ? ORDER BY date DESC, id DESC', [
          uid(),
          status,
        ])
        .map(rowToImportItem)
      const cardByDigits = cardsByLastDigits(listCardsActive())
      const rules = listMerchantRules()
      const usualCategory = merchantCategories()
      const fx = latestFxRate()
      const suggestFixed = status === ImportPendiente ? fixedSuggester() : null
      const cutoffs = cutoffsFor()
      const reopenable = status === ImportConfirmado ? reopenableIds() : new Set<number>()
      const findDuplicate = duplicateFinder(items)
      const findRefunded = refundFinder(items)
      const matchedByID = matchedItemsOf(items)
      const data = items.map((it): ImportItemView => {
        const card = cardByDigits.get(it.cardLastDigits)
        const rule = ruleFor(rules, it.description)
        const dup = duplicateReviewable(it) ? findDuplicate(it, card?.id ?? null) : null
        const refunded = refundReviewable(it) ? findRefunded(it, card?.id ?? null) : null
        const suggestedClp = suggestClp(it, fx)
        const fixedPeriod = billingPeriodOf(it, card ? (cutoffs.get(card.id) ?? NO_CUTOFF) : NO_CUTOFF)
        const fixed =
          suggestFixed && it.status === ImportPendiente && it.kind === ImportKindExpense
            ? suggestFixed(it, fixedPeriod, card?.id ?? null, clpAmountOf(it, suggestedClp))
            : null
        const matched = it.matchedItemId != null ? (matchedByID.get(it.matchedItemId) ?? null) : null
        return {
          ...it,
          cardId: card?.id ?? null,
          cardName: card?.name ?? '',
          rulePattern: rule?.pattern ?? '',
          suggestedMerchant: rule?.merchant ?? '',
          // A rule naming the merchant but no category takes the merchant's usual one (mirrors Go).
          suggestedCategory: rule ? rule.category || (usualCategory.get(rule.merchant.toLowerCase()) ?? '') : '',
          suggestedPattern: suggestPattern(it.description),
          duplicateExpenseId: dup?.id ?? null,
          duplicateDescription: dup?.description ?? '',
          duplicateDate: dup ? dup.date.slice(0, 10) : '',
          matchedSource: matched?.source ?? '',
          matchedDate: matched?.date ?? '',
          suggestedAmountClp: suggestedClp,
          suggestedFixedId: fixed?.id ?? null,
          suggestedFixedDescription: fixed?.description ?? '',
          suggestedFixedPeriod: fixed ? fixedPeriod : '',
          suggestedRefundExpenseId: refunded?.id ?? null,
          suggestedRefundDescription: refunded?.description ?? '',
          reopenable: reopenable.has(it.id),
        }
      })
      return { data }
    },

    async ConfirmImportItem(
      id: number,
      dateStr: string,
      description: string,
      category: string,
      merchant: string,
      cardID: number | null,
      kind: string,
      installmentAmount: string,
      installmentsTotal: number,
      rulePattern: string,
    ): Promise<ExpenseResult> {
      const v = validateExpense(dateStr, description, category, merchant, cardID, kind, installmentAmount, installmentsTotal)
      if (v.error || !v.expense) return { error: v.error ?? newError(ErrValidation, 'gasto inválido') }
      const ex = v.expense
      const pattern = validateRulePattern(rulePattern)
      if (pattern.error) return { error: pattern.error }
      const billing = cutoffFor(cardID)
      if (billing.error) return { error: billing.error }
      return db.transaction((): ExpenseResult => {
        const pending = loadPendingItem(id)
        if (pending.error || !pending.item) return { error: pending.error ?? newError(ErrNotFound, 'movimiento no encontrado') }
        const item = pending.item
        const refused = requireKind(item, ImportKindExpense) ?? requirePesos(item, ex.installmentAmount)
        if (refused) return { error: refused }
        // A card statement places the purchase exactly: cuota n/N started n-1
        // months before it (the earlier cuotas are paid), and a one-payment
        // purchase or fee is billed in the statement's month.
        const placed = item.firstPeriod !== '' && ex.installmentsTotal === item.installmentsTotal
        const created = placed
          ? insertExpense(ex, billing.cutoff, item.firstPeriod, item.installmentNumber - 1)
          : insertExpense(ex, billing.cutoff)
        if (bankRounded(item, ex.installmentsTotal, ex.installmentAmount)) {
          settleLastCuota(created.id, Money.fromString(item.amount))
        }
        recordItemCurrency(item, created.id, ex.installmentAmount.mulInt(Math.max(ex.installmentsTotal, 1)))
        db.exec('UPDATE import_items SET status = ?, expense_id = ? WHERE id = ? AND user_id = ?', [
          ImportConfirmado,
          created.id,
          id,
          uid(),
        ])
        if (pattern.pattern !== '') {
          db.exec(
            `INSERT INTO merchant_rules (user_id, pattern, merchant, category, created_at) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (user_id, pattern) DO UPDATE SET merchant = EXCLUDED.merchant, category = EXCLUDED.category`,
            [uid(), pattern.pattern, ex.merchant, ex.category, nowIso()],
          )
        }
        return { data: created }
      })
    },

    async LinkImportItem(id: number, expenseID: number): Promise<OpResult> {
      return db.transaction((): OpResult => {
        const pending = loadPendingItem(id)
        if (pending.error || !pending.item) return { error: pending.error ?? newError(ErrNotFound, 'movimiento no encontrado') }
        const wrongKind = requireKind(pending.item, ImportKindExpense)
        if (wrongKind) return { error: wrongKind }
        const exRow = db.query('SELECT * FROM expenses WHERE id = ? AND user_id = ? AND deleted_at IS NULL', [
          expenseID,
          uid(),
        ])[0]
        if (!exRow) return { error: newError(ErrNotFound, 'gasto no encontrado') }
        // An expense is one purchase: it takes the sighting of one item only.
        const taken = db.query('SELECT 1 FROM import_items WHERE user_id = ? AND expense_id = ? AND id <> ?', [
          uid(),
          expenseID,
          id,
        ])
        if (taken.length > 0) {
          return { error: newError(ErrConflict, 'ese gasto ya está enlazado a otro movimiento del banco') }
        }
        // Merged like Go's LinkImportItem: the bank's date, amount and month, the user's words.
        const ex = rowToExpense(exRow)
        mergeIntoExpense(pending.item, ex, cutoffOfExpense(ex))
        return {}
      })
    },

    async DiscardImportItem(id: number): Promise<OpResult> {
      return moveImportItem(id, ImportPendiente, ImportDescartado)
    },

    async LinkImportItemToFixed(id: number, fixedID: number, period: string): Promise<OpResult> {
      if (!validPeriod(period)) return { error: invalidPeriodError() }
      return db.transaction((): OpResult => {
        const pending = loadPendingItem(id)
        if (pending.error || !pending.item) return { error: pending.error ?? newError(ErrNotFound, 'movimiento no encontrado') }
        const item = pending.item
        const wrongKind = requireKind(item, ImportKindExpense)
        if (wrongKind) return { error: wrongKind }
        const fe = ownFixedExpense(fixedID)
        if (!fe) return { error: newError(ErrNotFound, 'gasto fijo no encontrado') }
        const outside = requireBillsIn(fe, period, 'enlazarlo')
        if (outside) return { error: outside }
        const taken = db.query(
          'SELECT 1 FROM import_items WHERE user_id = ? AND fixed_expense_id = ? AND fixed_period = ?',
          [uid(), fixedID, period],
        )
        if (taken.length > 0) {
          return { error: newError(ErrConflict, 'ese mes del gasto fijo ya está enlazado a otro movimiento del banco') }
        }
        // A fixed expense in UF keeps its UF amounts: a peso charge is not an amount in UF (mirrors Go).
        if (item.currency === CurrencyCLP && fe.currency !== CurrencyUF) applyMonthAmount(fe, period, Money.fromString(item.amount))
        db.exec(
          `INSERT INTO fixed_expense_payments (fixed_expense_id, period, paid_at) VALUES (?, ?, ?)
           ON CONFLICT (fixed_expense_id, period) DO UPDATE SET paid_at = EXCLUDED.paid_at`,
          [fixedID, period, nowIso()],
        )
        db.exec(
          'UPDATE import_items SET status = ?, fixed_expense_id = ?, fixed_period = ? WHERE id = ? AND user_id = ?',
          [ImportConfirmado, fixedID, period, id, uid()],
        )
        return {}
      })
    },

    // RestoreImportItem mirrors Go: a discarded item, or a confirmed one whose
    // targets all went to the trash, goes back to review without its old link.
    async RestoreImportItem(id: number): Promise<OpResult> {
      const row = db.query('SELECT * FROM import_items WHERE id = ? AND user_id = ?', [id, uid()])[0]
      if (!row) return { error: newError(ErrNotFound, 'movimiento no encontrado') }
      if (rowToImportItem(row).status !== ImportConfirmado) return moveImportItem(id, ImportDescartado, ImportPendiente)
      return db.transaction((): OpResult => {
        if (!reopenableIds().has(id)) {
          return {
            error: newError(ErrConflict, 'el movimiento sigue registrado: elimina primero el gasto o ingreso que creó'),
          }
        }
        db.exec(
          `UPDATE import_items SET status = ?, expense_id = NULL, income_id = NULL, fixed_expense_id = NULL,
           fixed_period = '', refund_id = NULL WHERE id = ? AND user_id = ? AND status = ?`,
          [ImportPendiente, id, uid(), ImportConfirmado],
        )
        return {}
      })
    },

    async ListMerchantRules(): Promise<MerchantRule[]> {
      return listMerchantRules()
    },

    async DeleteMerchantRule(id: number): Promise<OpResult> {
      db.exec('DELETE FROM merchant_rules WHERE id = ? AND user_id = ?', [id, uid()])
      if (db.changes() === 0) return { error: newError(ErrNotFound, 'regla no encontrada') }
      return {}
    },

    async ConfirmImportItemAsIncome(
      id: number,
      period: string,
      description: string,
      amount: string,
    ): Promise<IncomeResult> {
      if (!validPeriod(period)) return { error: invalidPeriodError() }
      const desc = description.trim()
      if (desc === '') return { error: newError(ErrValidation, 'la descripción es obligatoria') }
      const parsed = amountOrError(amount)
      if (parsed.error || !parsed.amount) return { error: parsed.error ?? invalidAmountError(amount) }
      if (parsed.amount.isZero()) return { error: newError(ErrValidation, 'el monto debe ser mayor a 0') }
      const amt = parsed.amount
      return db.transaction((): IncomeResult => {
        const pending = loadPendingItem(id)
        if (pending.error || !pending.item) return { error: pending.error ?? newError(ErrNotFound, 'movimiento no encontrado') }
        const refused = requireKind(pending.item, ImportKindCredit) ?? requirePesos(pending.item, amt)
        if (refused) return { error: refused }
        const inc = rowToIncome(
          insertReturning('incomes', {
            userId: uid(),
            period,
            description: desc,
            amount: amt.toString(),
            createdAt: nowIso(),
          }),
        )
        db.exec('UPDATE import_items SET status = ?, income_id = ? WHERE id = ? AND user_id = ?', [
          ImportConfirmado,
          inc.id,
          id,
          uid(),
        ])
        return { data: inc }
      })
    },

    async ConfirmImportItemAsRefund(id: number, expenseID: number, period: string, amount: string): Promise<RefundResult> {
      return db.transaction((): RefundResult => {
        const pending = loadPendingItem(id)
        if (pending.error || !pending.item) return { error: pending.error ?? newError(ErrNotFound, 'movimiento no encontrado') }
        const kind = requireKind(pending.item, ImportKindCredit)
        if (kind) return { error: kind }
        const parsed = amountOrError(amount)
        if (parsed.error || !parsed.amount) return { error: parsed.error ?? invalidAmountError(amount) }
        const notPesos = requirePesos(pending.item, parsed.amount)
        if (notPesos) return { error: notPesos }
        const res = insertRefund(expenseID, period, amount, pending.item.description)
        if (res.error || !res.data) return res
        db.exec('UPDATE import_items SET status = ?, refund_id = ? WHERE id = ? AND user_id = ?', [
          ImportConfirmado,
          res.data.id,
          id,
          uid(),
        ])
        return res
      })
    },

    // ---------- card statements ----------

    async ImportCardStatement(input: CardStatementInput): Promise<CardStatementImportResult> {
      const v = validateStatement(uid(), input)
      if (v.error || !v.value) return { error: v.error ?? newError(ErrValidation, 'estado de cuenta inválido') }
      const { statement, lines, schedule } = v.value
      try {
        return db.transaction((): CardStatementImportResult => {
          const out: CardStatementImport = {
            statementId: 0,
            alreadyImported: false,
            added: 0,
            duplicates: 0,
            reconciled: 0,
            linkedInstallments: 0,
            paymentsMatched: 0,
            merged: 0,
          }
          const existing = db.query(
            'SELECT id FROM card_statements WHERE user_id = ? AND card_last_digits = ? AND kind = ? AND statement_date = ?',
            [uid(), statement.cardLastDigits, statement.kind, statement.statementDate],
          )[0]
          if (existing) {
            out.statementId = asNumber(existing.id)
            out.alreadyImported = true
            return { data: out }
          }
          const card = cardByDigits(statement.cardLastDigits)
          const st = rowToCardStatement(
            insertReturning('card_statements', {
              ...statement,
              cardId: card?.id ?? null,
              fxRate: '',
              importedAt: nowIso(),
            }),
          )
          out.statementId = st.id
          for (const e of schedule) insertReturning('card_statement_schedule', { statementId: st.id, ...e })
          const stored = lines.map((l) => rowToCardStatementLine(insertReturning('card_statement_lines', { ...l, statementId: st.id })))
          feedInbox(st, card, stored, out)
          return { data: out }
        })
      } catch (err) {
        if (err instanceof TxAbort) return { error: err.appError }
        throw err
      }
    },

    async ListCardStatements(period: string): Promise<CardStatementsResult> {
      if (period !== '' && !validPeriod(period)) return { error: invalidPeriodError() }
      const where = period !== '' ? 'AND period = ?' : ''
      const params: SqlValue[] = period !== '' ? [uid(), period] : [uid()]
      const sts = db
        .query(`SELECT * FROM card_statements WHERE user_id = ? ${where} ORDER BY statement_date DESC, kind ASC, id DESC`, params)
        .map(rowToCardStatement)
      const sc = statementsContext(sts)
      return { data: sts.map((st) => statementView(st, sc)) }
    },

    async GetCardStatement(id: number): Promise<CardStatementDetailResult> {
      const row = db.query('SELECT * FROM card_statements WHERE id = ? AND user_id = ?', [id, uid()])[0]
      if (!row) return { error: newError(ErrNotFound, 'estado de cuenta no encontrado') }
      const st = rowToCardStatement(row)
      const statement = statementView(st, statementsContext([st]))
      const schedule = db
        .query('SELECT * FROM card_statement_schedule WHERE statement_id = ? ORDER BY period ASC', [id])
        .map(rowToScheduleEntry)
      const lines = db
        .query('SELECT * FROM card_statement_lines WHERE statement_id = ? AND user_id = ? ORDER BY position ASC', [id, uid()])
        .map(rowToCardStatementLine)
      return { data: { statement, lines: lines.map((l) => lineView(l, lines)), schedule } }
    },

    // DeleteCardStatement forgets a statement (to re-import it after a parser
    // fix). Its inbox items and linked expenses stay.
    async DeleteCardStatement(id: number): Promise<OpResult> {
      db.exec('DELETE FROM card_statements WHERE id = ? AND user_id = ?', [id, uid()])
      if (db.changes() === 0) return { error: newError(ErrNotFound, 'estado de cuenta no encontrado') }
      return {}
    },

    // ---------- trash (papelera) ----------

    async PurgeTrashItem(itemType: string, id: number): Promise<OpResult> {
      const table = trashTables[itemType]
      if (!table) return { error: newError(ErrValidation, 'tipo de elemento inválido: ' + itemType) }
      db.exec(`DELETE FROM ${table} WHERE id = ? AND user_id = ? AND deleted_at IS NOT NULL`, [id, uid()])
      if (db.changes() === 0) return { error: newError(ErrNotFound, 'el elemento no está en la papelera') }
      return {}
    },

    async EmptyTrash(): Promise<OpResult> {
      db.transaction(() => {
        for (const table of Object.values(trashTables)) {
          db.exec(`DELETE FROM ${table} WHERE user_id = ? AND deleted_at IS NOT NULL`, [uid()])
        }
      })
      return {}
    },

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

      const { fixed, amountsByID, uf } = loadFixed(true)
      const now = currentPeriod()
      for (const fe of fixed) {
        out.push({
          type: 'fixedexpense',
          id: fe.id,
          description: fe.description,
          // In pesos, like every trash amount.
          amount: fixedCharge(fe, amountsByID.get(fe.id) ?? [], uf, fixedDisplayPeriod(fe, now)).clp.toString(),
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
