import { useState, type SubmitEvent } from 'react'
import { FinanceService, KIND_CUOTAS, KIND_UNICO, type Card, type Expense } from '@/services/finance'
import { errMsg } from '@/lib/result'
import { errorText } from '@/lib/useQuery'
import { times } from '@/lib/money'
import { formatCLP, periodLabel, todayISO } from '@/lib/format'
import { Button, Field, Modal, MoneyInput, Select, inputCls } from './ui'

const MAX_CUOTAS = 120

// Mirrors backend periodOf: a card purchase on/after the cutoff day rolls to the
// next month. Preview only — the backend computes the real periods.
function computeFirstPeriod(dateStr: string, billingDay: number): string {
  if (!dateStr) return ''
  const [y, m, d] = dateStr.split('-').map(Number)
  let year = y ?? 0
  let month = m ?? 1
  if (billingDay > 0 && (d ?? 0) >= billingDay) {
    month += 1
    if (month > 12) {
      month = 1
      year += 1
    }
  }
  return `${year}-${String(month).padStart(2, '0')}`
}

// parseCuotas validates the installments field: a whole number 1..MAX_CUOTAS.
function parseCuotas(raw: string): number | null {
  if (!/^\d+$/.test(raw.trim())) return null
  const n = Number(raw)
  return n >= 1 && n <= MAX_CUOTAS ? n : null
}

type Props = {
  cards: Card[]
  categories: string[]
  merchants: string[]
  expense?: Expense | null
  onClose: () => void
  onSaved: () => void
}

export function ExpenseForm({ cards, categories, merchants, expense, onClose, onSaved }: Props) {
  const [description, setDescription] = useState(expense?.description ?? '')
  const [amount, setAmount] = useState(expense?.installmentAmount ?? '')
  const [category, setCategory] = useState(expense?.category ?? '')
  const [merchant, setMerchant] = useState(expense?.merchant ?? '')
  const [cardId, setCardId] = useState<string>(expense?.cardId != null ? String(expense.cardId) : '')
  const [kind, setKind] = useState(expense?.kind ?? KIND_CUOTAS)
  const [total, setTotal] = useState(expense ? String(expense.installmentsTotal) : '12')
  const [date, setDate] = useState(expense?.date ? expense.date.slice(0, 10) : todayISO())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const isCuotas = kind === KIND_CUOTAS
  const cuotas = isCuotas ? parseCuotas(total) : 1
  const selectedCard = cards.find((c) => String(c.id) === cardId)
  const firstPeriod = isCuotas && selectedCard && date ? computeFirstPeriod(date, selectedCard.billingDay) : null

  // Keep the expense's current category/merchant selectable even if it was
  // removed from the managed list (e.g. editing an old expense).
  const categoryOptions = category && !categories.includes(category) ? [...categories, category] : categories
  const merchantOptions = merchant && !merchants.includes(merchant) ? [...merchants, merchant] : merchants

  async function submit(e: SubmitEvent) {
    e.preventDefault()
    if (cuotas === null) {
      setError(`Las cuotas deben ser un número entero entre 1 y ${MAX_CUOTAS}.`)
      return
    }
    setError(null)
    setBusy(true)
    try {
      const card = cardId === '' ? null : Number(cardId)
      const res = expense
        ? await FinanceService.UpdateExpense(expense.id, date, description, category, merchant, card, kind, amount, cuotas)
        : await FinanceService.CreateExpense(date, description, category, merchant, card, kind, amount, cuotas)
      const msg = errMsg(res)
      if (msg) {
        setError(msg)
        return
      }
      onSaved()
      onClose()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={expense ? 'Editar gasto' : 'Agregar gasto'} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4" aria-describedby={error ? 'expense-form-error' : undefined}>
        <Field label="Descripción">
          <input className={inputCls} value={description} onChange={(e) => setDescription(e.target.value)} autoFocus required />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Tipo">
            <Select value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value={KIND_CUOTAS}>En cuotas</option>
              <option value={KIND_UNICO}>Pago único</option>
            </Select>
          </Field>
          {isCuotas ? (
            <Field label="Cuotas totales">
              <input
                className={inputCls}
                type="number"
                inputMode="numeric"
                min={1}
                max={MAX_CUOTAS}
                step={1}
                value={total}
                aria-invalid={cuotas === null}
                onChange={(e) => setTotal(e.target.value)}
              />
            </Field>
          ) : (
            <Field label="Monto total">
              <MoneyInput value={amount} onChange={setAmount} placeholder="150000" required />
            </Field>
          )}
        </div>

        {isCuotas && (
          <Field label="Monto por cuota (mensual)">
            <MoneyInput value={amount} onChange={setAmount} placeholder="150000" required />
          </Field>
        )}

        {isCuotas && amount && cuotas !== null && (
          <p className="text-sm text-slate-300">
            Total de la compra: <strong className="tabular-nums">{formatCLP(times(amount, cuotas))}</strong>{' '}
            <span className="text-slate-500">
              ({cuotas} × {formatCLP(amount)})
            </span>
          </p>
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
          <Field label="Comercio">
            <Select value={merchant} onChange={(e) => setMerchant(e.target.value)}>
              <option value="">Sin comercio</option>
              {merchantOptions.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Tarjeta">
            <Select value={cardId} onChange={(e) => setCardId(e.target.value)}>
              <option value="">Sin tarjeta</option>
              {cards.map((c) => (
                <option key={c.id} value={String(c.id)}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Fecha de compra">
            <input className={inputCls} type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
          </Field>
        </div>

        {firstPeriod && (
          <p className="text-xs text-slate-400">
            Primera cuota en: <strong>{periodLabel(firstPeriod)}</strong>
          </p>
        )}

        <p className="text-xs text-slate-500">
          {isCuotas
            ? 'La cuota se factura cada mes (según el día de corte de la tarjeta) hasta completar el total.'
            : 'Pago único: se carga una sola vez en el mes de la compra.'}
        </p>

        {error && (
          <p id="expense-form-error" role="alert" className="rounded bg-danger/10 px-3 py-2 text-sm text-red-200">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? 'Guardando…' : expense ? 'Guardar' : 'Agregar'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
