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
  MerchantResult,
  MerchantRule,
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
  StageResult,
  StageSummary,
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
  inYearRange,
  MAX_YEAR,
  MIN_YEAR,
  monthOf,
  monthsBetween,
  periodOf,
  validPeriod,
  type DateParts,
} from '@/engine/finance/period'
import { activeIn, latestAsOf, resolveAsOf, sumAsOf, type EffectiveDated } from '@/engine/finance/fixedexpense'
import { normalizeDescriptor, ruleFor, suggestPattern } from '@/engine/finance/descriptor'
import { amountGap, namesMatch } from '@/engine/finance/fixedmatch'
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
  ImportSourceEmail,
  ImportSourcePDFAccount,
  ImportSourcePDFCard,
  KindCuotas,
  KindUnico,
  LineCharge,
  LineCredit,
  LinePayment,
  LinePurchase,
  LineVoluntary,
  SourceCuota,
  SourceFijo,
  StatementInternational,
  StatementNational,
  StatusPagado,
  StatusPendiente,
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
// duplicateWindowDays: how far a manually entered expense may be from the
// detected movement and still be offered as "probably the same purchase".
const duplicateWindowDays = 2

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
  if (![ImportSourceEmail, ImportSourcePDFAccount, ImportSourcePDFCard].includes(batch.source)) {
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
  return [LinePayment, LinePurchase, LineVoluntary, LineCharge, LineCredit].includes(s)
}

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
    const number = Math.max(l.installmentNumber, 1)
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

// clpAmountOf mirrors the Go helper: the item's amount in pesos (its own for a
// CLP item, the suggested conversion for a USD one), or null when unknown.
function clpAmountOf(it: ImportItem, suggestedClp: string): Money | null {
  if (it.currency === 'CLP') return Money.fromString(it.amount)
  return suggestedClp === '' ? null : Money.fromString(suggestedClp)
}

// billingPeriodOf mirrors the Go helper: the month the statement states, else
// the date rolled by the card's cutoff (0 = no card).
function billingPeriodOf(it: ImportItem, billingDay: number): string {
  return it.firstPeriod !== '' ? it.firstPeriod : periodOf(storedDateParts(it.date), billingDay)
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

  // billingDayFor: the card's cutoff day, or 0 (no roll) without a card. A card
  // in the trash is accepted only with allowTrashed: an edit may keep the card a
  // row already had, but nothing new may be charged to it.
  function billingDayFor(
    cardID: number | null,
    allowTrashed = false,
  ): { day: number; error?: ReturnType<typeof newError> } {
    if (cardID == null) return { day: 0 }
    const live = allowTrashed ? '' : ' AND deleted_at IS NULL'
    const rows = db.query(`SELECT * FROM cards WHERE id = ? AND user_id = ?${live}`, [cardID, uid()])
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
  // (card statement lines link to them) and a paid cuota is never rewritten:
  // the new amount reaches pending cuotas only, and an edit that would drop a
  // paid cuota or move the plan to other months is refused. It checks before
  // writing anything, so a refusal leaves the plan untouched.
  function replanInstallments(
    expenseId: number,
    ex: ValidatedExpense,
    placement: PlacementChange,
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
    const current = byNumber.get(1)
    const first = current && placement.before === placement.after ? current.period : placement.after
    if (lastPaid > 0 && current && first !== current.period) {
      return newError(
        ErrValidation,
        'el cambio mueve las cuotas a otros meses y hay cuotas pagadas: desmárcalas para moverlo',
      )
    }

    const amount = ex.installmentAmount.toString()
    for (let n = 1; n <= total; n++) {
      const period = addMonths(first, n - 1)
      const inst = byNumber.get(n)
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
          amount,
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
    billingDay: number,
    paidCount: number,
    firstPeriod = '',
  ): void {
    const total = ex.kind === KindUnico ? 1 : ex.installmentsTotal
    const first = firstPeriod !== '' ? firstPeriod : periodOf(ex.date.parts, billingDay)
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
  function insertExpense(ex: ValidatedExpense, billingDay: number, firstPeriod = '', paidCount = 0): Expense {
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
    generateInstallments(created.id, ex, billingDay, paidCount, firstPeriod)
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

  // findDuplicateExpense mirrors the Go helper: a live expense not yet linked to
  // an import item, within duplicateWindowDays, whose cuota or total equals the
  // amount and, when the item's card is known, on that card.
  function findDuplicateExpense(item: ImportItem, cardId: number | null): Expense | null {
    const params: SqlValue[] = [uid(), item.date, duplicateWindowDays, uid()]
    let cardFilter = ''
    if (cardId != null) {
      cardFilter = 'AND card_id = ?'
      params.push(cardId)
    }
    params.push(item.date)
    const rows = db.query(
      `SELECT * FROM expenses WHERE user_id = ? AND deleted_at IS NULL
       AND ABS(julianday(substr(date, 1, 10)) - julianday(?)) <= ?
       AND id NOT IN (SELECT expense_id FROM import_items WHERE user_id = ? AND expense_id IS NOT NULL)
       ${cardFilter}
       ORDER BY ABS(julianday(substr(date, 1, 10)) - julianday(?)) ASC, id ASC`,
      params,
    )
    const amount = Money.fromString(item.amount)
    for (const r of rows) {
      const ex = rowToExpense(r)
      const cuota = Money.fromString(ex.installmentAmount)
      if (cuota.cmp(amount) === 0 || cuota.mulInt(ex.installmentsTotal).cmp(amount) === 0) return ex
    }
    return null
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
         kind, statement_line_id, installment_number, installment_amount, first_period)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
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
  function feedInbox(st: CardStatement, card: Card | null, lines: CardStatementLine[], out: CardStatementImport): void {
    const candidates: ImportCandidate[] = []
    const staged: CardStatementLine[] = []
    for (const l of lines) {
      if (l.section === LinePayment) {
        out.paymentsMatched += reconcilePaymentLine(st, l)
        continue
      }
      if (l.section === LinePurchase || l.section === LineVoluntary) {
        const instId = continuedInstallment(card, l)
        if (instId != null) {
          db.exec('UPDATE card_statement_lines SET installment_id = ? WHERE id = ?', [instId, l.id])
          out.linkedInstallments++
          continue
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
    out.added = sum.added
    out.duplicates = sum.duplicates
    out.reconciled = sum.reconciled
    ids.forEach((id, k) => {
      db.exec('UPDATE card_statement_lines SET import_item_id = ? WHERE id = ?', [id, staged[k]?.id ?? null])
    })
  }

  // statementView adds the bank-vs-app comparison. bankCharges is what the app
  // should have as expenses on the card for the period (purchases, products and
  // charges billed this month); credits are income, payments move money.
  async function statementView(
    st: CardStatement,
    cardByID: Map<number, Card>,
    appByPeriod: Map<string, Map<number, string>>,
  ): Promise<CardStatementView> {
    let bankCharges = Money.zero()
    let bankCredits = Money.zero()
    for (const r of db.query('SELECT * FROM card_statement_lines WHERE statement_id = ? AND user_id = ?', [st.id, uid()])) {
      const l = rowToCardStatementLine(r)
      const amount = Money.fromString(l.installmentAmount)
      if (l.section === LinePurchase || l.section === LineVoluntary || l.section === LineCharge) {
        bankCharges = bankCharges.add(amount)
      } else if (l.section === LineCredit) {
        bankCredits = bankCredits.add(amount.abs())
      }
    }
    const pending = db.query(
      `SELECT COUNT(*) AS n FROM import_items WHERE user_id = ? AND status = ?
       AND statement_line_id IN (SELECT id FROM card_statement_lines WHERE statement_id = ?)`,
      [uid(), ImportPendiente, st.id],
    )[0]
    const v: CardStatementView = {
      ...st,
      cardName: '',
      bankCharges: bankCharges.toString(),
      bankCredits: bankCredits.toString(),
      appCharges: null,
      pendingItems: asNumber(pending?.n),
    }
    if (st.cardId == null) return v
    v.cardName = cardByID.get(st.cardId)?.name ?? ''
    if (st.currency !== 'CLP') return v // the app keeps CLP only: USD lines are compared in the inbox
    let byCard = appByPeriod.get(st.period)
    if (!byCard) {
      const res = await service.MonthlySummary(st.period)
      if (res.error || !res.data) throw new Error(`summarizing ${st.period}: ${res.error?.message ?? 'no data'}`)
      byCard = new Map(res.data.porTarjeta.map((d) => [d.card.id, d.gastoMes]))
      appByPeriod.set(st.period, byCard)
    }
    v.appCharges = byCard.get(st.cardId) ?? '0'
    return v
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

  // fixedSuggester mirrors Go's fixedIndex.suggest: the live fixed expense whose
  // still-unpaid month the item most likely bills — same name, amount within
  // the tolerance (closest wins), same card when both name one.
  function fixedSuggester(): (it: ImportItem, period: string, cardId: number | null, clp: Money | null) => FixedExpense | null {
    const { fixed, amountsByID } = loadFixed(false)
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
        if (!activeIn(fe, period) || paid.has(`${fe.id}|${period}`)) continue
        if (fe.cardId != null && cardId != null && fe.cardId !== cardId) continue
        if (!namesMatch(fe.description, it.description)) continue
        const gap = amountGap(clp, resolveAsOf(amountsByID.get(fe.id) ?? [], period))
        if (gap === null) continue
        if (bestGap === null || gap.cmp(bestGap) < 0) {
          best = fe
          bestGap = gap
        }
      }
      return best
    }
  }

  // reopenableIds mirrors Go's reopenableItems: confirmed items whose every
  // target (expense, income, fixed expense) is in the trash or gone.
  function reopenableIds(): Set<number> {
    const rows = db.query(
      `SELECT ii.id FROM import_items AS ii
       LEFT JOIN expenses AS e ON e.id = ii.expense_id
       LEFT JOIN incomes AS inc ON inc.id = ii.income_id
       LEFT JOIN fixed_expenses AS f ON f.id = ii.fixed_expense_id
       WHERE ii.user_id = ? AND ii.status = ?
         AND (e.id IS NULL OR e.deleted_at IS NOT NULL)
         AND (inc.id IS NULL OR inc.deleted_at IS NOT NULL)
         AND (f.id IS NULL OR f.deleted_at IS NOT NULL)`,
      [uid(), ImportConfirmado],
    )
    return new Set(rows.map((r) => asNumber(r.id)))
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

    async CreateCard(name: string, creditLimit: string, billingDay: number, lastDigits: string): Promise<CardResult> {
      if (name.trim() === '') return { error: newError(ErrValidation, 'el nombre es obligatorio') }
      const parsed = amountOrError(creditLimit)
      if (parsed.error || !parsed.amount) return { error: parsed.error ?? invalidAmountError(creditLimit) }
      const digits = validateLastDigits(lastDigits)
      if (digits.error) return { error: digits.error }
      const day = billingDay < 1 || billingDay > 28 ? 24 : billingDay
      const row = db.query(
        `INSERT INTO cards (user_id, name, credit_limit, billing_day, last_digits, created_at)
         VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
        [uid(), name.trim(), parsed.amount.toString(), day, digits.digits, nowIso()],
      )[0]
      if (!row) return { error: newError(ErrNotFound, 'tarjeta no encontrada') }
      return { data: rowToCard(row) }
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
      db.exec(
        `UPDATE cards SET name = ?, credit_limit = ?, billing_day = ?, last_digits = ?
         WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
        [name.trim(), parsed.amount.toString(), day, digits.digits, id, uid()],
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
      return db.transaction((): ExpenseResult => ({ data: insertExpense(ex, billing.day) }))
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
      const billing = billingDayFor(cardID, old.cardId === cardID)
      if (billing.error) return { error: billing.error }
      // The old card row is gone: its expense was never on a known cutoff.
      const oldBillingDay = billingDayFor(old.cardId, true).day
      // The cuota-1 month the old and new inputs lead to (see replanInstallments).
      const placement: PlacementChange = {
        before: periodOf(storedDateParts(old.date), oldBillingDay),
        after: periodOf(ex.date.parts, billing.day),
      }
      return db.transaction((): ExpenseResult => {
        // A returned error still commits here (only a throw rolls back), so the
        // replan refuses before writing anything and runs before the UPDATE.
        const refused = replanInstallments(id, ex, placement)
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
      const old = ownFixedExpense(id)
      if (!old) return { error: newError(ErrNotFound, 'gasto fijo no encontrado') }
      const billing = billingDayFor(cardID, old.cardId === cardID)
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
          const outside = requireActiveIn(fe, period, 'marcarlo pagado')
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

    // Contributions of a goal in the trash stay untouched until it is restored.
    async DeleteSavingsContribution(id: number): Promise<OpResult> {
      const user = uid()
      db.exec(
        `DELETE FROM savings_contributions WHERE id = ? AND user_id = ?
         AND goal_id IN (SELECT id FROM savings_goals WHERE user_id = ? AND deleted_at IS NULL)`,
        [id, user, user],
      )
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
      const fx = latestFxRate()
      const suggestFixed = status === ImportPendiente ? fixedSuggester() : null
      const reopenable = status === ImportConfirmado ? reopenableIds() : new Set<number>()
      const data = items.map((it): ImportItemView => {
        const card = cardByDigits.get(it.cardLastDigits)
        const rule = ruleFor(rules, it.description)
        const reviewable = it.status === ImportPendiente && it.kind !== ImportKindCredit && it.currency === 'CLP'
        const dup = reviewable ? findDuplicateExpense(it, card?.id ?? null) : null
        const suggestedClp = suggestClp(it, fx)
        const fixedPeriod = billingPeriodOf(it, card?.billingDay ?? 0)
        const fixed =
          suggestFixed && it.status === ImportPendiente && it.kind === ImportKindExpense
            ? suggestFixed(it, fixedPeriod, card?.id ?? null, clpAmountOf(it, suggestedClp))
            : null
        const matchedRow =
          it.matchedItemId != null
            ? db.query('SELECT * FROM import_items WHERE id = ? AND user_id = ?', [it.matchedItemId, uid()])[0]
            : undefined
        const matched = matchedRow ? rowToImportItem(matchedRow) : null
        return {
          ...it,
          cardId: card?.id ?? null,
          cardName: card?.name ?? '',
          rulePattern: rule?.pattern ?? '',
          suggestedMerchant: rule?.merchant ?? '',
          suggestedCategory: rule?.category ?? '',
          suggestedPattern: suggestPattern(it.description),
          duplicateExpenseId: dup?.id ?? null,
          duplicateDescription: dup?.description ?? '',
          matchedSource: matched?.source ?? '',
          matchedDate: matched?.date ?? '',
          suggestedAmountClp: suggestedClp,
          suggestedFixedId: fixed?.id ?? null,
          suggestedFixedDescription: fixed?.description ?? '',
          suggestedFixedPeriod: fixed ? fixedPeriod : '',
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
      const billing = billingDayFor(cardID)
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
          ? insertExpense(ex, billing.day, item.firstPeriod, item.installmentNumber - 1)
          : insertExpense(ex, billing.day)
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
        const ok = db.query('SELECT 1 FROM expenses WHERE id = ? AND user_id = ? AND deleted_at IS NULL', [
          expenseID,
          uid(),
        ])
        if (ok.length === 0) return { error: newError(ErrNotFound, 'gasto no encontrado') }
        // An expense is one purchase: it takes the sighting of one item only.
        const taken = db.query('SELECT 1 FROM import_items WHERE user_id = ? AND expense_id = ? AND id <> ?', [
          uid(),
          expenseID,
          id,
        ])
        if (taken.length > 0) {
          return { error: newError(ErrConflict, 'ese gasto ya está enlazado a otro movimiento del banco') }
        }
        db.exec('UPDATE import_items SET status = ?, expense_id = ? WHERE id = ? AND user_id = ?', [
          ImportConfirmado,
          expenseID,
          id,
          uid(),
        ])
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
        const outside = requireActiveIn(fe, period, 'enlazarlo')
        if (outside) return { error: outside }
        const taken = db.query(
          'SELECT 1 FROM import_items WHERE user_id = ? AND fixed_expense_id = ? AND fixed_period = ?',
          [uid(), fixedID, period],
        )
        if (taken.length > 0) {
          return { error: newError(ErrConflict, 'ese mes del gasto fijo ya está enlazado a otro movimiento del banco') }
        }
        if (item.currency === 'CLP') applyMonthAmount(fe, period, Money.fromString(item.amount))
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
           fixed_period = '' WHERE id = ? AND user_id = ? AND status = ?`,
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
      const cardByID = cardMapAll()
      const appByPeriod = new Map<string, Map<number, string>>()
      const data: CardStatementView[] = []
      for (const st of sts) data.push(await statementView(st, cardByID, appByPeriod))
      return { data }
    },

    async GetCardStatement(id: number): Promise<CardStatementDetailResult> {
      const row = db.query('SELECT * FROM card_statements WHERE id = ? AND user_id = ?', [id, uid()])[0]
      if (!row) return { error: newError(ErrNotFound, 'estado de cuenta no encontrado') }
      const statement = await statementView(rowToCardStatement(row), cardMapAll(), new Map())
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
