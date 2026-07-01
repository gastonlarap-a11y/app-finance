import { useCallback, useEffect, useRef, useState } from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { activeUserAtom, periodAtom, refreshAtom } from '@/atoms/finance'
import { UsersService, type User } from '@/services/users'
import { currentPeriod } from '@/lib/format'
import { failed } from '@/lib/result'
import { Button, Field, Modal, inputCls } from './ui'

export function UserSwitcher() {
  const [active, setActive] = useAtom(activeUserAtom)
  const [users, setUsers] = useState<User[]>([])
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null)
  const refresh = useAtomValue(refreshAtom)
  const bump = useSetAtom(refreshAtom)
  const setPeriod = useSetAtom(periodAtom)
  const boxRef = useRef<HTMLDivElement>(null)

  const load = useCallback(() => {
    UsersService.ActiveUser().then((r) => setActive(r.data ?? null))
    UsersService.ListUsers().then((list) => setUsers(list ?? []))
  }, [setActive])

  useEffect(() => {
    load()
  }, [load, refresh])

  // Close the dropdown when clicking outside it.
  useEffect(() => {
    if (!open) return
    function onClick(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) {
        setOpen(false)
        setConfirmDeleteId(null)
      }
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])

  // Reload every view for the freshly-selected profile.
  function applySwitch(user: User) {
    setActive(user)
    setPeriod(currentPeriod())
    bump((n) => n + 1)
    setOpen(false)
  }

  async function switchTo(id: number) {
    if (id === active?.id) {
      setOpen(false)
      return
    }
    setBusy(true)
    try {
      const res = await UsersService.SwitchUser(id)
      if (failed(res) || !res.data) return
      applySwitch(res.data)
    } finally {
      setBusy(false)
    }
  }

  async function createUser(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      const res = await UsersService.CreateUser(newName)
      if (failed(res) || !res.data) return
      setUsers((prev) => [...prev, res.data!])
      setNewName('')
      setCreating(false)
      applySwitch(res.data)
    } finally {
      setBusy(false)
    }
  }

  // Soft-deletes a profile. Deleting the active one auto-switches to whichever
  // user the backend reassigns to; deleting any other just refreshes the list.
  async function removeUser(id: number) {
    setConfirmDeleteId(null)
    setBusy(true)
    try {
      const res = await UsersService.DeleteUser(id)
      if (failed(res)) return
      if (res.data) {
        applySwitch(res.data)
      } else {
        setUsers((prev) => prev.filter((u) => u.id !== id))
        bump((n) => n + 1)
      }
    } finally {
      setBusy(false)
    }
  }

  const others = users.filter((u) => u.id !== active?.id)
  const canDelete = users.length > 1

  return (
    <div className="relative" ref={boxRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={busy}
        className="flex items-center gap-2 rounded-full bg-surface-alt px-3 py-1.5 text-sm ring-1 ring-slate-700 hover:ring-slate-500 disabled:opacity-60"
        title="Cambiar de usuario"
      >
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/20 text-xs font-bold text-primary">
          {(active?.name ?? '?').charAt(0).toUpperCase()}
        </span>
        <span className="max-w-[10rem] truncate font-medium">{active?.name ?? '…'}</span>
        <span className="text-xs text-slate-400">▾</span>
      </button>

      {open && (
        <div className="absolute right-0 z-50 mt-2 w-64 rounded-base bg-surface-alt p-1.5 shadow-2xl ring-1 ring-slate-700">
          {active && canDelete && (
            <div className="mb-1 flex items-center justify-between rounded px-2 py-1.5 text-sm">
              <span className="truncate text-slate-300">
                Perfil activo: <span className="font-medium text-slate-100">{active.name}</span>
              </span>
              {confirmDeleteId === active.id ? (
                <span className="flex shrink-0 items-center gap-2 text-xs">
                  <button onClick={() => removeUser(active.id)} className="text-danger hover:text-red-400" title="Confirmar eliminación">
                    ✓ Sí
                  </button>
                  <button onClick={() => setConfirmDeleteId(null)} className="text-slate-400 hover:text-slate-200" title="Cancelar">
                    ✕ No
                  </button>
                </span>
              ) : (
                <button
                  onClick={() => setConfirmDeleteId(active.id)}
                  className="shrink-0 px-1 text-slate-500 hover:text-danger"
                  title="Eliminar este usuario"
                >
                  🗑
                </button>
              )}
            </div>
          )}
          <p className="px-2 py-1 text-xs uppercase text-slate-500">Cambiar usuario</p>
          {others.length === 0 ? (
            <p className="px-2 py-1 text-sm text-slate-500">No hay otros usuarios.</p>
          ) : (
            others.map((u) => (
              <div key={u.id} className="flex items-center gap-1 rounded hover:bg-slate-700/50">
                <button
                  onClick={() => switchTo(u.id)}
                  className="flex flex-1 items-center gap-2 rounded px-2 py-1.5 text-left text-sm"
                >
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-slate-600 text-[10px] font-bold">
                    {u.name.charAt(0).toUpperCase()}
                  </span>
                  <span className="truncate">{u.name}</span>
                </button>
                {confirmDeleteId === u.id ? (
                  <span className="flex shrink-0 items-center gap-1 pr-2 text-xs">
                    <button onClick={() => removeUser(u.id)} className="text-danger hover:text-red-400" title="Confirmar eliminación">
                      ✓
                    </button>
                    <button onClick={() => setConfirmDeleteId(null)} className="text-slate-400 hover:text-slate-200" title="Cancelar">
                      ✕
                    </button>
                  </span>
                ) : (
                  <button
                    onClick={() => setConfirmDeleteId(u.id)}
                    className="shrink-0 px-2 text-slate-500 hover:text-danger"
                    title="Eliminar usuario"
                  >
                    🗑
                  </button>
                )}
              </div>
            ))
          )}
          <div className="my-1 border-t border-slate-700" />
          <button
            onClick={() => {
              setOpen(false)
              setCreating(true)
            }}
            className="w-full rounded px-2 py-1.5 text-left text-sm text-primary hover:bg-slate-700/50"
          >
            ➕ Crear usuario nuevo
          </button>
        </div>
      )}

      {creating && (
        <Modal title="Crear usuario" onClose={() => setCreating(false)}>
          <form onSubmit={createUser} className="space-y-4">
            <Field label="Nombre del usuario">
              <input
                className={inputCls}
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Camila"
                autoFocus
                required
              />
            </Field>
            <p className="text-xs text-slate-500">
              Se crea un perfil con sus propias finanzas (vacío) y se cambia a él al instante.
            </p>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" onClick={() => setCreating(false)}>
                Cancelar
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? 'Creando…' : 'Crear y entrar'}
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  )
}
