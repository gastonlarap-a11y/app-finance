import { useState, type SubmitEvent } from 'react'
import { useAtomValue } from 'jotai'
import { FinanceService, type Category, type CategoryBudgetView } from '@/services/finance'
import { periodAtom } from '@/atoms/finance'
import { useInvalidate, useVersion } from '@/atoms/refresh'
import { failed } from '@/lib/result'
import { useQuery } from '@/lib/useQuery'
import { formatCLP, periodLabel } from '@/lib/format'
import { Button, Empty, Field, Modal, MoneyInput, QueryError, Section, Spinner, inputCls } from './ui'
import { TagsSection } from './TagsSection'

export function CategoriesView() {
  const version = useVersion('ledger')
  const period = useAtomValue(periodAtom)
  const invalidate = useInvalidate()
  const reload = () => invalidate('ledger')
  const [editing, setEditing] = useState<Category | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [budgetFor, setBudgetFor] = useState<Category | null>(null)
  const [confirmId, setConfirmId] = useState<number | null>(null)

  const query = useQuery(`${period}:${version}`, async () => {
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
    <div className="space-y-5">
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
    <TagsSection />
    </div>
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
  const [rollover, setRollover] = useState(category.rollover)
  const [busy, setBusy] = useState(false)

  // save sets the cap (null lifts it) and the carry-over option.
  async function save(value: string | null) {
    setBusy(true)
    try {
      const res =
        value === null
          ? await FinanceService.RemoveCategoryBudget(category.id, from)
          : await FinanceService.SetCategoryBudget(category.id, from, value)
      if (failed(res)) return
      if (rollover !== category.rollover && failed(await FinanceService.SetCategoryRollover(category.id, rollover))) return
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
          Rige desde {from ? periodLabel(from) : 'el mes elegido'} en adelante; los meses anteriores mantienen su tope. Un tope de
          $0 significa «no gastar nada» en esta categoría.
        </p>
        <label className="flex items-start gap-2 text-sm text-slate-300">
          <input type="checkbox" className="mt-1" checked={rollover} onChange={(e) => setRollover(e.target.checked)} />
          <span>
            Traspasar lo no gastado al mes siguiente
            <span className="block text-xs text-slate-500">
              Lo que sobre de un mes se suma al tope del siguiente (si te pasas, el mes siguiente parte de cero).
            </span>
          </span>
        </label>
        <div className="flex flex-wrap justify-end gap-2 pt-2">
          {current && (
            <Button variant="danger" onClick={() => save(null)} disabled={busy}>
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
