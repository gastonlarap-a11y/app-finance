import { useEffect, useState } from 'react'
import { useAtom, useSetAtom } from 'jotai'
import {
  FinanceService,
  type Card,
  type FixedExpenseView,
} from '@/services/finance'
import { periodAtom, refreshAtom } from '@/atoms/finance'
import { failed } from '@/lib/result'
import { formatCLP, periodLabel } from '@/lib/format'
import { Button, Empty, Field, Modal, MoneyInput, Section, Select, inputCls } from './ui'

export function FixedExpensesView() {
  const [period] = useAtom(periodAtom)
  const [refresh] = useAtom(refreshAtom)
  const bump = useSetAtom(refreshAtom)

  const [items, setItems] = useState<FixedExpenseView[]>([])
  const [cards, setCards] = useState<Card[]>([])
  const [categories, setCategories] = useState<string[]>([])

  const [editing, setEditing] = useState<FixedExpenseView | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [amountFor, setAmountFor] = useState<FixedExpenseView | null>(null)
  const [confirmCancel, setConfirmCancel] = useState<number | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null)

  useEffect(() => {
    let active = true
    Promise.all([
      FinanceService.ListFixedExpenses(),
      FinanceService.ListCards(),
      FinanceService.ListCategories(),
    ]).then(([fx, cs, cats]) => {
      if (!active) return
      setItems(fx ?? [])
      setCards(cs ?? [])
      setCategories((cats ?? []).map((c) => c.name))
    })
    return () => {
      active = false
    }
  }, [refresh])

  async function cancelFrom(id: number) {
    setConfirmCancel(null)
    const res = await FinanceService.EndFixedExpense(id, period)
    if (!failed(res)) bump((n) => n + 1)
  }

  async function remove(id: number) {
    setConfirmDelete(null)
    const res = await FinanceService.DeleteFixedExpense(id)
    if (!failed(res)) bump((n) => n + 1)
  }

  return (
    <Section
      title="Gastos fijos mensuales"
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
        Suscripciones y servicios que se cobran cada mes automáticamente. Al cambiar un monto, sólo
        aplica desde el mes seleccionado ({periodLabel(period)}) en adelante; los meses anteriores no
        se modifican.
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
                  {!fe.active && <span className="ml-2 text-xs text-slate-500">(cancelado)</span>}
                </div>
                <div className="text-xs text-slate-500">
                  {formatCLP(fe.currentAmount)} · {fe.category || 'Sin categoría'}
                  {fe.cardName ? ` · ${fe.cardName}` : ''} · desde {fe.startPeriod}
                  {fe.endPeriod ? ` · hasta ${fe.endPeriod}` : ''}
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
                    <span className="text-sm text-danger">¿Eliminar todo?</span>
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
          onSaved={() => bump((n) => n + 1)}
        />
      )}

      {amountFor && (
        <AmountModal
          fixed={amountFor}
          period={period}
          onClose={() => setAmountFor(null)}
          onSaved={() => bump((n) => n + 1)}
        />
      )}
    </Section>
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
  const [amount, setAmount] = useState(fixed ? String(fixed.currentAmount ?? '') : '')
  const [category, setCategory] = useState(fixed?.category ?? '')
  const [cardId, setCardId] = useState<string>(fixed?.cardId != null ? String(fixed.cardId) : '')
  const [startPeriod, setStartPeriod] = useState(fixed?.startPeriod ?? defaultPeriod)
  const [busy, setBusy] = useState(false)

  const categoryOptions =
    category && !categories.includes(category) ? [...categories, category] : categories

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      const card = cardId === '' ? null : Number(cardId)
      const res = editing
        ? await FinanceService.UpdateFixedExpense(fixed!.id, description, category, card)
        : await FinanceService.CreateFixedExpense(description, category, card, startPeriod, amount)
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
          <div className="grid grid-cols-2 gap-3">
            <Field label="Monto mensual">
              <MoneyInput value={amount} onChange={setAmount} placeholder="9990" required />
            </Field>
            <Field label="Desde el mes (YYYY-MM)">
              <input className={inputCls} value={startPeriod} onChange={(e) => setStartPeriod(e.target.value)} placeholder="2026-06" required />
            </Field>
          </div>
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
  const [amount, setAmount] = useState(String(fixed.currentAmount ?? ''))
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
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
        <Field label="Nuevo monto mensual">
          <MoneyInput value={amount} onChange={setAmount} placeholder="12000" autoFocus required />
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
