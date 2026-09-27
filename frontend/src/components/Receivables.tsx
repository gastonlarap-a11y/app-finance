import { useState, type SubmitEvent } from 'react'
import { FinanceService, type Movimiento } from '@/services/finance'
import { useInvalidate, useVersion } from '@/atoms/refresh'
import { failed } from '@/lib/result'
import { useQuery } from '@/lib/useQuery'
import { formatCLP, formatDate, periodLabel } from '@/lib/format'
import { perInstallment, times } from '@/lib/money'
import { Button, Field, Modal, MoneyInput, QueryError, Section, inputCls } from './ui'

// ReceivableDialog records that someone owes part of an expense (a split
// bill). When they pay, «Cobrado» turns it into a refund of the expense.
export function ReceivableDialog({ expense, onClose, onSaved }: { expense: Movimiento; onClose: () => void; onSaved: () => void }) {
  const total = times(expense.amount, Math.max(expense.total, 1))
  const [person, setPerson] = useState('')
  const [amount, setAmount] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: SubmitEvent) {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    try {
      if (!failed(await FinanceService.CreateReceivable(expense.expenseId, person, amount))) onSaved()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={`Me deben de «${expense.description}»`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <p className="text-sm text-slate-400">
          El gasto costó {formatCLP(total)}. Cuando te paguen, márcalo como cobrado: se registra como reembolso y tu gasto queda en
          tu parte.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Quién te debe">
            <input className={inputCls} value={person} onChange={(e) => setPerson(e.target.value)} placeholder="Ana" required autoFocus />
          </Field>
          <Field label="Cuánto">
            <MoneyInput value={amount} onChange={setAmount} required placeholder="10000" />
          </Field>
        </div>
        <div className="flex flex-wrap gap-2 text-xs">
          {[2, 3, 4].map((n) => (
            <button
              key={n}
              type="button"
              className="rounded-full bg-slate-800 px-3 py-1 text-slate-300 hover:bg-slate-700"
              onClick={() => setAmount(perInstallment(total, n))}
            >
              Dividido en {n}: {formatCLP(perInstallment(total, n))}
            </button>
          ))}
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" disabled={busy || amount === '' || person.trim() === ''}>
            {busy ? 'Guardando…' : 'Guardar'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}

// ReceivablesPanel lists what others still owe; «Cobrado» records the refund
// in the month on screen.
export function ReceivablesPanel({ period }: { period: string }) {
  const version = useVersion('ledger')
  const invalidate = useInvalidate()
  const [confirmId, setConfirmId] = useState<number | null>(null)
  const query = useQuery(`receivables:${version}`, async () => {
    const res = await FinanceService.ListReceivables()
    if (res.error) throw new Error(res.error.message)
    return (res.data ?? []).filter((r) => r.settledPeriod === '')
  })

  async function settle(id: number) {
    if (!failed(await FinanceService.SettleReceivable(id, period))) invalidate('ledger')
  }

  async function remove(id: number) {
    setConfirmId(null)
    if (!failed(await FinanceService.DeleteReceivable(id))) invalidate('ledger')
  }

  if (query.status === 'error') return <QueryError message={query.error} onRetry={() => invalidate('ledger')} />
  if (!query.data || query.data.length === 0) return null
  return (
    <Section title="Por cobrar">
      <ul className="space-y-2">
        {query.data.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 rounded-base bg-surface p-3 text-sm ring-1 ring-slate-800">
            <div>
              <span className="font-medium">{r.person}</span> te debe{' '}
              <strong className="tabular-nums">{formatCLP(r.amount)}</strong>
              <div className="text-xs text-slate-500">
                de «{r.expenseDescription}» del {formatDate(r.expenseDate)}
              </div>
            </div>
            {confirmId === r.id ? (
              <div className="flex items-center gap-2">
                <span className="text-danger">¿Quitar?</span>
                <Button variant="danger" onClick={() => void remove(r.id)}>
                  Sí
                </Button>
                <Button variant="ghost" onClick={() => setConfirmId(null)}>
                  No
                </Button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <Button onClick={() => void settle(r.id)}>Cobrado en {periodLabel(period)}</Button>
                <Button variant="ghost" onClick={() => setConfirmId(r.id)}>
                  Quitar
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </Section>
  )
}
