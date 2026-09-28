import { useState, type SubmitEvent } from 'react'
import { useAtomValue } from 'jotai'
import { FinanceService, type SavingsGoalView } from '@/services/finance'
import { periodAtom } from '@/atoms/finance'
import { useInvalidate, useVersion } from '@/atoms/refresh'
import { failed } from '@/lib/result'
import { useQuery } from '@/lib/useQuery'
import { isNegative, isZero, ratio } from '@/lib/money'
import { formatCLP, periodLabel } from '@/lib/format'
import { ArrowDownToLine, CircleCheck, Pencil, PiggyBank, Plus, Trash, X } from 'lucide-react'
import {
  Badge,
  Bar,
  Button,
  Callout,
  ConfirmDialog,
  EmptyState,
  Field,
  IconButton,
  Menu,
  Modal,
  MoneyInput,
  QueryError,
  Skeleton,
  inputCls,
  type MenuAction,
} from './ui'

// SavingsView manages savings goals. Contributions count as an outflow of their
// month (they lower disponible and the carried balance) but show apart from
// gastos and never count against category budgets; withdrawals do the reverse.
export function SavingsView() {
  const version = useVersion('ledger')
  const period = useAtomValue(periodAtom)
  const invalidate = useInvalidate()
  const reload = () => invalidate('ledger')
  const [editing, setEditing] = useState<SavingsGoalView | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [movement, setMovement] = useState<GoalMovement | null>(null)
  const [deleting, setDeleting] = useState<SavingsGoalView | null>(null)

  const query = useQuery(version, () => FinanceService.ListSavingsGoals())

  async function remove(id: number) {
    if (!failed(await FinanceService.DeleteSavingsGoal(id))) reload()
  }

  async function removeContribution(id: number) {
    if (!failed(await FinanceService.DeleteSavingsContribution(id))) reload()
  }

  function openNew() {
    setEditing(null)
    setShowForm(true)
  }

  if (query.status === 'error') return <QueryError message={query.error} onRetry={reload} />
  const goals = query.data
  const overdue = goals?.filter((g) => g.overdue) ?? []

  return (
    <div className="@container space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-prose text-sm text-fg-muted">
          Cada aporte sale del disponible del mes en que lo registras (como un gasto, pero aparte), así el saldo refleja lo que te
          queda para gastar. Un retiro hace lo contrario: la plata vuelve al disponible de su mes.
        </p>
        <Button icon={Plus} onClick={openNew}>
          Nueva meta
        </Button>
      </div>

      {overdue.length > 0 && (
        <Callout tone="negative" role="status" title="Metas vencidas sin completar">
          {overdue.map((g) => `${g.name} (faltan ${formatCLP(g.remaining)})`).join(', ')}. Ajusta la fecha objetivo o el monto, o
          sigue aportando.
        </Callout>
      )}

      {!goals ? (
        <div className="grid gap-4 @2xl:grid-cols-2">
          <Skeleton className="h-44 w-full rounded-xl" />
          <Skeleton className="h-44 w-full rounded-xl" />
        </div>
      ) : goals.length === 0 ? (
        <EmptyState
          icon={PiggyBank}
          title="Aún no tienes metas de ahorro"
          action={
            <Button icon={Plus} onClick={openNew}>
              Crear la primera
            </Button>
          }
        >
          Vacaciones, fondo de emergencia, el pie del auto… Define cuánto y para cuándo, y la app te dice cuánto apartar cada mes.
        </EmptyState>
      ) : (
        <ul className="grid gap-4 @2xl:grid-cols-2">
          {goals.map((g) => {
            const done = isZero(g.remaining)
            const actions: MenuAction[] = [
              ...(!isZero(g.saved) ? [{ label: 'Retirar', icon: ArrowDownToLine, onSelect: () => setMovement({ goal: g, kind: 'retiro' }) }] : []),
              {
                label: 'Editar',
                icon: Pencil,
                onSelect: () => {
                  setEditing(g)
                  setShowForm(true)
                },
              },
              { label: 'Eliminar…', icon: Trash, tone: 'danger' as const, onSelect: () => setDeleting(g) },
            ]
            return (
              <li key={g.id} className="flex flex-col rounded-xl bg-panel p-5 shadow-xs ring-1 ring-line">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-start gap-3">
                    <span aria-hidden="true" className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent-fg">
                      <PiggyBank className="size-5" />
                    </span>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold text-fg">{g.name}</span>
                        {done && (
                          <Badge tone="positive" icon={CircleCheck}>
                            Cumplida
                          </Badge>
                        )}
                        {g.overdue && <Badge tone="negative">Vencida</Badge>}
                      </div>
                      <div className="text-xs text-fg-muted">
                        <span className="font-medium tabular-nums text-fg">{formatCLP(g.saved)}</span> de {formatCLP(g.targetAmount)}
                        {g.targetPeriod && ` · objetivo ${periodLabel(g.targetPeriod)}`}
                      </div>
                    </div>
                  </div>
                  <Menu label={`Acciones de la meta ${g.name}`} items={actions} />
                </div>

                <div className="mt-4">
                  <Bar fill={ratio(g.saved, g.targetAmount)} tone={done ? 'success' : 'primary'} />
                </div>
                {!done && (
                  <p className="mt-2 text-sm text-fg-muted">
                    Faltan <strong className="text-fg">{formatCLP(g.remaining)}</strong>
                    {g.monthsLeft > 0
                      ? ` · aparta ${formatCLP(g.monthlyNeeded)} al mes durante ${g.monthsLeft} ${g.monthsLeft === 1 ? 'mes' : 'meses'} para llegar a tiempo`
                      : g.targetPeriod
                        ? ' · la fecha objetivo ya pasó'
                        : ''}
                  </p>
                )}

                <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
                  {g.contributions.length > 0 ? (
                    <details className="group min-w-0 flex-1">
                      <summary className="cursor-pointer text-xs font-medium text-fg-muted hover:text-fg">
                        {g.contributions.length} {g.contributions.length === 1 ? 'movimiento' : 'movimientos'}
                      </summary>
                      <ul className="mt-2 divide-y divide-line text-sm">
                        {g.contributions.map((c) => (
                          <li key={c.id} className="flex items-center justify-between gap-2 py-1">
                            <span className="text-fg-muted">
                              {periodLabel(c.period)}
                              {isNegative(c.amount) && ' · retiro'}
                            </span>
                            <span className="flex items-center gap-1.5">
                              <span className={`tabular-nums ${isNegative(c.amount) ? 'text-caution-fg' : 'text-positive-fg'}`}>
                                {formatCLP(c.amount)}
                              </span>
                              <IconButton
                                label={`Eliminar ${isNegative(c.amount) ? 'retiro' : 'aporte'} de ${periodLabel(c.period)}`}
                                icon={X}
                                tone="danger"
                                size="sm"
                                onClick={() => void removeContribution(c.id)}
                              />
                            </span>
                          </li>
                        ))}
                      </ul>
                    </details>
                  ) : (
                    <span className="text-xs text-fg-subtle">Sin aportes todavía</span>
                  )}
                  {!done && (
                    <Button size="sm" icon={Plus} onClick={() => setMovement({ goal: g, kind: 'aporte' })}>
                      Aporte
                    </Button>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {deleting && (
        <ConfirmDialog title="Eliminar meta" onConfirm={() => remove(deleting.id)} onClose={() => setDeleting(null)}>
          ¿Eliminar la meta «{deleting.name}»? Va a la papelera con sus aportes; mientras esté ahí, sus aportes no cuentan.
        </ConfirmDialog>
      )}
      {showForm && <GoalForm goal={editing} onClose={() => setShowForm(false)} onSaved={reload} />}
      {movement && <MovementForm movement={movement} defaultPeriod={period} onClose={() => setMovement(null)} onSaved={reload} />}
    </div>
  )
}

function GoalForm({ goal, onClose, onSaved }: { goal: SavingsGoalView | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(goal?.name ?? '')
  const [target, setTarget] = useState(goal?.targetAmount ?? '')
  const [targetPeriod, setTargetPeriod] = useState(goal?.targetPeriod ?? '')
  const [busy, setBusy] = useState(false)

  async function submit(e: SubmitEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      const res = goal
        ? await FinanceService.UpdateSavingsGoal(goal.id, name, target, targetPeriod)
        : await FinanceService.CreateSavingsGoal(name, target, targetPeriod)
      if (failed(res)) return
      onSaved()
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={goal ? 'Editar meta' : 'Nueva meta de ahorro'} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Nombre">
          <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="Vacaciones, fondo de emergencia…" required />
        </Field>
        <Field label="Monto objetivo">
          <MoneyInput value={target} onChange={setTarget} placeholder="1000000" required />
        </Field>
        <Field label="Fecha objetivo (opcional)">
          <input type="month" className={inputCls} value={targetPeriod} onChange={(e) => setTargetPeriod(e.target.value)} />
        </Field>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" loading={busy}>
            Guardar
          </Button>
        </div>
      </form>
    </Modal>
  )
}

// A money movement on a goal: a contribution leaves the month's disponible, a
// withdrawal gives it back (never more than the goal holds).
type GoalMovement = { goal: SavingsGoalView; kind: 'aporte' | 'retiro' }

function MovementForm({
  movement: { goal, kind },
  defaultPeriod,
  onClose,
  onSaved,
}: {
  movement: GoalMovement
  defaultPeriod: string
  onClose: () => void
  onSaved: () => void
}) {
  const withdrawal = kind === 'retiro'
  const [amount, setAmount] = useState(withdrawal || isZero(goal.monthlyNeeded) ? '' : goal.monthlyNeeded)
  const [period, setPeriod] = useState(defaultPeriod)
  const [busy, setBusy] = useState(false)

  async function submit(e: SubmitEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      const res = withdrawal
        ? await FinanceService.WithdrawSavings(goal.id, period, amount)
        : await FinanceService.AddSavingsContribution(goal.id, period, amount)
      if (failed(res)) return
      onSaved()
      onClose()
    } finally {
      setBusy(false)
    }
  }

  const month = period ? periodLabel(period) : 'ese mes'
  return (
    <Modal title={`${withdrawal ? 'Retiro' : 'Aporte'} · ${goal.name}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Monto">
          <MoneyInput value={amount} onChange={setAmount} placeholder="100000" required />
        </Field>
        <Field label="Mes">
          <input type="month" className={inputCls} value={period} onChange={(e) => setPeriod(e.target.value)} required />
        </Field>
        <p className="text-xs text-fg-subtle">
          {withdrawal
            ? `Vuelve al disponible de ${month}. Tienes ${formatCLP(goal.saved)} en esta meta.`
            : `Se descuenta del disponible de ${month}.`}
        </p>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" loading={busy}>
            {withdrawal ? 'Registrar retiro' : 'Registrar aporte'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
