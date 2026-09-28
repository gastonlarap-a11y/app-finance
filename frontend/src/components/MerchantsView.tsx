import { useState, type SubmitEvent } from 'react'
import { Pencil, Plus, Search, Store } from 'lucide-react'
import { FinanceService, type Merchant } from '@/services/finance'
import { useInvalidate, useVersion } from '@/atoms/refresh'
import { failed } from '@/lib/result'
import { useQuery } from '@/lib/useQuery'
import { Button, ConfirmAction, Empty, EmptyState, Field, IconButton, Modal, QueryError, Section, SkeletonRows, inputCls } from './ui'

// MerchantsView is Configuración › Comercios: where you buy, assignable to
// expenses and used by the import rules.
export function MerchantsView() {
  const version = useVersion('ledger')
  const invalidate = useInvalidate()
  // Merchants carry the categorization rules the import inbox applies.
  const reload = () => invalidate('ledger', 'imports')
  const [editing, setEditing] = useState<Merchant | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [query, setQuery] = useState('')

  const merchantsQuery = useQuery(version, () => FinanceService.ListMerchants())

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
  const merchants = merchantsQuery.data ?? []
  const filtered = merchants.filter((m) => m.name.toLowerCase().includes(query.toLowerCase()))

  return (
    <Section
      title="Comercios"
      action={
        <Button icon={Plus} onClick={() => open(null)}>
          Nuevo comercio
        </Button>
      }
    >
      {!merchantsQuery.data ? (
        <SkeletonRows rows={4} />
      ) : merchants.length === 0 ? (
        <EmptyState icon={Store} title="Aún no tienes comercios" action={<Button icon={Plus} onClick={() => open(null)}>Crear un comercio</Button>}>
          Jumbo, Falabella, la farmacia… Asígnalos a tus gastos; las reglas de importación los completan solas.
        </EmptyState>
      ) : (
        <>
          <div className="relative mb-3">
            <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" />
            <input
              type="search"
              aria-label="Buscar comercio"
              className={`${inputCls} pl-9`}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Buscar comercio…"
            />
          </div>
          {filtered.length === 0 ? (
            <Empty>No hay comercios que coincidan con la búsqueda.</Empty>
          ) : (
            <ul className="divide-y divide-line">
              {filtered.map((m) => (
                <li key={m.id} className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
                  <div className="flex min-w-0 items-center gap-3">
                    <span aria-hidden="true" className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent-soft text-xs font-bold text-accent-fg">
                      {m.name.charAt(0).toUpperCase()}
                    </span>
                    <span className="truncate font-medium text-fg">{m.name}</span>
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

      {showForm && <MerchantForm merchant={editing} onClose={() => setShowForm(false)} onSaved={reload} />}
    </Section>
  )
}

function MerchantForm({
  merchant,
  onClose,
  onSaved,
}: {
  merchant: Merchant | null
  onClose: () => void
  onSaved: () => void
}) {
  const editing = !!merchant
  const [name, setName] = useState(merchant?.name ?? '')
  const [busy, setBusy] = useState(false)

  async function submit(e: SubmitEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      const res = merchant ? await FinanceService.UpdateMerchant(merchant.id, name) : await FinanceService.CreateMerchant(name)
      if (failed(res)) return
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
