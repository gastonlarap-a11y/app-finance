import { useState } from 'react'
import { RotateCcw, Trash, UserRound } from 'lucide-react'
import { FinanceService, type OpResult, type TrashItem } from '@/services/finance'
import { UsersService } from '@/services/users'
import { useInvalidate, useVersion } from '@/atoms/refresh'
import { failed } from '@/lib/result'
import { useQuery } from '@/lib/useQuery'
import { formatCLP, formatDate } from '@/lib/format'
import { Badge, Button, ConfirmDialog, Empty, EmptyState, QueryError, Section, SkeletonRows } from './ui'

const TYPE_LABELS: Record<string, string> = {
  card: 'Tarjeta',
  category: 'Categoría',
  merchant: 'Comercio',
  income: 'Ingreso',
  expense: 'Gasto',
  fixedexpense: 'Gasto fijo',
  savingsgoal: 'Meta de ahorro',
}

// Arrow wrappers (not bare method references) so the service keeps its `this`.
const RESTORE_BY_TYPE: Record<string, (id: number) => Promise<OpResult>> = {
  card: (id) => FinanceService.RestoreCard(id),
  category: (id) => FinanceService.RestoreCategory(id),
  merchant: (id) => FinanceService.RestoreMerchant(id),
  income: (id) => FinanceService.RestoreIncome(id),
  expense: (id) => FinanceService.RestoreExpense(id),
  fixedexpense: (id) => FinanceService.RestoreFixedExpense(id),
  savingsgoal: (id) => FinanceService.RestoreSavingsGoal(id),
}

// Purge names what a «eliminar para siempre» confirmation is about.
type Purge = { kind: 'item'; item: TrashItem } | { kind: 'user'; id: number; name: string } | { kind: 'all' }

function purgeQuestion(p: Purge): string {
  if (p.kind === 'all') return '¿Vaciar la papelera? Todo lo que contiene se elimina para siempre.'
  if (p.kind === 'user') return `¿Eliminar el perfil «${p.name}» para siempre? Se borran todos sus datos.`
  return `¿Eliminar «${p.item.description}» para siempre?`
}

// TrashView is Configuración › Papelera: what was deleted, to restore it or
// delete it for good (only from here).
export function TrashView() {
  const version = useVersion('ledger', 'profiles')
  const invalidate = useInvalidate()
  const reload = () => invalidate('ledger', 'profiles')
  const [purging, setPurging] = useState<Purge | null>(null)

  const query = useQuery(version, async () => {
    const [trash, deletedUsers] = await Promise.all([FinanceService.ListTrash(), UsersService.ListDeletedUsers()])
    if (trash.error) throw new Error(trash.error.message)
    return { items: trash.data ?? [], deletedUsers }
  })

  async function restoreItem(item: TrashItem) {
    const restore = RESTORE_BY_TYPE[item.type]
    if (restore && !failed(await restore(item.id))) invalidate('ledger')
  }

  async function restoreUser(id: number) {
    if (!failed(await UsersService.RestoreUser(id))) invalidate('profiles')
  }

  async function purge(p: Purge) {
    const res =
      p.kind === 'item'
        ? await FinanceService.PurgeTrashItem(p.item.type, p.item.id)
        : p.kind === 'user'
          ? await UsersService.PurgeUser(p.id)
          : await FinanceService.EmptyTrash()
    if (!failed(res)) reload()
  }

  if (query.status === 'error') return <QueryError message={query.error} onRetry={reload} />
  const data = query.data

  return (
    <div className="space-y-6">
      <Section
        title="Movimientos eliminados"
        action={
          data && data.items.length > 0 && (
            <Button variant="quiet" size="sm" icon={Trash} onClick={() => setPurging({ kind: 'all' })}>
              Vaciar papelera
            </Button>
          )
        }
      >
        {!data ? (
          <SkeletonRows rows={3} />
        ) : data.items.length === 0 ? (
          <EmptyState icon={Trash} title="La papelera está vacía">
            Lo que elimines (tarjetas, categorías, gastos, metas…) queda aquí para restaurarlo.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {data.items.map((it) => (
              <li key={`${it.type}-${it.id}`} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge>{TYPE_LABELS[it.type] ?? it.type}</Badge>
                    <span className="font-medium text-fg">{it.description}</span>
                    {it.period && <span className="text-sm text-fg-muted">{it.period}</span>}
                  </div>
                  <div className="mt-0.5 text-xs text-fg-subtle">Eliminado el {formatDate(it.deletedAt)}</div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {it.amount != null && <span className="mr-1 tabular-nums text-fg">{formatCLP(it.amount)}</span>}
                  <Button variant="secondary" size="sm" icon={RotateCcw} onClick={() => void restoreItem(it)}>
                    Restaurar
                  </Button>
                  <Button variant="quiet" size="sm" onClick={() => setPurging({ kind: 'item', item: it })}>
                    Eliminar para siempre
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Perfiles eliminados">
        {!data ? (
          <SkeletonRows rows={1} />
        ) : data.deletedUsers.length === 0 ? (
          <Empty>No hay perfiles eliminados.</Empty>
        ) : (
          <>
            <ul className="divide-y divide-line">
              {data.deletedUsers.map((u) => (
                <li key={u.id} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
                  <div className="flex min-w-0 items-center gap-3">
                    <UserRound aria-hidden="true" className="size-4 shrink-0 text-fg-subtle" />
                    <div>
                      <span className="font-medium text-fg">{u.name}</span>
                      <div className="text-xs text-fg-subtle">Eliminado el {formatDate(u.deletedAt)}</div>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button variant="secondary" size="sm" icon={RotateCcw} onClick={() => void restoreUser(u.id)}>
                      Restaurar
                    </Button>
                    <Button variant="quiet" size="sm" onClick={() => setPurging({ kind: 'user', id: u.id, name: u.name })}>
                      Eliminar para siempre
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-fg-subtle">
              Eliminar un perfil para siempre borra todos sus datos (y, en el escritorio, la contraseña de su correo guardada en el
              llavero). Ya no viajará en tus respaldos.
            </p>
          </>
        )}
      </Section>

      {purging && (
        <ConfirmDialog
          title="Eliminar para siempre"
          confirmLabel={purging.kind === 'all' ? 'Vaciar papelera' : 'Eliminar para siempre'}
          onConfirm={() => purge(purging)}
          onClose={() => setPurging(null)}
        >
          {purgeQuestion(purging)} No se puede deshacer.
        </ConfirmDialog>
      )}
    </div>
  )
}
