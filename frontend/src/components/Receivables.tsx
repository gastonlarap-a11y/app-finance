import { useState, type SubmitEvent } from 'react'
import { HandCoins } from 'lucide-react'
import { FinanceService, type Movimiento } from '@/services/finance'
import { useInvalidate, useVersion } from '@/atoms/refresh'
import { failed } from '@/lib/result'
import { useQuery } from '@/lib/useQuery'
import { formatCLP, formatDate, periodLabel } from '@/lib/format'
import { perInstallment, times } from '@/lib/money'
import { Button, ConfirmAction, Field, Modal, MoneyInput, QueryError, Section, inputCls } from './ui'

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
        <p className="text-sm text-fg-muted">
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
              className="rounded-full bg-sunken px-3 py-1 text-fg-muted ring-1 ring-inset ring-line transition-colors hover:bg-accent-soft hover:text-accent-fg"
              onClick={() => setAmount(perInstallment(total, n))}
            >
              Dividido en {n}: {formatCLP(perInstallment(total, n))}
            </button>
          ))}
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" loading={busy} disabled={amount === '' || person.trim() === ''}>
            Guardar
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
  const query = useQuery(`receivables:${version}`, async () => {
    const res = await FinanceService.ListReceivables()
    if (res.error) throw new Error(res.error.message)
    return (res.data ?? []).filter((r) => r.settledPeriod === '')
  })

  async function settle(id: number) {
    if (!failed(await FinanceService.SettleReceivable(id, period))) invalidate('ledger')
  }

  async function remove(id: number) {
    if (!failed(await FinanceService.DeleteReceivable(id))) invalidate('ledger')
  }

  if (query.status === 'error') return <QueryError message={query.error} onRetry={() => invalidate('ledger')} />
  if (!query.data || query.data.length === 0) return null
  return (
    <Section title="Por cobrar">
      <ul className="divide-y divide-line">
        {query.data.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm first:pt-0 last:pb-0">
            <div className="flex min-w-0 items-start gap-3">
              <HandCoins aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-fg-subtle" />
              <div className="min-w-0">
                <span className="font-medium text-fg">{r.person}</span> te debe <strong className="tabular-nums">{formatCLP(r.amount)}</strong>
                <div className="text-xs text-fg-subtle">
                  de «{r.expenseDescription}» del {formatDate(r.expenseDate)}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={() => void settle(r.id)}>
                Cobrado en {periodLabel(period)}
              </Button>
              <ConfirmAction label={`Quitar la deuda de ${r.person}`} iconOnly question="¿Quitar?" confirmLabel="Quitar" onConfirm={() => remove(r.id)} />
            </div>
          </li>
        ))}
      </ul>
    </Section>
  )
}
