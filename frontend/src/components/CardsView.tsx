import { useState, type SubmitEvent } from 'react'
import { FinanceService, type Card } from '@/services/finance'
import { useInvalidate, useVersion } from '@/atoms/refresh'
import { failed } from '@/lib/result'
import { useQuery } from '@/lib/useQuery'
import { formatCLP } from '@/lib/format'
import { Link } from './Link'
import { CreditCard, Pencil, Plus } from 'lucide-react'
import { cardColor } from '@/lib/look'
import {
  Button,
  ColorPicker,
  ConfirmAction,
  EmptyState,
  Field,
  Input,
  LookIcon,
  Modal,
  MoneyInput,
  QueryError,
  Section,
  SkeletonRows,
  inputCls,
} from './ui'
import { AccountSelect, useAccounts } from './Accounts'

// CardsView is Configuración › Tarjetas. Their statements live in Importar ›
// Estados de cuenta; this month's use of each card, in the Resumen.
export function CardsView() {
  const version = useVersion('ledger')
  const invalidate = useInvalidate()
  // Card names and billing days also show in the imported statements.
  const reload = () => invalidate('ledger', 'imports')
  const [editing, setEditing] = useState<Card | null>(null)
  const [showForm, setShowForm] = useState(false)

  const query = useQuery(version, () => FinanceService.ListCards())

  async function remove(id: number) {
    const res = await FinanceService.DeleteCard(id)
    if (!failed(res)) reload()
  }

  function open(card: Card | null) {
    setEditing(card)
    setShowForm(true)
  }

  if (query.status === 'error') return <QueryError message={query.error} onRetry={reload} />
  const cards = query.data ?? []

  return (
    <div className="space-y-6">
      <Section
        title="Tarjetas de crédito"
        action={
          <Button icon={Plus} onClick={() => open(null)}>
            Nueva tarjeta
          </Button>
        }
      >
        {!query.data ? (
          <SkeletonRows rows={3} />
        ) : cards.length === 0 ? (
          <EmptyState icon={CreditCard} title="Aún no tienes tarjetas" action={<Button icon={Plus} onClick={() => open(null)}>Crear una tarjeta</Button>}>
            Crea una para asignarle gastos en cuotas, ver su cupo cada mes y asociar sus estados de cuenta.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {cards.map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
                <div className="flex min-w-0 items-center gap-3">
                  <LookIcon look={{ icon: 'credit-card', color: cardColor(c) }} size="lg" />
                  <div className="min-w-0">
                    <div className="font-medium text-fg">
                      {c.name}
                      {c.lastDigits !== '' && <span className="ml-2 font-mono text-xs text-fg-subtle">•••• {c.lastDigits}</span>}
                    </div>
                    <div className="text-xs text-fg-muted">
                      Cupo {formatCLP(c.creditLimit)} · corte día {c.billingDay}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <Button variant="secondary" size="sm" icon={Pencil} onClick={() => open(c)}>
                    Editar
                  </Button>
                  <ConfirmAction label={`Eliminar la tarjeta ${c.name}`} iconOnly onConfirm={() => remove(c.id)} />
                </div>
              </li>
            ))}
          </ul>
        )}

        {cards.length > 0 && (
          <p className="mt-3 text-sm text-fg-muted">
            Sus estados de cuenta importados están en{' '}
            <Link to={{ page: 'importar', tab: 'estados' }}>Importar › Estados de cuenta</Link>.
          </p>
        )}

        {showForm && (
          <CardForm
            card={editing}
            onClose={() => setShowForm(false)}
            onSaved={reload}
          />
        )}
      </Section>
    </div>
  )
}

function CardForm({ card, onClose, onSaved }: { card: Card | null; onClose: () => void; onSaved: () => void }) {
  const editing = !!card
  const [name, setName] = useState(card?.name ?? '')
  const [limit, setLimit] = useState(card?.creditLimit ?? '')
  const [billingDay, setBillingDay] = useState(String(card?.billingDay ?? 24))
  const [lastDigits, setLastDigits] = useState(card?.lastDigits ?? '')
  const accounts = useAccounts()
  const [accountId, setAccountId] = useState<number | null>(card?.accountId ?? null)
  const [color, setColor] = useState(card?.color ?? '')
  const [busy, setBusy] = useState(false)

  async function submit(e: SubmitEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      const day = Math.min(28, Math.max(1, Number(billingDay) || 24))
      const res = card
        ? await FinanceService.UpdateCard(card.id, name, limit || '0', day, lastDigits)
        : await FinanceService.CreateCard(name, limit || '0', day, lastDigits)
      if (failed(res) || !res.data) return
      const id = res.data.id
      // The card is saved either way; a failed extra keeps the dialog open
      // (with its toast) so that choice is not silently lost.
      const extraFailed =
        (accountId !== (card?.accountId ?? null) && failed(await FinanceService.SetCardAccount(id, accountId))) ||
        (color !== (card?.color ?? '') && failed(await FinanceService.SetCardColor(id, color)))
      onSaved()
      if (!extraFailed) onClose()
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
        <Field
          label="Día de corte (factura)"
          hint="Compras hasta el día anterior (inclusive) quedan en el mes actual. El día del corte y los siguientes van al mes siguiente."
        >
          <Input type="number" min="1" max="28" value={billingDay} onChange={(e) => setBillingDay(e.target.value)} />
        </Field>
        <Field label="Últimos 4 dígitos (opcional)" hint="Permiten asociar a esta tarjeta los movimientos importados de estados de cuenta y cartolas.">
          <Input
            inputMode="numeric"
            pattern="[0-9]{4}"
            maxLength={4}
            value={lastDigits}
            onChange={(e) => setLastDigits(e.target.value.replace(/\D/g, ''))}
            placeholder="1234"
          />
        </Field>
        <AccountSelect accounts={accounts} value={accountId} onChange={setAccountId} label="Se paga desde la cuenta" noneLabel="Ninguna" />
        <ColorPicker value={color} onChange={setColor} auto={card ? cardColor({ id: card.id, color: '' }) : undefined} />
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
