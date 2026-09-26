import { useState, type SubmitEvent } from 'react'
import { FinanceService } from '@/services/finance'
import { failed } from '@/lib/result'
import { periodLabel } from '@/lib/format'
import { Button, Field, Modal, MoneyInput, inputCls } from './ui'

// RefundDialog records money returned for an expense (a store return, a bank
// reversal): it lowers the gastos of the month it arrives in, in the expense's
// category. The backend refuses refunds adding up to more than the expense.
export function RefundDialog({
  expenseId,
  expenseDescription,
  defaultPeriod,
  onClose,
  onSaved,
}: {
  expenseId: number
  expenseDescription: string
  defaultPeriod: string
  onClose: () => void
  onSaved: () => void
}) {
  const [amount, setAmount] = useState('')
  const [period, setPeriod] = useState(defaultPeriod)
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: SubmitEvent) {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    try {
      if (!failed(await FinanceService.CreateRefund(expenseId, period, amount, description))) onSaved()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={`Reembolso de «${expenseDescription}»`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <p className="text-sm text-slate-400">
          La devolución rebaja los gastos de {period ? periodLabel(period) : 'su mes'} en la categoría del gasto. Puede ser parcial.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Monto devuelto">
            <MoneyInput value={amount} onChange={setAmount} required placeholder="10000" />
          </Field>
          <Field label="Mes en que llegó">
            <input type="month" className={inputCls} value={period} onChange={(e) => setPeriod(e.target.value)} required />
          </Field>
        </div>
        <Field label="Descripción (opcional)">
          <input className={inputCls} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Devolución en tienda" />
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" disabled={busy || amount === ''}>
            {busy ? 'Guardando…' : 'Registrar'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
