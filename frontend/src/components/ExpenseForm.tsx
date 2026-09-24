import { useState, type SubmitEvent } from 'react'
import { FinanceService, KIND_CUOTAS, KIND_UNICO, type Card, type Expense, type ImportItemView } from '@/services/finance'
import { errMsg } from '@/lib/result'
import { errorText } from '@/lib/useQuery'
import { perInstallment, times } from '@/lib/money'
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

// What the form edits: an existing expense, a movement detected by the import
// inbox (confirmed into a new expense), or nothing (a new manual expense).
export type ExpenseFormTarget =
  | { mode: 'create' }
  | { mode: 'edit'; expense: Expense }
  | { mode: 'confirm'; item: ImportItemView }

type Props = {
  cards: Card[]
  categories: string[]
  merchants: string[]
  target: ExpenseFormTarget
  onClose: () => void
  onSaved: () => void
}

interface Draft {
  description: string
  amount: string
  category: string
  merchant: string
  cardId: string
  kind: string
  total: string
  date: string
}

function initialDraft(target: ExpenseFormTarget): Draft {
  switch (target.mode) {
    case 'edit': {
      const ex = target.expense
      return {
        description: ex.description,
        amount: ex.installmentAmount,
        category: ex.category,
        merchant: ex.merchant,
        cardId: ex.cardId != null ? String(ex.cardId) : '',
        kind: ex.kind,
        total: String(ex.installmentsTotal),
        date: ex.date.slice(0, 10),
      }
    }
    case 'confirm': {
      // Detected amounts are purchase totals: a cuotas purchase is split into
      // its cuota for the per-month field, which the user reviews.
      const it = target.item
      const cuotas = it.installmentsTotal > 1
      return {
        description: it.suggestedMerchant || it.description,
        amount: cuotas ? perInstallment(it.amount, it.installmentsTotal) : it.amount,
        category: it.suggestedCategory,
        merchant: it.suggestedMerchant,
        cardId: it.cardId != null ? String(it.cardId) : '',
        kind: cuotas ? KIND_CUOTAS : KIND_UNICO,
        total: String(it.installmentsTotal),
        date: it.date,
      }
    }
    case 'create':
      return { description: '', amount: '', category: '', merchant: '', cardId: '', kind: KIND_CUOTAS, total: '12', date: todayISO() }
  }
}

const TITLES: Record<ExpenseFormTarget['mode'], string> = {
  create: 'Agregar gasto',
  edit: 'Editar gasto',
  confirm: 'Confirmar movimiento',
}

export function ExpenseForm({ cards, categories, merchants, target, onClose, onSaved }: Props) {
  const [initial] = useState(() => initialDraft(target))
  const [description, setDescription] = useState(initial.description)
  const [amount, setAmount] = useState(initial.amount)
  const [category, setCategory] = useState(initial.category)
  const [merchant, setMerchant] = useState(initial.merchant)
  const [cardId, setCardId] = useState<string>(initial.cardId)
  const [kind, setKind] = useState(initial.kind)
  const [total, setTotal] = useState(initial.total)
  const [date, setDate] = useState(initial.date)
  const importItem = target.mode === 'confirm' ? target.item : null
  const [learnRule, setLearnRule] = useState(importItem !== null)
  const [rulePattern, setRulePattern] = useState(importItem ? importItem.rulePattern || importItem.suggestedPattern : '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // A rule only helps if it suggests something: it needs a merchant or a category.
  const ruleUseful = merchant !== '' || category !== ''
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
      const res =
        target.mode === 'edit'
          ? await FinanceService.UpdateExpense(target.expense.id, date, description, category, merchant, card, kind, amount, cuotas)
          : target.mode === 'confirm'
            ? await FinanceService.ConfirmImportItem(
                target.item.id, date, description, category, merchant, card, kind, amount, cuotas,
                learnRule && ruleUseful ? rulePattern : '',
              )
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
    <Modal title={TITLES[target.mode]} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4" aria-describedby={error ? 'expense-form-error' : undefined}>
        {importItem && (
          <p className="rounded bg-surface px-3 py-2 text-sm text-slate-300 ring-1 ring-slate-800">
            Glosa del banco: <span className="font-mono text-slate-100">{importItem.description}</span> ·{' '}
            <span className="tabular-nums">{formatCLP(importItem.amount)}</span>
            {importItem.installmentsTotal > 1 && <> en {importItem.installmentsTotal} cuotas</>}
          </p>
        )}
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

        {importItem && (
          <div className="space-y-2 rounded bg-surface p-3 ring-1 ring-slate-800">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={learnRule} onChange={(e) => setLearnRule(e.target.checked)} />
              Recordar comercio y categoría para glosas que empiecen con…
            </label>
            {learnRule && !ruleUseful && (
              <p className="text-xs text-amber-200">Elige un comercio o una categoría para que la regla sugiera algo.</p>
            )}
            {learnRule && ruleUseful && (
              <Field label="Patrón de la glosa">
                <input
                  className={inputCls}
                  value={rulePattern}
                  onChange={(e) => setRulePattern(e.target.value)}
                  required
                  aria-describedby="rule-pattern-help"
                />
                <p id="rule-pattern-help" className="mt-1 text-xs text-slate-500">
                  Se ignoran mayúsculas, números y letras sueltas: «cruz verde» cubre «CRUZ VERDE L9093 CHILLAN C».
                </p>
              </Field>
            )}
          </div>
        )}

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
            {busy ? 'Guardando…' : target.mode === 'edit' ? 'Guardar' : target.mode === 'confirm' ? 'Confirmar' : 'Agregar'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
