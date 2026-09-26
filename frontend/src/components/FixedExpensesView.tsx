import { useState, type SubmitEvent } from 'react'
import { useAtomValue } from 'jotai'
import { FinanceService, type Card, type FixedExpenseView } from '@/services/finance'
import { periodAtom } from '@/atoms/finance'
import { useInvalidate, useVersion } from '@/atoms/refresh'
import { failed } from '@/lib/result'
import { useQuery } from '@/lib/useQuery'
import { currentPeriod, formatCLP, formatUF, parseDecimalInput, periodLabel } from '@/lib/format'
import { Button, Empty, Field, Modal, MoneyInput, QueryError, Section, Select, Spinner, inputCls } from './ui'
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
  const [confirmCancel, setConfirmCancel] = useState<number | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null)

  const query = useQuery(version, async () => {
    const [items, cards, cats] = await Promise.all([
      FinanceService.ListFixedExpenses(),
      FinanceService.ListCards(),
      FinanceService.ListCategories(),
    ])
    return { items, cards, categories: cats.map((c) => c.name) }
  })

  if (query.status === 'error') return <QueryError message={query.error} onRetry={reload} />
  if (!query.data) return <Spinner />
  const { items, cards, categories } = query.data

  async function cancelFrom(id: number) {
    setConfirmCancel(null)
    const res = await FinanceService.EndFixedExpense(id, period)
    if (!failed(res)) reload()
  }

  async function remove(id: number) {
    setConfirmDelete(null)
    const res = await FinanceService.DeleteFixedExpense(id)
    if (!failed(res)) reload()
  }

  return (
    <div className="space-y-5">
    <RecurringSuggestions period={period} />
    <Section
      title="Gastos fijos"
      action={
        <Button
          onClick={() => {
            setEditing(null)
            setShowForm(true)
          }}
        >
          + Nuevo gasto fijo
        </Button>
      }
    >
      <p className="mb-3 text-xs text-slate-500">
        Suscripciones, servicios y seguros que se cobran solos: cada mes, trimestre, año… en pesos o en
        UF (se convierte con el valor de la UF de cada mes). Al cambiar un monto, sólo aplica desde el
        mes seleccionado ({periodLabel(period)}) en adelante; los meses anteriores no se modifican.
      </p>

      {items.length === 0 ? (
        <Empty>Aún no tienes gastos fijos. Crea uno (Netflix, plan celular, etc.) para que se cargue cada mes.</Empty>
      ) : (
        <ul className="space-y-2">
          {items.map((fe) => (
            <li key={fe.id} className="flex items-center justify-between rounded-base bg-surface p-3 ring-1 ring-slate-800">
              <div>
                <div className="font-medium">
                  {fe.description}
                  {/* active is false both before the start and after the end month. */}
                  {!fe.active &&
                    (fe.endPeriod !== '' && fe.endPeriod < currentPeriod() ? (
                      <span className="ml-2 text-xs text-slate-500">(cancelado)</span>
                    ) : (
                      <span className="ml-2 text-xs text-primary">(programado desde {periodLabel(fe.startPeriod)})</span>
                    ))}
                </div>
                <div className="text-xs text-slate-500">
                  {amountLabel(fe)} · {frequencyLabel(fe.intervalMonths)} · {fe.category || 'Sin categoría'}
                  {fe.cardName ? ` · ${fe.cardName}` : ''} · desde {fe.startPeriod}
                  {fe.endPeriod ? ` · hasta ${fe.endPeriod}` : ''}
                  {fe.intervalMonths > 1 && fe.nextPeriod !== '' && ` · próximo cobro: ${periodLabel(fe.nextPeriod)}`}
                </div>
              </div>
              <div className="flex flex-wrap items-center justify-end gap-2">
                <Button variant="ghost" onClick={() => setAmountFor(fe)}>
                  Cambiar monto
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setEditing(fe)
                    setShowForm(true)
                  }}
                >
                  Editar
                </Button>
                {confirmCancel === fe.id ? (
                  <>
                    <span className="text-sm text-warning">¿Cancelar desde {periodLabel(period)}?</span>
                    <Button variant="danger" onClick={() => cancelFrom(fe.id)}>Sí</Button>
                    <Button variant="ghost" onClick={() => setConfirmCancel(null)}>No</Button>
                  </>
                ) : (
                  <Button variant="ghost" onClick={() => setConfirmCancel(fe.id)}>Cancelar</Button>
                )}
                {confirmDelete === fe.id ? (
                  <>
                    <span className="text-sm text-danger">¿Eliminar?</span>
                    <Button variant="danger" onClick={() => remove(fe.id)}>Sí</Button>
                    <Button variant="ghost" onClick={() => setConfirmDelete(null)}>No</Button>
                  </>
                ) : (
                  <Button variant="danger" onClick={() => setConfirmDelete(fe.id)}>Eliminar</Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {showForm && (
        <FixedExpenseForm
          fixed={editing}
          cards={cards}
          categories={categories}
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
            <p className="text-xs text-slate-500">
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

        {editing && (
          <p className="text-xs text-slate-500">
            Para cambiar el monto usa “Cambiar monto”, así sólo afecta del mes elegido en adelante.
          </p>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? 'Guardando…' : editing ? 'Guardar' : 'Crear'}
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
        <p className="text-xs text-slate-500">
          El nuevo monto aplica desde <strong>{periodLabel(period)}</strong> en adelante. Los meses
          anteriores conservan su valor.
        </p>
        <Field label={fixed.currency === 'UF' ? 'Nuevo monto en UF' : 'Nuevo monto'}>
          <AmountInput currency={fixed.currency} value={amount} onChange={setAmount} />
        </Field>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? 'Guardando…' : 'Aplicar'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
