import { useState, type SubmitEvent } from 'react'
import { useAtomValue } from 'jotai'
import { FinanceService, type SavingsGoalView } from '@/services/finance'
import { periodAtom } from '@/atoms/finance'
import { useInvalidate, useVersion } from '@/atoms/refresh'
import { failed } from '@/lib/result'
import { useQuery } from '@/lib/useQuery'
import { isNegative, isZero, ratio } from '@/lib/money'
import { formatCLP, periodLabel } from '@/lib/format'
import { Bar, Button, Empty, Field, IconButton, Modal, MoneyInput, QueryError, Section, Spinner, inputCls } from './ui'

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
  const [confirmId, setConfirmId] = useState<number | null>(null)

  const query = useQuery(version, () => FinanceService.ListSavingsGoals())

  async function remove(id: number) {
    setConfirmId(null)
    if (!failed(await FinanceService.DeleteSavingsGoal(id))) reload()
  }

  async function removeContribution(id: number) {
    if (!failed(await FinanceService.DeleteSavingsContribution(id))) reload()
  }

  if (query.status === 'error') return <QueryError message={query.error} onRetry={reload} />
  if (!query.data) return <Spinner />
  const goals = query.data

  return (
    <Section
      title="Metas de ahorro"
      action={
        <Button
          onClick={() => {
            setEditing(null)
            setShowForm(true)
          }}
        >
          + Nueva meta
        </Button>
      }
    >
      <p className="mb-4 text-xs text-slate-500">
        Cada aporte sale del disponible del mes en que lo registras (como un gasto, pero aparte), así el saldo refleja
        lo que te queda para gastar. Un retiro hace lo contrario: la plata vuelve al disponible de su mes.
      </p>
      {goals.some((g) => g.overdue) && (
        <div role="status" className="mb-4 rounded-base bg-danger/10 px-4 py-3 text-sm text-red-200 ring-1 ring-danger/30">
          Metas vencidas sin completar:{' '}
          {goals
            .filter((g) => g.overdue)
            .map((g) => `${g.name} (faltan ${formatCLP(g.remaining)})`)
            .join(', ')}
          . Ajusta la fecha objetivo o el monto, o sigue aportando.
        </div>
      )}
      {goals.length === 0 ? (
        <Empty>Aún no tienes metas. Crea una (vacaciones, fondo de emergencia…) y registra aportes mes a mes.</Empty>
      ) : (
        <ul className="space-y-4">
          {goals.map((g) => {
            const done = isZero(g.remaining)
            return (
              <li key={g.id} className="rounded-base bg-surface p-4 ring-1 ring-slate-800">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="font-medium">
                      {g.name} {done && <span className="ml-1 text-xs text-success">¡Meta cumplida!</span>}
                      {g.overdue && (
                        <span className="ml-2 rounded-full bg-danger/15 px-2 py-0.5 text-xs text-red-200">Vencida</span>
                      )}
                    </div>
                    <div className="text-xs text-slate-500">
                      {formatCLP(g.saved)} de {formatCLP(g.targetAmount)}
                      {g.targetPeriod && ` · objetivo ${periodLabel(g.targetPeriod)}`}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button onClick={() => setMovement({ goal: g, kind: 'aporte' })}>+ Aporte</Button>
                    {!isZero(g.saved) && (
                      <Button variant="ghost" onClick={() => setMovement({ goal: g, kind: 'retiro' })}>
                        Retirar
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setEditing(g)
                        setShowForm(true)
                      }}
                    >
                      Editar
                    </Button>
                    {confirmId === g.id ? (
                      <>
                        <span className="text-sm text-danger">¿Eliminar?</span>
                        <Button variant="danger" onClick={() => remove(g.id)}>
                          Sí
                        </Button>
                        <Button variant="ghost" onClick={() => setConfirmId(null)}>
                          No
                        </Button>
                      </>
                    ) : (
                      <Button variant="danger" onClick={() => setConfirmId(g.id)}>
                        Eliminar
                      </Button>
                    )}
                  </div>
                </div>

                <div className="mt-3">
                  <Bar fill={ratio(g.saved, g.targetAmount)} tone={done ? 'success' : 'primary'} />
                </div>
                {!done && (
                  <p className="mt-2 text-sm text-slate-300">
                    Faltan <strong>{formatCLP(g.remaining)}</strong>
                    {g.monthsLeft > 0
                      ? ` · ahorra ${formatCLP(g.monthlyNeeded)} al mes durante ${g.monthsLeft} ${g.monthsLeft === 1 ? 'mes' : 'meses'} para llegar a tiempo`
                      : g.targetPeriod
                        ? ' · la fecha objetivo ya pasó'
                        : ''}
                  </p>
                )}

                {g.contributions.length > 0 && (
                  <details className="mt-3">
                    <summary className="cursor-pointer text-xs text-slate-400">
                      {g.contributions.length} {g.contributions.length === 1 ? 'movimiento' : 'movimientos'}
                    </summary>
                    <ul className="mt-2 space-y-1 text-sm">
                      {g.contributions.map((c) => (
                        <li key={c.id} className="flex items-center justify-between">
                          <span className="text-slate-400">
                            {periodLabel(c.period)}
                            {isNegative(c.amount) && ' · retiro'}
                          </span>
                          <span className="flex items-center gap-2">
                            <span className={`tabular-nums ${isNegative(c.amount) ? 'text-warning' : 'text-success'}`}>
                              {formatCLP(c.amount)}
                            </span>
                            <IconButton
                              label={`Eliminar ${isNegative(c.amount) ? 'retiro' : 'aporte'} de ${periodLabel(c.period)}`}
                              onClick={() => removeContribution(c.id)}
                              className="text-slate-500 hover:text-danger"
                            >
                              ✕
                            </IconButton>
                          </span>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </li>
            )
          })}
        </ul>
      )}

      {showForm && <GoalForm goal={editing} onClose={() => setShowForm(false)} onSaved={reload} />}
      {movement && <MovementForm movement={movement} defaultPeriod={period} onClose={() => setMovement(null)} onSaved={reload} />}
    </Section>
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
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? 'Guardando…' : 'Guardar'}
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
        <p className="text-xs text-slate-500">
          {withdrawal
            ? `Vuelve al disponible de ${month}. Tienes ${formatCLP(goal.saved)} en esta meta.`
            : `Se descuenta del disponible de ${month}.`}
        </p>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? 'Guardando…' : withdrawal ? 'Registrar retiro' : 'Registrar aporte'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
