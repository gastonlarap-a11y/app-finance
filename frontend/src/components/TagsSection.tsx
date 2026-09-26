import { useState, type SubmitEvent } from 'react'
import { FinanceService, type TagView } from '@/services/finance'
import { useInvalidate, useVersion } from '@/atoms/refresh'
import { failed } from '@/lib/result'
import { useQuery } from '@/lib/useQuery'
import { Button, Empty, Field, Modal, QueryError, Section, Spinner, inputCls } from './ui'

// TagsSection lists the tags in use (labels across categories: viaje, trabajo,
// deducible) and lets the user rename or delete them. Tags are added on the
// expense form; Buscar filters and totals by one.
export function TagsSection() {
  const version = useVersion('ledger')
  const invalidate = useInvalidate()
  const reload = () => invalidate('ledger')
  const [renaming, setRenaming] = useState<TagView | null>(null)
  const [confirmId, setConfirmId] = useState<number | null>(null)
  const query = useQuery(version, () => FinanceService.ListTags())

  async function remove(id: number) {
    setConfirmId(null)
    if (!failed(await FinanceService.DeleteTag(id))) reload()
  }

  return (
    <Section title="Etiquetas">
      <p className="mb-3 text-xs text-slate-500">
        Marcas que cruzan categorías (viaje, trabajo, deducible). Se agregan al crear o editar un gasto; en Buscar puedes
        filtrar por una y ver cuánto suma.
      </p>
      {query.status === 'error' ? (
        <QueryError message={query.error} onRetry={reload} />
      ) : !query.data ? (
        <Spinner />
      ) : query.data.length === 0 ? (
        <Empty>Aún no usas etiquetas.</Empty>
      ) : (
        <ul className="space-y-2">
          {query.data.map((t) => (
            <li key={t.id} className="flex items-center justify-between rounded-base bg-surface p-3 ring-1 ring-slate-800">
              <span>
                <span className="font-medium">#{t.name}</span>{' '}
                <span className="text-xs text-slate-500">
                  {t.count} {t.count === 1 ? 'gasto' : 'gastos'}
                </span>
              </span>
              <span className="flex items-center gap-2">
                <Button variant="ghost" onClick={() => setRenaming(t)}>
                  Renombrar
                </Button>
                {confirmId === t.id ? (
                  <>
                    <span className="text-sm text-danger">¿Quitarla de todos sus gastos?</span>
                    <Button variant="danger" onClick={() => remove(t.id)}>
                      Sí
                    </Button>
                    <Button variant="ghost" onClick={() => setConfirmId(null)}>
                      No
                    </Button>
                  </>
                ) : (
                  <Button variant="danger" onClick={() => setConfirmId(t.id)}>
                    Eliminar
                  </Button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {renaming && (
        <RenameTagModal
          tag={renaming}
          onClose={() => setRenaming(null)}
          onSaved={() => {
            setRenaming(null)
            reload()
          }}
        />
      )}
    </Section>
  )
}

function RenameTagModal({ tag, onClose, onSaved }: { tag: TagView; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(tag.name)
  const [busy, setBusy] = useState(false)

  async function submit(e: SubmitEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      if (!failed(await FinanceService.RenameTag(tag.id, name))) onSaved()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={`Renombrar #${tag.name}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Nuevo nombre">
          <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} maxLength={30} required />
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? 'Guardando…' : 'Renombrar'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
