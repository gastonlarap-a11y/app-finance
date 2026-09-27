import { useState } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
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
import { greaterThan, isNegative, isZero, ratio, subtract, sum } from '@/lib/money'
import { currentPeriod, formatAmount, formatCLP, formatDate, formatUF, periodLabel } from '@/lib/format'
import { BankCodes, BankDescription, Bar, Button, Empty, IconButton, QueryError, Section, Spinner, StatCard, TagChips } from './ui'
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
import { AccountBalancesPanel } from './Accounts'
import { Link } from './Link'
import { exportBasename, monthTable } from '@/lib/exportTables'

const filterCls = 'rounded bg-surface px-2 py-1.5 text-sm ring-1 ring-slate-700 focus:ring-2 focus:ring-primary'

function movKey(m: Movimiento): string {
  if (m.source === SOURCE_REEMBOLSO) return `reembolso-${m.refundId}`
  return m.source === SOURCE_FIJO ? `fijo-${m.fixedId}` : `cuota-${m.installmentId}`
}

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
      merchants: mers.map((m) => m.name),
    }
  })

  const [editing, setEditing] = useState<Expense | null>(null)
  const [confirmExpId, setConfirmExpId] = useState<number | null>(null)
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set())
  const [filterCategory, setFilterCategory] = useState('')
  const [filterCardId, setFilterCardId] = useState<number | ''>('')
  const [reconcile, setReconcile] = useState<ReconcileMode | null>(null)
  const [refundFor, setRefundFor] = useState<Movimiento | null>(null)
  const [cuotaFor, setCuotaFor] = useState<Movimiento | null>(null)
  const [owedFor, setOwedFor] = useState<Movimiento | null>(null)
  const [confirmRefundId, setConfirmRefundId] = useState<number | null>(null)
  // New expenses go through the app-wide dialog (QuickAddHost, also on the N key).
  const openNewExpense = useSetAtom(quickAddAtom)

  if (query.status === 'error') return <QueryError message={query.error} onRetry={reload} />
  if (!query.data) return <Spinner />
  const { summary, expenses, categories, merchants } = query.data
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
    setConfirmRefundId(null)
    // A bank credit confirmed as this refund can then go back to review.
    if (!failed(await FinanceService.DeleteRefund(refundId))) invalidate('ledger', 'imports')
  }

  async function removeExpense(expenseId: number) {
    setConfirmExpId(null)
    // Its import item (if any) reopens and its statement lines unlink.
    if (!failed(await FinanceService.DeleteExpense(expenseId))) invalidate('ledger', 'imports')
  }

  function editExpense(expenseId: number) {
    const exp = expenses.find((e) => e.id === expenseId)
    if (exp) setEditing(exp)
  }

  const balanceTone = summary.alcanza ? 'success' : 'danger'
  const budgetByCategory = new Map<string, BudgetStatus>(summary.presupuestos.map((b) => [b.category, b]))
  const overBudget = summary.presupuestos.filter((b) => b.over)
  const nearBudget = summary.presupuestos.filter((b) => b.near)

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

  const filteredMovs = summary.movimientos.filter((m) => {
    if (filterCategory && m.category !== filterCategory) return false
    if (filterCardId !== '' && m.cardId !== filterCardId) return false
    return true
  })

  return (
    <div className={`space-y-5 transition-opacity ${stale ? 'opacity-60' : ''}`} aria-busy={stale}>
      <DuesBanner />
      {overBudget.length > 0 && (
        <div role="status" className="rounded-base bg-danger/10 px-4 py-3 text-sm text-red-200 ring-1 ring-danger/30">
          Presupuesto excedido en{' '}
          {overBudget.map((b, i) => (
            <span key={b.categoryId}>
              {i > 0 && ', '}
              <strong>{b.category}</strong> ({formatCLP(b.spent)} de {formatCLP(sum([b.budget, b.carried]))})
            </span>
          ))}
          .
        </div>
      )}
      {nearBudget.length > 0 && (
        <div role="status" className="rounded-base bg-warning/10 px-4 py-3 text-sm text-amber-200 ring-1 ring-warning/30">
          Cerca del tope (80 % o más) en{' '}
          {nearBudget.map((b, i) => (
            <span key={b.categoryId}>
              {i > 0 && ', '}
              <strong>{b.category}</strong> (quedan {formatCLP(b.remaining)} de {formatCLP(sum([b.budget, b.carried]))})
            </span>
          ))}
          .
        </div>
      )}

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatCard
          label="Disponible"
          value={formatCLP(summary.disponible)}
          tone="primary"
          hint={`Acumulado ${formatCLP(summary.acumulado)} + ingresos ${formatCLP(summary.ingresos)}`}
        />
        <StatCard
          label="Gastos del mes"
          value={formatCLP(summary.gastos)}
          hint={`Pagado ${formatCLP(summary.pagado)} · Pendiente ${formatCLP(summary.pendiente)}`}
        />
        <StatCard
          label="Balance"
          value={formatCLP(summary.balance)}
          tone={balanceTone}
          hint={
            isZero(summary.ahorro)
              ? 'Se arrastra al próximo mes'
              : isNegative(summary.ahorro)
                ? `Con ${formatCLP(subtract('0', summary.ahorro))} retirados del ahorro · se arrastra al próximo mes`
                : `Tras ahorrar ${formatCLP(summary.ahorro)} · se arrastra al próximo mes`
          }
        />
        <StatCard label="¿Alcanza?" value={summary.alcanza ? 'Sí ✓' : 'No ✕'} tone={balanceTone} />
      </div>

      <ReconciliationBar summary={summary} onOpen={setReconcile} />

      <StatementBanner period={period} />

      <div className="grid gap-5 lg:grid-cols-4">
        <div className="lg:col-span-3">
          <Section
            title="Movimientos del mes"
            action={
              <div className="flex items-center gap-2">
                {summary.movimientos.length > 0 && (
                  <ExportButton build={() => monthTable(summary)} basename={exportBasename('mes', summary.period)} />
                )}
                <Button onClick={() => openNewExpense(true)}>
                  + Agregar gasto <kbd className="ml-1 hidden rounded bg-white/15 px-1 text-xs md:inline">N</kbd>
                </Button>
              </div>
            }
          >
            {summary.movimientos.length === 0 ? (
              <Empty>No hay movimientos este mes. Agrega un gasto para empezar.</Empty>
            ) : (
              <>
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <select
                    aria-label="Filtrar por categoría"
                    className={filterCls}
                    value={filterCategory}
                    onChange={(e) => setFilterCategory(e.target.value)}
                  >
                    <option value="">Todas las categorías</option>
                    {movCategories.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                  <select
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
                  </select>
                  {(filterCategory || filterCardId !== '') && (
                    <button
                      type="button"
                      className="text-xs text-slate-400 hover:text-slate-200"
                      onClick={() => {
                        setFilterCategory('')
                        setFilterCardId('')
                      }}
                    >
                      Limpiar filtros
                    </button>
                  )}
                </div>

                {filteredMovs.length === 0 ? (
                  <Empty>No hay movimientos con ese filtro.</Empty>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="text-left text-xs uppercase text-slate-400">
                        <tr>
                          <th className="pb-2">Descripción</th>
                          <th className="hidden pb-2 md:table-cell">Categoría</th>
                          <th className="hidden pb-2 lg:table-cell">Comercio</th>
                          <th className="hidden pb-2 lg:table-cell">Tarjeta</th>
                          <th className="hidden pb-2 lg:table-cell">Cuota</th>
                          <th className="hidden pb-2 md:table-cell">Fecha</th>
                          <th className="pb-2 text-right">Monto</th>
                          <th className="pb-2 text-center">Estado</th>
                          <th className="pb-2">
                            <span className="sr-only">Acciones</span>
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredMovs.map((m) => {
                          const paid = m.status === STATUS_PAGADO
                          const isFijo = m.source === SOURCE_FIJO
                          const isRefund = m.source === SOURCE_REEMBOLSO
                          const busy = pending.has(movKey(m))
                          return (
                            <tr key={movKey(m)} className="border-t border-slate-800">
                              <td className="py-2 font-medium">
                                <span className="block max-w-[220px] truncate" title={m.description}>
                                  {m.description}
                                </span>
                                <BankDescription text={m.bankDescription} />
                                {m.currency !== '' && (
                                  <span className="block text-[11px] text-slate-500">
                                    {formatAmount(m.originalAmount, m.currency)} en total
                                  </span>
                                )}
                                <TagChips tags={m.tags} />
                                <BankCodes codes={m.references} />
                              </td>
                              <td className="hidden py-2 text-slate-400 md:table-cell">
                                <span className="block max-w-[140px] truncate" title={m.category}>
                                  {m.category}
                                </span>
                              </td>
                              <td className="hidden py-2 text-slate-400 lg:table-cell">
                                <span className="block max-w-[140px] truncate" title={m.merchant || '—'}>
                                  {m.merchant || '—'}
                                </span>
                              </td>
                              <td className="hidden py-2 text-slate-400 lg:table-cell">
                                <span className="block max-w-[120px] truncate" title={m.cardName || '—'}>
                                  {m.cardName || '—'}
                                </span>
                              </td>
                              <td className="hidden py-2 text-slate-400 lg:table-cell">
                                {isFijo ? 'Fijo' : isRefund ? 'Reembolso' : m.total > 1 ? `${m.number}/${m.total}` : 'Único'}
                              </td>
                              <td className="hidden py-2 text-slate-400 md:table-cell">{isFijo || isRefund ? '—' : formatDate(m.date)}</td>
                              <td className={`py-2 text-right tabular-nums ${isRefund ? 'text-success' : ''}`}>
                                {formatCLP(m.amount)}
                                {m.ufAmount !== null && (
                                  <span
                                    className="block text-xs text-slate-500"
                                    title={m.estimado ? 'Valor de la UF estimado: aún no se descarga el de este mes' : undefined}
                                  >
                                    {formatUF(m.ufAmount)}
                                    {m.estimado && ' · estimado'}
                                  </span>
                                )}
                              </td>
                              <td className="py-2 text-center">
                                {isRefund ? (
                                  <span className="rounded-full bg-success/20 px-2 py-0.5 text-xs font-medium text-success">Devuelto</span>
                                ) : (
                                <button
                                  type="button"
                                  onClick={() => togglePaid(m, paid)}
                                  disabled={busy}
                                  aria-pressed={paid}
                                  aria-label={`${m.description}: ${paid ? 'pagado' : 'pendiente'}. Cambiar estado`}
                                  className={`rounded-full px-2 py-0.5 text-xs font-medium disabled:opacity-50 ${
                                    paid ? 'bg-success/20 text-success' : 'bg-warning/20 text-warning'
                                  }`}
                                >
                                  {busy ? '…' : paid ? 'Pagado' : 'Pendiente'}
                                </button>
                                )}
                              </td>
                              <td className="whitespace-nowrap py-2 text-right">
                                {isFijo ? (
                                  <Link to={{ page: 'fijos' }} className="text-xs text-slate-500 hover:underline">
                                    Fijo ⚙<span className="sr-only">: se administra en Gastos fijos</span>
                                  </Link>
                                ) : isRefund && m.refundId !== null ? (
                                  confirmRefundId === m.refundId ? (
                                    <>
                                      <button type="button" onClick={() => removeRefund(m.refundId!)} className="text-xs text-danger hover:text-red-400">
                                        Quitar
                                      </button>{' '}
                                      <button
                                        type="button"
                                        onClick={() => setConfirmRefundId(null)}
                                        className="text-xs text-slate-400 hover:text-slate-200"
                                      >
                                        Cancelar
                                      </button>
                                    </>
                                  ) : (
                                    <IconButton
                                      label={`Quitar reembolso ${m.description}`}
                                      onClick={() => setConfirmRefundId(m.refundId)}
                                      className="text-slate-400 hover:text-danger"
                                    >
                                      🗑
                                    </IconButton>
                                  )
                                ) : confirmExpId === m.expenseId ? (
                                  <>
                                    <button
                                      type="button"
                                      onClick={() => removeExpense(m.expenseId)}
                                      className="text-xs text-danger hover:text-red-400"
                                    >
                                      Eliminar
                                    </button>{' '}
                                    <button
                                      type="button"
                                      onClick={() => setConfirmExpId(null)}
                                      className="text-xs text-slate-400 hover:text-slate-200"
                                    >
                                      Cancelar
                                    </button>
                                  </>
                                ) : (
                                  <>
                                    <IconButton
                                      label={`Editar ${m.description}`}
                                      onClick={() => editExpense(m.expenseId)}
                                      className="text-slate-400 hover:text-primary"
                                    >
                                      ✎
                                    </IconButton>{' '}
                                    <IconButton
                                      label={`Registrar reembolso de ${m.description}`}
                                      onClick={() => setRefundFor(m)}
                                      className="text-slate-400 hover:text-success"
                                    >
                                      ↩
                                    </IconButton>{' '}
                                    <IconButton
                                      label={`Me deben parte de ${m.description}`}
                                      onClick={() => setOwedFor(m)}
                                      className="text-slate-400 hover:text-primary"
                                    >
                                      👥
                                    </IconButton>{' '}
                                    {m.total > 1 && m.status !== 'pagado' && (
                                      <>
                                        <IconButton
                                          label={`Cuotas de ${m.description}: monto o prepago`}
                                          onClick={() => setCuotaFor(m)}
                                          className="text-slate-400 hover:text-primary"
                                        >
                                          ⋯
                                        </IconButton>{' '}
                                      </>
                                    )}
                                    <IconButton
                                      label={`Eliminar ${m.description}`}
                                      onClick={() => setConfirmExpId(m.expenseId)}
                                      className="text-slate-400 hover:text-danger"
                                    >
                                      🗑
                                    </IconButton>
                                  </>
                                )}
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}
          </Section>

          <div className="mt-5">
            <ReceivablesPanel period={summary.period} />
          </div>

          {summary.porCategoria.length > 0 && (
            <div className="mt-5">
              <Section title="Por categoría">
                <ul className="space-y-3">
                  {summary.porCategoria.map((c) => {
                    const budget = budgetByCategory.get(c.category)
                    return (
                      <li key={c.category} className="text-sm">
                        <div className="flex items-center justify-between gap-3">
                          <span className="w-40 shrink-0 truncate text-slate-300">{c.category}</span>
                          <div className="flex-1">
                            {budget ? (
                              <Bar
                                fill={ratio(budget.spent, sum([budget.budget, budget.carried]))}
                                tone={budget.over ? 'danger' : budget.near ? 'warning' : 'success'}
                              />
                            ) : (
                              <Bar fill={ratio(c.total, summary.gastos)} />
                            )}
                          </div>
                          <span className="w-28 shrink-0 text-right tabular-nums">{formatCLP(c.total)}</span>
                        </div>
                        {budget && (
                          <div
                            className={`mt-0.5 text-right text-xs ${budget.over ? 'text-danger' : budget.near ? 'text-warning' : 'text-slate-500'}`}
                          >
                            {budget.over
                              ? `Excedido por ${formatCLP(budget.remaining.replace('-', ''))} · tope ${formatCLP(sum([budget.budget, budget.carried]))}`
                              : `Quedan ${formatCLP(budget.remaining)} de ${formatCLP(sum([budget.budget, budget.carried]))}`}
                            {!isZero(budget.carried) && ` (incluye ${formatCLP(budget.carried)} traspasado)`}
                          </div>
                        )}
                      </li>
                    )
                  })}
                </ul>
              </Section>
            </div>
          )}

          <div className="mt-5">
            <TrendPanel period={period} />
          </div>
        </div>

        <div className="space-y-5">
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
                      <div className="mb-1 flex items-center justify-between text-sm">
                        <span className="font-medium">{t.card.name}</span>
                        <span className="text-slate-400">{formatCLP(t.gastoMes)} este mes</span>
                      </div>
                      <Bar fill={hasLimit ? ratio(t.cupoUsado, t.card.creditLimit) : 0} tone={over ? 'danger' : 'primary'} />
                      <div className="mt-1 flex justify-between text-xs text-slate-500">
                        <span>
                          Usado {formatCLP(t.cupoUsado)} / {formatCLP(t.card.creditLimit)}
                        </span>
                        <span className={over ? 'text-danger' : 'text-success'}>Disponible {formatCLP(t.cupoDisponible)}</span>
                      </div>
                      {pendingCount > 0 && (
                        <button
                          type="button"
                          onClick={() => markCardPaid(cardMovs)}
                          className="mt-2 text-xs text-primary hover:underline"
                          title="Marcar pagado todo lo de esta tarjeta este mes"
                        >
                          ✓ Marcar pagado ({pendingCount})
                        </button>
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

// ReconciliationBar says where the carried balance comes from and offers to
// set the opening balance or reconcile the month's close with the bank.
function ReconciliationBar({ summary, onOpen }: { summary: MonthlySummary; onOpen: (mode: ReconcileMode) => void }) {
  const rec = summary.conciliacion
  const canClose = summary.period <= currentPeriod()
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-base bg-surface px-4 py-3 text-sm ring-1 ring-slate-800">
      <div className="space-y-0.5">
        <p className="text-slate-400">
          {summary.acumuladoDesde
            ? `Saldo arrastrado desde el cierre conciliado de ${periodLabel(summary.acumuladoDesde)}.`
            : 'Saldo arrastrado desde el primer mes con datos (sin saldo inicial).'}
        </p>
        {rec && (
          <p>
            Cierre conciliado: saldo real <strong>{formatCLP(rec.saldoReal)}</strong> · calculado {formatCLP(rec.calculado)} ·{' '}
            <span className={isZero(rec.diferencia) ? 'text-success' : isNegative(rec.diferencia) ? 'text-danger' : 'text-warning'}>
              {isZero(rec.diferencia) ? 'cuadra ✓' : `diferencia ${formatCLP(rec.diferencia)}`}
            </span>
          </p>
        )}
      </div>
      <div className="flex gap-2">
        <Button variant="ghost" onClick={() => onOpen('inicio')}>
          Saldo inicial
        </Button>
        {canClose && (
          <Button variant="ghost" onClick={() => onOpen('cierre')}>
            {rec ? 'Editar conciliación' : 'Conciliar cierre'}
          </Button>
        )}
      </div>
    </div>
  )
}
