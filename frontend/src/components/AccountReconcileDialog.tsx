import { useState, type SubmitEvent } from 'react'
import { FinanceService, type AccountView } from '@/services/finance'
import { failed } from '@/lib/result'
import { compare, isNegative, subtract, withSign } from '@/lib/money'
import { formatCLP, periodLabel } from '@/lib/format'
import { Button, Field, Modal, MoneyInput } from './ui'

type Props = {
  account: AccountView // at the close of `period`
  period: string
  onClose: () => void
  onSaved: () => void
}

// AccountReconcileDialog records one account's real balance at the close of
// `period` (backend/finance/accountreconciliation.go): from the next month on,
// the account's balance starts from it. The month's summary does not change.
export function AccountReconcileDialog({ account, period, onClose, onSaved }: Props) {
  const recorded = account.conciliacion?.saldoReal ?? null
  // MoneyInput holds a magnitude; the sign is a separate, explicit choice
  // (an overdrawn account), so a stray "-" can never flip a balance.
  const [magnitude, setMagnitude] = useState(recorded ? recorded.replace(/^-/, '') : '')
  const [negative, setNegative] = useState(recorded ? isNegative(recorded) : false)
  const [busy, setBusy] = useState(false)

  const amount = withSign(magnitude, negative)
  const computed = account.conciliacion?.calculado ?? account.balance
  const difference = amount === '' ? null : subtract(amount, computed)

  async function save(e: SubmitEvent) {
    e.preventDefault()
    if (amount === '' || busy) return
    setBusy(true)
    try {
      if (!failed(await FinanceService.SetAccountReconciliation(account.id, period, amount))) {
        onSaved()
        onClose()
      }
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    setBusy(true)
    try {
      if (!failed(await FinanceService.DeleteAccountReconciliation(account.id, period))) {
        onSaved()
        onClose()
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={`Conciliar ${account.name} · ${periodLabel(period)}`} onClose={onClose}>
      <form onSubmit={save} className="space-y-4">
        <p className="text-sm text-fg-muted">
          Ingresa el saldo que muestra tu banco al cierre de {periodLabel(period)}. Desde el mes siguiente, el saldo de esta cuenta
          parte de ahí. El resumen del mes no cambia.
        </p>
        <Field label="Saldo real al cierre">
          <MoneyInput value={magnitude} onChange={setMagnitude} required placeholder="0" autoFocus />
        </Field>
        <label className="flex items-center gap-2 text-sm text-fg-muted">
          <input type="checkbox" className="size-4 accent-accent" checked={negative} onChange={(e) => setNegative(e.target.checked)} />
          Saldo negativo (cuenta sobregirada)
        </label>
        <dl className="grid grid-cols-2 gap-1 rounded-lg bg-sunken p-3 text-sm">
          <dt className="text-fg-muted">Calculado por la app</dt>
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
              Quitar conciliación
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
