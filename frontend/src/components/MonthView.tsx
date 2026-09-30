import { useState } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import {
  CheckCheck,
  CircleAlert,
  CircleCheck,
  Clock,
  FileText,
  Layers,
  LoaderCircle,
  Pencil,
  Plus,
  Receipt,
  Repeat,
  Scale,
  Trash,
  Undo2,
  Users,
  Wallet,
} from 'lucide-react'
import {
  FinanceService,
  SOURCE_FIJO,
  SOURCE_REEMBOLSO,
  STATUS_PAGADO,
  type BudgetStatus,
  type Expense,
  type MonthlySummary,
  type Movimiento,
  type OpResult,
} from '@/services/finance'
import { periodAtom, quickAddAtom } from '@/atoms/finance'
import { useInvalidate, useVersion } from '@/atoms/refresh'
import { failed } from '@/lib/result'
import { notify } from '@/lib/notify'
import { useQuery } from '@/lib/useQuery'
import { navigate } from '@/lib/useRoute'
import { greaterThan, isNegative, isZero, ratio, subtract, sum } from '@/lib/money'
import { currentPeriod, formatAmount, formatCLP, formatDate, formatUF, periodLabel } from '@/lib/format'
import {
  Badge,
  BankCodes,
  BankDescription,
  Bar,
  Button,
  Callout,
  ColorDot,
  ConfirmAction,
  ConfirmDialog,
  Empty,
  EmptyState,
  LookIcon,
  Menu,
  QueryError,
  Section,
  Select,
  Skeleton,
  StatCard,
  TagChips,
  Toggletip,
  tbl,
  type MenuAction,
} from './ui'
import { CuotaProgress } from './CuotaProgress'
import { ExpenseForm } from './ExpenseForm'
import { IncomePanel } from './IncomePanel'
import { ExportButton } from './ExportButton'
import { TrendPanel } from './TrendPanel'
import { StatementBanner } from './CardStatements'
import { ReconcileDialog, type ReconcileMode } from './ReconcileDialog'
import { RefundDialog } from './RefundDialog'
import { CuotaDialog } from './CuotaDialog'
import { ReceivableDialog, ReceivablesPanel } from './Receivables'
import { DuesBanner } from './DuesBanner'
import { OnboardingChecklist } from './OnboardingChecklist'
import { AccountBalancesPanel } from './Accounts'
import { Link } from './Link'
import { exportBasename, monthTable } from '@/lib/exportTables'
import { autoColor, cardColor, categoryLooks, type ColorKey, type Look } from '@/lib/look'

const filterCls =
  'h-9 rounded-lg bg-panel pl-3 text-sm text-fg outline-none ring-1 ring-inset ring-line-input focus:ring-2 focus:ring-focus'

function movKey(m: Movimiento): string {
  if (m.source === SOURCE_REEMBOLSO) return `reembolso-${m.refundId}`
  return m.source === SOURCE_FIJO ? `fijo-${m.fixedId}` : `cuota-${m.installmentId}`
}

// MonthView is the Resumen: whether the month's money is enough, its
// movements (cuotas, fixed expenses, refunds), incomes, card quotas and
// accounts. Its layout follows its own width (container queries): the
// sidebar takes part of the window, so the viewport alone does not tell.
export function MonthView() {
  const period = useAtomValue(periodAtom)
  const version = useVersion('ledger')
  const invalidate = useInvalidate()
  const reload = () => invalidate('ledger')

  const query = useQuery(`${period}:${version}`, async () => {
    const [summary, expenses, cats, mers] = await Promise.all([
      FinanceService.MonthlySummary(period),
      FinanceService.ListExpenses(period),
      FinanceService.ListCategories(),
      FinanceService.ListMerchants(),
    ])
    if (summary.error || !summary.data) throw new Error(summary.error?.message ?? 'resumen vacío')
    return {
      summary: summary.data,
      expenses,
      categories: cats.map((c) => c.name),
      looks: categoryLooks(cats),
      merchants: mers.map((m) => m.name),
    }
  })

  const [editing, setEditing] = useState<Expense | null>(null)
  const [deleting, setDeleting] = useState<Movimiento | null>(null)
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set())
  const [filterCategory, setFilterCategory] = useState('')
  const [filterCardId, setFilterCardId] = useState<number | ''>('')
  const [reconcile, setReconcile] = useState<ReconcileMode | null>(null)
  const [refundFor, setRefundFor] = useState<Movimiento | null>(null)
  const [cuotaFor, setCuotaFor] = useState<Movimiento | null>(null)
  const [owedFor, setOwedFor] = useState<Movimiento | null>(null)
  // New expenses go through the app-wide dialog (QuickAddHost, also on the N key).
  const openNewExpense = useSetAtom(quickAddAtom)

  if (query.status === 'error') return <QueryError message={query.error} onRetry={reload} />
  if (!query.data) return <MonthSkeleton />
  const { summary, expenses, categories, looks, merchants } = query.data
  const cardColors = new Map(summary.porTarjeta.map((t) => [t.card.id, cardColor(t.card)]))
  const stale = query.status === 'loading'

  // The month comes from the rows shown, not the navigation atom: while the next
  // month loads, the previous month's rows stay on screen (dimmed) and a tap on
  // one must mark ITS month, not the one being loaded.
  function setPaid(m: Movimiento, paid: boolean): Promise<OpResult> {
    return m.source === SOURCE_FIJO && m.fixedId != null
      ? FinanceService.SetFixedExpensePaid(m.fixedId, summary.period, paid)
      : FinanceService.SetInstallmentPaid(m.installmentId, paid)
  }

  async function togglePaid(m: Movimiento, currentlyPaid: boolean) {
    const key = movKey(m)
    setPending((s) => new Set(s).add(key))
    try {
      if (!failed(await setPaid(m, !currentlyPaid))) reload()
    } finally {
      setPending((s) => {
        const next = new Set(s)
        next.delete(key)
        return next
      })
    }
  }

  // Marks every pending charge of a card as paid, reporting partial failures
  // instead of silently leaving some rows pending.
  async function markCardPaid(targets: Movimiento[]) {
    const todo = targets.filter((m) => m.status !== STATUS_PAGADO)
    if (todo.length === 0) return
    const results = await Promise.allSettled(todo.map((m) => setPaid(m, true)))
    const failures = results.filter((r) => r.status === 'rejected' || r.value.error).length
    if (failures > 0) notify(`${failures} de ${todo.length} cargos no se pudieron marcar como pagados.`)
    reload()
  }

  async function removeRefund(refundId: number) {
    // A bank credit confirmed as this refund can then go back to review.
    if (!failed(await FinanceService.DeleteRefund(refundId))) invalidate('ledger', 'imports')
  }

  async function removeExpense(expenseId: number) {
    // Its import item (if any) reopens and its statement lines unlink.
    if (!failed(await FinanceService.DeleteExpense(expenseId))) invalidate('ledger', 'imports')
  }

  function editExpense(expenseId: number) {
    const exp = expenses.find((e) => e.id === expenseId)
    if (exp) setEditing(exp)
  }

  function rowActions(m: Movimiento): MenuAction[] {
    return [
      { label: 'Editar', icon: Pencil, onSelect: () => editExpense(m.expenseId) },
      { label: 'Registrar reembolso', icon: Undo2, onSelect: () => setRefundFor(m) },
      { label: 'Me deben parte', icon: Users, onSelect: () => setOwedFor(m) },
      ...(m.total > 1 && m.status !== STATUS_PAGADO
        ? [{ label: 'Cuotas: monto o prepago', icon: Layers, onSelect: () => setCuotaFor(m) }]
        : []),
      { label: 'Eliminar…', icon: Trash, tone: 'danger' as const, onSelect: () => setDeleting(m) },
    ]
  }

  const budgetByCategory = new Map<string, BudgetStatus>(summary.presupuestos.map((b) => [b.category, b]))

  // Built from the movimientos themselves (not summary.porTarjeta) so a card that
  // was since soft-deleted still shows up as a filter option for its past charges.
  const movCategories = Array.from(new Set(summary.movimientos.map((m) => m.category))).sort()
  const movCards = Array.from(
    new Map(
      summary.movimientos
        .filter((m): m is Movimiento & { cardId: number } => m.cardId != null)
        .map((m) => [m.cardId, m.cardName || '—'] as const),
    ),
  )
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name))

  const filtering = filterCategory !== '' || filterCardId !== ''
  const filteredMovs = summary.movimientos.filter((m) => {
    if (filterCategory && m.category !== filterCategory) return false
    if (filterCardId !== '' && m.cardId !== filterCardId) return false
    return true
  })
  const clearFilters = () => {
    setFilterCategory('')
    setFilterCardId('')
  }

  return (
    <div className={`@container space-y-6 transition-opacity ${stale ? 'opacity-60' : ''}`} aria-busy={stale}>
      <OnboardingChecklist onOpeningBalance={() => setReconcile('inicio')} />
      <DuesBanner />
      <BudgetAlerts budgets={summary.presupuestos} />
      <MonthHeadline summary={summary} />
      <ReconciliationBar summary={summary} onOpen={setReconcile} />
      <StatementBanner period={period} />

      <div className="grid items-start gap-6 @4xl:grid-cols-[minmax(0,1fr)_19rem]">
        <div className="min-w-0 space-y-6">
          <Section
            title="Movimientos del mes"
            action={
              summary.movimientos.length > 0 && (
                <ExportButton build={() => monthTable(summary)} basename={exportBasename('mes', summary.period)} />
              )
            }
          >
            {summary.movimientos.length === 0 ? (
              <EmptyState
                icon={Receipt}
                title="Aún no hay movimientos este mes"
                action={
                  <div className="flex flex-wrap justify-center gap-2">
                    <Button icon={Plus} onClick={() => openNewExpense(true)}>
                      Agregar gasto
                    </Button>
                    <Button variant="secondary" icon={FileText} onClick={() => navigate({ page: 'importar', tab: 'bandeja' })}>
                      Importar estado de cuenta
                    </Button>
                  </div>
                }
              >
                Agrega un gasto o importa tu estado de cuenta: sus cuotas y tus gastos fijos aparecen aquí.
              </EmptyState>
            ) : (
              <>
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <Select aria-label="Filtrar por categoría" className={filterCls} value={filterCategory} onChange={(e) => setFilterCategory(e.target.value)}>
                    <option value="">Todas las categorías</option>
                    {movCategories.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </Select>
                  <Select
                    aria-label="Filtrar por tarjeta"
                    className={filterCls}
                    value={filterCardId}
                    onChange={(e) => setFilterCardId(e.target.value === '' ? '' : Number(e.target.value))}
                  >
                    <option value="">Todas las tarjetas</option>
                    {movCards.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </Select>
                  {filtering && (
                    <Button variant="quiet" size="sm" onClick={clearFilters}>
                      Limpiar filtros
                    </Button>
                  )}
                </div>

                {filteredMovs.length === 0 ? (
                  <Empty>No hay movimientos con ese filtro.</Empty>
                ) : (
                  // The table's columns follow the table's own width.
                  <div className={`@container ${tbl.wrap}`}>
                    <table className={tbl.table}>
                      <thead className={tbl.thead}>
                        <tr>
                          <th className={tbl.th}>Descripción</th>
                          <th className={`${tbl.th} hidden @xl:table-cell`}>Categoría</th>
                          <th className={`${tbl.th} hidden @4xl:table-cell`}>Comercio</th>
                          <th className={`${tbl.th} hidden @4xl:table-cell`}>Tarjeta</th>
                          <th className={`${tbl.th} hidden @4xl:table-cell`}>Cuota</th>
                          <th className={`${tbl.th} hidden @xl:table-cell`}>Fecha</th>
                          <th className={`${tbl.th} text-right`}>Monto</th>
                          <th className={`${tbl.th} text-center`}>Estado</th>
                          <th className={tbl.th}>
                            <span className="sr-only">Acciones</span>
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredMovs.map((m) => (
                          <MovementRow
                            key={movKey(m)}
                            m={m}
                            look={looks.byName(m.category)}
                            cardDot={m.cardId != null ? (cardColors.get(m.cardId) ?? autoColor(m.cardId)) : null}
                            busy={pending.has(movKey(m))}
                            actions={rowActions(m)}
                            onTogglePaid={(paid) => void togglePaid(m, paid)}
                            onRemoveRefund={removeRefund}
                          />
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}
          </Section>

          <ReceivablesPanel period={summary.period} />

          {summary.porCategoria.length > 0 && (
            <Section title="Por categoría">
              <ul className="space-y-3">
                {summary.porCategoria.map((c) => {
                  const budget = budgetByCategory.get(c.category)
                  const cap = budget ? sum([budget.budget, budget.carried]) : null
                  return (
                    <li key={c.category} className="text-sm">
                      <div className="flex items-center justify-between gap-3">
                        <span className="flex w-40 shrink-0 items-center gap-2">
                          <LookIcon look={looks.byName(c.category)} size="sm" />
                          <span className="truncate text-fg">{c.category}</span>
                        </span>
                        <div className="flex-1">
                          {budget && cap ? (
                            <Bar fill={ratio(budget.spent, cap)} tone={budget.over ? 'danger' : budget.near ? 'warning' : 'success'} />
                          ) : (
                            <Bar fill={ratio(c.total, summary.gastos)} />
                          )}
                        </div>
                        <span className="w-28 shrink-0 text-right tabular-nums text-fg">{formatCLP(c.total)}</span>
                      </div>
                      {budget && cap && (
                        <div
                          className={`mt-0.5 text-right text-xs ${
                            budget.over ? 'text-negative-fg' : budget.near ? 'text-caution-fg' : 'text-fg-subtle'
                          }`}
                        >
                          {budget.over
                            ? `Excedido por ${formatCLP(budget.remaining.replace('-', ''))} · tope ${formatCLP(cap)}`
                            : `Quedan ${formatCLP(budget.remaining)} de ${formatCLP(cap)}`}
                          {!isZero(budget.carried) && ` (incluye ${formatCLP(budget.carried)} traspasado)`}
                        </div>
                      )}
                    </li>
                  )
                })}
              </ul>
            </Section>
          )}

          <TrendPanel period={period} />
        </div>

        {/* Beside the movements on wide layouts; below them, two by two, on narrower ones. */}
        <div className="grid gap-6 @2xl:grid-cols-2 @4xl:grid-cols-1">
          <IncomePanel />

          <Section title="Tarjetas (cupo)">
            {summary.porTarjeta.length === 0 ? (
              <Empty>
                Sin tarjetas. <Link to={{ page: 'config', section: 'tarjetas' }}>Créalas en Configuración › Tarjetas</Link>.
              </Empty>
            ) : (
              <ul className="space-y-4">
                {summary.porTarjeta.map((t) => {
                  const hasLimit = !isZero(t.card.creditLimit)
                  const over = hasLimit && greaterThan(t.cupoUsado, t.card.creditLimit)
                  // Independent of the table filters above — always every pending
                  // cuota/fijo billed to this card this month, nothing more, nothing less.
                  const cardMovs = summary.movimientos.filter((m) => m.cardId === t.card.id)
                  const pendingCount = cardMovs.filter((m) => m.status !== STATUS_PAGADO).length
                  return (
                    <li key={t.card.id}>
                      <div className="mb-1 flex items-center justify-between gap-2 text-sm">
                        <span className="flex items-center gap-2 font-medium text-fg">
                          <ColorDot color={cardColor(t.card)} />
                          {t.card.name}
                        </span>
                        <span className="tabular-nums text-fg-muted">{formatCLP(t.gastoMes)} este mes</span>
                      </div>
                      <Bar fill={hasLimit ? ratio(t.cupoUsado, t.card.creditLimit) : 0} tone={over ? 'danger' : 'primary'} />
                      <div className="mt-1 flex justify-between gap-2 text-xs">
                        <span className="text-fg-subtle">
                          Usado {formatCLP(t.cupoUsado)} de {formatCLP(t.card.creditLimit)}
                        </span>
                        <span className={over ? 'text-negative-fg' : 'text-positive-fg'}>Disponible {formatCLP(t.cupoDisponible)}</span>
                      </div>
                      {pendingCount > 0 && (
                        <Button variant="quiet" size="sm" icon={CheckCheck} className="mt-1 -ml-3" onClick={() => void markCardPaid(cardMovs)}>
                          Marcar pagado lo del mes ({pendingCount})
                        </Button>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
          </Section>

          <AccountBalancesPanel period={period} />
        </div>
      </div>

      {editing && (
        <ExpenseForm
          cards={summary.porTarjeta.map((t) => t.card)}
          categories={categories}
          merchants={merchants}
          target={{ mode: 'edit', expense: editing, tags: summary.movimientos.find((m) => m.expenseId === editing.id)?.tags ?? [] }}
          onClose={() => setEditing(null)}
          onSaved={reload}
        />
      )}
      {deleting && (
        <ConfirmDialog title="Eliminar gasto" onConfirm={() => removeExpense(deleting.expenseId)} onClose={() => setDeleting(null)}>
          ¿Eliminar «{deleting.description}»? Va a la papelera con todas sus cuotas; puedes restaurarlo desde Configuración ›
          Papelera.
        </ConfirmDialog>
      )}
      {owedFor && (
        <ReceivableDialog
          expense={owedFor}
          onClose={() => setOwedFor(null)}
          onSaved={() => {
            setOwedFor(null)
            reload()
          }}
        />
      )}
      {cuotaFor && (
        <CuotaDialog
          cuota={cuotaFor}
          defaultPeriod={summary.period}
          onClose={() => setCuotaFor(null)}
          onSaved={() => {
            setCuotaFor(null)
            reload()
          }}
        />
      )}
      {refundFor && (
        <RefundDialog
          expenseId={refundFor.expenseId}
          expenseDescription={refundFor.description}
          defaultPeriod={summary.period}
          onClose={() => setRefundFor(null)}
          onSaved={() => {
            setRefundFor(null)
            reload()
          }}
        />
      )}
      {reconcile && (
        <ReconcileDialog
          mode={reconcile}
          summary={summary}
          onClose={() => setReconcile(null)}
          onSaved={() => {
            setReconcile(null)
            reload()
          }}
        />
      )}
    </div>
  )
}

// MovementRow is one line of the month's table: what, where, how much, whether
// it is paid (a toggle) and its actions (a ⋯ menu for expenses).
function MovementRow({
  m,
  look,
  cardDot,
  busy,
  actions,
  onTogglePaid,
  onRemoveRefund,
}: {
  m: Movimiento
  look: Look
  // The color dot of the card it is charged to; null = no card.
  cardDot: ColorKey | null
  busy: boolean
  actions: MenuAction[]
  onTogglePaid: (currentlyPaid: boolean) => void
  onRemoveRefund: (refundId: number) => Promise<void>
}) {
  const paid = m.status === STATUS_PAGADO
  const isFijo = m.source === SOURCE_FIJO
  const isRefund = m.source === SOURCE_REEMBOLSO
  const StatusIcon = busy ? LoaderCircle : paid ? CircleCheck : Clock
  return (
    <tr className={tbl.row}>
      <td className={`${tbl.td} @lg:min-w-44`}>
        <div className="flex items-start gap-2.5">
          <LookIcon look={look} size="sm" />
          <div className="min-w-0">
            <span className="line-clamp-2 max-w-[16rem] font-medium text-fg">{m.description}</span>
            <BankDescription text={m.bankDescription} />
            <CuotaProgress m={m} />
            {m.currency !== '' && <span className="block text-[11px] text-fg-subtle">{formatAmount(m.originalAmount, m.currency)} en total</span>}
            <TagChips tags={m.tags} />
            <BankCodes codes={m.references} />
          </div>
        </div>
      </td>
      <td className={`${tbl.td} hidden text-fg-muted @xl:table-cell`}>
        <span className="line-clamp-2 max-w-[10rem] break-words">{m.category}</span>
      </td>
      <td className={`${tbl.td} hidden text-fg-muted @4xl:table-cell`}>
        <span className="line-clamp-2 max-w-[10rem] break-words">{m.merchant || '—'}</span>
      </td>
      <td className={`${tbl.td} hidden text-fg-muted @4xl:table-cell`}>
        {cardDot ? (
          <span className="flex items-center gap-1.5">
            <ColorDot color={cardDot} />
            <span className="line-clamp-2 max-w-[9rem] break-words">{m.cardName || '—'}</span>
          </span>
        ) : (
          '—'
        )}
      </td>
      <td className={`${tbl.td} hidden whitespace-nowrap text-fg-muted @4xl:table-cell`}>
        {isFijo ? 'Fijo' : isRefund ? 'Reembolso' : m.total > 1 ? `${m.number}/${m.total}` : 'Único'}
      </td>
      <td className={`${tbl.td} hidden whitespace-nowrap text-fg-muted @xl:table-cell`}>{isFijo || isRefund ? '—' : formatDate(m.date)}</td>
      <td className={`${tbl.td} ${tbl.num} ${isRefund ? 'text-positive-fg' : 'text-fg'}`}>
        {formatCLP(m.amount)}
        {m.ufAmount !== null && (
          <span className="flex items-center justify-end gap-1 text-xs text-fg-subtle">
            {formatUF(m.ufAmount)}
            {m.estimado && (
              <>
                · estimado
                <Toggletip label="¿Por qué estimado?">Valor de la UF estimado: aún no se descarga el de este mes.</Toggletip>
              </>
            )}
          </span>
        )}
      </td>
      <td className={`${tbl.td} text-center`}>
        {isRefund ? (
          <Badge tone="positive" icon={Undo2}>
            Devuelto
          </Badge>
        ) : (
          <button
            type="button"
            onClick={() => onTogglePaid(paid)}
            disabled={busy}
            aria-pressed={paid}
            aria-label={`${m.description}: ${paid ? 'pagado' : 'pendiente'}. Cambiar estado`}
            className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ring-transparent transition-colors disabled:opacity-60 ${
              paid ? 'bg-positive-soft text-positive-fg hover:ring-positive-fg/40' : 'bg-caution-soft text-caution-fg hover:ring-caution-fg/40'
            }`}
          >
            <StatusIcon aria-hidden="true" className={`size-3.5 ${busy ? 'motion-safe:animate-spin' : ''}`} />
            {paid ? 'Pagado' : 'Pendiente'}
          </button>
        )}
      </td>
      <td className={`${tbl.td} text-right`}>
        {isFijo ? (
          <Link to={{ page: 'fijos' }} className="inline-flex items-center gap-1 whitespace-nowrap text-xs text-fg-subtle hover:text-fg hover:underline">
            <Repeat aria-hidden="true" className="size-3.5" />
            Fijo<span className="sr-only">: se administra en Gastos fijos</span>
          </Link>
        ) : isRefund && m.refundId !== null ? (
          <ConfirmAction
            label={`Quitar el reembolso de ${m.description}`}
            iconOnly
            question="¿Quitar?"
            confirmLabel="Quitar"
            onConfirm={() => onRemoveRefund(m.refundId!)} // refundId checked non-null just above
          />
        ) : (
          <Menu label={`Acciones de ${m.description}`} items={actions} />
        )}
      </td>
    </tr>
  )
}

// MonthHeadline answers the app's question first — is the month's money
// enough? — then the three figures behind the answer.
function MonthHeadline({ summary }: { summary: MonthlySummary }) {
  const ok = summary.alcanza
  const short = isNegative(summary.balance)
  const Icon = ok ? CircleCheck : CircleAlert
  const tone = ok ? 'success' : 'danger'
  return (
    <div className="grid gap-4 @2xl:grid-cols-3 @5xl:grid-cols-[minmax(0,1.3fr)_repeat(3,minmax(0,1fr))]">
      <section
        aria-label="¿Alcanza este mes?"
        className={`flex items-center gap-4 rounded-xl p-5 ring-1 ring-inset @2xl:col-span-3 @5xl:col-span-1 ${
          ok ? 'bg-positive-soft ring-positive-fg/25' : 'bg-negative-soft ring-negative-fg/30'
        }`}
      >
        <Icon aria-hidden="true" className={`size-10 shrink-0 ${ok ? 'text-positive-fg' : 'text-negative-fg'}`} />
        <div className="min-w-0">
          <p className="text-lg font-semibold text-fg">{ok ? 'Te alcanza este mes' : 'Este mes no alcanza'}</p>
          <p className="text-sm text-fg-muted">
            {short
              ? `Faltan ${formatCLP(subtract('0', summary.balance))} para cubrir los gastos.`
              : `Te quedan ${formatCLP(summary.balance)} después de los gastos.`}
          </p>
        </div>
      </section>
      <StatCard
        label="Disponible"
        icon={Wallet}
        value={formatCLP(summary.disponible)}
        tone="primary"
        hint={`Acumulado ${formatCLP(summary.acumulado)} + ingresos ${formatCLP(summary.ingresos)}`}
      />
      <StatCard
        label="Gastos del mes"
        icon={Receipt}
        value={formatCLP(summary.gastos)}
        hint={`Pagado ${formatCLP(summary.pagado)} · Pendiente ${formatCLP(summary.pendiente)}`}
      />
      <StatCard
        label="Balance"
        icon={Scale}
        value={formatCLP(summary.balance)}
        tone={tone}
        hint={
          isZero(summary.ahorro)
            ? 'Se arrastra al próximo mes'
            : isNegative(summary.ahorro)
              ? `Con ${formatCLP(subtract('0', summary.ahorro))} retirados del ahorro · se arrastra al próximo mes`
              : `Tras ahorrar ${formatCLP(summary.ahorro)} · se arrastra al próximo mes`
        }
      />
    </div>
  )
}

// BudgetAlerts calls out the categories over (or near) their monthly cap.
function BudgetAlerts({ budgets }: { budgets: BudgetStatus[] }) {
  const over = budgets.filter((b) => b.over)
  const near = budgets.filter((b) => b.near)
  const cap = (b: BudgetStatus) => formatCLP(sum([b.budget, b.carried]))
  return (
    <>
      {over.length > 0 && (
        <Callout tone="negative" role="status" title="Presupuesto excedido">
          <ul className="space-y-0.5">
            {over.map((b) => (
              <li key={b.categoryId}>
                <strong className="font-medium">{b.category}</strong>: {formatCLP(b.spent)} de {cap(b)}
              </li>
            ))}
          </ul>
        </Callout>
      )}
      {near.length > 0 && (
        <Callout tone="caution" role="status" title="Cerca del tope (80 % o más)">
          <ul className="space-y-0.5">
            {near.map((b) => (
              <li key={b.categoryId}>
                <strong className="font-medium">{b.category}</strong>: quedan {formatCLP(b.remaining)} de {cap(b)}
              </li>
            ))}
          </ul>
        </Callout>
      )}
    </>
  )
}

// ReconciliationBar says where the carried balance comes from and offers to
// set the opening balance or reconcile the month's close with the bank.
function ReconciliationBar({ summary, onOpen }: { summary: MonthlySummary; onOpen: (mode: ReconcileMode) => void }) {
  const rec = summary.conciliacion
  const canClose = summary.period <= currentPeriod()
  const matches = rec !== null && isZero(rec.diferencia)
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-panel px-4 py-3 text-sm shadow-xs ring-1 ring-line">
      <div className="space-y-0.5">
        <p className="text-fg-muted">
          {summary.acumuladoDesde
            ? `Saldo arrastrado desde el cierre conciliado de ${periodLabel(summary.acumuladoDesde)}.`
            : 'Saldo arrastrado desde el primer mes con datos (sin saldo inicial).'}
        </p>
        {rec && (
          <p className="text-fg">
            Cierre conciliado: saldo real <strong>{formatCLP(rec.saldoReal)}</strong> · calculado {formatCLP(rec.calculado)} ·{' '}
            <span
              className={`inline-flex items-center gap-1 ${
                matches ? 'text-positive-fg' : isNegative(rec.diferencia) ? 'text-negative-fg' : 'text-caution-fg'
              }`}
            >
              {matches && <CircleCheck aria-hidden="true" className="size-3.5" />}
              {matches ? 'cuadra' : `diferencia ${formatCLP(rec.diferencia)}`}
            </span>
          </p>
        )}
      </div>
      <div className="flex gap-2">
        <Button variant="secondary" size="sm" onClick={() => onOpen('inicio')}>
          Saldo inicial
        </Button>
        {canClose && (
          <Button variant="secondary" size="sm" onClick={() => onOpen('cierre')}>
            {rec ? 'Editar conciliación' : 'Conciliar cierre'}
          </Button>
        )}
      </div>
    </div>
  )
}

// MonthSkeleton holds the Resumen's shape while the month loads the first time.
function MonthSkeleton() {
  return (
    <div role="status" className="@container space-y-6">
      <span className="sr-only">Cargando el mes…</span>
      <div className="grid gap-4 @2xl:grid-cols-3 @5xl:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-24 w-full rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-14 w-full rounded-xl" />
      <div className="grid gap-6 @4xl:grid-cols-[minmax(0,1fr)_19rem]">
        <Skeleton className="h-96 w-full rounded-xl" />
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    </div>
  )
}
