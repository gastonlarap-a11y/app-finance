import { useState } from 'react'
import { FinanceService, type OpResult, type TrashItem } from '@/services/finance'
import { UsersService } from '@/services/users'
import { useInvalidate, useVersion } from '@/atoms/refresh'
import { failed } from '@/lib/result'
import { useQuery } from '@/lib/useQuery'
import { formatCLP, formatDate } from '@/lib/format'
import { Button, Empty, QueryError, Section, Spinner } from './ui'

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

// Confirm names what a «¿Eliminar para siempre?» prompt is about.
type Confirm = { kind: 'item'; item: TrashItem } | { kind: 'user'; id: number } | { kind: 'all' } | null

export function TrashView() {
  const version = useVersion('ledger', 'profiles')
  const invalidate = useInvalidate()
  const reload = () => invalidate('ledger', 'profiles')
  const [confirm, setConfirm] = useState<Confirm>(null)

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

  // purge deletes what the confirm prompt names, for good.
  async function purge(c: NonNullable<Confirm>) {
    setConfirm(null)
    const res =
      c.kind === 'item'
        ? await FinanceService.PurgeTrashItem(c.item.type, c.item.id)
        : c.kind === 'user'
          ? await UsersService.PurgeUser(c.id)
          : await FinanceService.EmptyTrash()
    if (!failed(res)) reload()
  }

  if (query.status === 'error') return <QueryError message={query.error} onRetry={reload} />
  if (!query.data) return <Spinner />
  const { items, deletedUsers } = query.data

  const confirmFor = (c: NonNullable<Confirm>, restore: () => void) =>
    confirm !== null && JSON.stringify(confirm) === JSON.stringify(c) ? (
      <div className="flex items-center gap-2">
        <span className="text-sm text-danger">¿Para siempre? No se puede deshacer.</span>
        <Button variant="danger" onClick={() => void purge(c)}>
          Sí, eliminar
        </Button>
        <Button variant="ghost" onClick={() => setConfirm(null)}>
          No
        </Button>
      </div>
    ) : (
      <div className="flex items-center gap-2">
        <Button variant="ghost" onClick={restore}>
          ↺ Restaurar
        </Button>
        <Button variant="ghost" onClick={() => setConfirm(c)}>
          Eliminar para siempre
        </Button>
      </div>
    )

  return (
    <div className="space-y-6">
      <Section title="Movimientos eliminados">
        {items.length === 0 ? (
          <Empty>No hay movimientos eliminados.</Empty>
        ) : (
          <>
            <ul className="space-y-2">
              {items.map((it) => (
                <li
                  key={`${it.type}-${it.id}`}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-base bg-surface p-3 ring-1 ring-slate-800"
                >
                  <div>
                    <span className="mr-2 rounded bg-slate-700 px-2 py-0.5 text-xs uppercase text-slate-300">
                      {TYPE_LABELS[it.type] ?? it.type}
                    </span>
                    <span className="font-medium">{it.description}</span>
                    {it.period && <span className="ml-2 text-sm text-slate-400">{it.period}</span>}
                    <div className="text-xs text-slate-500">Eliminado el {formatDate(it.deletedAt)}</div>
                  </div>
                  <div className="flex flex-wrap items-center gap-3">
                    {it.amount != null && <span className="tabular-nums">{formatCLP(it.amount)}</span>}
                    {confirmFor({ kind: 'item', item: it }, () => void restoreItem(it))}
                  </div>
                </li>
              ))}
            </ul>
            <div className="mt-3 flex flex-wrap items-center justify-end gap-2 text-sm">
              {confirm?.kind === 'all' ? (
                <>
                  <span className="text-danger">¿Eliminar todo para siempre? No se puede deshacer.</span>
                  <Button variant="danger" onClick={() => void purge({ kind: 'all' })}>
                    Sí, vaciar
                  </Button>
                  <Button variant="ghost" onClick={() => setConfirm(null)}>
                    No
                  </Button>
                </>
              ) : (
                <Button variant="ghost" onClick={() => setConfirm({ kind: 'all' })}>
                  Vaciar papelera
                </Button>
              )}
            </div>
          </>
        )}
      </Section>

      <Section title="Usuarios eliminados">
        {deletedUsers.length === 0 ? (
          <Empty>No hay usuarios eliminados.</Empty>
        ) : (
          <>
            <ul className="space-y-2">
              {deletedUsers.map((u) => (
                <li
                  key={u.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-base bg-surface p-3 ring-1 ring-slate-800"
                >
                  <div>
                    <span className="font-medium">{u.name}</span>
                    <div className="text-xs text-slate-500">Eliminado el {formatDate(u.deletedAt)}</div>
                  </div>
                  {confirmFor({ kind: 'user', id: u.id }, () => void restoreUser(u.id))}
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-slate-500">
              Eliminar un perfil para siempre borra todos sus datos (y, en el escritorio, la contraseña de su correo guardada en el
              llavero). Ya no viajará en tus respaldos.
            </p>
          </>
        )}
      </Section>
    </div>
  )
}
