import { useCallback, useEffect, useState } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { refreshAtom, tabAtom } from '@/atoms/finance'
import { SettingsService, type SettingsState } from '@/services/settings'
import { Button } from './ui'

function lastBackupLabel(s: SettingsState | null): string {
  if (!s?.lastBackup) return 'sin respaldos aún'
  const d = new Date(String(s.lastBackup))
  return `último: ${d.toLocaleString('es-CL', { dateStyle: 'short', timeStyle: 'short' })}`
}

export function BackupControl() {
  const [state, setState] = useState<SettingsState | null>(null)
  const [busy, setBusy] = useState(false)
  // Reload when something changes elsewhere (e.g. connecting Drive in Settings)
  // or when switching tabs — this header control never re-mounts on its own.
  const refresh = useAtomValue(refreshAtom)
  const tab = useAtomValue(tabAtom)
  const bump = useSetAtom(refreshAtom)

  const load = useCallback(() => {
    SettingsService.GetState().then((r) => setState(r.data ?? null))
  }, [])

  useEffect(() => {
    load()
  }, [load, refresh, tab])

  async function backupNow() {
    setBusy(true)
    try {
      const res = await SettingsService.BackupNow()
      if (res.error) {
        window.alert('Respaldo: ' + res.error.message)
      } else if (res.data) {
        window.alert(
          res.data.uploaded
            ? '✓ Respaldo subido a Google Drive'
            : '✓ Respaldo local creado (conecta Google Drive en Ajustes para subirlo)',
        )
      }
      bump((n) => n + 1)
    } finally {
      setBusy(false)
    }
  }

  const connected = !!state?.driveConnected
  const dot = connected ? 'bg-success' : state?.clientIdConfigured ? 'bg-warning' : 'bg-slate-500'

  return (
    <div className="flex items-center gap-3">
      <div className="hidden text-right text-xs text-slate-400 sm:block">
        <div className="flex items-center justify-end gap-1.5">
          <span className={`inline-block h-2 w-2 rounded-full ${dot}`} />
          <span>{connected ? 'Drive conectado' : 'Drive sin conectar'}</span>
        </div>
        <div className="text-slate-500">{lastBackupLabel(state)}</div>
      </div>
      <Button variant="ghost" onClick={backupNow} disabled={busy}>
        {busy ? 'Respaldando…' : '☁ Respaldar'}
      </Button>
    </div>
  )
}
