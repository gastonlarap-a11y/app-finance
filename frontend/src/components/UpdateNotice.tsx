import { useEffect, useState } from 'react'
import { UpdatesService, onDownloadProgress, onUpdateStateChange, type DownloadProgress, type UpdateState } from '@/services/updates'
import { errMsg, failed } from '@/lib/result'
import { notify } from '@/lib/notify'
import { useQuery } from '@/lib/useQuery'
import { Bar, Button, Modal, Section } from './ui'

function formatMB(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function formatWhen(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString('es-CL', { dateStyle: 'short', timeStyle: 'short' }) : 'nunca'
}

// useUpdateState reads the backend's update state and re-reads it whenever the
// updater reports a change (check done, download ready or failed).
function useUpdateState() {
  const [tick, setTick] = useState(0)
  useEffect(() => onUpdateStateChange(() => setTick((n) => n + 1)), [])
  const query = useQuery(`updates:${tick}`, async () => (await UpdatesService.GetUpdateState()).data ?? null)
  return { state: query.data ?? null, reload: () => setTick((n) => n + 1) }
}

function ReleaseNotes({ state, onClose }: { state: UpdateState; onClose: () => void }) {
  const rel = state.available
  if (!rel) return null
  return (
    <Modal title={`Novedades de la versión ${rel.version}`} onClose={onClose}>
      <p className="mb-3 text-xs text-slate-400">
        Publicada el {formatWhen(rel.publishedAt)} · descarga de {formatMB(rel.size)} · tienes la {state.currentVersion}
      </p>
      <div className="max-h-80 overflow-y-auto whitespace-pre-wrap rounded bg-surface p-3 text-sm text-slate-300 ring-1 ring-slate-800">
        {rel.notes.trim() || 'Sin notas.'}
      </div>
    </Modal>
  )
}

// UpdateBanner offers a newer release under the header and walks it through
// download → ready → restart. Desktop only (the PWA updates itself).
export function UpdateBanner() {
  const { state, reload } = useUpdateState()
  const [progress, setProgress] = useState<DownloadProgress | null>(null)
  const [dismissed, setDismissed] = useState<string | null>(null) // version hidden for this session
  const [showNotes, setShowNotes] = useState(false)
  const [backupError, setBackupError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => onDownloadProgress(setProgress), [])

  const rel = state?.available
  if (!state || !rel || (dismissed === rel.version && state.phase === 'idle')) return null

  async function install() {
    setProgress(null)
    if (!failed(await UpdatesService.InstallUpdate())) reload()
  }

  async function restart(skipBackup: boolean) {
    setBusy(true)
    setBackupError(null)
    try {
      const res = await UpdatesService.RestartToUpdate(skipBackup)
      const msg = errMsg(res)
      if (msg) {
        // A failed backup is a decision for the user, not just a toast.
        if (!skipBackup && msg.includes('respaldo')) setBackupError(msg)
        else notify(msg)
        reload()
      }
      // On success the app quits and reopens in the new version.
    } finally {
      setBusy(false)
    }
  }

  const pct = progress && progress.total > 0 ? progress.written / progress.total : 0

  return (
    <div role="status" className="border-b border-primary/40 bg-primary/10">
      <div className="mx-auto flex max-w-[1536px] flex-wrap items-center gap-3 px-6 py-2 text-sm">
        {state.blocked ? (
          <span className="text-amber-200">
            Hay una versión nueva ({rel.version}), pero no se puede instalar desde aquí: {state.blocked}
          </span>
        ) : state.phase === 'downloading' ? (
          <div className="flex min-w-64 flex-1 items-center gap-3">
            <span>Descargando la versión {rel.version}…</span>
            <div className="w-48">
              <Bar fill={pct} />
            </div>
            <span className="tabular-nums text-slate-400" aria-live="polite">
              {progress ? `${Math.round(pct * 100)}%` : ''}
            </span>
          </div>
        ) : state.phase === 'ready' || state.phase === 'restarting' ? (
          <>
            <span>La versión {rel.version} está lista.</span>
            {backupError ? (
              <>
                <span className="text-amber-200">{backupError}</span>
                <Button variant="ghost" disabled={busy} onClick={() => void restart(false)}>
                  Reintentar
                </Button>
                <Button variant="danger" disabled={busy} onClick={() => void restart(true)}>
                  Actualizar sin respaldo
                </Button>
              </>
            ) : (
              <Button disabled={busy || state.phase === 'restarting'} onClick={() => void restart(false)}>
                {busy || state.phase === 'restarting' ? 'Respaldando y reiniciando…' : 'Reiniciar y actualizar'}
              </Button>
            )}
          </>
        ) : (
          <>
            <span>
              Nueva versión <strong>{rel.version}</strong> disponible (tienes la {state.currentVersion}).
            </span>
            {state.lastError && <span className="text-red-300">{state.lastError}</span>}
            <Button variant="ghost" onClick={() => setShowNotes(true)}>
              Ver novedades
            </Button>
            <Button onClick={() => void install()}>{state.lastError ? 'Reintentar' : 'Actualizar'}</Button>
            <Button variant="ghost" onClick={() => setDismissed(rel.version)}>
              Más tarde
            </Button>
          </>
        )}
      </div>
      {showNotes && <ReleaseNotes state={state} onClose={() => setShowNotes(false)} />}
    </div>
  )
}

// UpdatesSettings shows the installed version and checks on demand.
export function UpdatesSettings() {
  const { state, reload } = useUpdateState()
  const [checking, setChecking] = useState(false)

  async function checkNow() {
    setChecking(true)
    try {
      const res = await UpdatesService.CheckForUpdate()
      if (failed(res) || !res.data) return
      if (res.data.available) notify(`Versión ${res.data.available.version} disponible: usa el aviso de arriba para instalarla.`, 'success')
      else if (!res.data.lastError) notify('Tienes la última versión.', 'success')
      reload()
    } finally {
      setChecking(false)
    }
  }

  return (
    <Section title="Actualizaciones">
      <div className="space-y-2 text-sm">
        <p>
          Versión instalada: <strong>{state?.currentVersion || '—'}</strong>
        </p>
        <p className="text-xs text-slate-500">
          La app busca versiones nuevas al abrirse y cada 6 horas. Última revisión: {formatWhen(state?.lastChecked ?? null)}.
          Antes de instalar, respalda tus datos si tienes activado el respaldo al cerrar.
        </p>
        {state?.lastError && <p className="text-xs text-red-300">{state.lastError}</p>}
        {state?.blocked && <p className="text-xs text-amber-200">{state.blocked}</p>}
        <Button variant="ghost" onClick={() => void checkNow()} disabled={checking}>
          {checking ? 'Buscando…' : 'Buscar actualizaciones'}
        </Button>
      </div>
    </Section>
  )
}
