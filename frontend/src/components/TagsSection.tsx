import { useState, type SubmitEvent } from 'react'
import { Pencil, Tag } from 'lucide-react'
import { FinanceService, type TagView } from '@/services/finance'
import { useInvalidate, useVersion } from '@/atoms/refresh'
import { failed } from '@/lib/result'
import { useQuery } from '@/lib/useQuery'
import { Button, ConfirmAction, EmptyState, Field, IconButton, Modal, QueryError, Section, SkeletonRows, inputCls } from './ui'

// TagsSection lists the tags in use (labels across categories: viaje, trabajo,
// deducible) and lets the user rename or delete them. Tags are added on the
// expense form; Buscar filters and totals by one.
export function TagsSection() {
  const version = useVersion('ledger')
  const invalidate = useInvalidate()
  const reload = () => invalidate('ledger')
  const [renaming, setRenaming] = useState<TagView | null>(null)
  const query = useQuery(version, () => FinanceService.ListTags())

  async function remove(id: number) {
    if (!failed(await FinanceService.DeleteTag(id))) reload()
  }

  return (
    <Section title="Etiquetas">
      <p className="mb-4 text-sm text-fg-muted">
        Marcas que cruzan categorías (viaje, trabajo, deducible). Se agregan al crear o editar un gasto; en Buscar puedes filtrar
        por una y ver cuánto suma.
      </p>
      {query.status === 'error' ? (
        <QueryError message={query.error} onRetry={reload} />
      ) : !query.data ? (
        <SkeletonRows rows={3} />
      ) : query.data.length === 0 ? (
        <EmptyState icon={Tag} title="Aún no usas etiquetas">
          Escríbelas en el campo «Etiquetas» al agregar o editar un gasto, separadas por coma.
        </EmptyState>
      ) : (
        <ul className="divide-y divide-line">
          {query.data.map((t) => (
            <li key={t.id} className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
              <span className="min-w-0">
                <span className="rounded-full bg-accent-soft px-2 py-0.5 text-sm font-medium text-accent-fg">#{t.name}</span>{' '}
                <span className="text-xs text-fg-muted">
                  {t.count} {t.count === 1 ? 'gasto' : 'gastos'}
                </span>
              </span>
              <span className="flex items-center gap-1">
                <IconButton label={`Renombrar la etiqueta ${t.name}`} icon={Pencil} onClick={() => setRenaming(t)} />
                <ConfirmAction
                  label={`Eliminar la etiqueta ${t.name}`}
                  iconOnly
                  question="¿Quitarla de todos sus gastos?"
                  confirmLabel="Quitar"
                  onConfirm={() => remove(t.id)}
                />
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
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" loading={busy}>
            Renombrar
          </Button>
        </div>
      </form>
    </Modal>
  )
}
