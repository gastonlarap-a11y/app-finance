import { useState, type SubmitEvent } from 'react'
import { FinanceService, type Movimiento } from '@/services/finance'
import { failed } from '@/lib/result'
import { formatCLP, periodLabel } from '@/lib/format'
import { Button, Field, Modal, MoneyInput, inputCls } from './ui'

// CuotaDialog adjusts one pending cuota of a purchase in cuotas: its amount
// (the bank rounded it, or it was renegotiated) or paying off the whole
// balance early, which moves every pending cuota to the month it is paid.
// Paid cuotas never change.
export function CuotaDialog({
  cuota,
  defaultPeriod,
  onClose,
  onSaved,
}: {
  cuota: Movimiento
  defaultPeriod: string
  onClose: () => void
  onSaved: () => void
}) {
  const [amount, setAmount] = useState(cuota.amount)
  const [period, setPeriod] = useState(defaultPeriod)
  const [busy, setBusy] = useState(false)

  async function run(action: () => ReturnType<typeof FinanceService.PrepayExpense>) {
    if (busy) return
    setBusy(true)
    try {
      if (!failed(await action())) onSaved()
    } finally {
      setBusy(false)
    }
  }

  function saveAmount(e: SubmitEvent) {
    e.preventDefault()
    void run(() => FinanceService.SetInstallmentAmount(cuota.installmentId, amount))
  }

  return (
    <Modal title={`Cuota ${cuota.number} de ${cuota.total} · ${cuota.description}`} onClose={onClose}>
      <form onSubmit={saveAmount} className="space-y-3">
        <Field label="Monto de esta cuota">
          <MoneyInput value={amount} onChange={setAmount} required placeholder={cuota.amount} />
        </Field>
        <p className="text-xs text-slate-500">
          Útil cuando el banco redondea la última cuota. Si después editas el gasto, su monto de cuota vuelve a aplicarse a las cuotas
          pendientes.
        </p>
        <div className="flex justify-end">
          <Button type="submit" disabled={busy || amount === ''}>
            Guardar monto
          </Button>
        </div>
      </form>

      <div className="mt-6 space-y-3 border-t border-slate-800 pt-4">
        <h4 className="text-sm font-semibold text-slate-200">Pagar el saldo por adelantado</h4>
        <Field label="Mes en que lo pagas">
          <input type="month" className={inputCls} value={period} onChange={(e) => setPeriod(e.target.value)} required />
        </Field>
        <p className="text-xs text-slate-500">
          Todas las cuotas pendientes (incluida esta de {formatCLP(cuota.amount)}) pasan a{' '}
          {period ? periodLabel(period) : 'ese mes'}; las ya pagadas no se tocan.
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cerrar
          </Button>
          <Button disabled={busy || period === ''} onClick={() => void run(() => FinanceService.PrepayExpense(cuota.expenseId, period))}>
            Prepagar saldo
          </Button>
        </div>
      </div>
    </Modal>
  )
}
