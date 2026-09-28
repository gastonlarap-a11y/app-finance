// Desktop «Restaurar un respaldo»: the backups on this computer, a file picked
// by hand or the Google Drive copy. Nothing is replaced until the user sees what
// the backup holds and confirms; the current data is kept aside first (the
// backend's pre-restore copy), so a restore can be undone the same way.
import { useState } from 'react'
import { ArchiveRestore, CloudDownload, FileUp, History } from 'lucide-react'
import { SettingsService, type BackupFile, type BackupSummary } from '@/services/settings'
import { errMsg } from '@/lib/result'
import { errorText, useQuery } from '@/lib/useQuery'
import { Button, Callout, EmptyState, Modal, QueryError, SkeletonRows } from './ui'
import { SyncNoticeBox } from './SyncNoticeBox'

const KIND_LABEL: Record<string, string> = {
  respaldo: 'Respaldo',
  'antes-de-migrar': 'Antes de actualizar la app',
  'antes-de-restaurar': 'Antes de restaurar',
  anterior: 'Respaldo (versión anterior de la app)',
}

// Candidate is what the confirmation shows: where the backup comes from and
// what it holds.
interface Candidate {
  path: string
  label: string
  summary: BackupSummary
}

type Step =
  | { kind: 'idle' }
  | { kind: 'inspecting'; key: string }
  | { kind: 'confirming'; candidate: Candidate }
  | { kind: 'restoring'; candidate: Candidate }
  | { kind: 'done'; safetyCopy: string }
  | { kind: 'failed'; message: string }

function when(iso: string): string {
  return new Date(iso).toLocaleString('es-CL', { dateStyle: 'medium', timeStyle: 'short' })
}

function size(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
}

export function RestoreBackup({ driveConnected }: { driveConnected: boolean }) {
  const [reloadKey, setReloadKey] = useState(0)
  const [step, setStep] = useState<Step>({ kind: 'idle' })
  const query = useQuery(`backups:${reloadKey}`, async () => {
    const res = await SettingsService.ListBackups()
    const msg = errMsg(res)
    if (msg) throw new Error(msg)
    return res.data ?? []
  })
  const busy = step.kind === 'inspecting' || step.kind === 'restoring' || step.kind === 'done'
  const inspectingKey = step.kind === 'inspecting' ? step.key : null

  // inspect validates a backup (in a temp copy) and opens the confirmation. A
  // source may relabel it (the Drive copy names its device and date).
  async function inspect(key: string, label: string, getPath: () => Promise<{ path: string; source?: string } | null>) {
    setStep({ kind: 'inspecting', key })
    try {
      const picked = await getPath()
      if (picked === null) {
        setStep({ kind: 'idle' })
        return
      }
      const path = picked.path
      if (picked.source) label = picked.source
      const res = await SettingsService.InspectBackup(path)
      const msg = errMsg(res)
      if (msg || !res.data) {
        setStep({ kind: 'failed', message: msg ?? 'el respaldo no se pudo revisar' })
        return
      }
      setStep({ kind: 'confirming', candidate: { path, label, summary: res.data } })
    } catch (err) {
      setStep({ kind: 'failed', message: errorText(err) })
    }
  }

  async function pickFile(): Promise<{ path: string } | null> {
    const res = await SettingsService.ChooseBackupFile()
    const msg = errMsg(res)
    if (msg) throw new Error(msg)
    return res.canceled || !res.path ? null : { path: res.path }
  }

  // fromDrive fetches the newest backup of any of your computers.
  async function fromDrive(): Promise<{ path: string; source?: string } | null> {
    const res = await SettingsService.DownloadDriveBackup()
    const msg = errMsg(res)
    if (msg) throw new Error(msg)
    return res.path ? { path: res.path, source: res.source } : null
  }

  async function restore(candidate: Candidate) {
    setStep({ kind: 'restoring', candidate })
    try {
      const res = await SettingsService.RestoreBackup(candidate.path)
      const msg = errMsg(res)
      if (msg || !res.data) {
        setStep({ kind: 'failed', message: msg ?? 'no se pudo restaurar' })
        return
      }
      setStep({ kind: 'done', safetyCopy: res.data.safetyCopy })
      // Every view, the profile list and the active profile change with the
      // data: a reload is the one refresh that covers them all.
      setTimeout(() => window.location.reload(), 4000)
    } catch (err) {
      setStep({ kind: 'failed', message: errorText(err) })
    }
  }

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-fg">Restaurar un respaldo</h3>
      <p className="text-xs text-fg-subtle">
        Reemplaza tus datos actuales por los de un respaldo. Antes se guarda una copia de lo que tienes
        ahora, que aparece en esta lista como «Antes de restaurar» por si quieres volver atrás.
      </p>

      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          icon={FileUp}
          disabled={busy}
          loading={inspectingKey === 'file'}
          onClick={() => void inspect('file', 'Archivo elegido', pickFile)}
        >
          {inspectingKey === 'file' ? 'Revisando…' : 'Elegir archivo…'}
        </Button>
        {driveConnected && (
          <Button
            variant="secondary"
            icon={CloudDownload}
            disabled={busy}
            loading={inspectingKey === 'drive'}
            onClick={() => void inspect('drive', 'Google Drive', fromDrive)}
          >
            {inspectingKey === 'drive' ? 'Descargando…' : 'Desde Google Drive'}
          </Button>
        )}
      </div>

      {step.kind === 'failed' && (
        <Callout tone="negative" role="alert">
          No se pudo restaurar: {step.message}
        </Callout>
      )}
      {step.kind === 'done' && (
        <Callout tone="positive" role="status">
          Respaldo restaurado. Tus datos anteriores quedaron en <code className="font-mono">{step.safetyCopy}</code>. Recargando…
        </Callout>
      )}

      {query.status === 'error' ? (
        <QueryError message={query.error} onRetry={() => setReloadKey((n) => n + 1)} />
      ) : !query.data ? (
        <SkeletonRows rows={3} />
      ) : query.data.length === 0 ? (
        <EmptyState icon={History} title="Aún no hay respaldos en este equipo">
          Se crean al cerrar la app (si está activado arriba) o con «Respaldar ahora».
        </EmptyState>
      ) : (
        <ul className="divide-y divide-line rounded-lg ring-1 ring-inset ring-line">
          {query.data.map((f: BackupFile) => (
            <li key={f.path} className="flex flex-wrap items-center justify-between gap-3 px-3 py-2 text-sm">
              <div className="min-w-0">
                <div className="text-fg">{when(f.at)}</div>
                <div className="text-xs text-fg-subtle">
                  {KIND_LABEL[f.kind] ?? f.kind} · {size(f.size)}
                </div>
              </div>
              <Button
                variant="quiet"
                size="sm"
                icon={ArchiveRestore}
                disabled={busy}
                loading={inspectingKey === f.path}
                onClick={() =>
                  void inspect(f.path, `${KIND_LABEL[f.kind] ?? f.kind} del ${when(f.at)}`, () => Promise.resolve({ path: f.path }))
                }
              >
                {inspectingKey === f.path ? 'Revisando…' : 'Restaurar…'}
              </Button>
            </li>
          ))}
        </ul>
      )}

      {(step.kind === 'confirming' || step.kind === 'restoring') && (
        <ConfirmRestore
          candidate={step.candidate}
          restoring={step.kind === 'restoring'}
          onCancel={() => setStep({ kind: 'idle' })}
          onConfirm={() => void restore(step.candidate)}
        />
      )}
    </div>
  )
}

function ConfirmRestore({
  candidate,
  restoring,
  onCancel,
  onConfirm,
}: {
  candidate: Candidate
  restoring: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  const s = candidate.summary
  const empty = s.expenses === 0 && s.incomes === 0
  return (
    <Modal title="Restaurar este respaldo" onClose={restoring ? () => undefined : onCancel}>
      <p className="text-sm text-fg-muted">
        <strong className="text-fg">{candidate.label}</strong> contiene {s.profiles} {s.profiles === 1 ? 'perfil' : 'perfiles'},{' '}
        {s.expenses} {s.expenses === 1 ? 'gasto' : 'gastos'} y {s.incomes} {s.incomes === 1 ? 'ingreso' : 'ingresos'}
        {s.firstPeriod !== '' && (
          <>
            , con movimientos de {s.firstPeriod} a {s.lastPeriod}
          </>
        )}
        .
      </p>
      {empty && (
        <Callout tone="caution" className="mt-3">
          Este respaldo no tiene gastos ni ingresos. ¿Seguro que es el que buscas?
        </Callout>
      )}
      {s.migrations > 0 && (
        <p className="mt-2 text-xs text-fg-subtle">
          Es de una versión anterior de la app: se pondrá al día al restaurarlo.
        </p>
      )}
      <SyncNoticeBox sync={s.sync} />
      <p className="mt-3 text-sm text-fg-muted">
        Se reemplazarán <strong className="text-fg">todos</strong> tus datos actuales. Antes se guardará una copia de ellos para
        poder volver atrás.
      </p>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="secondary" disabled={restoring} onClick={onCancel}>
          Cancelar
        </Button>
        <Button variant="danger" loading={restoring} onClick={onConfirm}>
          {restoring ? 'Restaurando…' : 'Reemplazar mis datos'}
        </Button>
      </div>
    </Modal>
  )
}
