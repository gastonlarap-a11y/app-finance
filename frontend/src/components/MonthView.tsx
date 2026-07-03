import { useCallback, useEffect, useState } from 'react'
import { useAtom, useSetAtom } from 'jotai'
import {
  FinanceService,
  SOURCE_FIJO,
  STATUS_PAGADO,
  type Expense,
  type MonthlySummary,
  type Movimiento,
} from '@/services/finance'
import { periodAtom, refreshAtom } from '@/atoms/finance'
import { failed } from '@/lib/result'
import { formatCLP, formatDate } from '@/lib/format'
import { Bar, Button, Empty, Section, Spinner, StatCard } from './ui'
import { ExpenseForm } from './ExpenseForm'
import { IncomePanel } from './IncomePanel'

export function MonthView() {
  const [period] = useAtom(periodAtom)
  const [refresh] = useAtom(refreshAtom)
  const bump = useSetAtom(refreshAtom)

  const [summary, setSummary] = useState<MonthlySummary | null>(null)
  const [expenses, setExpenses] = useState<Expense[]>([])
  const [categories, setCategories] = useState<string[]>([])
  const [merchants, setMerchants] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<Expense | null>(null)
  const [confirmExpId, setConfirmExpId] = useState<number | null>(null)
  const [filterCategory, setFilterCategory] = useState('')
  const [filterCardId, setFilterCardId] = useState<number | ''>('')

  const reload = useCallback(() => bump((n) => n + 1), [bump])

  useEffect(() => {
    let active = true
    setLoading(true)
    Promise.all([
      FinanceService.MonthlySummary(period),
      FinanceService.ListExpenses(period),
      FinanceService.ListCategories(),
      FinanceService.ListMerchants(),
    ])
      .then(([res, exp, cats, mers]) => {
        if (!active) return
        if (res.error) {
          window.alert(res.error.message)
          setSummary(null)
        } else {
          setSummary(res.data ?? null)
        }
        setExpenses(exp ?? [])
        setCategories((cats ?? []).map((c) => c.name))
        setMerchants((mers ?? []).map((m) => m.name))
      })
      .finally(() => active && setLoading(false))
    return () => {
      active = false
    }
  }, [period, refresh])

  async function togglePaid(m: Movimiento, currentlyPaid: boolean) {
    const res =
      m.source === SOURCE_FIJO && m.fixedId != null
        ? await FinanceService.SetFixedExpensePaid(m.fixedId, period, !currentlyPaid)
        : await FinanceService.SetInstallmentPaid(m.installmentId, !currentlyPaid)
    if (!failed(res)) reload()
  }

  async function markCardPaid(targets: Movimiento[]) {
    const pending = targets.filter((m) => m.status !== STATUS_PAGADO)
    if (pending.length === 0) return
    await Promise.all(
      pending.map((m) =>
        m.source === SOURCE_FIJO && m.fixedId != null
          ? FinanceService.SetFixedExpensePaid(m.fixedId, period, true)
          : FinanceService.SetInstallmentPaid(m.installmentId, true)
      )
    )
    reload()
  }

  async function removeExpense(expenseId: number) {
    setConfirmExpId(null)
    const res = await FinanceService.DeleteExpense(expenseId)
    if (!failed(res)) reload()
  }

  function editExpense(expenseId: number) {
    const exp = expenses.find((e) => e.id === expenseId)
    if (exp) {
      setEditing(exp)
      setShowForm(true)
    }
  }

  if (loading && !summary) return <Spinner />
  if (!summary) return <Empty>No se pudo cargar el resumen.</Empty>

  const balanceTone = summary.alcanza ? 'success' : 'danger'

  // Built from the movimientos themselves (not summary.porTarjeta) so a card that
  // was since soft-deleted still shows up as a filter option for its past charges.
  const movCategories = Array.from(new Set(summary.movimientos.map((m) => m.category))).sort()
  const movCards = Array.from(
    new Map(
      summary.movimientos
        .filter((m): m is Movimiento & { cardId: number } => m.cardId != null)
        .map((m) => [m.cardId, m.cardName || '—'] as const)
    )
  )
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name))

  const filteredMovs = summary.movimientos.filter((m) => {
    if (filterCategory && m.category !== filterCategory) return false
    if (filterCardId !== '' && m.cardId !== filterCardId) return false
    return true
  })

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatCard
          label="Disponible"
          value={formatCLP(summary.disponible)}
          tone="primary"
          hint={`Acumulado ${formatCLP(summary.acumulado)} + ingresos ${formatCLP(summary.ingresos)}`}
        />
        <StatCard label="Gastos del mes" value={formatCLP(summary.gastos)} hint={`Pagado ${formatCLP(summary.pagado)} · Pendiente ${formatCLP(summary.pendiente)}`} />
        <StatCard label="Balance" value={formatCLP(summary.balance)} tone={balanceTone} hint="Se arrastra al próximo mes" />
        <StatCard label="¿Alcanza?" value={summary.alcanza ? 'Sí ✓' : 'No ✕'} tone={balanceTone} />
      </div>

      <div className="grid gap-5 lg:grid-cols-4">
        <div className="lg:col-span-3">
          <Section
            title="Movimientos del mes"
            action={
              <Button
                onClick={() => {
                  setEditing(null)
                  setShowForm(true)
                }}
              >
                + Agregar gasto
              </Button>
            }
          >
            {summary.movimientos.length === 0 ? (
              <Empty>No hay movimientos este mes. Agrega un gasto para empezar.</Empty>
            ) : (
              <>
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <select
                    className="rounded bg-surface px-2 py-1.5 text-sm ring-1 ring-slate-700 focus:ring-2 focus:ring-primary"
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
                    className="rounded bg-surface px-2 py-1.5 text-sm ring-1 ring-slate-700 focus:ring-2 focus:ring-primary"
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
                </div>

                {filteredMovs.length === 0 ? (
                  <Empty>No hay movimientos con ese filtro.</Empty>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="text-left text-xs uppercase text-slate-400">
                        <tr>
                          <th className="pb-2">Descripción</th>
                          <th className="pb-2 hidden md:table-cell">Categoría</th>
                          <th className="pb-2 hidden lg:table-cell">Comercio</th>
                          <th className="pb-2 hidden lg:table-cell">Tarjeta</th>
                          <th className="pb-2 hidden lg:table-cell">Cuota</th>
                          <th className="pb-2 hidden md:table-cell">Fecha</th>
                          <th className="pb-2 text-right">Monto</th>
                          <th className="pb-2 text-center">Estado</th>
                          <th className="pb-2"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredMovs.map((m) => {
                          const paid = m.status === STATUS_PAGADO
                          const isFijo = m.source === SOURCE_FIJO
                          return (
                            <tr key={isFijo ? `fijo-${m.fixedId}` : `cuota-${m.installmentId}`} className="border-t border-slate-800">
                              <td className="py-2 font-medium">
                                <span className="block max-w-[220px] truncate" title={m.description}>{m.description}</span>
                              </td>
                              <td className="py-2 hidden text-slate-400 md:table-cell">
                                <span className="block max-w-[140px] truncate" title={m.category}>{m.category}</span>
                              </td>
                              <td className="py-2 hidden text-slate-400 lg:table-cell">
                                <span className="block max-w-[140px] truncate" title={m.merchant || '—'}>{m.merchant || '—'}</span>
                              </td>
                              <td className="py-2 hidden text-slate-400 lg:table-cell">
                                <span className="block max-w-[120px] truncate" title={m.cardName || '—'}>{m.cardName || '—'}</span>
                              </td>
                              <td className="py-2 hidden text-slate-400 lg:table-cell">{isFijo ? 'Fijo' : m.total > 1 ? `${m.number}/${m.total}` : 'Único'}</td>
                              <td className="py-2 hidden text-slate-400 md:table-cell">{isFijo ? '—' : formatDate(m.date)}</td>
                              <td className="py-2 text-right tabular-nums">{formatCLP(m.amount)}</td>
                              <td className="py-2 text-center">
                                <button
                                  onClick={() => togglePaid(m, paid)}
                                  className={`rounded-full px-2 py-0.5 text-xs font-medium ${paid ? 'bg-success/20 text-success' : 'bg-warning/20 text-warning'}`}
                                  title="Marcar pagado/pendiente"
                                >
                                  {paid ? 'Pagado' : 'Pendiente'}
                                </button>
                              </td>
                              <td className="py-2 text-right whitespace-nowrap">
                                {isFijo ? (
                                  <span className="text-xs text-slate-500" title="Se administra en la pestaña Fijos">Fijo ⚙</span>
                                ) : (
                                  <>
                                    <button onClick={() => editExpense(m.expenseId)} className="text-slate-400 hover:text-primary" title="Editar">
                                      ✎
                                    </button>{' '}
                                    {confirmExpId === m.expenseId ? (
                                      <>
                                        <button onClick={() => removeExpense(m.expenseId)} className="text-xs text-danger hover:text-red-400" title="Confirmar eliminación">
                                          ✓ Sí
                                        </button>{' '}
                                        <button onClick={() => setConfirmExpId(null)} className="text-xs text-slate-400 hover:text-slate-200" title="Cancelar">
                                          ✕ No
                                        </button>
                                      </>
                                    ) : (
                                      <button onClick={() => setConfirmExpId(m.expenseId)} className="text-slate-400 hover:text-danger" title="Eliminar">
                                        🗑
                                      </button>
                                    )}
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
                <ul className="space-y-2">
                  {summary.porCategoria.map((c) => (
                    <li key={c.category} className="flex items-center justify-between gap-3 text-sm">
                      <span className="w-40 shrink-0 truncate text-slate-300">{c.category}</span>
                      <div className="flex-1">
                        <Bar value={Number(c.total)} max={Number(summary.gastos) || 1} />
                      </div>
                      <span className="w-28 shrink-0 text-right tabular-nums">{formatCLP(c.total)}</span>
                    </li>
                  ))}
                </ul>
              </Section>
            </div>
          )}
        </div>

        <div className="space-y-5">
          <IncomePanel />

          <Section title="Tarjetas (cupo)">
            {summary.porTarjeta.length === 0 ? (
              <Empty>Sin tarjetas. Créalas en la pestaña Tarjetas.</Empty>
            ) : (
              <ul className="space-y-4">
                {summary.porTarjeta.map((t) => {
                  const limit = Number(t.card.creditLimit) || 0
                  const used = Number(t.cupoUsado) || 0
                  const over = used > limit && limit > 0
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
                      <Bar value={used} max={limit || used || 1} tone={over ? 'danger' : 'primary'} />
                      <div className="mt-1 flex justify-between text-xs text-slate-500">
                        <span>Usado {formatCLP(t.cupoUsado)} / {formatCLP(t.card.creditLimit)}</span>
                        <span className={over ? 'text-danger' : 'text-success'}>
                          Disponible {formatCLP(t.cupoDisponible)}
                        </span>
                      </div>
                      {pendingCount > 0 && (
                        <button
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
          expense={editing}
          onClose={() => setShowForm(false)}
          onSaved={reload}
        />
      )}
    </div>
  )
}
