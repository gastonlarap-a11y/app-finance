import { useState, type SubmitEvent } from 'react'
import { Plus } from 'lucide-react'
import { useInvalidate } from '@/atoms/refresh'
import { notify } from '@/lib/notify'
import { Link } from '../Link'
import { initial, useProfileActions, useProfiles } from '../shell/profiles'
import { Badge, Button, ConfirmAction, Field, Input, QueryError, Section, SkeletonRows } from '../ui'

// ProfilesSettings manages the profiles sharing this app (no login: each one
// has its own finances in the same database, switching is instant).
export function ProfilesSettings() {
  const { query, active, users } = useProfiles()
  const { switchTo, create, remove } = useProfileActions()
  const invalidate = useInvalidate()
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: SubmitEvent) {
    e.preventDefault()
    const trimmed = name.trim()
    if (busy || trimmed === '') return
    setBusy(true)
    try {
      if (await create(trimmed)) {
        setName('')
        notify(`Perfil «${trimmed}» creado: ahora estás en él.`, 'success')
      }
    } finally {
      setBusy(false)
    }
  }

  if (query.status === 'error') return <QueryError message={query.error} onRetry={() => invalidate('profiles')} />

  return (
    <div className="space-y-5">
      <Section title="Perfiles">
        <p className="mb-2 text-sm text-fg-muted">
          Cada perfil tiene sus propias finanzas en esta misma app. Cambiar de perfil es instantáneo y no pide contraseña.
        </p>
        {!query.data ? (
          <SkeletonRows rows={2} />
        ) : (
          <ul className="divide-y divide-line">
            {users.map((u) => (
              <li key={u.id} className="flex flex-wrap items-center gap-3 py-3">
                <span aria-hidden="true" className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent-soft text-sm font-bold text-accent-fg">
                  {initial(u.name)}
                </span>
                <span className="min-w-0 flex-1 truncate font-medium text-fg">{u.name}</span>
                {u.id === active?.id ? (
                  <Badge tone="accent">En uso</Badge>
                ) : (
                  <Button variant="secondary" size="sm" onClick={() => void switchTo(u.id)}>
                    Usar este perfil
                  </Button>
                )}
                {users.length > 1 && (
                  <ConfirmAction
                    label={`Eliminar el perfil ${u.name}`}
                    iconOnly
                    question="¿Enviar a la papelera?"
                    confirmLabel="Eliminar"
                    onConfirm={() => remove(u.id)}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-xs text-fg-subtle">
          Un perfil eliminado va a la <Link to={{ page: 'config', section: 'papelera' }}>Papelera</Link>, desde donde puedes
          restaurarlo.
        </p>
      </Section>

      <Section title="Nuevo perfil">
        <form onSubmit={submit} className="space-y-2">
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-48 flex-1">
              <Field label="Nombre">
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Camila" required />
              </Field>
            </div>
            <Button type="submit" icon={Plus} loading={busy}>
              Crear perfil
            </Button>
          </div>
          <p className="text-xs text-fg-subtle">Empieza vacío y pasas a usarlo al instante.</p>
        </form>
      </Section>
    </div>
  )
}
