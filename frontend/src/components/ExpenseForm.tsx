import { useState } from 'react'
import { FinanceService, KIND_CUOTAS, KIND_UNICO, type Card, type Expense } from '@/services/finance'
import { failed } from '@/lib/result'
import { periodLabel, todayISO } from '@/lib/format'
import { Button, Field, Modal, inputCls } from './ui'

function computeFirstPeriod(dateStr: string, billingDay: number): string {
  if (!dateStr) return ''
  const parts = dateStr.split('-')
  let year = Number(parts[0])
  let month = Number(parts[1])
  const day = Number(parts[2])
  if (billingDay > 0 && day >= billingDay) {
    month += 1
    if (month > 12) { month = 1; year += 1 }
  }
  return `${year}-${String(month).padStart(2, '0')}`
}

type Props = {
  cards: Card[]
  categories: string[]
  expense?: Expense | null
  onClose: () => void
  onSaved: () => void
}

export function ExpenseForm({ cards, categories, expense, onClose, onSaved }: Props) {
  const editing = !!expense
  const [description, setDescription] = useState(expense?.description ?? '')
  const [amount, setAmount] = useState(expense ? String(expense.installmentAmount ?? '') : '')
  const [category, setCategory] = useState(expense?.category ?? '')
  const [cardId, setCardId] = useState<string>(expense?.cardId != null ? String(expense.cardId) : '')
  const [kind, setKind] = useState(expense?.kind ?? KIND_CUOTAS)
  const [total, setTotal] = useState(expense ? String(expense.installmentsTotal ?? 1) : '12')
  const [date, setDate] = useState(
    expense?.date ? String(expense.date).slice(0, 10) : todayISO(),
  )
  const [busy, setBusy] = useState(false)

  const isCuotas = kind === KIND_CUOTAS

  const selectedCard = cards.find((c) => String(c.id) === cardId)
  const firstPeriod = isCuotas && selectedCard && date ? computeFirstPeriod(date, selectedCard.billingDay) : null

  // Keep the expense's current category selectable even if it was removed from
  // the managed list (e.g. editing an old expense).
  const categoryOptions =
    category && !categories.includes(category) ? [...categories, category] : categories

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      const card = cardId === '' ? null : Number(cardId)
      const cuotas = isCuotas ? Math.max(1, Number(total) || 1) : 1
      const res = editing
        ? await FinanceService.UpdateExpense(expense!.id, date, description, category, card, kind, amount, cuotas)
        : await FinanceService.CreateExpense(date, description, category, card, kind, amount, cuotas)
      if (failed(res)) return
      onSaved()
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={editing ? 'Editar gasto' : 'Agregar gasto'} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Descripción">
          <input className={inputCls} value={description} onChange={(e) => setDescription(e.target.value)} autoFocus required />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Tipo">
            <select className={inputCls} value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value={KIND_CUOTAS}>En cuotas</option>
              <option value={KIND_UNICO}>Pago único</option>
            </select>
          </Field>
          <Field label={isCuotas ? 'Monto por cuota (mensual)' : 'Monto total'}>
            <input
              className={inputCls}
              type="number"
              min="1"
              step="1"
              inputMode="numeric"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="150000"
              required
            />
          </Field>
        </div>

        {isCuotas && (
          <Field label="Cuotas totales">
            <input
              className={inputCls}
              type="number"
              min="1"
              value={total}
              onChange={(e) => setTotal(e.target.value)}
            />
          </Field>
        )}

        <div className="grid grid-cols-2 gap-3">
          <Field label="Categoría">
            <select className={inputCls} value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">Sin categoría</option>
              {categoryOptions.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Tarjeta">
            <select className={inputCls} value={cardId} onChange={(e) => setCardId(e.target.value)}>
              <option value="">Sin tarjeta</option>
              {cards.map((c) => (
                <option key={c.id} value={String(c.id)}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <Field label="Fecha de compra">
          <input className={inputCls} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>

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

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? 'Guardando…' : editing ? 'Guardar' : 'Agregar'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
