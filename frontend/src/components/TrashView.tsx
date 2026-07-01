import { useEffect, useState } from 'react'
import { useAtom, useSetAtom } from 'jotai'
import { FinanceService, type TrashItem } from '@/services/finance'
import { UsersService, type User } from '@/services/users'
import { refreshAtom } from '@/atoms/finance'
import { failed } from '@/lib/result'
import { formatCLP, formatDate } from '@/lib/format'
import { Button, Empty, Section } from './ui'

const TYPE_LABELS: Record<string, string> = {
  card: 'Tarjeta',
  category: 'Categoría',
  income: 'Ingreso',
  expense: 'Gasto',
  fixedexpense: 'Gasto fijo',
}

const RESTORE_BY_TYPE: Record<string, (id: number) => Promise<{ error?: { code: string; message: string } | null }>> = {
  card: FinanceService.RestoreCard,
  category: FinanceService.RestoreCategory,
  income: FinanceService.RestoreIncome,
  expense: FinanceService.RestoreExpense,
  fixedexpense: FinanceService.RestoreFixedExpense,
}

export function TrashView() {
  const [refresh] = useAtom(refreshAtom)
  const bump = useSetAtom(refreshAtom)
  const [items, setItems] = useState<TrashItem[]>([])
  const [deletedUsers, setDeletedUsers] = useState<User[]>([])

  useEffect(() => {
    let active = true
    FinanceService.ListTrash().then((r) => active && setItems(r.data ?? []))
    UsersService.ListDeletedUsers().then((list) => active && setDeletedUsers(list ?? []))
    return () => {
      active = false
    }
  }, [refresh])

  async function restoreItem(item: TrashItem) {
    const restore = RESTORE_BY_TYPE[item.type]
    if (!restore) return
    const res = await restore(item.id)
    if (!failed(res)) bump((n) => n + 1)
  }

  async function restoreUser(id: number) {
    const res = await UsersService.RestoreUser(id)
    if (!failed(res)) bump((n) => n + 1)
  }

  return (
    <div className="space-y-6">
      <Section title="Movimientos eliminados">
        {items.length === 0 ? (
          <Empty>No hay movimientos eliminados.</Empty>
        ) : (
          <ul className="space-y-2">
            {items.map((it) => (
              <li
                key={`${it.type}-${it.id}`}
                className="flex items-center justify-between rounded-base bg-surface p-3 ring-1 ring-slate-800"
              >
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
              <li
                key={u.id}
                className="flex items-center justify-between rounded-base bg-surface p-3 ring-1 ring-slate-800"
              >
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
