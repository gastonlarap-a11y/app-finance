import { useState, type SubmitEvent } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { FinanceService, type Card } from '@/services/finance'
import { refreshAtom } from '@/atoms/finance'
import { failed } from '@/lib/result'
import { useQuery } from '@/lib/useQuery'
import { formatCLP } from '@/lib/format'
import { Button, Empty, Field, Modal, MoneyInput, QueryError, Section, Spinner, inputCls } from './ui'

export function CardsView() {
  const refresh = useAtomValue(refreshAtom)
  const bump = useSetAtom(refreshAtom)
  const [editing, setEditing] = useState<Card | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [confirmId, setConfirmId] = useState<number | null>(null)

  const query = useQuery(String(refresh), () => FinanceService.ListCards())

  async function remove(id: number) {
    setConfirmId(null)
    const res = await FinanceService.DeleteCard(id)
    if (!failed(res)) bump((n) => n + 1)
  }

  if (query.status === 'error') return <QueryError message={query.error} onRetry={() => bump((n) => n + 1)} />
  if (!query.data) return <Spinner />
  const cards = query.data

  return (
    <Section
      title="Tarjetas de crédito"
      action={
        <Button
          onClick={() => {
            setEditing(null)
            setShowForm(true)
          }}
        >
          + Nueva tarjeta
        </Button>
      }
    >
      {cards.length === 0 ? (
        <Empty>Aún no tienes tarjetas. Crea una para asignarle gastos y ver su cupo.</Empty>
      ) : (
        <ul className="space-y-2">
          {cards.map((c) => (
            <li key={c.id} className="flex items-center justify-between rounded-base bg-surface p-3 ring-1 ring-slate-800">
              <div>
                <div className="font-medium">{c.name}</div>
                <div className="text-xs text-slate-500">
                  Cupo {formatCLP(c.creditLimit)} · corte día {c.billingDay}
                  {c.lastDigits !== '' && <> · terminada en {c.lastDigits}</>}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  onClick={() => {
                    setEditing(c)
                    setShowForm(true)
                  }}
                >
                  Editar
                </Button>
                {confirmId === c.id ? (
                  <>
                    <span className="text-sm text-danger">¿Eliminar?</span>
                    <Button variant="danger" onClick={() => remove(c.id)}>Sí</Button>
                    <Button variant="ghost" onClick={() => setConfirmId(null)}>No</Button>
                  </>
                ) : (
                  <Button variant="danger" onClick={() => setConfirmId(c.id)}>
                    Eliminar
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {showForm && (
        <CardForm
          card={editing}
          onClose={() => setShowForm(false)}
          onSaved={() => bump((n) => n + 1)}
        />
      )}
    </Section>
  )
}

function CardForm({ card, onClose, onSaved }: { card: Card | null; onClose: () => void; onSaved: () => void }) {
  const editing = !!card
  const [name, setName] = useState(card?.name ?? '')
  const [limit, setLimit] = useState(card?.creditLimit ?? '')
  const [billingDay, setBillingDay] = useState(String(card?.billingDay ?? 24))
  const [lastDigits, setLastDigits] = useState(card?.lastDigits ?? '')
  const [busy, setBusy] = useState(false)

  async function submit(e: SubmitEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      const day = Math.min(28, Math.max(1, Number(billingDay) || 24))
      const res = card
        ? await FinanceService.UpdateCard(card.id, name, limit || '0', day, lastDigits)
        : await FinanceService.CreateCard(name, limit || '0', day, lastDigits)
      if (failed(res)) return
      onSaved()
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={editing ? 'Editar tarjeta' : 'Nueva tarjeta'} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Nombre">
          <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="Visa, Mastercard…" autoFocus required />
        </Field>
        <Field label="Cupo total">
          <MoneyInput value={limit} onChange={setLimit} placeholder="1000000" />
        </Field>
        <Field label="Día de corte (factura)">
          <input className={inputCls} type="number" min="1" max="28" value={billingDay} onChange={(e) => setBillingDay(e.target.value)} />
          <p className="mt-1 text-xs text-slate-500">
            Compras hasta el día anterior (inclusive) quedan en el mes actual. El día del corte y los siguientes van al mes siguiente.
          </p>
        </Field>
        <Field label="Últimos 4 dígitos (opcional)">
          <input
            className={inputCls}
            inputMode="numeric"
            pattern="[0-9]{4}"
            maxLength={4}
            value={lastDigits}
            onChange={(e) => setLastDigits(e.target.value.replace(/\D/g, ''))}
            placeholder="1234"
          />
          <p className="mt-1 text-xs text-slate-500">
            Permiten asociar a esta tarjeta los movimientos importados de correos y estados de cuenta.
          </p>
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
