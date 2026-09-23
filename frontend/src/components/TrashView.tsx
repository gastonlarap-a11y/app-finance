import { useAtomValue, useSetAtom } from 'jotai'
import { FinanceService, type OpResult, type TrashItem } from '@/services/finance'
import { UsersService } from '@/services/users'
import { refreshAtom } from '@/atoms/finance'
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

export function TrashView() {
  const refresh = useAtomValue(refreshAtom)
  const bump = useSetAtom(refreshAtom)
  const reload = () => bump((n) => n + 1)

  const query = useQuery(String(refresh), async () => {
    const [trash, deletedUsers] = await Promise.all([FinanceService.ListTrash(), UsersService.ListDeletedUsers()])
    if (trash.error) throw new Error(trash.error.message)
    return { items: trash.data ?? [], deletedUsers }
  })

  async function restoreItem(item: TrashItem) {
    const restore = RESTORE_BY_TYPE[item.type]
    if (restore && !failed(await restore(item.id))) reload()
  }

  async function restoreUser(id: number) {
    if (!failed(await UsersService.RestoreUser(id))) reload()
  }

  if (query.status === 'error') return <QueryError message={query.error} onRetry={reload} />
  if (!query.data) return <Spinner />
  const { items, deletedUsers } = query.data

  return (
    <div className="space-y-6">
      <Section title="Movimientos eliminados">
        {items.length === 0 ? (
          <Empty>No hay movimientos eliminados.</Empty>
        ) : (
          <ul className="space-y-2">
            {items.map((it) => (
              <li key={`${it.type}-${it.id}`} className="flex items-center justify-between rounded-base bg-surface p-3 ring-1 ring-slate-800">
                <div>
                  <span className="mr-2 rounded bg-slate-700 px-2 py-0.5 text-xs uppercase text-slate-300">
                    {TYPE_LABELS[it.type] ?? it.type}
                  </span>
                  <span className="font-medium">{it.description}</span>
                  {it.period && <span className="ml-2 text-sm text-slate-400">{it.period}</span>}
                  <div className="text-xs text-slate-500">Eliminado el {formatDate(it.deletedAt)}</div>
                </div>
                <div className="flex items-center gap-3">
                  {it.amount != null && <span className="tabular-nums">{formatCLP(it.amount)}</span>}
                  <Button variant="ghost" onClick={() => restoreItem(it)}>
                    ↺ Restaurar
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Usuarios eliminados">
        {deletedUsers.length === 0 ? (
          <Empty>No hay usuarios eliminados.</Empty>
        ) : (
          <ul className="space-y-2">
            {deletedUsers.map((u) => (
              <li key={u.id} className="flex items-center justify-between rounded-base bg-surface p-3 ring-1 ring-slate-800">
                <div>
                  <span className="font-medium">{u.name}</span>
                  <div className="text-xs text-slate-500">Eliminado el {formatDate(u.deletedAt)}</div>
                </div>
                <Button variant="ghost" onClick={() => restoreUser(u.id)}>
                  ↺ Restaurar
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  )
}
