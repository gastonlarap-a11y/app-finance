import { lazy, Suspense, useState } from 'react'
import { CloudUpload } from 'lucide-react'
import { useInvalidate, useVersion } from '@/atoms/refresh'
import { SettingsService, type SettingsState } from '@/services/settings'
import { useQuery } from '@/lib/useQuery'
import { IconButton } from '../ui'
import { requestBackup } from './backupNow'

// import.meta.env.VITE_TARGET is inlined by `define` at transform time, so the
// bundler sees a literal condition and never pulls the web engine (worker +
// sqlite-wasm) into the desktop bundle.
const WebExportControl =
  import.meta.env.VITE_TARGET === 'web'
    ? lazy(() => import('../WebBackup').then((m) => ({ default: m.WebExportControl })))
    : null

function lastBackupLabel(s: SettingsState | undefined): string {
  if (!s?.lastBackup) return 'Sin respaldos aún'
  const d = new Date(s.lastBackup)
  return `Último: ${d.toLocaleString('es-CL', { dateStyle: 'short', timeStyle: 'short' })}`
}

// SidebarBackup keeps the backup one click away: Drive status and "back up
// now" on desktop, export-to-file on the web build (no Drive there).
export function SidebarBackup({ rail }: { rail: boolean }) {
  if (WebExportControl) {
    return (
      <Suspense fallback={null}>
        <WebExportControl compact={rail} />
      </Suspense>
    )
  }
  return <DriveBackup rail={rail} />
}

function DriveBackup({ rail }: { rail: boolean }) {
  const [busy, setBusy] = useState(false)
  // Settings changes elsewhere (e.g. connecting Drive) invalidate 'settings',
  // which refetches this control — it never re-mounts on its own.
  const version = useVersion('settings')
  const invalidate = useInvalidate()
  const query = useQuery(version, async () => (await SettingsService.GetState()).data ?? undefined)
  const state = query.data

  async function backupNow() {
    setBusy(true)
    try {
      await requestBackup()
      invalidate('settings')
    } finally {
      setBusy(false)
    }
  }

  const connected = !!state?.driveConnected
  const status = connected ? 'Drive conectado' : 'Drive sin conectar'
  const dot = connected ? 'bg-positive-fg' : state?.clientIdConfigured ? 'bg-caution-fg' : 'bg-line-strong'
  const label = busy ? 'Respaldando…' : `Respaldar ahora (${status}. ${lastBackupLabel(state)})`

  if (rail) {
    return (
      <div className="flex justify-center">
        <IconButton label={label} icon={CloudUpload} onClick={() => void backupNow()} disabled={busy} />
      </div>
    )
  }
  return (
    <div className="flex items-center gap-2 px-2 py-1">
      <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${dot}`} />
      <div className="min-w-0 flex-1 text-xs leading-tight">
        <p className="truncate text-fg-muted">{status}</p>
        <p className="truncate text-fg-subtle">{busy ? 'Respaldando…' : lastBackupLabel(state)}</p>
      </div>
      <IconButton label={label} icon={CloudUpload} onClick={() => void backupNow()} disabled={busy} />
    </div>
  )
}
