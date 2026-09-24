import { useEffect, useState } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import {
  FinanceService,
  SOURCE_FIJO,
  STATUS_PAGADO,
  type BudgetStatus,
  type Expense,
  type Movimiento,
  type OpResult,
} from '@/services/finance'
import { periodAtom, refreshAtom } from '@/atoms/finance'
import { failed } from '@/lib/result'
import { notify } from '@/lib/notify'
import { useQuery } from '@/lib/useQuery'
import { greaterThan, isZero, ratio } from '@/lib/money'
import { formatCLP, formatDate } from '@/lib/format'
import { Bar, Button, Empty, IconButton, QueryError, Section, Spinner, StatCard } from './ui'
import { ExpenseForm } from './ExpenseForm'
import { IncomePanel } from './IncomePanel'
import { ExportButton } from './ExportButton'
import { TrendPanel } from './TrendPanel'
import { exportBasename, monthTable } from '@/lib/exportTables'

const filterCls = 'rounded bg-surface px-2 py-1.5 text-sm ring-1 ring-slate-700 focus:ring-2 focus:ring-primary'

function movKey(m: Movimiento): string {
  return m.source === SOURCE_FIJO ? `fijo-${m.fixedId}` : `cuota-${m.installmentId}`
}

export function MonthView() {
  const period = useAtomValue(periodAtom)
  const refresh = useAtomValue(refreshAtom)
  const bump = useSetAtom(refreshAtom)
  const reload = () => bump((n) => n + 1)

  const query = useQuery(`${period}:${refresh}`, async () => {
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

  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<Expense | null>(null)
  const [confirmExpId, setConfirmExpId] = useState<number | null>(null)
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set())
  const [filterCategory, setFilterCategory] = useState('')
  const [filterCardId, setFilterCardId] = useState<number | ''>('')

  function openNewExpense() {
    setEditing(null)
    setShowForm(true)
  }

  // "n" opens the new-expense form (ignored while typing or inside a dialog).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'n' || e.altKey || e.ctrlKey || e.metaKey) return
      const t = e.target
      if (t instanceof HTMLElement && (['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || t.closest('dialog'))) return
      e.preventDefault()
      openNewExpense()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (query.status === 'error') return <QueryError message={query.error} onRetry={reload} />
  if (!query.data) return <Spinner />
  const { summary, expenses, categories, merchants } = query.data
  const stale = query.status === 'loading'

  function setPaid(m: Movimiento, paid: boolean): Promise<OpResult> {
    return m.source === SOURCE_FIJO && m.fixedId != null
      ? FinanceService.SetFixedExpensePaid(m.fixedId, period, paid)
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

  async function removeExpense(expenseId: number) {
    setConfirmExpId(null)
    if (!failed(await FinanceService.DeleteExpense(expenseId))) reload()
  }

  function editExpense(expenseId: number) {
    const exp = expenses.find((e) => e.id === expenseId)
    if (exp) {
      setEditing(exp)
      setShowForm(true)
    }
  }

  const balanceTone = summary.alcanza ? 'success' : 'danger'
  const budgetByCategory = new Map<string, BudgetStatus>(summary.presupuestos.map((b) => [b.category, b]))
  const overBudget = summary.presupuestos.filter((b) => b.over)

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
      {overBudget.length > 0 && (
        <div role="status" className="rounded-base bg-danger/10 px-4 py-3 text-sm text-red-200 ring-1 ring-danger/30">
          Presupuesto excedido en{' '}
          {overBudget.map((b, i) => (
            <span key={b.categoryId}>
              {i > 0 && ', '}
              <strong>{b.category}</strong> ({formatCLP(b.spent)} de {formatCLP(b.budget)})
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
              : `Tras ahorrar ${formatCLP(summary.ahorro)} · se arrastra al próximo mes`
          }
        />
        <StatCard label="¿Alcanza?" value={summary.alcanza ? 'Sí ✓' : 'No ✕'} tone={balanceTone} />
      </div>

      <div className="grid gap-5 lg:grid-cols-4">
        <div className="lg:col-span-3">
          <Section
            title="Movimientos del mes"
            action={
              <div className="flex items-center gap-2">
                {summary.movimientos.length > 0 && (
                  <ExportButton build={() => monthTable(summary)} basename={exportBasename('mes', period)} />
                )}
                <Button onClick={openNewExpense}>
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
                          const busy = pending.has(movKey(m))
                          return (
                            <tr key={movKey(m)} className="border-t border-slate-800">
                              <td className="py-2 font-medium">
                                <span className="block max-w-[220px] truncate" title={m.description}>
                                  {m.description}
                                </span>
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
                                {isFijo ? 'Fijo' : m.total > 1 ? `${m.number}/${m.total}` : 'Único'}
                              </td>
                              <td className="hidden py-2 text-slate-400 md:table-cell">{isFijo ? '—' : formatDate(m.date)}</td>
                              <td className="py-2 text-right tabular-nums">{formatCLP(m.amount)}</td>
                              <td className="py-2 text-center">
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
                              </td>
                              <td className="whitespace-nowrap py-2 text-right">
                                {isFijo ? (
                                  <span className="text-xs text-slate-500" title="Se administra en la pestaña Fijos">
                                    Fijo ⚙
                                  </span>
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
                              <Bar fill={ratio(budget.spent, budget.budget)} tone={budget.over ? 'danger' : 'success'} />
                            ) : (
                              <Bar fill={ratio(c.total, summary.gastos)} />
                            )}
                          </div>
                          <span className="w-28 shrink-0 text-right tabular-nums">{formatCLP(c.total)}</span>
                        </div>
                        {budget && (
                          <div className={`mt-0.5 text-right text-xs ${budget.over ? 'text-danger' : 'text-slate-500'}`}>
                            {budget.over
                              ? `Excedido por ${formatCLP(budget.remaining.replace('-', ''))} · tope ${formatCLP(budget.budget)}`
                              : `Quedan ${formatCLP(budget.remaining)} de ${formatCLP(budget.budget)}`}
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
            <TrendPanel period={period} refresh={refresh} />
          </div>
        </div>

        <div className="space-y-5">
          <IncomePanel />

          <Section title="Tarjetas (cupo)">
            {summary.porTarjeta.length === 0 ? (
              <Empty>Sin tarjetas. Créalas en la pestaña Tarjetas.</Empty>
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
        </div>
      </div>

      {showForm && (
        <ExpenseForm
          cards={summary.porTarjeta.map((t) => t.card)}
          categories={categories}
          merchants={merchants}
          target={editing ? { mode: 'edit', expense: editing } : { mode: 'create' }}
          onClose={() => setShowForm(false)}
          onSaved={reload}
        />
      )}
    </div>
  )
}
