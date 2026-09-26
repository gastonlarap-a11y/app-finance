import { useState, type SubmitEvent } from 'react'
import { FinanceService, type MonthlySummary } from '@/services/finance'
import { failed } from '@/lib/result'
import { compare, isNegative, isZero, subtract } from '@/lib/money'
import { formatCLP, periodLabel, shiftPeriod } from '@/lib/format'
import { Button, Field, Modal, MoneyInput } from './ui'

// Both entry points record the same thing — the real balance at the close of a
// month (see backend/finance/reconciliation.go):
//   - 'cierre': the month shown, compared with the balance the app computes;
//   - 'inicio': the month before it, i.e. the balance this month starts with.
export type ReconcileMode = 'cierre' | 'inicio'

type Props = {
  mode: ReconcileMode
  summary: MonthlySummary
  onClose: () => void
  onSaved: () => void
}

// initialBalance is the real balance already recorded for the target month, if any.
function initialBalance(mode: ReconcileMode, summary: MonthlySummary, target: string): string | null {
  if (mode === 'cierre') return summary.conciliacion?.saldoReal ?? null
  return summary.acumuladoDesde === target ? summary.acumulado : null
}

export function ReconcileDialog({ mode, summary, onClose, onSaved }: Props) {
  const target = mode === 'cierre' ? summary.period : shiftPeriod(summary.period, -1)
  const recorded = initialBalance(mode, summary, target)
  // MoneyInput holds a magnitude; the sign is a separate, explicit choice
  // (an overdrawn account), so a stray "-" can never flip a balance.
  const [magnitude, setMagnitude] = useState(recorded ? recorded.replace(/^-/, '') : '')
  const [negative, setNegative] = useState(recorded ? isNegative(recorded) : false)
  const [busy, setBusy] = useState(false)

  const amount = magnitude === '' ? '' : negative && !isZero(magnitude) ? `-${magnitude}` : magnitude
  // What the app computes for the target month: the balance at the close of the
  // month shown, or the carried balance it starts with.
  const computed = mode === 'cierre' ? (summary.conciliacion?.calculado ?? summary.balance) : summary.acumulado
  const difference = amount === '' ? null : subtract(amount, computed)

  async function save(e: SubmitEvent) {
    e.preventDefault()
    if (amount === '' || busy) return
    setBusy(true)
    try {
      if (!failed(await FinanceService.SetReconciliation(target, amount))) onSaved()
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    setBusy(true)
    try {
      if (!failed(await FinanceService.DeleteReconciliation(target))) onSaved()
    } finally {
      setBusy(false)
    }
  }

  const title = mode === 'cierre' ? `Conciliar cierre de ${periodLabel(target)}` : `Saldo inicial de ${periodLabel(summary.period)}`
  return (
    <Modal title={title} onClose={onClose}>
      <form onSubmit={save} className="space-y-4">
        <p className="text-sm text-slate-400">
          {mode === 'cierre'
            ? 'Ingresa el saldo que muestra tu banco al cierre del mes. Desde ahí se arrastra el saldo a los meses siguientes.'
            : `Ingresa con cuánto partiste este mes (el saldo real al cierre de ${periodLabel(target)}). Los meses anteriores dejan de sumarse.`}
        </p>
        <Field label="Saldo real">
          <MoneyInput value={magnitude} onChange={setMagnitude} required placeholder="0" />
        </Field>
        <label className="flex items-center gap-2 text-sm text-slate-300">
          <input type="checkbox" checked={negative} onChange={(e) => setNegative(e.target.checked)} />
          Saldo negativo (cuenta sobregirada)
        </label>
        <dl className="grid grid-cols-2 gap-1 rounded bg-surface p-3 text-sm">
          <dt className="text-slate-400">{mode === 'cierre' ? 'Calculado por la app' : 'Arrastre calculado'}</dt>
          <dd className="text-right">{formatCLP(computed)}</dd>
          {difference !== null && (
            <>
              <dt className="text-slate-400">Diferencia</dt>
              <dd className={`text-right font-medium ${compare(difference, '0') < 0 ? 'text-danger' : compare(difference, '0') > 0 ? 'text-success' : ''}`}>
                {formatCLP(difference)}
              </dd>
            </>
          )}
        </dl>
        <div className="flex flex-wrap justify-between gap-2">
          {recorded !== null ? (
            <Button variant="ghost" onClick={remove} disabled={busy}>
              Quitar
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancelar
            </Button>
            <Button type="submit" disabled={busy || amount === ''}>
              {busy ? 'Guardando…' : 'Guardar'}
            </Button>
          </div>
        </div>
      </form>
    </Modal>
  )
}
