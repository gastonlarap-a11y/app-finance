import { useEffect, useState } from 'react'
import { useAtom, useSetAtom } from 'jotai'
import { FinanceService, type Merchant } from '@/services/finance'
import { refreshAtom } from '@/atoms/finance'
import { failed } from '@/lib/result'
import { Button, Empty, Field, Modal, Section, inputCls } from './ui'

export function MerchantsView() {
  const [refresh] = useAtom(refreshAtom)
  const bump = useSetAtom(refreshAtom)
  const [merchants, setMerchants] = useState<Merchant[]>([])
  const [editing, setEditing] = useState<Merchant | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [confirmId, setConfirmId] = useState<number | null>(null)
  const [query, setQuery] = useState('')

  useEffect(() => {
    let active = true
    FinanceService.ListMerchants().then((ms) => active && setMerchants(ms ?? []))
    return () => {
      active = false
    }
  }, [refresh])

  async function remove(id: number) {
    setConfirmId(null)
    const res = await FinanceService.DeleteMerchant(id)
    if (!failed(res)) bump((n) => n + 1)
  }

  const filtered = merchants.filter((m) => m.name.toLowerCase().includes(query.toLowerCase()))

  return (
    <Section
      title="Comercios"
      action={
        <Button
          onClick={() => {
            setEditing(null)
            setShowForm(true)
          }}
        >
          + Nuevo comercio
        </Button>
      }
    >
      {merchants.length === 0 ? (
        <Empty>Aún no tienes comercios. Crea uno para asignarlo a tus gastos.</Empty>
      ) : (
        <>
          <input
            className={`${inputCls} mb-3`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar comercio…"
          />
          {filtered.length === 0 ? (
            <Empty>No hay comercios que coincidan con la búsqueda.</Empty>
          ) : (
            <ul className="space-y-2">
              {filtered.map((m) => (
                <li key={m.id} className="flex items-center justify-between rounded-base bg-surface p-3 ring-1 ring-slate-800">
                  <div className="flex items-center gap-3">
                    <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/20 text-xs font-bold text-primary">
                      {m.name.charAt(0).toUpperCase()}
                    </span>
                    <span className="font-medium">{m.name}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setEditing(m)
                        setShowForm(true)
                      }}
                    >
                      Editar
                    </Button>
                    {confirmId === m.id ? (
                      <>
                        <span className="text-sm text-danger">¿Eliminar?</span>
                        <Button variant="danger" onClick={() => remove(m.id)}>Sí</Button>
                        <Button variant="ghost" onClick={() => setConfirmId(null)}>No</Button>
                      </>
                    ) : (
                      <Button variant="danger" onClick={() => setConfirmId(m.id)}>
                        Eliminar
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {showForm && (
        <MerchantForm
          merchant={editing}
          onClose={() => setShowForm(false)}
          onSaved={() => bump((n) => n + 1)}
        />
      )}
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

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      const res = editing
        ? await FinanceService.UpdateMerchant(merchant!.id, name)
        : await FinanceService.CreateMerchant(name)
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
