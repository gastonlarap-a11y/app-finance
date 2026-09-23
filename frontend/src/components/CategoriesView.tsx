import { useState, type SubmitEvent } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { FinanceService, type Category, type CategoryBudgetView } from '@/services/finance'
import { periodAtom, refreshAtom } from '@/atoms/finance'
import { failed } from '@/lib/result'
import { useQuery } from '@/lib/useQuery'
import { formatCLP, periodLabel } from '@/lib/format'
import { Button, Empty, Field, Modal, MoneyInput, QueryError, Section, Spinner, inputCls } from './ui'

export function CategoriesView() {
  const refresh = useAtomValue(refreshAtom)
  const period = useAtomValue(periodAtom)
  const bump = useSetAtom(refreshAtom)
  const reload = () => bump((n) => n + 1)
  const [editing, setEditing] = useState<Category | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [budgetFor, setBudgetFor] = useState<Category | null>(null)
  const [confirmId, setConfirmId] = useState<number | null>(null)

  const query = useQuery(`${period}:${refresh}`, async () => {
    const [categories, budgets] = await Promise.all([
      FinanceService.ListCategories(),
      FinanceService.ListCategoryBudgets(period),
    ])
    if (budgets.error) throw new Error(budgets.error.message)
    return { categories, budgetById: new Map((budgets.data ?? []).map((b) => [b.categoryId, b])) }
  })

  async function remove(id: number) {
    setConfirmId(null)
    if (!failed(await FinanceService.DeleteCategory(id))) reload()
  }

  if (query.status === 'error') return <QueryError message={query.error} onRetry={reload} />
  if (!query.data) return <Spinner />
  const { categories, budgetById } = query.data

  return (
    <Section
      title="Categorías"
      action={
        <Button
          onClick={() => {
            setEditing(null)
            setShowForm(true)
          }}
        >
          + Nueva categoría
        </Button>
      }
    >
      {categories.length === 0 ? (
        <Empty>Aún no tienes categorías. Crea una para clasificar tus gastos.</Empty>
      ) : (
        <>
          <p className="mb-3 text-xs text-slate-500">Presupuestos vigentes en {periodLabel(period)}.</p>
          <ul className="space-y-2">
            {categories.map((c) => {
              const budget = budgetById.get(c.id)
              return (
                <li
                  key={c.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-base bg-surface p-3 ring-1 ring-slate-800"
                >
                  <div>
                    <div className="font-medium">{c.name}</div>
                    <div className="text-xs text-slate-500">
                      {budget
                        ? `Tope ${formatCLP(budget.amount)} / mes · desde ${periodLabel(budget.effectiveFrom)}`
                        : 'Sin presupuesto'}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button variant="ghost" onClick={() => setBudgetFor(c)}>
                      Presupuesto
                    </Button>
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
                        <Button variant="danger" onClick={() => remove(c.id)}>
                          Sí
                        </Button>
                        <Button variant="ghost" onClick={() => setConfirmId(null)}>
                          No
                        </Button>
                      </>
                    ) : (
                      <Button variant="danger" onClick={() => setConfirmId(c.id)}>
                        Eliminar
                      </Button>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        </>
      )}

      {showForm && <CategoryForm category={editing} onClose={() => setShowForm(false)} onSaved={reload} />}
      {budgetFor && (
        <BudgetForm
          category={budgetFor}
          current={budgetById.get(budgetFor.id)}
          defaultFrom={period}
          onClose={() => setBudgetFor(null)}
          onSaved={reload}
        />
      )}
    </Section>
  )
}

function CategoryForm({
  category,
  onClose,
  onSaved,
}: {
  category: Category | null
  onClose: () => void
  onSaved: () => void
}) {
  const [name, setName] = useState(category?.name ?? '')
  const [busy, setBusy] = useState(false)

  async function submit(e: SubmitEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      const res = category
        ? await FinanceService.UpdateCategory(category.id, name)
        : await FinanceService.CreateCategory(name)
      if (failed(res)) return
      onSaved()
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={category ? 'Editar categoría' : 'Nueva categoría'} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Nombre">
          <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="Comida, Transporte…" autoFocus required />
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

// BudgetForm sets a category's monthly cap from a month onward; earlier months
// keep whatever cap they had ("de este mes en adelante").
function BudgetForm({
  category,
  current,
  defaultFrom,
  onClose,
  onSaved,
}: {
  category: Category
  current: CategoryBudgetView | undefined
  defaultFrom: string
  onClose: () => void
  onSaved: () => void
}) {
  const [amount, setAmount] = useState(current?.amount ?? '')
  const [from, setFrom] = useState(defaultFrom)
  const [busy, setBusy] = useState(false)

  async function save(value: string) {
    setBusy(true)
    try {
      if (failed(await FinanceService.SetCategoryBudget(category.id, from, value))) return
      onSaved()
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={`Presupuesto · ${category.name}`} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void save(amount || '0')
        }}
        className="space-y-4"
      >
        <Field label="Tope mensual">
          <MoneyInput value={amount} onChange={setAmount} placeholder="150000" autoFocus required />
        </Field>
        <Field label="Desde el mes">
          <input type="month" className={inputCls} value={from} onChange={(e) => setFrom(e.target.value)} required />
        </Field>
        <p className="text-xs text-slate-500">
          Rige desde {from ? periodLabel(from) : 'el mes elegido'} en adelante; los meses anteriores mantienen su tope.
        </p>
        <div className="flex flex-wrap justify-end gap-2 pt-2">
          {current && (
            <Button variant="danger" onClick={() => save('0')} disabled={busy}>
              Quitar tope
            </Button>
          )}
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
