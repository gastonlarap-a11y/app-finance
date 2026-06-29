import { useEffect, useState } from 'react'
import { useAtom, useSetAtom } from 'jotai'
import { FinanceService, type Category } from '@/services/finance'
import { refreshAtom } from '@/atoms/finance'
import { failed } from '@/lib/result'
import { Button, Empty, Field, Modal, Section, inputCls } from './ui'

export function CategoriesView() {
  const [refresh] = useAtom(refreshAtom)
  const bump = useSetAtom(refreshAtom)
  const [categories, setCategories] = useState<Category[]>([])
  const [editing, setEditing] = useState<Category | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [confirmId, setConfirmId] = useState<number | null>(null)

  useEffect(() => {
    let active = true
    FinanceService.ListCategories().then((cs) => active && setCategories(cs ?? []))
    return () => {
      active = false
    }
  }, [refresh])

  async function remove(id: number) {
    setConfirmId(null)
    const res = await FinanceService.DeleteCategory(id)
    if (!failed(res)) bump((n) => n + 1)
  }

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
        <ul className="space-y-2">
          {categories.map((c) => (
            <li key={c.id} className="flex items-center justify-between rounded-base bg-surface p-3 ring-1 ring-slate-800">
              <div className="font-medium">{c.name}</div>
              <div className="flex items-center gap-2">
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
                    <Button variant="danger" onClick={() => remove(c.id)}>Sí</Button>
                    <Button variant="ghost" onClick={() => setConfirmId(null)}>No</Button>
                  </>
                ) : (
                  <Button variant="danger" onClick={() => setConfirmId(c.id)}>
                    Eliminar
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {showForm && (
        <CategoryForm
          category={editing}
          onClose={() => setShowForm(false)}
          onSaved={() => bump((n) => n + 1)}
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
  const editing = !!category
  const [name, setName] = useState(category?.name ?? '')
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      const res = editing
        ? await FinanceService.UpdateCategory(category!.id, name)
        : await FinanceService.CreateCategory(name)
      if (failed(res)) return
      onSaved()
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={editing ? 'Editar categoría' : 'Nueva categoría'} onClose={onClose}>
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
