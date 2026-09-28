import { useState, type SubmitEvent } from 'react'
import { useAtomValue } from 'jotai'
import { FinanceService, type Card, type FixedExpenseView } from '@/services/finance'
import { periodAtom } from '@/atoms/finance'
import { useInvalidate, useVersion } from '@/atoms/refresh'
import { failed } from '@/lib/result'
import { useQuery } from '@/lib/useQuery'
import { currentPeriod, formatCLP, formatUF, parseDecimalInput, periodLabel } from '@/lib/format'
import { CalendarX, Coins, Pencil, Plus, Repeat, Trash } from 'lucide-react'
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  Field,
  Menu,
  Modal,
  MoneyInput,
  QueryError,
  Section,
  Select,
  SkeletonRows,
  inputCls,
  type MenuAction,
} from './ui'
import { RecurringSuggestions } from './RecurringSuggestions'

// Billing frequencies (backend/finance/fixedexpense.go validIntervals).
const FREQUENCIES: readonly { months: number; label: string }[] = [
  { months: 1, label: 'Mensual' },
  { months: 2, label: 'Bimestral' },
  { months: 3, label: 'Trimestral' },
  { months: 4, label: 'Cuatrimestral' },
  { months: 6, label: 'Semestral' },
  { months: 12, label: 'Anual' },
]

function frequencyLabel(months: number): string {
  return FREQUENCIES.find((f) => f.months === months)?.label ?? `Cada ${months} meses`
}

// amountLabel shows a fixed expense's current amount in its currency, with the
// peso equivalent for UF.
function amountLabel(fe: FixedExpenseView): string {
  return fe.currency === 'UF' ? `${formatUF(fe.currentAmount)} (≈ ${formatCLP(fe.currentAmountClp)})` : formatCLP(fe.currentAmount)
}

// AmountInput takes pesos (thousands mask) or UF (decimals), keeping the value
// as the plain decimal string the backend reads.
function AmountInput({ currency, value, onChange }: { currency: string; value: string; onChange: (v: string) => void }) {
  const [typed, setTyped] = useState(value.replace('.', ','))
  if (currency !== 'UF') return <MoneyInput value={value} onChange={onChange} placeholder="9990" required />
  return (
    <input
      className={inputCls}
      inputMode="decimal"
      value={typed}
      onChange={(e) => {
        setTyped(e.target.value)
        onChange(parseDecimalInput(e.target.value))
      }}
      placeholder="12,5"
      required
    />
  )
}

export function FixedExpensesView() {
  const period = useAtomValue(periodAtom)
  const version = useVersion('ledger')
  const invalidate = useInvalidate()
  const reload = () => invalidate('ledger')

  const [editing, setEditing] = useState<FixedExpenseView | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [amountFor, setAmountFor] = useState<FixedExpenseView | null>(null)
  const [cancelling, setCancelling] = useState<FixedExpenseView | null>(null)
  const [deleting, setDeleting] = useState<FixedExpenseView | null>(null)

  const query = useQuery(version, async () => {
    const [items, cards, cats] = await Promise.all([
      FinanceService.ListFixedExpenses(),
      FinanceService.ListCards(),
      FinanceService.ListCategories(),
    ])
    return { items, cards, categories: cats.map((c) => c.name) }
  })

  if (query.status === 'error') return <QueryError message={query.error} onRetry={reload} />

  async function cancelFrom(id: number) {
    const res = await FinanceService.EndFixedExpense(id, period)
    if (!failed(res)) reload()
  }

  async function remove(id: number) {
    const res = await FinanceService.DeleteFixedExpense(id)
    if (!failed(res)) reload()
  }

  function openNew() {
    setEditing(null)
    setShowForm(true)
  }

  const data = query.data
  return (
    <div className="space-y-6">
    <RecurringSuggestions period={period} />
    <Section
      title="Tus gastos fijos"
      action={
        <Button icon={Plus} onClick={openNew}>
          Nuevo gasto fijo
        </Button>
      }
    >
      <p className="mb-4 text-sm text-fg-muted">
        Suscripciones, servicios y seguros que se cobran solos: cada mes, trimestre, año… en pesos o en
        UF (se convierte con el valor de la UF de cada mes). Al cambiar un monto, sólo aplica desde el
        mes seleccionado ({periodLabel(period)}) en adelante; los meses anteriores no se modifican.
      </p>

      {!data ? (
        <SkeletonRows rows={4} />
      ) : data.items.length === 0 ? (
        <EmptyState
          icon={Repeat}
          title="Aún no tienes gastos fijos"
          action={
            <Button icon={Plus} onClick={openNew}>
              Crear el primero
            </Button>
          }
        >
          Netflix, el plan del celular, el arriendo en UF… Se cargan solos cada mes y puedes marcarlos pagados en el Resumen.
        </EmptyState>
      ) : (
        <ul className="divide-y divide-line">
          {data.items.map((fe) => {
            // active is false both before the start and after the end month.
            const cancelled = !fe.active && fe.endPeriod !== '' && fe.endPeriod < currentPeriod()
            const actions: MenuAction[] = [
              { label: 'Cambiar monto', icon: Coins, onSelect: () => setAmountFor(fe) },
              {
                label: 'Editar',
                icon: Pencil,
                onSelect: () => {
                  setEditing(fe)
                  setShowForm(true)
                },
              },
              ...(cancelled ? [] : [{ label: `Cancelar desde ${periodLabel(period)}…`, icon: CalendarX, onSelect: () => setCancelling(fe) }]),
              { label: 'Eliminar…', icon: Trash, tone: 'danger' as const, onSelect: () => setDeleting(fe) },
            ]
            return (
              <li key={fe.id} className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-fg">{fe.description}</span>
                    {!fe.active &&
                      (cancelled ? (
                        <Badge>Cancelado</Badge>
                      ) : (
                        <Badge tone="info">Programado desde {periodLabel(fe.startPeriod)}</Badge>
                      ))}
                  </div>
                  <div className="mt-0.5 text-xs text-fg-muted">
                    <span className="font-medium tabular-nums text-fg">{amountLabel(fe)}</span> · {frequencyLabel(fe.intervalMonths)} ·{' '}
                    {fe.category || 'Sin categoría'}
                    {fe.cardName ? ` · ${fe.cardName}` : ''} · desde {periodLabel(fe.startPeriod)}
                    {fe.endPeriod ? ` · hasta ${periodLabel(fe.endPeriod)}` : ''}
                    {fe.dueDay != null && fe.cardId == null && ` · vence el día ${fe.dueDay}`}
                    {fe.intervalMonths > 1 && fe.nextPeriod !== '' && ` · próximo cobro: ${periodLabel(fe.nextPeriod)}`}
                  </div>
                </div>
                <Menu label={`Acciones de ${fe.description}`} items={actions} />
              </li>
            )
          })}
        </ul>
      )}

      {cancelling && (
        <ConfirmDialog
          title="Cancelar gasto fijo"
          confirmLabel="Cancelar desde este mes"
          onConfirm={() => cancelFrom(cancelling.id)}
          onClose={() => setCancelling(null)}
        >
          «{cancelling.description}» deja de cobrarse desde {periodLabel(period)}. Los meses anteriores quedan como están.
        </ConfirmDialog>
      )}
      {deleting && (
        <ConfirmDialog title="Eliminar gasto fijo" onConfirm={() => remove(deleting.id)} onClose={() => setDeleting(null)}>
          ¿Eliminar «{deleting.description}» de todos los meses? Va a la papelera; si solo dejó de cobrarse, usa «Cancelar desde…».
        </ConfirmDialog>
      )}

      {showForm && data && (
        <FixedExpenseForm
          fixed={editing}
          cards={data.cards}
          categories={data.categories}
          defaultPeriod={period}
          onClose={() => setShowForm(false)}
          onSaved={reload}
        />
      )}

      {amountFor && (
        <AmountModal
          fixed={amountFor}
          period={period}
          onClose={() => setAmountFor(null)}
          onSaved={reload}
        />
      )}
    </Section>
    </div>
  )
}

function FixedExpenseForm({
  fixed,
  cards,
  categories,
  defaultPeriod,
  onClose,
  onSaved,
}: {
  fixed: FixedExpenseView | null
  cards: Card[]
  categories: string[]
  defaultPeriod: string
  onClose: () => void
  onSaved: () => void
}) {
  const editing = !!fixed
  const [description, setDescription] = useState(fixed?.description ?? '')
  const [amount, setAmount] = useState(fixed?.currentAmount ?? '')
  const [category, setCategory] = useState(fixed?.category ?? '')
  const [cardId, setCardId] = useState<string>(fixed?.cardId != null ? String(fixed.cardId) : '')
  const [startPeriod, setStartPeriod] = useState(fixed?.startPeriod ?? defaultPeriod)
  const [intervalMonths, setIntervalMonths] = useState(fixed?.intervalMonths ?? 1)
  const [currency, setCurrency] = useState(fixed?.currency ?? 'CLP')
  const [dueDay, setDueDay] = useState(fixed?.dueDay != null ? String(fixed.dueDay) : '')
  const [busy, setBusy] = useState(false)

  const categoryOptions =
    category && !categories.includes(category) ? [...categories, category] : categories

  async function submit(e: SubmitEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      const card = cardId === '' ? null : Number(cardId)
      const res = fixed
        ? await FinanceService.UpdateFixedExpense(fixed.id, description, category, card)
        : await FinanceService.CreateFixedExpense(description, category, card, startPeriod, amount, intervalMonths, currency)
      if (failed(res)) return
      // One on a card is paid with the card: it reminds through its statement.
      const day = card === null && dueDay !== '' ? Number(dueDay) : null
      if (res.data && day !== (fixed?.dueDay ?? null) && failed(await FinanceService.SetFixedExpenseDueDay(res.data.id, day))) {
        return
      }
      onSaved()
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={editing ? 'Editar gasto fijo' : 'Nuevo gasto fijo'} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Descripción">
          <input className={inputCls} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Netflix, Plan celular…" autoFocus required />
        </Field>

        {!editing && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Frecuencia">
                <Select value={String(intervalMonths)} onChange={(e) => setIntervalMonths(Number(e.target.value))}>
                  {FREQUENCIES.map((f) => (
                    <option key={f.months} value={String(f.months)}>
                      {f.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Moneda">
                <Select
                  value={currency}
                  onChange={(e) => {
                    setCurrency(e.target.value)
                    setAmount('')
                  }}
                >
                  <option value="CLP">Pesos</option>
                  <option value="UF">UF (arriendo, dividendo, isapre)</option>
                </Select>
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label={currency === 'UF' ? 'Monto en UF' : 'Monto'}>
                <AmountInput key={currency} currency={currency} value={amount} onChange={setAmount} />
              </Field>
              <Field label={intervalMonths > 1 ? 'Primer cobro' : 'Desde el mes'}>
                <input type="month" className={inputCls} value={startPeriod} onChange={(e) => setStartPeriod(e.target.value)} required />
              </Field>
            </div>
            <p className="text-xs text-fg-subtle">
              La frecuencia y la moneda no se pueden cambiar después: cambiarías cobros ya registrados.
              {currency === 'UF' && ' El valor de la UF se descarga solo (mindicador.cl) y en meses sin valor se estima con el último.'}
            </p>
          </>
        )}

        <div className="grid grid-cols-2 gap-3">
          <Field label="Categoría">
            <Select value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">Sin categoría</option>
              {categoryOptions.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Tarjeta">
            <Select value={cardId} onChange={(e) => setCardId(e.target.value)}>
              <option value="">Sin tarjeta</option>
              {cards.map((c) => (
                <option key={c.id} value={String(c.id)}>
                  {c.name}
                </option>
              ))}
              {/* Its card went to the trash: keep it selectable (see ExpenseForm). */}
              {cardId !== '' && !cards.some((c) => String(c.id) === cardId) && (
                <option value={cardId}>Tarjeta eliminada</option>
              )}
            </Select>
          </Field>
        </div>

        {cardId === '' && (
          <Field label="Vence el día (opcional)">
            <input
              className={`${inputCls} w-24`}
              type="number"
              min="1"
              max="31"
              inputMode="numeric"
              value={dueDay}
              onChange={(e) => setDueDay(e.target.value)}
              placeholder="5"
            />
            <p className="mt-1 text-xs text-fg-subtle">
              Te avisa unos días antes mientras siga pendiente. Si el mes es más corto, vence su último día. Los
              cargados a una tarjeta se avisan con el vencimiento de su estado de cuenta.
            </p>
          </Field>
        )}

        {editing && (
          <p className="text-xs text-fg-subtle">
            Para cambiar el monto usa “Cambiar monto”, así sólo afecta del mes elegido en adelante.
          </p>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" loading={busy}>
            {editing ? 'Guardar' : 'Crear'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}

function AmountModal({
  fixed,
  period,
  onClose,
  onSaved,
}: {
  fixed: FixedExpenseView
  period: string
  onClose: () => void
  onSaved: () => void
}) {
  const [amount, setAmount] = useState(fixed.currentAmount)
  const [busy, setBusy] = useState(false)

  async function submit(e: SubmitEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      const res = await FinanceService.SetFixedExpenseAmount(fixed.id, period, amount)
      if (failed(res)) return
      onSaved()
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={`Cambiar monto · ${fixed.description}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <p className="text-sm text-fg-muted">
          El nuevo monto aplica desde <strong className="text-fg">{periodLabel(period)}</strong> en adelante. Los meses
          anteriores conservan su valor.
        </p>
        <Field label={fixed.currency === 'UF' ? 'Nuevo monto en UF' : 'Nuevo monto'}>
          <AmountInput currency={fixed.currency} value={amount} onChange={setAmount} />
        </Field>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" loading={busy}>
            Aplicar
          </Button>
        </div>
      </form>
    </Modal>
  )
}
