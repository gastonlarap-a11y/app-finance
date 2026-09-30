import { useState, type SubmitEvent } from 'react'
import { FinanceService, type AccountsClosing, type MonthlySummary } from '@/services/finance'
import { failed } from '@/lib/result'
import { useQuery } from '@/lib/useQuery'
import { compare, isNegative, isZero, subtract, withSign } from '@/lib/money'
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

  const amount = withSign(magnitude, negative)
  // The same close as the bank shows it through the accounts, when they are all reconciled.
  const closing = useQuery(`accounts-closing:${target}`, async () => {
    const r = await FinanceService.AccountsClosing(target)
    if (r.error) throw new Error(r.error.message)
    return r.data ?? null
  })
  function applyClosing(total: string) {
    setMagnitude(total.replace(/^-/, ''))
    setNegative(isNegative(total))
  }
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
        <p className="text-sm text-fg-muted">
          {mode === 'cierre'
            ? 'Ingresa el saldo que muestra tu banco al cierre del mes. Desde ahí se arrastra el saldo a los meses siguientes.'
            : `Ingresa con cuánto partiste este mes (el saldo real al cierre de ${periodLabel(target)}). Los meses anteriores dejan de sumarse.`}
        </p>
        <Field label="Saldo real">
          <MoneyInput value={magnitude} onChange={setMagnitude} required placeholder="0" />
        </Field>
        <label className="flex items-center gap-2 text-sm text-fg-muted">
          <input type="checkbox" className="size-4 accent-accent" checked={negative} onChange={(e) => setNegative(e.target.checked)} />
          Saldo negativo (cuenta sobregirada)
        </label>
        {closing.status === 'error' ? (
          <p className="text-xs text-negative-fg">No se pudo calcular desde tus cuentas: {closing.error}</p>
        ) : (
          closing.data && <FromAccounts closing={closing.data} onUse={applyClosing} />
        )}
        <dl className="grid grid-cols-2 gap-1 rounded-lg bg-sunken p-3 text-sm">
          <dt className="text-fg-muted">{mode === 'cierre' ? 'Calculado por la app' : 'Arrastre calculado'}</dt>
          <dd className="text-right tabular-nums text-fg">{formatCLP(computed)}</dd>
          {difference !== null && (
            <>
              <dt className="text-fg-muted">Diferencia</dt>
              <dd
                className={`text-right font-medium tabular-nums ${
                  compare(difference, '0') < 0 ? 'text-negative-fg' : compare(difference, '0') > 0 ? 'text-positive-fg' : 'text-fg'
                }`}
              >
                {formatCLP(difference)}
              </dd>
            </>
          )}
        </dl>
        <div className="flex flex-wrap justify-between gap-2">
          {recorded !== null ? (
            <Button variant="quiet" onClick={remove} disabled={busy}>
              Quitar
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="secondary" onClick={onClose}>
              Cancelar
            </Button>
            <Button type="submit" loading={busy} disabled={amount === ''}>
              Guardar
            </Button>
          </div>
        </div>
      </form>
    </Modal>
  )
}

// FromAccounts offers the month's close as the bank shows it through the
// accounts — their real closing balances minus what the cards owed — once
// every account that counts is reconciled, or says which ones are missing.
// Nothing when the profile has no accounts.
function FromAccounts({ closing: c, onUse }: { closing: AccountsClosing; onUse: (total: string) => void }) {
  if (!c.complete) {
    if (c.missing.length === 0) return null
    return (
      <p className="text-xs text-fg-subtle">
        Para calcularlo desde tus cuentas, concilia también {c.missing.join(', ')} en el panel Cuentas.
      </p>
    )
  }
  return (
    <div className="space-y-2 rounded-lg bg-sunken p-3 text-sm ring-1 ring-inset ring-line">
      <p className="text-fg-muted">
        Según tus cuentas conciliadas: <span className="tabular-nums">{formatCLP(c.accounts)}</span>
        {!isZero(c.cardsOwed) && (
          <>
            {' '}
            − tarjetas por pagar <span className="tabular-nums">{formatCLP(c.cardsOwed)}</span>
          </>
        )}{' '}
        = <strong className="tabular-nums text-fg">{formatCLP(c.total)}</strong>
        {!isZero(c.saved) && <> (sin contar {formatCLP(c.saved)} de ahorro, que ya es Ahorro)</>}.
      </p>
      {(!isZero(c.unassignedIngresos) || !isZero(c.unassignedGastos)) && (
        <p className="text-xs text-caution-fg">
          Este mes hay movimientos sin cuenta (+{formatCLP(c.unassignedIngresos)} / −{formatCLP(c.unassignedGastos)}): la suma de
          tus cuentas no los incluye.
        </p>
      )}
      <Button size="sm" variant="secondary" onClick={() => onUse(c.total)}>
        Usar este saldo
      </Button>
    </div>
  )
}
