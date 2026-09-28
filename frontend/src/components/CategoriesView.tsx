import { useState, type SubmitEvent } from 'react'
import { FinanceService, type Category, type CategoryBudgetView } from '@/services/finance'
import { useInvalidate, useVersion } from '@/atoms/refresh'
import { failed } from '@/lib/result'
import { useQuery } from '@/lib/useQuery'
import { currentPeriod, formatCLP, periodLabel } from '@/lib/format'
import { autoIcon, categoryLook, isColorKey, resolveLook } from '@/lib/look'
import { Pencil, Plus, Shapes, Target } from 'lucide-react'
import {
  Button,
  ColorPicker,
  ConfirmAction,
  EmptyState,
  Field,
  IconButton,
  IconPicker,
  LookIcon,
  Modal,
  MoneyInput,
  QueryError,
  Section,
  SkeletonRows,
  Switch,
  inputCls,
} from './ui'

// CategoriesView is Configuración › Categorías y presupuestos. Budgets are
// effective-dated, so it shows the ones in force in a month of its own
// (today by default), independent of the month the Resumen is on.
export function CategoriesView() {
  const version = useVersion('ledger')
  const [period, setPeriod] = useState(currentPeriod)
  const invalidate = useInvalidate()
  const reload = () => invalidate('ledger')
  const [editing, setEditing] = useState<Category | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [budgetFor, setBudgetFor] = useState<Category | null>(null)

  const query = useQuery(`${period}:${version}`, async () => {
    const [categories, budgets] = await Promise.all([
      FinanceService.ListCategories(),
      FinanceService.ListCategoryBudgets(period),
    ])
    if (budgets.error) throw new Error(budgets.error.message)
    return { categories, budgetById: new Map((budgets.data ?? []).map((b) => [b.categoryId, b])) }
  })

  async function remove(id: number) {
    if (!failed(await FinanceService.DeleteCategory(id))) reload()
  }

  function open(category: Category | null) {
    setEditing(category)
    setShowForm(true)
  }

  if (query.status === 'error') return <QueryError message={query.error} onRetry={reload} />
  const categories = query.data?.categories ?? []
  const budgetById = query.data?.budgetById ?? new Map<number, CategoryBudgetView>()

  return (
    <div className="space-y-5">
    <Section
      title="Categorías"
      action={
        <Button icon={Plus} onClick={() => open(null)}>
          Nueva categoría
        </Button>
      }
    >
      {!query.data ? (
        <SkeletonRows rows={4} />
      ) : categories.length === 0 ? (
        <EmptyState icon={Shapes} title="Aún no tienes categorías" action={<Button icon={Plus} onClick={() => open(null)}>Crear una categoría</Button>}>
          Supermercado, transporte, salud… Clasifica tus gastos para ver en qué se va la plata y ponerle un tope a cada una.
        </EmptyState>
      ) : (
        <>
          <label className="mb-3 flex flex-wrap items-center gap-2 text-sm text-fg-muted">
            Presupuestos vigentes en
            <input
              type="month"
              className="h-8 rounded-md bg-panel px-2 text-fg outline-none ring-1 ring-inset ring-line-input focus:ring-2 focus:ring-focus"
              value={period}
              onChange={(e) => e.target.value && setPeriod(e.target.value)}
            />
          </label>
          <ul className="divide-y divide-line">
            {categories.map((c) => {
              const budget = budgetById.get(c.id)
              return (
                <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-3 first:pt-0 last:pb-0">
                  <div className="flex min-w-0 items-center gap-3">
                  <LookIcon look={categoryLook(c)} />
                  <div className="min-w-0">
                    <div className="font-medium text-fg">{c.name}</div>
                    <div className="text-xs text-fg-muted">
                      {budget ? (
                        <>
                          Tope <span className="tabular-nums text-fg">{formatCLP(budget.amount)}</span> / mes · desde{' '}
                          {periodLabel(budget.effectiveFrom)}
                        </>
                      ) : (
                        'Sin presupuesto'
                      )}
                      {c.rollover && ' · traspasa lo no gastado'}
                    </div>
                  </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button variant="secondary" size="sm" icon={Target} onClick={() => setBudgetFor(c)}>
                      Presupuesto
                    </Button>
                    <IconButton label={`Editar la categoría ${c.name}`} icon={Pencil} onClick={() => open(c)} />
                    <ConfirmAction label={`Eliminar la categoría ${c.name}`} iconOnly onConfirm={() => remove(c.id)} />
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
  const [icon, setIcon] = useState(category?.icon ?? '')
  const [color, setColor] = useState(category?.color ?? '')
  const [busy, setBusy] = useState(false)
  // What 'Automático' resolves to, previewed live as the name changes.
  const autoLook = category ? resolveLook({ id: category.id, name }) : { icon: autoIcon(name, 'tag'), color: undefined }

  async function submit(e: SubmitEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      const res = category
        ? await FinanceService.UpdateCategory(category.id, name)
        : await FinanceService.CreateCategory(name)
      if (failed(res) || !res.data) return
      const lookChanged = icon !== (category?.icon ?? '') || color !== (category?.color ?? '')
      // The category is saved either way; a failed look write keeps the dialog
      // open (with its toast) so the choice is not silently lost.
      if (lookChanged && failed(await FinanceService.SetCategoryLook(res.data.id, icon, color))) {
        onSaved()
        return
      }
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
        <IconPicker value={icon} onChange={setIcon} auto={autoLook.icon} color={isColorKey(color) ? color : (autoLook.color ?? 'gray')} />
        <ColorPicker value={color} onChange={setColor} auto={autoLook.color} />
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
        <p className="text-xs text-fg-subtle">
          Rige desde {from ? periodLabel(from) : 'el mes elegido'} en adelante; los meses anteriores mantienen su tope. Un tope de
          $0 significa «no gastar nada» en esta categoría.
        </p>
        <Switch
          label="Traspasar lo no gastado al mes siguiente"
          description="Lo que sobre de un mes se suma al tope del siguiente (si te pasas, el mes siguiente parte de cero)."
          checked={rollover}
          onChange={setRollover}
        />
        <div className="flex flex-wrap justify-end gap-2 pt-2">
          {current && (
            <Button variant="quiet" className="mr-auto" onClick={() => void save(null)} disabled={busy}>
              Quitar tope
            </Button>
          )}
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
