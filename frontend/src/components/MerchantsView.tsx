import { useState, type SubmitEvent } from 'react'
import { Pencil, Plus, Search, Store } from 'lucide-react'
import { FinanceService, type Merchant } from '@/services/finance'
import { useInvalidate, useVersion } from '@/atoms/refresh'
import { categoryLooks } from '@/lib/look'
import { failed } from '@/lib/result'
import { useQuery } from '@/lib/useQuery'
import { Button, ConfirmAction, Empty, EmptyState, Field, IconButton, LookIcon, Modal, QueryError, Section, Select, SkeletonRows, inputCls } from './ui'
import { CatalogButton } from './CatalogButton'

// MerchantsView is Configuración › Comercios: where you buy, assignable to
// expenses and used by the import rules. A merchant's usual category (Apple →
// Tecnología) is proposed when it is picked in an expense or recognized in an import.
export function MerchantsView() {
  const version = useVersion('ledger')
  const invalidate = useInvalidate()
  // Merchants carry the categorization rules the import inbox applies.
  const reload = () => invalidate('ledger', 'imports')
  const [editing, setEditing] = useState<Merchant | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [query, setQuery] = useState('')

  const merchantsQuery = useQuery(`merchants:${version}`, async () => {
    const [merchants, categories] = await Promise.all([FinanceService.ListMerchants(), FinanceService.ListCategories()])
    return { merchants, categories: categories.map((c) => c.name), looks: categoryLooks(categories) }
  })

  async function remove(id: number) {
    const res = await FinanceService.DeleteMerchant(id)
    if (!failed(res)) reload()
  }

  function open(merchant: Merchant | null) {
    setEditing(merchant)
    setShowForm(true)
  }

  if (merchantsQuery.status === 'error') {
    return <QueryError message={merchantsQuery.error} onRetry={reload} />
  }
  const data = merchantsQuery.data
  const merchants = data?.merchants ?? []
  const q = query.toLowerCase()
  const filtered = merchants.filter((m) => m.name.toLowerCase().includes(q) || m.category.toLowerCase().includes(q))

  return (
    <Section
      title="Comercios"
      action={
        <Button icon={Plus} onClick={() => open(null)}>
          Nuevo comercio
        </Button>
      }
    >
      {!data ? (
        <SkeletonRows rows={4} />
      ) : merchants.length === 0 ? (
        <EmptyState
          icon={Store}
          title="Aún no tienes comercios"
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <CatalogButton variant="primary" />
              <Button variant="secondary" icon={Plus} onClick={() => open(null)}>
                Crear un comercio
              </Button>
            </div>
          }
        >
          Jumbo, Falabella, la farmacia… Asígnalos a tus gastos; las reglas de importación los completan solas. El catálogo
          sugerido trae los comercios más comunes de Chile con su categoría.
        </EmptyState>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <div className="relative min-w-48 flex-1">
              <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" />
              <input
                type="search"
                aria-label="Buscar comercio o categoría"
                className={`${inputCls} pl-9`}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Buscar comercio o categoría…"
              />
            </div>
            <CatalogButton />
          </div>
          {filtered.length === 0 ? (
            <Empty>No hay comercios que coincidan con la búsqueda.</Empty>
          ) : (
            <ul className="divide-y divide-line">
              {filtered.map((m) => (
                <li key={m.id} className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
                  <div className="flex min-w-0 items-center gap-3">
                    <LookIcon look={data.looks.byName(m.category)} />
                    <div className="min-w-0">
                      <div className="truncate font-medium text-fg">{m.name}</div>
                      <div className="truncate text-xs text-fg-muted">{m.category || 'Sin categoría habitual'}</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <IconButton label={`Editar el comercio ${m.name}`} icon={Pencil} onClick={() => open(m)} />
                    <ConfirmAction label={`Eliminar el comercio ${m.name}`} iconOnly onConfirm={() => remove(m.id)} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {showForm && data && (
        <MerchantForm merchant={editing} categories={data.categories} onClose={() => setShowForm(false)} onSaved={reload} />
      )}
    </Section>
  )
}

function MerchantForm({
  merchant,
  categories,
  onClose,
  onSaved,
}: {
  merchant: Merchant | null
  categories: string[]
  onClose: () => void
  onSaved: () => void
}) {
  const editing = !!merchant
  const [name, setName] = useState(merchant?.name ?? '')
  const [category, setCategory] = useState(merchant?.category ?? '')
  const [busy, setBusy] = useState(false)
  const options = category && !categories.includes(category) ? [...categories, category] : categories

  async function submit(e: SubmitEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      const res = merchant ? await FinanceService.UpdateMerchant(merchant.id, name) : await FinanceService.CreateMerchant(name)
      if (failed(res) || !res.data) return
      // The merchant is saved either way; a failed category write keeps the
      // dialog open (with its toast) so the choice is not silently lost.
      if (category !== (merchant?.category ?? '') && failed(await FinanceService.SetMerchantCategory(res.data.id, category))) {
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
    <Modal title={editing ? 'Editar comercio' : 'Nuevo comercio'} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Nombre">
          <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="Jumbo, Falabella…" autoFocus required />
        </Field>
        <Field label="Categoría habitual (opcional)" hint="Se propone al elegir este comercio en un gasto y al importar sus movimientos.">
          <Select value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">Ninguna (vende de todo)</option>
            {options.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
        </Field>
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
